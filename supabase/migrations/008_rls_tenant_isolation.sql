-- ============================================================
-- 008_rls_tenant_isolation.sql  —  Multi-wall Phase 2c   (applied to prod 2026-06-08)
--
-- Replaces the "pragmatic trust" RLS with real per-wall tenant isolation +
-- per-board admin enforcement, server-side. Idempotent (drop + create with
-- exact names; CREATE OR REPLACE fns). Run in the Supabase SQL editor.
-- Verified post-apply by scripts/verify_2c_rls.mjs (22/22 checks, no lockout).
--
-- DEPLOY ORDER (done in this order; matters for lockout safety):
--   1. App changes shipped FIRST (commit 31d78ea — drop auto-join + "no wall yet"
--      onboarding + default isAdmin=false). After this migration a non-member
--      reads NO routes, so the app must already handle a wall-less account.
--   2. Backed up + tagged: scripts/backup_tables.mjs pre-2c; tag v1.8-pre-multiwall-2c.
--   3. Ran THIS file (begin/commit → atomic). Verified member/admin/non-member.
--   4. If it ever needs reverting → run the ROLLBACK block at the bottom.
--
-- Model (decisions 2026-06-08): routes/ratings = MEMBERS-ONLY reads; new accounts
-- DROP auto-join (no default wall — they pick one); board_settings READ stays
-- authenticated (holds/image not sensitive) but WRITE = board admin of the key.
-- Privileged board_members/boards writes keep going through the 007 DEFINER fns.
-- ============================================================

begin;  -- atomic: if any statement errors, NOTHING applies (no half-dropped policies → no partial lockout)

-- ── Helpers: membership / admin checks ───────────────────────────────────────
-- SECURITY DEFINER → bypass board_members RLS inside the check (no recursion);
-- auth.uid() is still the CALLER. STABLE; callable by logged-in users only.
create or replace function app_is_member(p_board uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from board_members
                  where board_id = p_board and user_id = auth.uid());
$$;
create or replace function app_is_admin(p_board uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from board_members
                  where board_id = p_board and user_id = auth.uid() and role = 'admin');
$$;
revoke all on function app_is_member(uuid) from public;
revoke all on function app_is_admin(uuid)  from public;
grant execute on function app_is_member(uuid) to authenticated;
grant execute on function app_is_admin(uuid)  to authenticated;

-- ── boards: PUBLIC or MEMBER can read; owner-manage stays (004) ──────────────
drop policy if exists "boards: authenticated read" on boards;
drop policy if exists "boards: public or member read" on boards;
create policy "boards: public or member read" on boards for select to authenticated
  using (visibility = 'public' or app_is_member(id));
-- keep: "boards: owner manage" (004). Visibility changes via set_board_visibility().

-- ── board_members: read-own stays; self-join PUBLIC walls only; no open leave ─
-- keep: "members: read own" (004). Roster via get_board_members() DEFINER fn.
drop policy if exists "members: join self" on board_members;
create policy "members: join self public" on board_members for insert to authenticated
  with check (user_id = auth.uid()
              and exists (select 1 from boards b
                           where b.id = board_id and b.visibility = 'public'));
-- private joins go through join_board_by_code() (DEFINER, bypasses this check).
drop policy if exists "members: leave self" on board_members;
-- leaving goes through leave_board() (DEFINER; enforces the last-admin guard).
-- role changes: none — set_member_role() DEFINER fn only.

-- ── routes: MEMBERS read; member-insert-own; own update/delete; BOARD ADMIN any ─
drop policy if exists "Anyone can read routes" on routes;
drop policy if exists "Members read board routes" on routes;
create policy "Members read board routes" on routes for select to authenticated
  using (app_is_member(board_id));

drop policy if exists "Users can insert own routes" on routes;
create policy "Users can insert own routes" on routes for insert to authenticated
  with check (auth.uid() = user_id and app_is_member(board_id));
-- keep: "Users can update own routes" / "Users can delete own routes" (000).

drop policy if exists "Admin can update any route" on routes;   -- was hardcoded email
drop policy if exists "Admin can delete any route" on routes;   -- was hardcoded email
drop policy if exists "Board admin can update any route" on routes;
drop policy if exists "Board admin can delete any route" on routes;
create policy "Board admin can update any route" on routes for update to authenticated
  using (app_is_admin(board_id));
create policy "Board admin can delete any route" on routes for delete to authenticated
  using (app_is_admin(board_id));

-- ── user_route_data: read rows for routes on YOUR walls; write own stays ─────
drop policy if exists "Anyone can read ratings" on user_route_data;
drop policy if exists "Members read board route data" on user_route_data;
create policy "Members read board route data" on user_route_data for select to authenticated
  using (exists (select 1 from routes r
                  where r.id = user_route_data.route_id and app_is_member(r.board_id)));
-- keep: "Users manage own route data" (000) for write.

-- ── board_settings: READ stays authenticated; WRITE = board admin of the key ──
-- keys: ANY key ending in a board uuid (holds_<id>, board_image_config_<id>, and
--       orphaned/future per-board keys like sam_embedding_<id>, hold_candidates_<id>)
--       → that board's admin; playlists_<uid> → that user; legacy globals → Barn admin.
--       (playlists_<uid> also ends in a uuid but is granted by the owner branch first;
--        the board-admin branch for it resolves to app_is_admin(<uid>)=false → harmless.)
drop policy if exists "Authenticated users write board settings" on board_settings;
drop policy if exists "Board admin writes board settings" on board_settings;
create policy "Board admin writes board settings" on board_settings for all to authenticated
  using (
        (key = 'playlists_' || auth.uid()::text)
     or (key ~ '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         and app_is_admin(substring(key from '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')::uuid))
     or (key in ('custom_holds','hold_overrides','board_image_config')
         and app_is_admin('1c97fee6-285a-4774-a185-cb5f17e60acf'::uuid))   -- The Barn
  )
  with check (
        (key = 'playlists_' || auth.uid()::text)
     or (key ~ '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         and app_is_admin(substring(key from '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')::uuid))
     or (key in ('custom_holds','hold_overrides','board_image_config')
         and app_is_admin('1c97fee6-285a-4774-a185-cb5f17e60acf'::uuid))
  );
-- keep: "Authenticated users read board settings" (000) — reads stay open.

-- sessions: already owner-private (000 "Users manage own sessions") — unchanged.

commit;

-- ============================================================
-- ROLLBACK (restore the permissive 2a/2b policies). Run if 2c locks anyone out.
-- (All commented out — safe to leave in the file; uncomment + run only to revert.)
-- ============================================================
-- drop policy if exists "boards: public or member read" on boards;
-- create policy "boards: authenticated read" on boards for select to authenticated using (true);
-- drop policy if exists "members: join self public" on board_members;
-- create policy "members: join self" on board_members for insert to authenticated with check (user_id = auth.uid());
-- create policy "members: leave self" on board_members for delete to authenticated using (user_id = auth.uid());
-- drop policy if exists "Members read board routes" on routes;
-- create policy "Anyone can read routes" on routes for select using (true);
-- drop policy if exists "Users can insert own routes" on routes;
-- create policy "Users can insert own routes" on routes for insert with check (auth.uid() = user_id);
-- drop policy if exists "Board admin can update any route" on routes;
-- drop policy if exists "Board admin can delete any route" on routes;
-- create policy "Admin can update any route" on routes for update using ((auth.jwt() ->> 'email') = 'paul@thisisyonder.com');
-- create policy "Admin can delete any route" on routes for delete using ((auth.jwt() ->> 'email') = 'paul@thisisyonder.com');
-- drop policy if exists "Members read board route data" on user_route_data;
-- create policy "Anyone can read ratings" on user_route_data for select using (true);
-- drop policy if exists "Board admin writes board settings" on board_settings;
-- create policy "Authenticated users write board settings" on board_settings for all to authenticated using (true) with check (true);
-- drop function if exists app_is_member(uuid); drop function if exists app_is_admin(uuid);
