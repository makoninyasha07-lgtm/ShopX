# ShopX — Live Payment + Hosting Starter

This is a **deployment-ready starter**, not an already-published website. It adds a server-side Paynow checkout flow, PostgreSQL order records, payment status polling, and a Render deployment blueprint. A public URL and real charges require the owner to deploy it and enter their own Paynow merchant credentials.

## What is wired up
- Existing ShopX storefront UI, with checkout redirected to the server.
- Server validates product IDs and quantities and calculates totals from PostgreSQL prices (not browser-submitted prices).
- Paynow hosted checkout using the official `paynow` Node package.
- Order records and order items stored in PostgreSQL.
- Payment confirmation is checked server-to-server through Paynow's poll URL; a browser return alone does not mark an order paid.
- Rate limiting, basic security headers, health endpoint, and environment-based secrets.
- Render blueprint for public hosting and a PostgreSQL database.

## Important limitations before real launch
- Paynow merchant account approval and API credentials are required. This starter is configured for Paynow's hosted web checkout; supported methods depend on the merchant account and provider configuration.
- The initial checkout catalogue is the eight seeded sample products. Seller-added products in the demo UI are not yet shared/persisted to the server catalogue, so they cannot be checked out as real orders. Production marketplace needs secure seller authentication, server-side product management, image uploads, inventory, and admin tools.
- This is **not yet a complete multi-vendor marketplace**: seller onboarding/KYC, commission ledger, seller payouts, refunds/disputes, shipping/tax rules, fraud controls, privacy/terms, backups, monitoring, and legal/compliance review still need to be built before accepting public orders.
- No Android APK is included. The hosted responsive site can be opened on Android; native packaging is a separate step.
- Do not use demo localStorage login for real accounts. It remains a prototype and must be replaced by secure server-side authentication before public account use.

## Public deployment (Render)
1. Create a GitHub account if needed, make a **private** repository, and upload the contents of this folder. Do not upload a real `.env` file or API keys.
2. In Render, choose **New → Blueprint** and connect the repository containing `render.yaml`.
3. Render will request `APP_URL`, `PAYNOW_INTEGRATION_ID`, and `PAYNOW_INTEGRATION_KEY`. First create the service, then set `APP_URL` to the exact HTTPS URL Render assigned to the service, for example `https://your-service-name.onrender.com`. Add the Paynow credentials in Render's Environment settings, not in code or chat.
4. Register with Paynow at https://www.paynow.co.zw/ and follow its developer docs at https://developers.paynow.co.zw/docs/paynow/quickstart/ to obtain an Integration ID and Integration Key. Use test mode first if available to your merchant account.
5. Redeploy after setting the environment variables. Open `https://YOUR-SERVICE.onrender.com/api/health`; it should report `ok: true` and `paymentsConfigured: true`.
6. Test checkout end-to-end using Paynow's test mode and confirm the order changes to `paid` only after provider status verification. Do not advertise live payments until this passes.

## Run locally
Requires Node.js 20+ and a PostgreSQL database.

```bash
cp .env.example .env
# Edit .env with database URL, Paynow credentials, and APP_URL (for local testing use an HTTPS tunnel)
npm install
npm start
```

Open `http://localhost:3000`. Without credentials the app runs but checkout intentionally returns a clear configuration error; it will never fake a successful payment.

## Security notes
- Keep `PAYNOW_INTEGRATION_KEY` private and rotate it if it leaks.
- Never accept a browser redirect as proof of payment; this server checks the Paynow poll URL.
- Use provider test mode first. Keep keys in the host's secret/environment manager.
- Before launch, add real account auth, seller/admin authorization, order access control, idempotency and webhook verification according to current Paynow guidance, audit logs, backups, and privacy/legal pages.
