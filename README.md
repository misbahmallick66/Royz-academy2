# Royz Academy website
Run: `node server.js` (Node 18+, no npm install needed), then open http://localhost:3000

1. Copy `.env.example` to `.env`. Add Razorpay keys for live payments (UPI, cards, net banking, wallets). Without keys it runs in demo mode (orders are saved, payment is confirmed on WhatsApp).
2. Razorpay webhook (recommended): URL `/api/webhooks/razorpay`, events `payment.captured` and `order.paid`, secret in `RAZORPAY_WEBHOOK_SECRET`.
3. Edit courses and prices in `data/courses.json` (PRICES ARE PLACEHOLDERS) and coupons in `data/coupons.json`. Restart after editing. Demo coupons: WELCOME10, ROYZ500, STUDENT15.
4. Orders and enquiries are saved in `data/`. View them at `/api/admin/orders` and `/api/admin/enquiries` with header `Authorization: Bearer <ADMIN_TOKEN>`.
5. Host on a Node host (Render, Railway, VPS). Static-only hosting will not run the backend.
