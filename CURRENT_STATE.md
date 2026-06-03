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

## Multi-Wall Readiness (next big feature)
Goal: support multiple physical boards/walls (e.g. Yonder, Walthamstow) as **separate communities**, with a wall switcher and per-wall data isolation. The app currently has **no board/tenant concept** — everything assumes one board. What's single-board today:

- `routes` and `sessions` have no `board_id`.
- `board_settings` keys (`hold_overrides`, `custom_holds`, `board_image_config`) are **global singletons**.
- **Base holds ship as one static `holds.json`** — per-wall holds must move into the DB.
- `profiles.display_name` is **globally unique** (two walls can't both have a "Dave").
- Admin is split — routes use a hardcoded email (`paul@thisisyonder.com`), comments use `is_admin`; no per-wall roles. Needs `board_members` roles.
- RLS uses a "pragmatic trust" model — fine for friends, needs real tenant isolation for paying customers.

Likely shape: a `boards` table, a `board_members` (board_id, user_id, role) table, a `board_id` FK on routes/sessions, per-board hold + image config (holds move to DB), an "active board" context threaded through every query, RLS rewritten around membership, and a wall switcher in the UI. **Recommended prep before building:** data-access layer + capture live schema into migrations.

## Recent Changes
- **2026-06-03** — **Milestone + docs/housekeeping pass.** Tagged `v1.3-pre-multi-wall` (annotated, pushed) as a restore point before the multi-wall feature. Did a full codebase re-read and re-synced CLAUDE.md (Key Files table, schema, sync pattern, view map, admin note, per-user data shape) and this file with reality. Archived historical root docs into `docs/archive/` and stray board images into `public/Archive/`. No app code changed.
- **2026-05-28** — **Hold Manager: fix pan regression, drop centroid dot, drag from body when armed** (`src/components/BoardSetupView.jsx`). Pan now works when touch/click starts on a hold (`panDragRef` initialized alongside `pendingHoldRef`). Centroid drag-dot removed entirely. `dotsVisible` renamed to `armed` with a mirrored `armedRef`. Drag from hold body activates only when `armed` (500ms after selection) and the hit hold is in the selection — otherwise movement falls through to pan. Touch tap-cancel threshold loosened 6px → 9px.
- **2026-05-28** — **Hold Manager: fix dotsVisible for lasso/Select All** — replaced per-tap timer scheduling with a single `useEffect` watching `selectedIds.length` and `vertexEditId`. (`src/components/BoardSetupView.jsx`)
- **2026-05-27** — **Hold Manager: new Select tool interaction model** (`src/components/BoardSetupView.jsx`). Removed `multiSelectMode`/Multi toggle — additive multi-select always on. Tap adds; tap empty clears; drag activates after a small threshold; long-press (touch) / double-click (mouse) enters vertex-edit; vertex handles only show when `vertexEditId` is set; lasso promoted to a standalone button.
- **2026-05-06** — **Session Record (Phase 1)** — new **Sessions** tab behind the `betaSessionLogger` toggle. Tab structure Routes / Sessions / Settings. Adds `PeriodPicker`, `ClimberCard`, `HoldHeatMap`, `SessionRollup`/cards, Unfinished Business. Added `flashed` and `attempted` boolean columns to `user_route_data` (action-based attempt tracking). New files: `src/utils/sessionStats.js`, `SessionsView.jsx`, `PeriodPicker.jsx`, `ClimberCard.jsx`, `HoldHeatMap.jsx`. *(Now merged to main.)*
- **2026-04-20** — **Comments** on route info pages. New `profiles` table (display_name + is_admin) — Settings gained a Display Name field, required before commenting. New `route_comments` table; per-route thread with post/like/flag and admin hard-delete; creator name highlighted with a "setter" pill. `isAdmin` sourced from `profiles.is_admin` with `VITE_ADMIN_EMAIL` bootstrap fallback. New: `CommentsSection.jsx`, `CommentItem.jsx`. Migrations `001_profiles.sql`, `002_route_comments.sql`.
- **2026-04-17 (Session 3 final)** — Board-image wizard stabilised: `upload → crop → align → fineTune → confirm`. 4 free pins with opacity overlay + live `matrix3d`, warping the new image to match the **old image** pixel-for-pixel; `FineTuneStep` (translate + uniform scale); "Show holds" toggle; "crop too small" warning. `boardRegion` stays single-source in `holds.json`. Safe rollback tag `v1.1-pre-session-3`.
- **2026-04-15** — Session 2: added `AlignStep` perspective-warp to `BoardImageUpdateView.jsx` (CSS `matrix3d` live preview, loupe magnifier). *Superseded by Session 3.*
- **March–April 2026** — Supabase integration (localStorage → Supabase + cache); auth + admin-only Hold Manager; tab-visibility sync; Hold Manager SVG alignment fix (`xMidYMid` → `xMidYMin`); Hold-Info mode; auto hold-type collection; session tracking; playlists; missing-hold ghost outlines; iOS PWA keyboard fix.
