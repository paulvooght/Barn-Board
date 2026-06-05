# CURRENT_STATE.md — What's Working, What's Not, What's Fragile

*Last updated: 2026-06-03*
*Milestone tag for this state: `v1.3-pre-multi-wall` (annotated, pushed). Restore with `git checkout v1.3-pre-multi-wall`.*

> **This doc was fully re-synced with the code on 2026-06-03.** The app had grown well beyond
> the previous version of this file (40 source files, ~17,300 lines). Several things the old doc
> listed as "not yet built" (per-user sends, per-user ratings, creator-only editing, shared
> playlists) are **built and live**, and sync is now **realtime**, not just visibility-based.

## Genuinely Working

### Routes
- **Create / edit / delete** — tap holds on the board, assign modes (start/hand/foot/handOnly/finish), fill the form, save. Creator-only editing enforced by `creatorId`.
- **Route form** — name (with a random name-generator hint), grade, angle, setter, description, YouTube URL, hold types (auto-collected from hold metadata), techniques, styles.
- **Route view** — dimmed board with full-intensity hold cutouts via SVG mask; **swipe carousel** to move between routes in the current filter/sort order.
- **Missing-hold system** — routes flag holds that no longer exist; ghost outlines drawn from stored `holdSnapshots`; auto-strip on save.

### Per-user progress (private, in `user_route_data`)
- **4-state send cycle** — empty → **tried → sent → flash** → empty, tracked both route-wide and **per-angle**.
- **Star ratings** — each user rates 1–5; the card shows the **community average** (optimistically updated).
- **Community grade suggestions** — users suggest a headline and/or per-angle grade; the app derives a **consensus** and re-normalises it live when the viewer switches V ↔ Font.

### Route list
- Sort (date / grade / rating, with direction toggle); filter (setter search, grade range incl. hidden angle-grades, min rating, hold types, styles); hide-sent toggle.
- **Playlists** — create / rename / delete / add / remove, tile UI.
- **Shared playlists** — publish a playlist publicly, browse others', subscribe (adds a private copy).

### Sessions (behind the `betaSessionLogger` toggle)
- Start / stop with a header timer + board-angle slider + log-angle control; session summary after Stop.
- **Sessions tab** — period picker (last session / week / month / all-time), **Climber Card** (top grades, strengths/weaknesses by hold type, climber-type label, period-over-period deltas), **Hold Heat Map**, **Unfinished Business**, per-session route list, session-history accordion.
- **Session editor** — edit a past session's sends, angles and times.
- Pure stats engine in `sessionStats.js` (side-effect-free, testable).

### Community
- **Comments** — per-route threads; post, like 👍, flag "⚑ Neg"; admin hard-delete; route-creator name highlighted yellow with a "setter" pill.
- **Display names** — required before commenting; globally unique; editable in Settings.

### Hold management (admin)
- **Hold Manager** (`BoardSetupView`) — Select/Draw/Copy tools; Boundaries / Hold-Info / Heatmap modes; undo/redo; lasso; copy-paste; long-press vertex editing.
- **Hold editor** (`HoldEditorView`) — polygon + metadata (name, colour, hold types, positivity, material).
- **Board image wizard** (`BoardImageUpdateView`) — upload → crop → align → fine-tune → confirm, with perspective warp; publishes 4 responsive variants to the `board-images` bucket and writes `board_image_config`.

### Settings
- Display name, grade system (V/Font) + conversion chart, admin/climber mode, board specs, beta toggles (Session Record, Video Thumbnail), account (email, sign out, **change password**).

### Auth, data & sync
- Email/password auth (Supabase); dev-only autologin for UI testing.
- **Four cooperating sync paths:** immediate flush (save route / end session), 1500 ms debounce, **realtime postgres subscription on `routes`**, tab-visibility refetch, plus an **offline pending-route queue** (`pendingRouteSync.js`) retried on load / visibility / `online`.
- First-login localStorage → Supabase migration. PWA (installable, offline shell).
- Three-layer hold data (base JSON → overrides → custom), all synced to `board_settings`.

## Known Bugs / Issues

### ⚠️ Hold editing blocked on laptop (reported 2026-06-05 — ACTIVE workstream, own thread)
Paul can't edit holds in **Hold Manager on laptop**. This is the current priority: it **blocks the Yonder refine pass**, which must precede Yonder getting routes (hold IDs freeze once a route references them). **Being fixed in a dedicated thread before multi-wall 2b-iv goes live** — 2b-iv opens Yonder to joiners/route-setters, so its go-live waits on this fix + the refine pass. Exact symptom + root cause **TBD** (Paul to describe; establish whether it's long-standing or recent). Likely areas: `BoardSetupView.jsx` coordinate conversion — `getBoundingClientRect()` + manual letterbox math for `preserveAspectRatio="xMidYMin meet"`, specifically the **height-constrained (laptop) branch** (phones are width-constrained; laptop is the different path) — plus `getSvgScale()` and the mouse-vs-touch (`lastTouchTimeRef` / `isSynthesizedMouse`) handling. If the bug is recent, rule out the 2b-iii `boardRegion`-prop change (commit `7a604f4`, identical value for The Barn so unlikely). ⚠️ Coordinate/touch handling is "DO NOT CHANGE CASUALLY" (CLAUDE.md) — diagnose with evidence before editing.

### Admin model is split & partly client-only (verified against live RLS 2026-06-03)
- **Routes:** edit/delete of *others'* routes is gated server-side to a **hardcoded email** (`paul@thisisyonder.com`) in RLS — not `profiles.is_admin`.
- **Comments:** delete uses `profiles.is_admin` (a different mechanism).
- **`board_settings` (hold data + image config):** writable by **any authenticated user** server-side. Hold-editing is protected *only* by the **client-side `isAdmin` gate, which fails open** when `VITE_ADMIN_EMAIL` is unset.
- **Fixes:** (1) default `isAdmin` to `false`; (2) tighten `board_settings` writes before a public 200-user wall; (3) **multi-wall must replace the hardcoded-email route policy with per-board roles** (`board_members`) — else only Paul can admin any wall.

### Schema captured & verified
- `supabase/migrations/000_core_tables.sql` backfills the previously-undocumented tables (`routes`, `sessions`, `board_settings`, `user_route_data`, `shared_playlists`). **Verified against live prod 2026-06-03** via `scripts/dump_schema.sql` — column types/defaults/nullability **and** RLS policies mirror production exactly (same names, roles, expressions). Safe to run against prod (idempotent).
- Prod facts faithfully reproduced: **no foreign-key constraints** (referential integrity is app-managed); **no `user_id` indexes** on routes/sessions; `user_route_data.angle_sends` is `jsonb` while `angle_flashes`/`angle_attempts` are `integer[]`.

### Session tracking edge cases
- Summary may show duplicate sends if a route is toggled sent multiple times; personal-best counts can be off-by-one in dedup edge cases.

### Multi-device freshness
- Routes sync in realtime; **other tables** (sessions, playlists, per-user data, holds) still refresh on tab-visibility, not live.

## Fragile / Risky Areas

### `BoardSetupView.jsx` (~2,270 lines)
- Most complex file — 3 tools, 3 modes, copy/paste, undo/redo, vertex editing, zoom/pan. Touch/mouse handling is finely tuned. `preserveAspectRatio="xMidYMin meet"` is load-bearing — do not change to `xMidYMid`. Copy/paste rotation uses the `_origPoly` pattern to avoid drift.

### `App.jsx` (~3,040 lines)
- Does too much: view state, all CRUD, all four sync paths, per-user data, community grades, and a ~680-line inline `ViewRouteHeader`. State is highly interdependent (many `useState` + mirror refs). The prime refactor target — see Technical Debt.

### Board image wizard hold alignment
- The align → fine-tune pipeline warps a new photo to match the old image so `boardRegion` stays valid. Historically finicky to get holds lining up; test on phone **and** laptop after any change.

### Touch event handling (all interactive SVG)
- `lastTouchTimeRef` + `isSynthesizedMouse()` guards prevent ghost clicks on mobile. Preserve in BoardSetupView, HoldEditorView, BoardView.

### Coordinate system
- Hold positions are board-area percentages (0–100), mapped via `boardRegion` in `holds.json`. BoardView uses `getScreenCTM().inverse()`; BoardSetupView uses `getBoundingClientRect()` + letterbox math.

## Technical Debt
- **`App.jsx` too large** — extract the data/sync layer and CRUD into hooks (e.g. `useRouteSync`, `useSessionSync`, `useUserRouteData`) and move `ViewRouteHeader`/`NewAngleSuggestionRow`/`NavButton` to their own files.
- **No data-access layer** — Supabase calls are scattered across App.jsx, useCustomHolds, CommentsSection, Settings. The `user_route_data` upsert is hand-written **6×** with the full column list each time. A single `db.js` (or per-entity helpers) would remove the duplication **and** is the key enabler for adding a `board_id` dimension (multi-wall).
- **Duplicated constants** — the V/Font grade arrays are re-declared inline in `Settings.jsx`, `SessionHistoryAccordion.jsx`, and `SessionEditView.jsx` instead of importing from `constants.js`. Drift risk.
- **Inline styles everywhere** — repeated style objects (e.g. the toggle-switch markup is copy-pasted). CSS variables exist (`:root`) but component styles aren't shared.
- **~44 `console.*`** calls (31 in App.jsx) — fine for dev, noisy for a 200-user/day production wall.
- **No tests** — despite ideal pure-function targets (`sessionStats`, `heatMap`, `polygonUtils`, grade conversion).
- **No error boundary** — a render error white-screens the app.

## Multi-Wall Readiness (in progress — Phase 2)
**Status (2026-06-05):** Phase 1 design **approved**. Decisions: one account → many walls (data siloed per wall); each wall public or private (private = join code); **any member sets routes**; per-wall **admin** role manages a wall (admin-driven wall setup, no self-serve yet); Barn holds **migrate into the DB** (keep `holds.json` as revert). Rollout: **2a (plumbing) ✅** · **2b-i (scoping + switcher + per-wall admin) ✅** · **2b-ii (holds & image per wall) ✅** · **2b-iii (Yonder stood up — first real second wall) ✅** · **2b-iv (onboarding/join + admin-assignment UI) ← NEXT** · 2c (RLS tenant isolation + per-board roles server-side) · billing later.

➡️ **2b-iv context: read `MULTIWALL_2B_HANDOVER.md`.** The 2b-iii carried-over follow-ups are all **resolved** (per-board image naming, new-wall boardRegion setup, `publish_board_image.py --board`). **Yonder** board_id `275dfaa7-1df9-4fe7-8332-c2795eb9ebe7`, slug `yonder`, public, owner/admin Paul, 108 seeded holds (awaiting a Hold-Manager refine pass before it gets routes).

Goal: support multiple physical boards/walls (e.g. Yonder, Walthamstow) as **separate communities**, with a wall switcher and per-wall data isolation. Remaining single-board assumptions to clear in 2b/2c:

- ~~`routes` and `sessions` have no `board_id`~~ → **done in 2a** (added, backfilled to The Barn, defaulted).
- ~~`board_settings` hold/image keys are **global singletons**~~ → **done in 2b-ii** for holds + image (`holds_<boardId>`, `board_image_config_<boardId>`, `boards.specs.boardRegion`); old global keys kept as The Barn's revert path. (`playlists_${userId}` stays per-user.)
- ~~**Base holds ship as one static `holds.json`**~~ → **done in 2b-ii**: holds load per-wall from the DB; `holds.json` retained as The Barn's seed/revert.
- `profiles.display_name` is **globally unique** (two walls can't both have a "Dave").
- Admin is split — routes use a hardcoded email (`paul@thisisyonder.com`), comments use `is_admin`; no per-wall roles. Needs `board_members` roles.
- RLS uses a "pragmatic trust" model — fine for friends, needs real tenant isolation for paying customers.

Likely shape: a `boards` table, a `board_members` (board_id, user_id, role) table, a `board_id` FK on routes/sessions, per-board hold + image config (holds move to DB), an "active board" context threaded through every query, RLS rewritten around membership, and a wall switcher in the UI. **Recommended prep before building:** data-access layer + capture live schema into migrations.

## Recent Changes
- **2026-06-05** — **Multi-wall Phase 2b-iii (stand up Yonder — first real second wall) — DONE & deployed.** Yonder is live: `boards` row (`275dfaa7-1df9-4fe7-8332-c2795eb9ebe7`, slug `yonder`, **public**, no join code, owner/admin Paul; `claude-test` enrolled as member for verification), per-board `holds_<id>` (**108 auto-detected holds**), `board_image_config_<id>`, `boards.specs.boardRegion {1,0.5,98,97}`, and the image (`Yonder_Set_01_V1` + variants, cropped-to-board ~1990×1216) in the `board-images` bucket. **Architectural prereq fixed first** (commit `7a604f4`): `BoardView`/`BoardSetupView`/`HoldEditorView`/`BoardImageUpdateView` now **consume the per-wall `boardRegion` prop** (default `holds.json`) instead of the module-level constant — was invisible for The Barn (its region == holds.json) but would have misplaced every Yonder hold. `GuidedCameraStep` deferred (still Barn-calibrated region **and** photo dims; capture-aid only). **Carried-over 2b-ii follow-ups resolved** (commit `2155923`): wizard image name namespaced per wall; `publish_board_image.py --board <slug|id>` → `board_image_config_<id>` reading `board-assets/<slug>/`. **Bootstrap** (commit `39a11f2`/`f3746b8`): cropped the Yonder photo to the board → `detect_holds.py` with an **expanded colour palette** (added red/orange/green/blue/pink to the Barn's cyan/yellow/purple/black) + a **watershed split** for touching holds (67 colour-blind → 103, then 108 after widening the L/R crop so edge holds aren't clipped — re-crop → re-detect → re-seed → re-publish, clean because Yonder had no routes) → `seed_yonder.mjs` (dry-run + `--commit`, twin of `006_yonder_board.sql`) seeded the wall + holds + region; image published via the new `--board` flag. New per-wall source-asset convention `board-assets/<slug>/` (outside `public/`, not bundled). **Verified in preview:** switch to Yonder loads its (wider, re-cropped) image + holds (0 NaN); The Barn renders unchanged; a Yonder-scoped test route created + board-filtered, then deleted (Yonder kept route-free so hold IDs stay editable for the refine pass). Backup `pre-2b-iii`, rollback tag `v1.6-pre-multiwall-2b-iii`. ⚠️ **Yonder's 108 holds are a partial auto-seed** — prune false positives + add missed holds in Hold Manager **before** Yonder gets routes (IDs freeze once a route references them). **Next: 2b-iv (onboarding/join + admin-assignment UI).**
- **2026-06-05** — **Multi-wall Phase 2b-ii (holds & board image per wall) — DONE & deployed** (commit `48ea2b6`). Holds + image are now per-wall in the DB: `board_settings['holds_<boardId>']` (full hold array), `board_settings['board_image_config_<boardId>']`, and `boards.specs.boardRegion`. **Migration `005_holds_per_board.sql`** (+ executable twin `scripts/migrate_holds_to_board.mjs`, dry-run verifier + `--commit`) seeded The Barn: `holds_<barnId>` is a **verbatim copy of `custom_holds`** — provably safe because all 55 `holds.json` base holds are hidden via `hold_overrides`, so the live effective set *is* the 186 custom holds. **Every hold ID preserved by construction**; verifier confirmed all 275 hold refs across 25 routes resolve. Additive/non-destructive — old global keys (`custom_holds`/`hold_overrides`/`board_image_config`) left intact as a revert path; `holds.json` retained as seed. App: `useCustomHolds(user, boardId, seedFromLegacy)` loads the wall's single array (no more 3-layer merge; `saveAllHolds` preserves IDs; The Barn falls back to a read-only legacy rebuild if its blob is missing); per-board image config load (legacy-global fallback) + save; `activeBoardRegion` threaded to board components; `fetchBoards()` selects `specs`; `handleSetupSave` simplified (no ID remap); `db.js` per-board helpers; `backup_tables.mjs` now captures `boards`+`board_members`. **Verified in preview against The Barn** — reads `holds_<barnId>` (186 holds, IDs identical & in order), all holds render, routes open with holds highlighted on correct positions, no console errors. Backup `pre-2b-ii`, rollback tag `v1.5-pre-multiwall-2b-ii`. **Next: 2b-iii (stand Yonder up).** Carried-over follow-ups in `MULTIWALL_2B_HANDOVER.md`: per-board image naming, new-wall boardRegion setup, `publish_board_image.py` per-board.
- **2026-06-05** — **Multi-wall Phase 2b-i (scoping + switcher + per-wall admin) — DONE & deployed** (commit `cb7c89e`). Reads/writes scope to the active wall (`loadDataFromSupabase(userId, isFirstLoad, boardId)`; routes/sessions/visibility-refetch/realtime all board-filtered; new rows stamp `board_id` via `boardCol()`). `resolveActiveBoard()` loads the user's boards+roles into `myBoards`; `switchBoard()` changes wall + reloads; header `WallSwitcher` shows only when in 2+ walls. Per-wall admin: `isActiveBoardAdmin` (role on active wall) gates Hold Manager / image wizard / the Climber⇄Admin toggle (Settings), and admin tools now require admin MODE so the toggle is meaningful; comment moderation still uses the global `isAdmin`. App behaviour unchanged for the single live wall. Verified in preview against a throwaway wall (created + deleted). **Next: 2b-ii (holds & image per wall) — see `MULTIWALL_2B_HANDOVER.md`.**
- **2026-06-04** — **Multi-wall Phase 2a (plumbing) — DONE & deployed.** Migration `004_boards_multiwall.sql` applied to prod: `boards` + `board_members` tables, `board_id` added to `routes`/`sessions` and backfilled to the seed wall **"The Barn"** (also set as the column default), all existing users enrolled as members. App: `db.js` gained board/membership helpers; `resolveActiveBoard()` runs on login (uses the user's membership, auto-joins The Barn for membership-less accounts) and stores `activeBoardId` as the 2b switcher foundation. **App behaviour unchanged (single wall)** — reads aren't board-filtered yet; writes stay correct via the DB default. Rollback tag `v1.4-pre-multiwall-2a`; local data backup in `backups/` (free plan has no Supabase backups). Verified in preview (all reads 200, new-account auto-join 201, no errors). Next: 2b (switcher + onboarding + holds-to-DB + add Yonder).
- **2026-06-03** — **Milestone + docs/housekeeping pass.** Tagged `v1.3-pre-multi-wall` (annotated, pushed) as a restore point before the multi-wall feature. Did a full codebase re-read and re-synced CLAUDE.md (Key Files table, schema, sync pattern, view map, admin note, per-user data shape) and this file with reality. Archived historical root docs into `docs/archive/` and stray board images into `public/Archive/`. No app code changed.
- **2026-05-28** — **Hold Manager: fix pan regression, drop centroid dot, drag from body when armed** (`src/components/BoardSetupView.jsx`). Pan now works when touch/click starts on a hold (`panDragRef` initialized alongside `pendingHoldRef`). Centroid drag-dot removed entirely. `dotsVisible` renamed to `armed` with a mirrored `armedRef`. Drag from hold body activates only when `armed` (500ms after selection) and the hit hold is in the selection — otherwise movement falls through to pan. Touch tap-cancel threshold loosened 6px → 9px.
- **2026-05-28** — **Hold Manager: fix dotsVisible for lasso/Select All** — replaced per-tap timer scheduling with a single `useEffect` watching `selectedIds.length` and `vertexEditId`. (`src/components/BoardSetupView.jsx`)
- **2026-05-27** — **Hold Manager: new Select tool interaction model** (`src/components/BoardSetupView.jsx`). Removed `multiSelectMode`/Multi toggle — additive multi-select always on. Tap adds; tap empty clears; drag activates after a small threshold; long-press (touch) / double-click (mouse) enters vertex-edit; vertex handles only show when `vertexEditId` is set; lasso promoted to a standalone button.
- **2026-05-06** — **Session Record (Phase 1)** — new **Sessions** tab behind the `betaSessionLogger` toggle. Tab structure Routes / Sessions / Settings. Adds `PeriodPicker`, `ClimberCard`, `HoldHeatMap`, `SessionRollup`/cards, Unfinished Business. Added `flashed` and `attempted` boolean columns to `user_route_data` (action-based attempt tracking). New files: `src/utils/sessionStats.js`, `SessionsView.jsx`, `PeriodPicker.jsx`, `ClimberCard.jsx`, `HoldHeatMap.jsx`. *(Now merged to main.)*
- **2026-04-20** — **Comments** on route info pages. New `profiles` table (display_name + is_admin) — Settings gained a Display Name field, required before commenting. New `route_comments` table; per-route thread with post/like/flag and admin hard-delete; creator name highlighted with a "setter" pill. `isAdmin` sourced from `profiles.is_admin` with `VITE_ADMIN_EMAIL` bootstrap fallback. New: `CommentsSection.jsx`, `CommentItem.jsx`. Migrations `001_profiles.sql`, `002_route_comments.sql`.
- **2026-04-17 (Session 3 final)** — Board-image wizard stabilised: `upload → crop → align → fineTune → confirm`. 4 free pins with opacity overlay + live `matrix3d`, warping the new image to match the **old image** pixel-for-pixel; `FineTuneStep` (translate + uniform scale); "Show holds" toggle; "crop too small" warning. `boardRegion` stays single-source in `holds.json`. Safe rollback tag `v1.1-pre-session-3`.
- **2026-04-15** — Session 2: added `AlignStep` perspective-warp to `BoardImageUpdateView.jsx` (CSS `matrix3d` live preview, loupe magnifier). *Superseded by Session 3.*
- **March–April 2026** — Supabase integration (localStorage → Supabase + cache); auth + admin-only Hold Manager; tab-visibility sync; Hold Manager SVG alignment fix (`xMidYMid` → `xMidYMin`); Hold-Info mode; auto hold-type collection; session tracking; playlists; missing-hold ghost outlines; iOS PWA keyboard fix.
