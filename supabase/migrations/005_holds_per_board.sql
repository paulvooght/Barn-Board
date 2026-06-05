-- ============================================================
-- 005_holds_per_board.sql  —  Multi-wall Phase 2b-ii (holds & image per wall)
--
-- Moves The Barn's hold set, board image, and boardRegion OUT of the global
-- singletons and INTO per-board keys, so each wall owns its own holds/image.
--
--   board_settings['custom_holds']          → board_settings['holds_<barnId>']
--   board_settings['board_image_config']    → board_settings['board_image_config_<barnId>']
--   holds.json.boardRegion                  → boards.specs.boardRegion
--
-- WHY THIS IS A SAFE VERBATIM COPY (hold IDs preserved exactly):
--   The live effective hold set the app renders is
--     allHolds = [...holds.json.holds.filter(not hidden), ...custom_holds]
--   Every one of the 55 base holds in holds.json is currently hidden via
--   board_settings['hold_overrides'] (hidden:true), so the base layer contributes
--   ZERO holds. The effective set is therefore EXACTLY custom_holds (186 holds).
--   scripts/migrate_holds_to_board.mjs (dry-run) verifies this precondition and
--   that all 275 hold references across the 25 routes resolve — re-run it before
--   running this if the data may have changed.
--
-- ADDITIVE & NON-DESTRUCTIVE: only inserts NEW keys + augments boards.specs. It
-- never touches custom_holds / hold_overrides / board_image_config, so the old
-- global singletons remain as an instant revert path. Idempotent (ON CONFLICT).
--
-- Run in the Supabase SQL editor AFTER taking a backup
-- (node --env-file=.env.local scripts/backup_tables.mjs pre-2b-ii).
-- Equivalent to running:  node --env-file=.env.local scripts/migrate_holds_to_board.mjs --commit
-- ============================================================

do $$
declare
  barn_id      uuid;
  customs_data jsonb;
  image_data   jsonb;
begin
  select id into barn_id from boards where slug = 'the-barn';
  if barn_id is null then
    raise exception 'The Barn board (slug=the-barn) not found — run 004 first';
  end if;

  select data into customs_data from board_settings where key = 'custom_holds';
  if customs_data is null then
    raise exception 'board_settings[custom_holds] missing — nothing to migrate';
  end if;

  select data into image_data from board_settings where key = 'board_image_config';
  -- image_data may legitimately be null (no custom image published yet); that's fine.

  -- 1) Per-board hold set = the live custom_holds blob (== effective allHolds,
  --    since all base holds are hidden). IDs preserved verbatim.
  insert into board_settings (key, data, updated_at)
  values ('holds_' || barn_id, customs_data, now())
  on conflict (key) do update set data = excluded.data, updated_at = now();

  -- 2) Per-board image config = the live global image config (if any).
  if image_data is not null then
    insert into board_settings (key, data, updated_at)
    values ('board_image_config_' || barn_id, image_data, now())
    on conflict (key) do update set data = excluded.data, updated_at = now();
  end if;

  -- 3) boardRegion into boards.specs (single source of truth for the board area
  --    inside the photo; value lifted from src/data/holds.json, unchanged).
  update boards
  set specs = coalesce(specs, '{}'::jsonb)
              || '{"boardRegion": {"left": 1.0, "top": 0.5, "width": 98.0, "height": 97.0}}'::jsonb,
      updated_at = now()
  where id = barn_id;

  raise notice 'Migrated The Barn (%) — holds_% seeded from custom_holds; image config + boardRegion set.', barn_id, barn_id;
end $$;
