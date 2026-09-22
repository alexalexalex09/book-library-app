-- Signup history + admin notification prefs (service-role only)
-- Safe to re-run.

create table if not exists public.admin_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.admin_settings enable row level security;
revoke all on public.admin_settings from anon, authenticated;
grant select, insert, update on public.admin_settings to service_role;

create table if not exists public.signup_events (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text,
  provider text,
  created_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  immediate_notified_at timestamptz,
  digest_notified_at timestamptz
);

create index if not exists signup_events_created_at_idx
  on public.signup_events (created_at desc);

alter table public.signup_events enable row level security;
revoke all on public.signup_events from anon, authenticated;
grant select, insert, update on public.signup_events to service_role;

insert into public.admin_settings (key, value)
values ('signup_notify_mode', '{"mode":"immediate"}'::jsonb)
on conflict (key) do nothing;
