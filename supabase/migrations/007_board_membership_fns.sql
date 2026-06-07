-- ============================================================
-- 007_board_membership_fns.sql  —  Multi-wall Phase 2b-iv
--
-- ADDITIVE & NON-DESTRUCTIVE: adds 5 helper FUNCTIONS only. It does NOT create
-- or alter any table, and does NOT touch a single row of existing data. Safe to
-- re-run (CREATE OR REPLACE). No backfill, no deletes.
--
-- WHY functions (not plain client queries): these actions need to act with
-- elevated privilege under today's RLS and stay correct after the stricter
-- tenant-isolation work (2c):
--   • join a PRIVATE wall you can't yet see (by code)
--   • an ADMIN change SOMEONE ELSE's role (RLS has no such UPDATE policy)
--   • list ALL members of a wall (RLS only lets you read your OWN membership row)
--   • enforce the "a wall must always keep ≥1 admin" rule on the server
-- SECURITY DEFINER runs the function as its owner (bypassing RLS), so each one
-- re-checks permissions INTERNALLY (caller must be a member / an admin) — the
-- privilege is scoped to exactly these vetted operations.
--
-- Run in the Supabase SQL editor (DDL can't go through the service-role REST API).
-- ============================================================

-- ── 1. Join a wall by its code (private walls you can't see in the list) ──────
create or replace function join_board_by_code(p_code text)
returns table (id uuid, name text, slug text, visibility text)
language plpgsql security definer set search_path = public
as $$
declare
  v boards%rowtype;
begin
  if p_code is null or length(trim(p_code)) = 0 then
    raise exception 'A join code is required';
  end if;
  select * into v from boards
   where join_code is not null and lower(join_code) = lower(trim(p_code))
   limit 1;
  if v.id is null then
    raise exception 'No wall found for that code';
  end if;
  insert into board_members (board_id, user_id, role)
  values (v.id, auth.uid(), 'member')
  on conflict (board_id, user_id) do nothing;
  return query select v.id, v.name, v.slug, v.visibility;
end;
$$;

-- ── 2. List a wall's members (any member of that wall may view the roster) ────
create or replace function get_board_members(p_board uuid)
returns table (user_id uuid, role text, display_name text, joined_at timestamptz)
language plpgsql security definer set search_path = public stable
as $$
begin
  -- alias + qualify columns: the OUT params (user_id/role/...) would otherwise be
  -- ambiguous against board_members' columns (Postgres 42702).
  if not exists (select 1 from board_members bm where bm.board_id = p_board and bm.user_id = auth.uid()) then
    raise exception 'Not a member of this wall';
  end if;
  return query
    select bm.user_id, bm.role, coalesce(p.display_name, 'Climber') as display_name, bm.joined_at
      from board_members bm
      left join profiles p on p.user_id = bm.user_id
     where bm.board_id = p_board
     order by (bm.role = 'admin') desc, lower(coalesce(p.display_name, 'zzz'));
end;
$$;

-- ── 3. Promote / demote a member (admin only; never drop below 1 admin) ──────
create or replace function set_member_role(p_board uuid, p_user uuid, p_role text)
returns void language plpgsql security definer set search_path = public
as $$
declare
  v_admins int;
begin
  if p_role not in ('admin','member') then raise exception 'Invalid role'; end if;
  if not exists (select 1 from board_members where board_id = p_board and user_id = auth.uid() and role = 'admin') then
    raise exception 'Only a wall admin can change roles';
  end if;
  if not exists (select 1 from board_members where board_id = p_board and user_id = p_user) then
    raise exception 'That person is not a member of this wall';
  end if;
  if p_role = 'member'
     and exists (select 1 from board_members where board_id = p_board and user_id = p_user and role = 'admin') then
    select count(*) into v_admins from board_members where board_id = p_board and role = 'admin';
    if v_admins <= 1 then raise exception 'A wall must keep at least one admin'; end if;
  end if;
  update board_members set role = p_role where board_id = p_board and user_id = p_user;
end;
$$;

-- ── 4. Leave a wall (can't abandon a wall as its last admin while others remain) ─
create or replace function leave_board(p_board uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare
  v_members int;
  v_admins  int;
begin
  if not exists (select 1 from board_members where board_id = p_board and user_id = auth.uid()) then
    return; -- not a member; nothing to do
  end if;
  select count(*) into v_members from board_members where board_id = p_board;
  select count(*) into v_admins  from board_members where board_id = p_board and role = 'admin';
  if v_members > 1 and v_admins <= 1
     and exists (select 1 from board_members where board_id = p_board and user_id = auth.uid() and role = 'admin') then
    raise exception 'You are the only admin — make someone else an admin before leaving';
  end if;
  delete from board_members where board_id = p_board and user_id = auth.uid();
end;
$$;

-- ── 5. Set a wall public/private (admin only) ───────────────────────────────
create or replace function set_board_visibility(p_board uuid, p_vis text)
returns void language plpgsql security definer set search_path = public
as $$
begin
  if p_vis not in ('public','private') then raise exception 'Invalid visibility'; end if;
  if not exists (select 1 from board_members where board_id = p_board and user_id = auth.uid() and role = 'admin') then
    raise exception 'Only a wall admin can change visibility';
  end if;
  update boards set visibility = p_vis, updated_at = now() where id = p_board;
end;
$$;

-- ── Grants: callable by logged-in users only (each re-checks perms inside) ────
revoke all on function join_board_by_code(text)              from public;
revoke all on function get_board_members(uuid)               from public;
revoke all on function set_member_role(uuid, uuid, text)     from public;
revoke all on function leave_board(uuid)                     from public;
revoke all on function set_board_visibility(uuid, text)      from public;
grant execute on function join_board_by_code(text)           to authenticated;
grant execute on function get_board_members(uuid)            to authenticated;
grant execute on function set_member_role(uuid, uuid, text)  to authenticated;
grant execute on function leave_board(uuid)                  to authenticated;
grant execute on function set_board_visibility(uuid, text)   to authenticated;
