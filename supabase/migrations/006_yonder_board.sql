-- 006_yonder_board.sql — Multi-wall Phase 2b-iii: stand up Yonder (the first
-- real second wall). Public, no join code. Owner/admin: Paul. claude-test is
-- added as a member so dev-autologin can verify the wall switch + a test route.
--
-- Idempotent (ON CONFLICT guards → safe to re-run). This file creates ONLY the
-- wall identity + membership. The wall's DATA — holds (board_settings
-- holds_<id>), image config (board_image_config_<id>), and specs.boardRegion —
-- is seeded separately AFTER this row exists (so its id can be resolved):
--     python3 scripts/publish_board_image.py Yonder_Set_01_V1 --board yonder
--     node --env-file=.env.local scripts/seed_yonder_holds.mjs --commit
--
-- Touches NO existing data (The Barn, routes, sessions all untouched).

-- ── 1. The Yonder wall ───────────────────────────────────────────────────────
insert into boards (name, slug, visibility, join_code, owner_id, specs)
values (
  'Yonder',
  'yonder',
  'public',
  null,                                       -- public list, no join code
  '9390639e-cd23-432b-94dc-fab38185f062',     -- Paul V (owner)
  '{}'::jsonb                                  -- specs.boardRegion seeded by seed_yonder_holds.mjs
)
on conflict (slug) do nothing;

-- ── 2. Membership: Paul = admin (wall manager), claude-test = member ─────────
insert into board_members (board_id, user_id, role)
select b.id, v.user_id, v.role
from boards b
cross join (values
  ('9390639e-cd23-432b-94dc-fab38185f062'::uuid, 'admin'),   -- Paul V (wall admin)
  ('b97b6928-fdce-4da1-902f-962b57cbe3e5'::uuid, 'member')   -- claude-test (verification)
) as v(user_id, role)
where b.slug = 'yonder'
on conflict (board_id, user_id) do nothing;

-- Verify:
--   select id, name, slug, visibility, owner_id from boards where slug = 'yonder';
--   select bm.role, bm.user_id from board_members bm
--     join boards b on b.id = bm.board_id where b.slug = 'yonder';
