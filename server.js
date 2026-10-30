'use strict';
// Royz Academy backend: static hosting + enquiries, courses, coupons, orders, Razorpay payments.
// No npm packages needed. Requires Node 18+.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');

const ROOT = __dirname, PUB = path.join(ROOT, 'public'), DATA = path.join(ROOT, 'data');
try { // minimal .env loader
  for (const l of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch {}
const { PORT = 3000, RAZORPAY_KEY_ID: KEY, RAZORPAY_KEY_SECRET: SECRET, RAZORPAY_WEBHOOK_SECRET: WEBHOOK, ADMIN_TOKEN } = process.env;

const load = f => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const COURSES = load('courses.json').courses, COUPONS = load('coupons.json');
try{fs.copyFileSync(path.join(DATA,'courses.json'),path.join(PUB,'assets','courses.json'))}catch{}
const courseById = id => COURSES.find(c => c.id === id && c.enroll && c.price > 0);

// ---------- storage (JSON files, atomic writes, serialized) ----------
let queue = Promise.resolve();
const withLock = fn => (queue = queue.then(fn, fn));
const readList = f => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { return []; } };
const writeList = (f, d) => { const p = path.join(DATA, f), t = p + '.tmp'; fs.writeFileSync(t, JSON.stringify(d, null, 1)); fs.renameSync(t, p); };
const push = (f, row) => withLock(() => { const d = readList(f); d.push(row); writeList(f, d); });
const updateOrder = (id, fn) => withLock(() => {
  const d = readList('orders.json'), o = d.find(x => x.id === id);
  if (o) { fn(o); writeList('orders.json', d); } return o;
});

// ---------- helpers ----------
const hits = new Map();
const limited = (ip, key, max, windowMs) => {
  const k = key + ip, now = Date.now(), h = hits.get(k);
  if (!h || h.reset < now) { hits.set(k, { n: 1, reset: now + windowMs }); return false; }
  return ++h.n > max;
};
setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (v.reset < n) hits.delete(k); }, 60000).unref();

const SEC = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline' https://checkout.razorpay.com; frame-src https://api.razorpay.com https://checkout.razorpay.com; connect-src 'self' https://*.razorpay.com; base-uri 'self'; form-action 'self'"
};
const send = (res, code, obj) => { res.writeHead(code, { ...SEC, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const body = req => new Promise((ok, no) => {
  let s = ''; req.on('data', c => { s += c; if (s.length > 20000) { no(new Error('Too large')); req.destroy(); } });
  req.on('end', () => ok(s)); req.on('error', no);
});
const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');
const safeEq = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, n);
const phoneOf = s => { const d = String(s || '').replace(/\D/g, ''); const t = d.slice(-10); return /^[6-9]\d{9}$/.test(t) ? t : null; };
const emailOk = s => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);

function quote(course, code) {
  let discount = 0, applied = null;
  if (code) {
    const k = clean(code, 30).toUpperCase(), c = COUPONS[k];
    if (!c || c.active === false) return { error: 'Invalid coupon code' };
    if (c.expires && Date.now() > Date.parse(c.expires) + 864e5) return { error: 'This coupon has expired' };
    if (c.minAmount && course.price < c.minAmount) return { error: `Valid on orders of ₹${c.minAmount} or more` };
    if (c.courses && !c.courses.includes(course.id)) return { error: 'Not valid for this course' };
    discount = c.type === 'percent' ? Math.round(course.price * c.value / 100) : c.value;
    if (c.maxDiscount) discount = Math.min(discount, c.maxDiscount);
    discount = Math.min(discount, course.price - 1); applied = k;
  }
  return { price: course.price, discount, amount: course.price - discount, coupon: applied };
}

async function razorpay(path, payload) {
  const r = await fetch('https://api.razorpay.com/v1/' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(KEY + ':' + SECRET).toString('base64') },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(15000)
  });
  const j = await r.json(); if (!r.ok) throw new Error(j.error?.description || 'Payment gateway error'); return j;
}

// ---------- API ----------
async function api(req, res, url, ip) {
  const route = req.method + ' ' + url.pathname;
  if (route === 'GET /api/courses') { res.setHeader('Cache-Control', 'public, max-age=300'); return send(res, 200, { courses: COURSES }); }
  if (route === 'GET /api/health') return send(res, 200, { ok: true, payments: !!(KEY && SECRET) });

  if (route === 'POST /api/webhooks/razorpay') { // verified against RAW body
    const raw = await body(req);
    if (!WEBHOOK || !safeEq(hmac(WEBHOOK, raw), req.headers['x-razorpay-signature'] || '')) return send(res, 400, { error: 'Bad signature' });
    const ev = JSON.parse(raw), p = ev.payload?.payment?.entity;
    if (p && ['payment.captured', 'order.paid'].includes(ev.event)) {
      const o = readList('orders.json').find(x => x.gatewayOrderId === p.order_id);
      if (o) await updateOrder(o.id, x => { x.status = 'paid'; x.paymentId = p.id; x.method = p.method; x.paidAt = new Date().toISOString(); });
    }
    return send(res, 200, { ok: true });
  }

  if (route.startsWith('GET /api/admin/')) {
    const t = (req.headers.authorization || '').replace('Bearer ', '');
    if (!ADMIN_TOKEN || !safeEq(t, ADMIN_TOKEN)) return send(res, 401, { error: 'Unauthorized' });
    const f = { orders: 'orders.json', enquiries: 'enquiries.json' }[url.pathname.split('/').pop()];
    return f ? send(res, 200, readList(f).reverse()) : send(res, 404, { error: 'Not found' });
  }

  if (req.method !== 'POST') return send(res, 404, { error: 'Not found' });
  let d; try { d = JSON.parse(await body(req) || '{}'); } catch { return send(res, 400, { error: 'Invalid request' }); }

  if (route === 'POST /api/enquiries') {
    if (limited(ip, 'enq', 5, 600000)) return send(res, 429, { error: 'Too many requests. Please try again later.' });
    const name = clean(d.name, 80), phone = phoneOf(d.phone);
    if (name.length < 2 || !phone) return send(res, 400, { error: 'Please enter a valid name and 10-digit mobile number.' });
    if (d.website) return send(res, 200, { ok: true }); // honeypot
    await push('enquiries.json', { at: new Date().toISOString(), name, phone, email: clean(d.email, 120), course: clean(d.course, 80), message: clean(d.message, 1000) });
    return send(res, 200, { ok: true });
  }

  if (route === 'POST /api/coupons/validate') {
    if (limited(ip, 'cpn', 20, 600000)) return send(res, 429, { error: 'Too many attempts. Please wait a few minutes.' });
    const c = courseById(d.courseId); if (!c) return send(res, 400, { error: 'Unknown course' });
    const q = quote(c, d.code); return q.error ? send(res, 200, { valid: false, message: q.error }) : send(res, 200, { valid: true, ...q });
  }

  if (route === 'POST /api/orders') {
    if (limited(ip, 'ord', 10, 600000)) return send(res, 429, { error: 'Too many attempts. Please try again later.' });
    const c = courseById(d.courseId), name = clean(d.name, 80), phone = phoneOf(d.phone), email = clean(d.email, 120);
    if (!c) return send(res, 400, { error: 'Unknown course' });
    if (name.length < 2 || !phone || !emailOk(email)) return send(res, 400, { error: 'Please check your name, mobile number and email.' });
    const q = quote(c, d.coupon); if (q.error) return send(res, 400, { error: q.error });
    const id = 'RA' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();
    const order = { id, at: new Date().toISOString(), courseId: c.id, course: c.title, name, phone, email, coupon: q.coupon, price: q.price, discount: q.discount, amount: q.amount, status: 'created' };
    if (!(KEY && SECRET)) { order.status = 'pending_manual'; await push('orders.json', order); return send(res, 200, { orderId: id, amount: q.amount, demo: true }); }
    try {
      const g = await razorpay('orders', { amount: q.amount * 100, currency: 'INR', receipt: id, notes: { course: c.id, phone } });
      order.gatewayOrderId = g.id; await push('orders.json', order);
      return send(res, 200, { orderId: id, amount: q.amount, razorpay: { key: KEY, order_id: g.id, amount: g.amount } });
    } catch (e) { console.error('Razorpay:', e.message); return send(res, 502, { error: 'Payments are unavailable right now. Please try again shortly.' }); }
  }

  if (route === 'POST /api/payments/verify') {
    const { orderId, razorpay_order_id: ro, razorpay_payment_id: rp, razorpay_signature: rs } = d;
    if (!SECRET || !ro || !rp || !rs || !safeEq(hmac(SECRET, ro + '|' + rp), rs)) return send(res, 400, { error: 'Payment could not be verified' });
    const o = await updateOrder(clean(orderId, 40), x => { if (x.gatewayOrderId === ro) { x.status = 'paid'; x.paymentId = rp; x.paidAt = new Date().toISOString(); } });
    return o && o.gatewayOrderId === ro ? send(res, 200, { ok: true, orderId: o.id }) : send(res, 404, { error: 'Order not found' });
  }
  send(res, 404, { error: 'Not found' });
}

// ---------- static files ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain' };
const cache = new Map();
function serve(req, res, url) {
  let p = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[\/\\])+/, '');
  if (p.endsWith(path.sep) || p === '.') p = path.join(p, 'index.html');
  else if (!path.extname(p)) p += '.html'; // clean URLs: /checkout
  const f = path.join(PUB, p);
  if (!f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.stat(f, (e, st) => {
    if (e || !st.isFile()) { res.writeHead(404, { ...SEC, 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const ext = path.extname(f), h = { ...SEC, 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=604800' };
    const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '') && ['.html', '.css', '.js', '.json', '.svg'].includes(ext);
    if (!gz) { res.writeHead(200, { ...h, 'Content-Length': st.size }); return fs.createReadStream(f).pipe(res); }
    let c = cache.get(f); if (!c || c.m !== st.mtimeMs) { c = { m: st.mtimeMs, b: zlib.gzipSync(fs.readFileSync(f), { level: 9 }) }; cache.set(f, c); }
    res.writeHead(200, { ...h, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', 'Content-Length': c.b.length }); res.end(c.b);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  try { url.pathname.startsWith('/api/') ? await api(req, res, url, ip) : serve(req, res, url); }
  catch (e) { console.error(e); if (!res.headersSent) send(res, 500, { error: 'Something went wrong. Please try again.' }); }
}).listen(PORT, () => console.log(`Royz Academy running on http://localhost:${PORT} | payments: ${KEY && SECRET ? 'Razorpay LIVE' : 'demo mode'}`));
