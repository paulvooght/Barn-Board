-- ============================================================
-- 000_core_tables.sql  —  BACKFILL MIGRATION
--
-- Captures the tables that were originally created directly in the
-- Supabase dashboard and never recorded as migrations:
--   routes, sessions, board_settings, user_route_data, shared_playlists
--
-- Numbered 000 so a from-scratch rebuild creates these BEFORE
-- 003_user_route_data_angle_states.sql ALTERs user_route_data.
-- Run order: 000 → 001 → 002 → 003.
--
-- ── What's exact vs reconstructed ───────────────────────────
-- TABLE STRUCTURES (columns, types, primary keys) were read from the
--   LIVE database on 2026-06-03 via the PostgREST OpenAPI schema. They
--   match production.
-- COLUMN DEFAULTS are sensible values for a fresh rebuild; OpenAPI does
--   not reliably expose live defaults, so confirm with scripts/dump_schema.sql
--   if you need byte-for-byte parity (only matters for new rows on a
--   fresh project — existing prod rows are unaffected).
-- RLS POLICIES are RECONSTRUCTED from how src/App.jsx queries each table.
--   They express the app's INTENDED access rules but were NOT read from
--   the live DB. Verify against production with scripts/dump_schema.sql.
--
-- ── Safety ──────────────────────────────────────────────────
-- All CREATEs use IF NOT EXISTS, so running this against the existing
-- production DB will NOT alter table structures (it is a no-op there).
-- The RLS section uses DROP POLICY IF EXISTS + CREATE, which WOULD
-- replace live policies — only apply it to production after confirming
-- the policies below match the dump. Treat this file primarily as the
-- rebuild/record-of-truth for a fresh environment.
-- ============================================================

-- ─── routes (shared; everyone sees all, creator edits) ──────
create table if not exists routes (
  id          text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  data        jsonb not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists routes_user_id_idx on routes (user_id);

-- ─── sessions (private per user) ────────────────────────────
create table if not exists sessions (
  id          text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  data        jsonb not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists sessions_user_id_idx on sessions (user_id);

-- ─── board_settings (shared board config; keyed JSON blobs) ──
-- keys in use: hold_overrides, custom_holds, board_image_config, playlists_<userId>
create table if not exists board_settings (
  key         text primary key,
  data        jsonb not null,
  updated_at  timestamptz not null default now()
);

-- ─── user_route_data (one row per user per route) ───────────
-- NOTE: angle_sends is jsonb (legacy) while angle_flashes / angle_attempts
-- are integer[] (added later by 003). This asymmetry exists in production;
-- the app treats all three as arrays. Preserved here to match live.
create table if not exists user_route_data (
  user_id            uuid not null references auth.users(id) on delete cascade,
  route_id           text not null,
  sent               boolean   default false,
  flashed            boolean   default false,
  attempted          boolean   default false,
  rating             integer   default 0,
  angle_sends        jsonb     default '[]'::jsonb,
  angle_flashes      integer[] default '{}'::integer[],
  angle_attempts     integer[] default '{}'::integer[],
  grade_suggestions  jsonb     default '{}'::jsonb,
  updated_at         timestamptz not null default now(),
  primary key (user_id, route_id)
);

-- ─── shared_playlists (public playlists others can subscribe to) ──
create table if not exists shared_playlists (
  id            text primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  name          text not null,
  creator_name  text not null default '',
  route_ids     jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ════════════════════════════════════════════════════════════
-- RLS — RECONSTRUCTED from app behaviour. VERIFY before applying to prod.
-- ════════════════════════════════════════════════════════════
alter table routes            enable row level security;
alter table sessions          enable row level security;
alter table board_settings    enable row level security;
alter table user_route_data   enable row level security;
alter table shared_playlists  enable row level security;

-- routes: everyone reads all (community); only the creator writes.
drop policy if exists "routes: read all"   on routes;
create policy "routes: read all"   on routes for select to authenticated using (true);
drop policy if exists "routes: insert own" on routes;
create policy "routes: insert own" on routes for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "routes: update own" on routes;
create policy "routes: update own" on routes for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "routes: delete own" on routes;
create policy "routes: delete own" on routes for delete to authenticated using (auth.uid() = user_id);

-- sessions: fully private to the owner.
drop policy if exists "sessions: own" on sessions;
create policy "sessions: own" on sessions for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- user_route_data: everyone reads all (community ratings + grade consensus);
-- owner writes their own row.
drop policy if exists "urd: read all"   on user_route_data;
create policy "urd: read all"   on user_route_data for select to authenticated using (true);
drop policy if exists "urd: insert own" on user_route_data;
create policy "urd: insert own" on user_route_data for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "urd: update own" on user_route_data;
create policy "urd: update own" on user_route_data for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "urd: delete own" on user_route_data;
create policy "urd: delete own" on user_route_data for delete to authenticated using (auth.uid() = user_id);

-- board_settings: shared board config. Pragmatic trust — any authenticated
-- user can read/write (hold data is admin-curated in practice; playlists_<id>
-- keys are namespaced per user). MUST be tightened for multi-wall.
drop policy if exists "board_settings: all authenticated" on board_settings;
create policy "board_settings: all authenticated" on board_settings for all to authenticated using (true) with check (true);

-- shared_playlists: everyone browses; owner writes.
drop policy if exists "shared_pl: read all"   on shared_playlists;
create policy "shared_pl: read all"   on shared_playlists for select to authenticated using (true);
drop policy if exists "shared_pl: insert own" on shared_playlists;
create policy "shared_pl: insert own" on shared_playlists for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "shared_pl: update own" on shared_playlists;
create policy "shared_pl: update own" on shared_playlists for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "shared_pl: delete own" on shared_playlists;
create policy "shared_pl: delete own" on shared_playlists for delete to authenticated using (auth.uid() = user_id);
