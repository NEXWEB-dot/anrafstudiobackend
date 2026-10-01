# ANRAF Studio — Backend Architecture & Services

Production-ready, resilient e-commerce backend built with **Cloudflare Pages Functions**, **Cloudflare Workers (Cron)**, **Cloudflare R2**, and **Supabase (PostgreSQL)**.

## 0. Architecture & Guarantees

This architecture implements a **graceful degradation / offline-first** design:

| Guarantee | How It Works |
|---|---|
| **G1** | The public storefront never queries Supabase directly. It reads static catalog JSON from Cloudflare R2 CDN with automated fallbacks. Bot traffic cannot consume Supabase quota. |
| **G2** | If Supabase is paused, rate-limited (HTTP 429), quota-restricted (HTTP 402), or down, the storefront continues to display all products from R2. |
| **G3** | Zero order loss: Orders are saved atomically in Supabase via RPC. If Supabase is unavailable, orders are captured in R2 (`orders-pending/`) and emailed to admin via Resend, then replayed automatically upon recovery. |
| **G4** | **Emergency Mode**: If Supabase is down, the admin dashboard edits `products.json` directly in R2 and queues changes (`state/pending-ops.json`) for automatic replay. |
| **G5** | Zero secrets in browsers: Supabase is accessible only from server code using the `service_role` key. Postgres RLS is deny-all for all public/authenticated roles. |
| **G6** | Prices, order totals, and stock are strictly validated and computed server-side. |
| **G7** | Guarded catalog sync: Validates payload shape and enforces a shrink-guard before publishing to R2. |
| **G8** | Automatic alerting via Resend when errors or circuit-breaker trips occur. |

---

## 1. Directory Structure

```
/functions
  /api/checkout.js               # Public endpoint: Turnstile -> validate -> place_order RPC -> admin email
  /api/admin/_middleware.js      # Cloudflare Access JWT verification & Origin CSRF defense
  /api/admin/_product-ops.js     # Shared product upsert/delete (normal + emergency mode)
  /api/admin/status.js           # System health & emergency status
  /api/admin/products.js         # Products listing & creation
  /api/admin/products/[id].js    # Product update & deletion
  /api/admin/orders.js           # Orders listing (with offline R2 fallback)
  /api/admin/orders/[id].js      # Order status lifecycle management
  /api/admin/upload.js           # Image upload to R2 with magic-byte validation
  /api/admin/sync.js             # Manual catalog sync trigger
  /api/admin/checkout-toggle.js  # Emergency checkout kill switch

/shared
  sb.js                          # PostgREST Supabase client with hard timeouts & error classification
  mode.js                        # Circuit breaker state machine in R2
  catalog.js                     # Guarded catalog rebuild & validation (Supabase -> R2)
  emergency.js                   # R2 compare-and-swap (CAS) product operations & replay engine
  alerts.js                      # Resend email alert client with cooldown deduplication
  validate.js                    # Server-side input validation

/workers/cron
  index.js                       # 3 scheduled cron tasks (probe, reconcile, nightly maintenance)
  wrangler.toml                  # Cron worker deployment config

/supabase/migrations
  001_init.sql                   # Complete PostgreSQL schema, atomic RPCs, and RLS deny-all policies

/public
  /admin/                        # Static Admin Dashboard UI (protected by Cloudflare Access)
  /data/products.fallback.json   # Seed fallback catalog refreshed during build

/scripts
  fetch-fallback.mjs             # Pages build script to download latest catalog from R2 CDN
```

---

## 2. Setup & Deployment

### 2.1 Database Setup (Supabase)
1. In your **Supabase Dashboard**, open the **SQL Editor**.
2. Run the entire script in [`supabase/migrations/001_init.sql`](./supabase/migrations/001_init.sql).
3. Verify that `anon` has no permissions to query `orders` or `products`.

### 2.2 Cloudflare R2 Buckets
Create two R2 buckets in Cloudflare:
1. `store-public`: Connect to your custom domain e.g. `cdn.yourdomain.com` (stores `catalog/products.json` and `img/*`).
2. `store-private`: **No public domain** (stores `catalog/admin-products.json`, `state/*`, `orders-pending/*`, and `backups/*`).

### 2.3 Cloudflare Pages (API & Admin Dashboard)
1. Deploy this repository to **Cloudflare Pages**.
   - Build command: `node scripts/fetch-fallback.mjs`
   - Build output directory: `public`
2. In Cloudflare Pages Settings -> **Environment variables**, configure:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY`
   - `SITE_ORIGIN` (e.g. `https://yourdomain.com`)
   - `PUBLIC_CDN_ORIGIN` (e.g. `https://cdn.yourdomain.com`)
   - `ACCESS_TEAM_DOMAIN` (e.g. `your-team.cloudflareaccess.com`)
   - `ACCESS_AUD` (Application AUD tag from Cloudflare Zero Trust)
   - `ADMIN_EMAILS` (comma-separated allowlist)
   - `TURNSTILE_SECRET` (Turnstile secret key for checkout bot check)
   - `RESEND_API_KEY`
   - `MAIL_FROM` (e.g. `orders@yourdomain.com`)
   - `ADMIN_NOTIFY_EMAIL` (e.g. `admin@yourdomain.com`)
   - `ALERT_EMAIL` (e.g. `ops@yourdomain.com`)
   - `WHATSAPP_URL` (e.g. `https://wa.me/923000000000`)
3. Bind both R2 buckets under **Settings -> Functions -> R2 bucket bindings**:
   - `PUBLIC` -> `store-public`
   - `PRIVATE` -> `store-private`

### 2.4 Cloudflare Cron Worker
Deploy the cron worker from `/workers/cron`:
```bash
cd workers/cron
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_KEY
npx wrangler secret put PUBLIC_CDN_ORIGIN
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put MAIL_FROM
npx wrangler secret put ALERT_EMAIL
npx wrangler secret put ADMIN_NOTIFY_EMAIL
npx wrangler deploy
```

The worker automatically executes:
- `*/5 * * * *` — Probes Supabase health and replays pending offline operations.
- `0 */6 * * *` — Reconciles catalog sync and keeps Supabase active (prevents inactivity pause).
- `0 3 * * *` — Nightly backup export to R2, orphan image cleanup, and backup retention pruning.
