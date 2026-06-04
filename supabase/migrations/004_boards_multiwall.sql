-- ============================================================
-- 004_boards_multiwall.sql  —  Multi-wall Phase 2a (plumbing)
--
-- Additive & NON-DESTRUCTIVE. It never edits or deletes existing route/
-- session data — it only adds new tables + a board_id column and backfills it.
-- Safe to re-run (idempotent: IF NOT EXISTS / ON CONFLICT / slug guard).
--
-- After this runs the app still behaves as a single wall ("The Barn"); the
-- switcher, onboarding, per-wall holds and RLS isolation come in 2b/2c.
--
-- Run in the Supabase SQL editor. Confirm a backup / PITR is enabled first.
-- ============================================================

-- ── 1. New tables ───────────────────────────────────────────
create table if not exists boards (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text unique not null,
  visibility  text not null default 'private' check (visibility in ('public','private')),
  join_code   text,
  owner_id    uuid,
  specs       jsonb not null default '{}'::jsonb,   -- size + angle range, per wall
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

create table if not exists board_members (
  board_id  uuid not null,
  user_id   uuid not null,
  role      text not null default 'member' check (role in ('admin','member')),
  joined_at timestamptz default now(),
  primary key (board_id, user_id)
);

-- ── 2. board_id on the per-wall data (nullable; default set in step 3) ──
alter table routes   add column if not exists board_id uuid;
alter table sessions add column if not exists board_id uuid;

-- ── 3. Seed The Barn, backfill existing rows, enrol existing users ──
do $$
declare
  barn_id uuid;
  paul_id uuid;
begin
  select id into paul_id from auth.users where email = 'paul@thisisyonder.com' limit 1;

  select id into barn_id from boards where slug = 'the-barn';
  if barn_id is null then
    insert into boards (name, slug, visibility, owner_id)
    values ('The Barn', 'the-barn', 'private', paul_id)
    returning id into barn_id;
  end if;

  -- assign every existing route/session to The Barn
  update routes   set board_id = barn_id where board_id is null;
  update sessions set board_id = barn_id where board_id is null;

  -- default future inserts to The Barn, so older cached PWA clients (still on
  -- the pre-board_id code) keep landing in the right wall until they update
  execute format('alter table routes   alter column board_id set default %L::uuid', barn_id);
  execute format('alter table sessions alter column board_id set default %L::uuid', barn_id);

  -- enrol anyone who has any data as a Barn member (Paul + profile admins = admin)
  insert into board_members (board_id, user_id, role)
  select barn_id, u,
         case when u = paul_id
                or exists (select 1 from profiles p where p.user_id = u and p.is_admin)
              then 'admin' else 'member' end
  from (
    select user_id from profiles
    union select user_id from routes
    union select user_id from sessions
    union select user_id from user_route_data
  ) ids(u)
  where u is not null
  on conflict (board_id, user_id) do nothing;
end $$;

-- ── 4. RLS for the new tables ───────────────────────────────
-- 2a is deliberately permissive (single wall, everyone is a Barn member).
-- Tightened to true tenant isolation in 2c.
alter table boards         enable row level security;
alter table board_members  enable row level security;

-- boards: any authenticated user can read board metadata (tightened to
-- public-or-member in 2b); the owner can manage their own board.
drop policy if exists "boards: authenticated read" on boards;
create policy "boards: authenticated read" on boards for select to authenticated using (true);

drop policy if exists "boards: owner manage" on boards;
create policy "boards: owner manage" on boards for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- board_members: a user can see, add, and remove their OWN memberships.
-- NOTE: self-insert is open in 2a (single wall). 2b replaces this with a
-- join-code-gated SECURITY DEFINER function so nobody can self-join a private wall.
drop policy if exists "members: read own" on board_members;
create policy "members: read own" on board_members for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "members: join self" on board_members;
create policy "members: join self" on board_members for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists "members: leave self" on board_members;
create policy "members: leave self" on board_members for delete to authenticated
  using (user_id = auth.uid());
