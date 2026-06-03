-- ============================================================
-- 000_core_tables.sql  —  BACKFILL MIGRATION (verified mirror of prod)
--
-- Captures the tables that were originally created directly in the
-- Supabase dashboard and never recorded as migrations:
--   routes, sessions, board_settings, user_route_data, shared_playlists
--
-- Numbered 000 so a from-scratch rebuild creates these BEFORE
-- 003_user_route_data_angle_states.sql ALTERs user_route_data.
-- Run order: 000 → 001 → 002 → 003.
--
-- VERIFIED against the live database on 2026-06-03 (scripts/dump_schema.sql):
-- column types/defaults/nullability AND RLS policies below mirror production
-- exactly (same policy names, roles, USING / WITH CHECK expressions).
--
-- Notes about prod that this file faithfully reproduces:
--  • NO foreign-key constraints exist (referential integrity is app-managed).
--  • NO user_id indexes on routes/sessions (only the PK indexes exist).
--  • routes "admin can edit/delete any route" is gated to a HARDCODED EMAIL
--    in RLS (paul@thisisyonder.com) — NOT profiles.is_admin. This is a
--    single-admin model that multi-wall will need to replace with per-board
--    roles. (Comments, by contrast, use profiles.is_admin — see 002.)
--  • board_settings is writable by ANY authenticated user (hold data is only
--    protected by the client-side isAdmin gate). Tighten before a public wall.
--
-- Safe to run against prod: tables use IF NOT EXISTS (no-op if present);
-- policies use DROP POLICY IF EXISTS + CREATE with the exact prod names, so
-- re-running re-asserts the identical policy (idempotent mirror).
-- ============================================================

-- ─── routes (shared; everyone reads, creator or admin writes) ──────────
create table if not exists routes (
  id          text primary key,
  user_id     uuid not null,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- ─── sessions (private per user) ───────────────────────────────────────
create table if not exists sessions (
  id          text primary key,
  user_id     uuid not null,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- ─── board_settings (shared keyed JSON: holds, image config, playlists) ─
create table if not exists board_settings (
  key         text primary key,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz default now()
);

-- ─── user_route_data (one row per user per route) ──────────────────────
-- angle_sends is jsonb (legacy); angle_flashes / angle_attempts are int[]
-- (added by 003). This asymmetry is real in prod and preserved here.
create table if not exists user_route_data (
  user_id            uuid not null,
  route_id           text not null,
  sent               boolean     default false,
  flashed            boolean     default false,
  attempted          boolean     default false,
  rating             integer     default 0,
  angle_sends        jsonb       default '[]'::jsonb,
  angle_flashes      integer[]   default '{}'::integer[],
  angle_attempts     integer[]   default '{}'::integer[],
  grade_suggestions  jsonb       default '{}'::jsonb,
  updated_at         timestamptz default now(),
  primary key (user_id, route_id)
);

-- ─── shared_playlists (public, subscribable) ───────────────────────────
create table if not exists shared_playlists (
  id            text primary key,
  user_id       uuid not null,
  name          text not null,
  creator_name  text not null default ''::text,
  route_ids     jsonb not null default '[]'::jsonb,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- ════════════════════════════════════════════════════════════
-- RLS — verified mirror of production (2026-06-03)
-- ════════════════════════════════════════════════════════════
alter table routes            enable row level security;
alter table sessions          enable row level security;
alter table board_settings    enable row level security;
alter table user_route_data   enable row level security;
alter table shared_playlists  enable row level security;

-- routes: everyone reads; creator writes own; a hardcoded admin email may
-- update/delete any route.
drop policy if exists "Anyone can read routes" on routes;
create policy "Anyone can read routes" on routes for select using (true);
drop policy if exists "Users can insert own routes" on routes;
create policy "Users can insert own routes" on routes for insert with check (auth.uid() = user_id);
drop policy if exists "Users can update own routes" on routes;
create policy "Users can update own routes" on routes for update using (auth.uid() = user_id);
drop policy if exists "Users can delete own routes" on routes;
create policy "Users can delete own routes" on routes for delete using (auth.uid() = user_id);
drop policy if exists "Admin can update any route" on routes;
create policy "Admin can update any route" on routes for update using ((auth.jwt() ->> 'email') = 'paul@thisisyonder.com');
drop policy if exists "Admin can delete any route" on routes;
create policy "Admin can delete any route" on routes for delete using ((auth.jwt() ->> 'email') = 'paul@thisisyonder.com');

-- sessions: fully private to the owner.
drop policy if exists "Users manage own sessions" on sessions;
create policy "Users manage own sessions" on sessions for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- board_settings: any authenticated user can read AND write (pragmatic trust).
drop policy if exists "Authenticated users read board settings" on board_settings;
create policy "Authenticated users read board settings" on board_settings for select to authenticated using (true);
drop policy if exists "Authenticated users write board settings" on board_settings;
create policy "Authenticated users write board settings" on board_settings for all to authenticated using (true) with check (true);

-- user_route_data: everyone reads (community ratings/grades); owner writes own.
drop policy if exists "Anyone can read ratings" on user_route_data;
create policy "Anyone can read ratings" on user_route_data for select using (true);
drop policy if exists "Users manage own route data" on user_route_data;
create policy "Users manage own route data" on user_route_data for all using (auth.uid() = user_id);

-- shared_playlists: everyone browses; owner writes own.
drop policy if exists "Anyone can read shared playlists" on shared_playlists;
create policy "Anyone can read shared playlists" on shared_playlists for select using (true);
drop policy if exists "Users manage own shared playlists" on shared_playlists;
create policy "Users manage own shared playlists" on shared_playlists for insert with check (auth.uid() = user_id);
drop policy if exists "Users update own shared playlists" on shared_playlists;
create policy "Users update own shared playlists" on shared_playlists for update using (auth.uid() = user_id);
drop policy if exists "Users delete own shared playlists" on shared_playlists;
create policy "Users delete own shared playlists" on shared_playlists for delete using (auth.uid() = user_id);
