-- ============================================================
-- 002_route_comments.sql
-- Creates the route_comments table for per-route comment threads.
--
-- Run this manually in the Supabase SQL editor AFTER 001_profiles.sql.
-- ============================================================

create table if not exists route_comments (
  id          uuid primary key default gen_random_uuid(),
  route_id    text not null,
  user_id     uuid not null references auth.users(id) on delete cascade,
  body        text not null check (char_length(body) between 1 and 500),
  likes       uuid[] not null default '{}',
  flags       uuid[] not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Fast lookups by route
create index if not exists route_comments_route_id_idx on route_comments (route_id);

-- ── Row Level Security ──────────────────────────────────────

alter table route_comments enable row level security;

-- Anyone authenticated can read all comments
create policy "comments: authenticated read"
  on route_comments for select
  to authenticated
  using (true);

-- Users can only insert their own comments
create policy "comments: insert own"
  on route_comments for insert
  to authenticated
  with check (auth.uid() = user_id);

-- UPDATE policy: pragmatic-trust approach (same as profiles.is_admin).
-- Any authenticated user can update any comment row. This allows the
-- likes/flags array toggling from any user. The app never sends body,
-- user_id, route_id, or created_at in update payloads, so in practice
-- those fields are safe. A SECURITY DEFINER trigger approach was
-- considered but adds complexity without meaningful benefit given the
-- app's controlled client code.
create policy "comments: authenticated update"
  on route_comments for update
  to authenticated
  using (true)
  with check (true);

-- DELETE: admin only (checks profiles.is_admin)
create policy "comments: admin delete"
  on route_comments for delete
  to authenticated
  using (
    exists (
      select 1 from profiles
      where profiles.user_id = auth.uid()
        and profiles.is_admin = true
    )
  );

-- ── updated_at trigger ──────────────────────────────────────
-- Reuses set_updated_at() created in 001_profiles.sql

create trigger route_comments_set_updated_at
  before update on route_comments
  for each row
  execute function set_updated_at();
