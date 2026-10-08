# ANRAF Sanity + Resend API

Products are read from Sanity's public API CDN and order requests are sent through
Resend. No Supabase, R2, legacy admin API, or cron worker is required.

## Cloudflare Pages setup

- Install dependencies with `npm ci` (Node 22 or newer).
- Build command: `npm run build`; output directory: `dist`.
- Deploy from the repository root so Cloudflare includes `functions/`.
- Copy the setting names from `.env.example` into Cloudflare's environment settings.
  Store `RESEND_API_KEY` and `TURNSTILE_SECRET` as encrypted secrets, never in Git.
- Set `SITE_ORIGIN` to the exact storefront origin, with no trailing slash or path.
- Set `MAIL_FROM` to a sender on your verified Resend domain and `ADMIN_NOTIFY_EMAIL`
  to the inbox that receives orders. Configure Turnstile for the storefront hostname.
- Keep `CHECKOUT_ENABLED=false` until configured; enable for a controlled test order
  and verify actual email receipt before accepting customer traffic.

If the frontend is also on Cloudflare Pages, configure its `BACKEND_ORIGIN` runtime
variable with this backend's HTTPS origin. Its existing bridge handles checkout.
For GitHub Pages, set the frontend's `js/api-config.js` API_ORIGIN instead.

## Behavior and limits

- Published-only Sanity queries, five-minute catalog cache per edge location,
  separate 60-second checkout cache, and full-response catalog ETags.
- Checkout validates origins, bounded input, Turnstile, stock status, sizes and prices.
- Customer details go to Resend only; never to the public Sanity product dataset.
- Success means Resend accepted the message, not guaranteed inbox delivery.
- Resend retry deduplication lasts 24 hours; there is no private order database,
  order-management dashboard, automatic inventory reservation or outage order queue.
- Legacy database code is removed from deployment. Do not delete historical production
  order records when migrating. This source change does not delete cloud resources.

Run `npm test` for checkout security and failure-handling regression coverage.


## Sanity Studio

The complete Studio source is in sanity-studio/. It is a separate application: run npm ci and npm run build from that directory. Host its dist/ output as a separate Cloudflare Pages project or use Sanity hosting. Keep the backend project's root directory at the repository root. Studio dependencies and build output are intentionally not committed.

## Backups

Published product JSON is kept in backups/sanity.snapshot.json. Add backup product images to assets/. These folders are not copied into the API deployment. Run node scripts/backup-products.mjs to refresh the product backup.
