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

## Deploy sequence

1. Apply SQL audit migration; set `ADMIN_EMAILS` + `CORS_ORIGINS` on the API service; bootstrap `app_metadata.role`.
2. Deploy API, then the admin static site + DNS.
3. Smoke-test: admin login succeeds; a normal user sees “Access denied”.
4. If any secret was ever pasted into `admin/src`, rotate it.

## API surface (v1)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/admin/me` | Session gate |
| `GET` | `/api/admin/users?q=` | Email/UUID search |
| `GET` | `/api/admin/users/:id` | Safe projection |
| `POST` | `/api/admin/users/:id/sync-billing` | Stripe retrieve → Auth metadata |

Out of scope for v1: manual plan grants, bans, deletes, refunds, impersonation, Google OAuth on admin.
