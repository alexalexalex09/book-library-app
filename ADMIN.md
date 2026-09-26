# Admin console (admin.shelfmapper.com)

Hardened operator UI for looking up users and re-syncing Stripe billing metadata.
Hosted as a **Render Static Site**; API stays on the main Express service.

## Security model

Admin access requires **both**:

1. Supabase Auth `app_metadata.role === "admin"` (never `user_metadata`)
2. Email listed in server env `ADMIN_EMAILS` (comma-separated, case-insensitive)

Additional controls:

- Exact CORS allowlist via `CORS_ORIGINS`
- Mutating `/api/admin/*` requires `Origin` in `ADMIN_ORIGINS` (defaults to `admin.*` entries from CORS)
- Strict rate limit on `/api/admin` (default **300 / 15 min** per user; override with `ADMIN_RATE_LIMIT`)
- Append-only `admin_audit_log` (service role only; no client RLS policies)
- User projections strip unexpected `app_metadata` fields
- Search requires `q` ≥ 3 characters; capped result page (no full dump)
- Static site: `robots.txt` disallow-all, CSP/`_headers`, no signup UI

## Server env (Render web service)

| Variable | Purpose |
|---|---|
| `ADMIN_EMAILS` | Allowlisted admin emails (required for any admin access) |
| `ADMIN_RATE_LIMIT` | Max `/api/admin` requests per 15 minutes per admin (default `300`) |
| `CORS_ORIGINS` | Exact origins, e.g. `https://shelfmapper.com,https://admin.shelfmapper.com` |
| `ADMIN_ORIGINS` | Optional override for mutating admin Origin checks (defaults to admin hosts) |
| Existing | `SUPABASE_*` service role, `STRIPE_SECRET_KEY`, `APP_BASE_URL` |

Legacy `CORS_ORIGIN` (singular) is still read if `CORS_ORIGINS` is unset.

## Bootstrap an admin user

1. Create/sign in as the operator account in Supabase Auth (email/password).
2. In Supabase Dashboard → Authentication → Users → user → **App metadata**, set:

```json
{ "role": "admin" }
```

Keep any existing billing keys (`plan`, `stripe_*`) intact.

3. Set `ADMIN_EMAILS` on the API service to that exact email and redeploy.

There is **no** public path to become admin.

## Database

Run these in the Supabase SQL editor (also included in `schema.sql` / `migrate.sql`):

- [`server/sql/admin_audit_log.sql`](server/sql/admin_audit_log.sql)
- [`server/sql/signup_notifications.sql`](server/sql/signup_notifications.sql)
- [`server/sql/support_tickets.sql`](server/sql/support_tickets.sql)
- [`server/sql/admin_analytics.sql`](server/sql/admin_analytics.sql)

Applied via MCP to Dev (`wqxvahmiblqgsjyywxpa`) and App (`cyrdpxukqtruheigcdps`).

## Signup / support email notifications

Admin console shows **Recent signups**, **Support queue**, **Overview** analytics, and **Audit**.

Notification modes (persisted in `admin_settings`):

| Mode | Signup | Support |
|---|---|---|
| `off` | No signup emails | No support emails |
| `immediate` | Email on signup ack (first session within 48h) | Email on ticket create / user reply |
| `daily` | Signup digest via cron | Included in ops digest |

Outbound notification email is disabled. Signup history and the support queue stay in this console.

| Variable | Purpose |
|---|---|
| `CRON_SECRET` | Protects internal digest endpoints |
| `GEMINI_API_KEY` | Optional; AI suggested replies on support tickets |

Cron jobs (header `x-cron-secret: $CRON_SECRET`):

- `POST /api/internal/signups/digest` — signup-only daily summary
- `POST /api/internal/ops/digest` — combined ops digest (open tickets + signup digest when modes are `daily`; optional OCR error spike line)

Prefer **ops digest** once per day when using support notifications.

## Admin config

[`admin/src/config.json`](admin/src/config.json) (public values only — **never** put the service role key here):

```json
{
  "apiOrigin": "https://shelfmapper.com",
  "supabaseUrl": "https://YOUR_PROJECT.supabase.co",
  "supabaseAnonKey": "YOUR_PUBLISHABLE_ANON_KEY"
}
```

For local API against `http://127.0.0.1:3000`, point `apiOrigin` there and ensure `NODE_ENV` is not `production` (dev localhost origins are added automatically).

## Supabase Auth URL allowlist

Authentication → URL configuration — add:

- `https://admin.shelfmapper.com`
- Site URL can remain the main app; admin only needs the redirect/allowlist entry for the host.

## DNS / Render

1. Create a Render **Static Site** with publish directory `admin/src` (no build command).
2. Attach custom domain `admin.shelfmapper.com` and wait for TLS.
3. DNS: `admin` CNAME → the Render static hostname.
4. Confirm `_headers` is deployed (Render Static serves them from the publish root).

## Go-live status

| Step | Status |
|---|---|
| Admin API on `shelfmapper.com` | Live (`/api/admin/me` returns 401 without auth) |
| Audit SQL | Applied (Dev + App) |
| Support + analytics SQL | Applied (Dev + App) |
| `ADMIN_EMAILS` / `CORS_ORIGINS` / `ADMIN_ORIGINS` | Set — includes `admin.shelfmapper.com` + `shelfmapper-admin.onrender.com` |
| Admin `app_metadata.role` | Set for `frogitts@gmail.com` |
| Render Static Site | Live at [https://shelfmapper-admin.onrender.com](https://shelfmapper-admin.onrender.com) |
| Custom domain `admin.shelfmapper.com` | **Manual** — add in Render + DNS CNAME (Namecheap / registrar-servers.com) |
| Supabase Auth URL allowlist | **Manual** — add `https://admin.shelfmapper.com` and onrender URL |
| Security headers on CDN | CSP via HTML meta shipped; set remaining headers in Dashboard (see `admin/render.yaml`) |
| Ops digest cron | **Manual** — schedule `POST /api/internal/ops/digest` daily |

### Interim URL

Until DNS is attached, use **https://shelfmapper-admin.onrender.com**.  
`CORS_ORIGINS` / `ADMIN_ORIGINS` already include that host.

### Attach custom domain (Dashboard)

1. Open [shelfmapper-admin → Custom Domains](https://dashboard.render.com/static/srv-dap9nsu0tbcc738tg090) → Add `admin.shelfmapper.com`.
2. DNS: CNAME `admin` → `shelfmapper-admin.onrender.com` (or the hostname Render shows).
3. Wait for TLS / Verify in Render.
4. Supabase → Authentication → URL configuration → Redirect URLs / Site allowlist: add `https://admin.shelfmapper.com` and `https://shelfmapper-admin.onrender.com`.
5. Dashboard → Headers: paste the headers from [`admin/render.yaml`](admin/render.yaml) (or Sync Blueprint).

### Smoke test

1. Open the admin URL → sign in as `frogitts@gmail.com` (email/password).
2. Sign out/in once so the JWT includes `role: admin`.
3. Search a user; confirm a non-admin account sees Access denied.
4. Open Overview / Support / Audit panels.

## API surface

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/admin/me` | Session gate |
| `GET` | `/api/admin/users?q=` | Email/UUID search |
| `GET` | `/api/admin/users/:id` | Safe projection + ticket/usage extras |
| `POST` | `/api/admin/users/:id/sync-billing` | Stripe retrieve → Auth metadata |
| `GET` | `/api/admin/signups` | Recent signup history |
| `GET` | `/api/admin/stats/overview` | Product + support + engagement + billing |
| `GET` | `/api/admin/stats/billing` | Stripe subscription mirror (~10 min cache) |
| `GET` | `/api/admin/stats/usage` | OCR/books usage buckets |
| `GET` | `/api/admin/audit` | Recent audit rows |
| `GET/POST` | `/api/admin/support/tickets…` | Queue, detail, update, reply, suggest |
| `GET/POST` | `/api/admin/settings/notifications` | Signup + support notify modes |
| `POST` | `/api/support/tickets` | Public ticket create (optional auth) |
| `GET` | `/api/support/tickets` | Own tickets (auth) |
| `POST` | `/api/signup-ack` | Authenticated; records new signup |
| `POST` | `/api/internal/signups/digest` | Cron signup summary (`CRON_SECRET`) |
| `POST` | `/api/internal/ops/digest` | Cron ops digest (`CRON_SECRET`) |

### Audit action codes

| Code | Meaning |
|---|---|
| `admin.me` | Session gate succeeded (admin role + email allowlist) |
| `admin.users.search` | User search by email/UUID |
| `admin.users.get` | Opened user detail projection |
| `admin.users.sync_billing` | Stripe → Auth billing metadata sync |
| `admin.signups.list` | Loaded recent signup history |
| `admin.settings.notifications` | Changed signup/support notify modes |
| `admin.support.update` | Updated ticket status/priority/fields |
| `admin.support.reply` | Admin reply on a ticket |
| `admin.support.suggest` | Regenerated AI suggested reply (not emailed) |

Public support UI: [`client/src/support.html`](client/src/support.html).

Out of scope: live chat, attachments, auto-sending AI replies, full Stripe Dashboard parity.
