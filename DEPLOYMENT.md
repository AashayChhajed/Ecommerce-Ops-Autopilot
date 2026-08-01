# Deployment Guide — Render (backend + Postgres) & Vercel (frontend)

This project is split into three deployable pieces:

| Piece | Where it runs | What it is |
|---|---|---|
| **Database** | Render free Postgres | Managed PostgreSQL, created by the blueprint |
| **Backend API** | Render free web service | `backend/` — Node 22 ESM, custom HTTP router, API only |
| **Scheduler worker** | Render worker | `backend/` — same codebase, cron jobs only |
| **Frontend** | Vercel | `frontend/` — Next.js 16 dashboard |

Everything is wired via environment variables; no code changes are needed to deploy.
The repo is already on GitHub (`AashayChhajed/Ecommerce-Ops-Autopilot`), which both platforms can import directly.

---

## 0. One-time repo prep

1. Commit and push the latest code:

```bash
git add -A && git commit -m "Deploy prep: render.yaml blueprint, env example, deployment docs" && git push origin main
```

2. Make sure the repo is public **or** you're fine linking it to your Render/Vercel accounts (both support private repos with a GitHub connection).

---

## 1. Deploy the database + backend services to Render

**Option A — Blueprint (recommended, does both at once):**

1. Go to [dashboard.render.com](https://dashboard.render.com) → **New +** → **Blueprint**.
2. Connect the `AashayChhajed/Ecommerce-Ops-Autopilot` repo.
3. Render reads `render.yaml` and shows three resources to create:
   - `ecommerce-ops-autopilot-db` (free Postgres)
   - `ecommerce-ops-autopilot-api` (free web service, rootDir `backend`)
   - `ecommerce-ops-autopilot-scheduler` (worker service, rootDir `backend`)
4. Click **Apply**. Render provisions the DB, then builds & deploys the API.
   > If Apply errors on the free database (some accounts restrict free DBs in blueprints),
   > create the Postgres manually via Option B below and just point both backend services at it.

**Option B — Manual (if you prefer clicking):**

- **Postgres:** New + → PostgreSQL → Free plan → Create. Copy the **Internal Database URL**.
- **Web service:** New + → Web Service → connect repo → Root Directory: `backend` → Runtime: Node → Build: `npm install` → Start: `npm start`. Free plan.
- **Worker service:** New + → Background Worker → connect repo → Root Directory: `backend` → Runtime: Node → Build: `npm install` → Start: `npm run start:worker`.
- Add the env vars from the tables below (including `DATABASE_URL` from the DB you just created).

### Env vars to set on the web service

| Variable | Value | Required? |
|---|---|---|
| `DATABASE_URL` | auto-wired by blueprint (else paste Internal DB URL) | ✅ |
| `NODE_VERSION` | `22.14.0` (set by blueprint) | ✅ |
| `AUTOPILOT_DISABLE_SCHEDULER` | `1` | ✅ |
| `CORS_ORIGIN` | your Vercel URL, e.g. `https://ecommerce-ops-autopilot.vercel.app` | ✅ for UI |
| `ADMIN_PANEL_URL` | same Vercel URL (used in email "View in Dashboard" link) | optional |
| `GEMINI_API_KEY` | your Google AI Studio key — without it descriptions are **mock** text | recommended |
| `GEMINI_MODEL_NAME` | e.g. `gemini-2.5-flash` | optional |
| `SHOPIFY_SHOP_NAME` | e.g. `your-store.myshopify.com` | for live sync |
| `SHOPIFY_ACCESS_TOKEN` | Shopify Admin API token | for live sync |
| `SHOPIFY_API_VERSION` | `2024-04` (set by blueprint) | optional |
| `MAILTRAP_HOST/PORT/USERNAME/PASSWORD` | Mailtrap SMTP creds — without them emails are mock/console only | optional |
| `MAILTRAP_FROM_EMAIL` / `MAILTRAP_FROM_NAME` | sender identity | optional |
| `ADMIN_EMAIL` | recipient for low-stock alerts | optional |
| `SAFETY_BUFFER_PERCENT` | over-order guard buffer, default `100` | optional |

### Env vars to set on the worker service

| Variable | Value | Required? |
|---|---|---|
| `DATABASE_URL` | auto-wired by blueprint (else paste Internal DB URL) | ✅ |
| `NODE_VERSION` | `22.14.0` (set by blueprint) | ✅ |
| `AUTOPILOT_SCHEDULER_ONLY` | `1` | ✅ |
| `GEMINI_API_KEY` | same as web service | recommended |
| `GEMINI_MODEL_NAME` | same as web service | optional |
| `SHOPIFY_SHOP_NAME` | same as web service | for live sync |
| `SHOPIFY_ACCESS_TOKEN` | same as web service | for live sync |
| `SHOPIFY_API_VERSION` | `2024-04` | optional |
| `MAILTRAP_HOST/PORT/USERNAME/PASSWORD` | same as web service | optional |
| `MAILTRAP_FROM_EMAIL` / `MAILTRAP_FROM_NAME` | same as web service | optional |
| `ADMIN_EMAIL` | same as web service | optional |
| `SAFETY_BUFFER_PERCENT` | same as web service | optional |

> `SHOPIFY_SYNC_ENABLED=false` disables scheduled Shopify syncs if you don't want them.

### Keep the free web service awake (important!)

Render's **free web service spins down after ~15 min of no traffic** — and the in-process cron
scheduler only fires while the process is alive. Since we chose the "scheduler in-process"
architecture, add a free uptime monitor to ping the health endpoint every ~5 minutes:

- **[UptimeRobot](https://uptimerobot.com)** (free): add a monitor → type **HTTPS** →
  URL `https://<your-api>.onrender.com/actuator/health` → interval **5 minutes** → Create.
- or **[cron-job.org](https://cron-job.org)** (free): create a job hitting the same URL every 5 min.

That single ping keeps the service warm 24/7, so all 6 cron jobs run on schedule.

---

## 2. Deploy the frontend to Vercel

1. Go to [vercel.com/new](https://vercel.com/new) → import the `AashayChhajed/Ecommerce-Ops-Autopilot` repo.
2. Vercel auto-detects Next.js. Set **Root Directory** to `frontend`.
3. Add one env var **before** building:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_API_BASE_URL` | `https://<your-api>.onrender.com` (no trailing slash) |

   This is baked in at build time, so it must exist before the first deploy.
4. **Deploy.** The dashboard will be live at `https://<app>.vercel.app`.

> No `vercel.json` is needed — Next.js is auto-detected and the frontend makes all API
> calls client-side (no serverless API routes to configure).

---

## 3. Post-deploy verification

1. **Backend health:** open `https://<your-api>.onrender.com/actuator/health` → expect `{"status":"UP",...}`.
2. **CORS:** load the Vercel URL — the dashboard should show real data (not error banners).
   If you see CORS errors, fix `CORS_ORIGIN` on Render (must match the Vercel origin exactly, no trailing slash).
3. **Sync:** click **Shopify** or **Sync All** on the dashboard — products + orders should populate.
4. **Scheduler:** open the **Scheduler** page — jobs (`ShopifySyncJob`, `InventoryAuditJob`, …)
   should show runs within the hour.
5. **Images:** product thumbnails appear once Shopify sync stores `image_url` (existing rows get
   images on the next sync).

---

## 4. Cost & free-tier limits to keep in mind

| Service | Free tier | Caveats |
|---|---|---|
| **Render web service** | 750 instance-hrs/mo | Spins down after 15 min idle → keep-alive ping needed; ephemeral disk (fine — data lives in Postgres) |
| **Render Postgres (free)** | 1 GB, auto-expires **after 30 days** | Plan to migrate to a paid DB or Neon before expiry; `render.yaml` makes the swap a one-env-var change |
| **Vercel Hobby** | 100 GB-hrs, 1M funcs/mo | Plenty for a client-side dashboard |
| **Gemini API** | 10–15 RPM free | Description generation batches are throttled (15s between requests) and pause on 429s |

---

## 5. Troubleshooting

- **Backend shows DOWN on the dashboard** → `DATABASE_URL` wrong, or the DB hasn't finished provisioning. Check Render web service logs.
- **CORS error in the browser** → `CORS_ORIGIN` on Render doesn't exactly match the Vercel origin.
- **Scheduler page is empty** → worker logs show an error, or the worker env vars differ from the web service env vars.
- **Descriptions are generic boilerplate** → `GEMINI_API_KEY` isn't set; it's running in mock mode.
- **Emails aren't arriving** → `MAILTRAP_*` creds missing; check the email-test page (`mock: true`).
- **Deploy fails on Node version** → set `NODE_VERSION` env var to `22.14.0` on Render.

### Migration note (free DB expiry)

When the free Postgres expires (30 days), create a new DB (e.g. Neon free tier — the backend's
`DATABASE_URL` + TLS handling works with it unchanged), run a `pg_dump`/`pg_restore` or re-sync
from Shopify, and update `DATABASE_URL` on Render. No code changes required.
