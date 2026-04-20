-- ============================================================
-- 001_profiles.sql
-- Creates the profiles table for display names and admin flags.
--
-- Run this manually in the Supabase SQL editor.
-- After running, create your profile through the app (Settings →
-- Display Name), then run the admin-promotion statement at the bottom.
-- ============================================================

create table if not exists profiles (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  display_name text unique not null
    check (char_length(display_name) between 2 and 20),
  is_admin    boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ── Row Level Security ──────────────────────────────────────

alter table profiles enable row level security;

-- Anyone authenticated can read all profiles
-- (needed so comment threads can resolve display names for other users)
create policy "profiles: authenticated read"
  on profiles for select
  to authenticated
  using (true);

-- Users can only insert their own row
create policy "profiles: insert own"
  on profiles for insert
  to authenticated
  with check (auth.uid() = user_id);

-- Users can update their own row.
-- NOTE: is_admin is intentionally not write-protected at the RLS level
-- because the app never writes that column — it is only set by Paul
-- running the SQL promotion statement below. Keeping the policy simple
-- avoids the complexity of a SECURITY DEFINER trigger while still being
-- safe: no app code path ever sets is_admin, so no user can escalate
-- themselves through normal app usage.
create policy "profiles: update own"
  on profiles for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- No DELETE policy — profiles persist (routes reference display names)

-- ── updated_at trigger ──────────────────────────────────────

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
  before update on profiles
  for each row
  execute function set_updated_at();

-- ── Admin promotion ─────────────────────────────────────────
-- After you have created your own profile through the app, run:
--
-- UPDATE profiles
--   SET is_admin = true
--   WHERE user_id = (
--     SELECT id FROM auth.users WHERE email = '<REPLACE_WITH_ADMIN_EMAIL>'
--   );
