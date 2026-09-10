-- ============================================================
-- 010_set_versions.sql  —  RESET process backend (Stage 1 of docs/RESET_PROCESS_SPEC.md)
--
-- Adds the "set version" data model so a wall can be RESET (stripped and
-- re-set) without breaking existing routes: routes built on a retired set are
-- STAMPED with the version they were built on and become "archived" (never
-- deleted); the outgoing hold array is FROZEN under a versioned key so
-- archived routes keep rendering from the holds exactly as they were.
--
-- This migration only adds the data model + the RLS coverage a RESET needs in
-- order to WRITE the frozen snapshot. It does not perform a reset itself —
-- that's scripts/board_reset.mjs (the only sanctioned way to run one; see
-- spec §3.5). Nothing here changes what the app renders today: set_version
-- defaults to 1 for every route, boards.specs.setVersion seeds to 1, and no
-- `holds_<boardId>_v<n>` key exists yet for any wall.
--
-- Idempotent — safe to re-run. Atomic (begin/commit): if any statement
-- errors, nothing applies. Run in the Supabase SQL editor. Take a backup
-- first (non-negotiable per the spec's rule 4):
--   node --env-file=.env.local scripts/backup_tables.mjs pre-010
--
-- ── RLS FINDING (read before relying on this) ─────────────────────────────
-- 008's "Board admin writes board settings" policy grants a board admin write
-- access to a board_settings key by matching a TRAILING uuid:
--   key ~ '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
-- A frozen snapshot key looks like `holds_<boardId>_v2` — it ends in "_v2",
-- NOT the uuid, so under 008 that regex does not match at all and the write
-- falls through to no matching branch → RLS DENIES it for every role except
-- one that bypasses RLS outright (service_role). Confirmed by reading 008's
-- policy text directly; not exercised against a live write, since this
-- migration (which is what would create a matchable key) has not been
-- applied yet — there is nothing to test against until it lands. Verified the
-- regex change itself with an equivalent test in Node (same pattern engine
-- semantics for this pattern — no ARE-specific syntax used, only a plain
-- optional group), see the PR notes.
--
-- Left unfixed, this would NOT block scripts/board_reset.mjs (it authenticates
-- with the service-role key, which bypasses RLS like every other local
-- script), but WOULD silently block any future in-app RESET flow that writes
-- as the signed-in admin's own session. Fixed below by extending the regex to
-- also accept an optional `_v<digits>` suffix after the uuid, and changing the
-- extraction to a capture group so only the uuid portion (never the `_v<n>`
-- suffix) is passed to app_is_admin().
-- ============================================================

begin;

-- ── 1. routes.set_version — a real column (not inside `data`), so it can be
--    filtered and indexed. NOT NULL DEFAULT 1 backfills every existing row to
--    1 as part of the ADD COLUMN itself. ──
alter table routes add column if not exists set_version integer not null default 1;
-- Defensive belt-and-braces backfill (a no-op today — ADD COLUMN ... NOT NULL
-- DEFAULT already backfilled every row — but harmless and idempotent to keep,
-- in case this column is ever altered to be nullable and re-populated later).
update routes set set_version = 1 where set_version is null;

create index if not exists idx_routes_board_set on public.routes (board_id, set_version);

-- ── 2. boards.specs.setVersion — seed to 1 for every existing board, MERGED
--    into specs so boardRegion (and anything else already there) survives.
--    Only touches boards that don't have a setVersion yet, so this is safe to
--    re-run even after a real reset has advanced someone's version. ──
update boards
set specs = coalesce(specs, '{}'::jsonb) || jsonb_build_object('setVersion', 1),
    updated_at = now()
where specs ->> 'setVersion' is null;

-- ── 3. board_settings RLS: admin-write must also cover the frozen `_v<n>`
--    key (see the RLS FINDING above). Same shape as 008's policy — only the
--    middle branch's regex/extraction changed. playlists_ and the legacy
--    global-key branch are untouched. ──
drop policy if exists "Board admin writes board settings" on board_settings;
create policy "Board admin writes board settings" on board_settings for all to authenticated
  using (
        (key = 'playlists_' || auth.uid()::text)
     or (key ~ '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(_v[0-9]+)?$'
         and app_is_admin(substring(key from '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(_v[0-9]+)?$')::uuid))
     or (key in ('custom_holds','hold_overrides','board_image_config')
         and app_is_admin('1c97fee6-285a-4774-a185-cb5f17e60acf'::uuid))   -- The Barn
  )
  with check (
        (key = 'playlists_' || auth.uid()::text)
     or (key ~ '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(_v[0-9]+)?$'
         and app_is_admin(substring(key from '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(_v[0-9]+)?$')::uuid))
     or (key in ('custom_holds','hold_overrides','board_image_config')
         and app_is_admin('1c97fee6-285a-4774-a185-cb5f17e60acf'::uuid))
  );
-- keep: "Authenticated users read board settings" (000) — reads stay open, unchanged.

commit;

-- ============================================================
-- Verify:
--   select column_name, data_type, column_default, is_nullable
--     from information_schema.columns where table_name='routes' and column_name='set_version';
--   select indexname from pg_indexes where tablename='routes' and indexname='idx_routes_board_set';
--   select slug, specs->'setVersion' as set_version from boards;
--   select polname, pg_get_expr(polqual, polrelid) from pg_policy
--     where polrelid = 'board_settings'::regclass and polname = 'Board admin writes board settings';
-- ============================================================

-- ============================================================
-- ROLLBACK — revert to 008's board_settings policy (no `_v<n>` coverage).
-- Does NOT drop routes.set_version, idx_routes_board_set, or
-- boards.specs.setVersion: they're purely additive and nothing reads them
-- until scripts/board_reset.mjs (or a future in-app RESET flow) runs, so
-- leaving them in place after a policy rollback is harmless. Uncomment and
-- run only if this migration needs to be reverted.
-- ============================================================
-- begin;
-- drop policy if exists "Board admin writes board settings" on board_settings;
-- create policy "Board admin writes board settings" on board_settings for all to authenticated
--   using (
--         (key = 'playlists_' || auth.uid()::text)
--      or (key ~ '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
--          and app_is_admin(substring(key from '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')::uuid))
--      or (key in ('custom_holds','hold_overrides','board_image_config')
--          and app_is_admin('1c97fee6-285a-4774-a185-cb5f17e60acf'::uuid))
--   )
--   with check (
--         (key = 'playlists_' || auth.uid()::text)
--      or (key ~ '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
--          and app_is_admin(substring(key from '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')::uuid))
--      or (key in ('custom_holds','hold_overrides','board_image_config')
--          and app_is_admin('1c97fee6-285a-4774-a185-cb5f17e60acf'::uuid))
--   );
-- commit;
