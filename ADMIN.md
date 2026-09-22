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
- Strict rate limit on `/api/admin` (30 / 15 min per user)
- Append-only `admin_audit_log` (service role only; no client RLS policies)
- User projections strip unexpected `app_metadata` fields
- Search requires `q` ≥ 3 characters; capped result page (no full dump)
- Static site: `robots.txt` disallow-all, CSP/`_headers`, no signup UI

## Server env (Render web service)

| Variable | Purpose |
|---|---|
| `ADMIN_EMAILS` | Allowlisted admin emails (required for any admin access) |
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

Run [`server/sql/admin_audit_log.sql`](server/sql/admin_audit_log.sql) in the Supabase SQL editor (also included in `schema.sql` / `migrate.sql`).

## Admin static site config

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
| `ADMIN_EMAILS` / `CORS_ORIGINS` / `ADMIN_ORIGINS` | Set on Render web service |
| Admin `app_metadata.role` | Set for `frogitts@gmail.com` |
| Render Static Site | Live at [https://shelfmapper-admin.onrender.com](https://shelfmapper-admin.onrender.com) |
| Custom domain `admin.shelfmapper.com` | **Manual** — add in Render + DNS CNAME |
| Supabase Auth URL allowlist | **Manual** — add `https://admin.shelfmapper.com` (and onrender URL for interim) |
| Security headers on CDN | **Manual** — Render ignores `_headers`; set in Dashboard → Headers (see `admin/render.yaml`) |

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

## API surface (v1)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/admin/me` | Session gate |
| `GET` | `/api/admin/users?q=` | Email/UUID search |
| `GET` | `/api/admin/users/:id` | Safe projection |
| `POST` | `/api/admin/users/:id/sync-billing` | Stripe retrieve → Auth metadata |

Out of scope for v1: manual plan grants, bans, deletes, refunds, impersonation, Google OAuth on admin.
