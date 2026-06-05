# Multi-Wall — Handover Brief (for a fresh thread)

*Written 2026-06-05 at the end of a long session, to hand 2b-ii (and the rest of 2b) to a fresh thread with full context. Archive this to `docs/archive/` when 2b is complete.*

## How to use this brief
New thread: **read in this order** → `CLAUDE.md` → `CURRENT_STATE.md` → this file → `git log --oneline -20`. That's the full picture. Use an **Opus** thread (sensitive design + build). Follow the project's workflow (design → verify → commit+push each step).

---

## Where we are
Building **multi-wall** (multiple climbing boards as separate communities; one account can belong to many; switch between them). Phased rollout:

- **2a — plumbing — DONE & deployed.** Migration `004_boards_multiwall.sql` applied to prod: `boards` + `board_members` tables; `board_id` on `routes`/`sessions` (backfilled + defaulted to The Barn); all users enrolled as members.
- **2b-i — scoping + switcher + per-wall admin — DONE & deployed** (commit `cb7c89e`). Reads/writes scope to the active wall; header `WallSwitcher` (shows only when in 2+ walls); `resolveActiveBoard()`/`switchBoard()`/`myBoards`/`isActiveBoardAdmin` in App.jsx; per-wall admin gates Hold Manager / image wizard / the Climber⇄Admin toggle (Settings).
- **2b-ii — holds & board image per wall — DONE & deployed (2026-06-05, commit `48ea2b6`).** Per-board `holds_<boardId>` / `board_image_config_<boardId>` / `boards.specs.boardRegion`; migration `005_holds_per_board.sql` (+ `scripts/migrate_holds_to_board.mjs`) seeded The Barn from `custom_holds` verbatim (all base hidden → effective set == custom_holds), **every ID preserved**, 275/275 route refs resolve. `useCustomHolds(user, boardId, seedFromLegacy)` board-aware; old global keys + `holds.json` kept as revert. Backup `pre-2b-ii`, tag `v1.5-pre-multiwall-2b-ii`. Verified in preview (Barn renders identically).
- **2b-iii — stand Yonder up for real (photo + holds). ← THIS IS NEXT.** Paul has a Yonder photo (~2000px longest edge) ready to import. **Carried-over from 2b-ii (do these here):**
  1. **Per-board image naming** — the wizard's `imageName` isn't board-namespaced; two walls could collide on a storage filename (`board-images` bucket). Namespace by board (e.g. slug/id prefix) when publishing Yonder's image.
  2. **New-wall `boardRegion` setup** — a fresh wall has no `specs.boardRegion` and falls back to The Barn's (holds.json) + the bundled Barn image. `BoardImageUpdateView` currently warps a new photo to match an *existing* region; new-wall setup must *establish* the region (and seed the wall's first holds, e.g. via detection → `holds_<yonderId>`).
  3. **`scripts/publish_board_image.py`** still writes the **global** `board_image_config` (now only an app fallback). Give it a board arg → `board_image_config_<boardId>` before using it on a multi-wall setup.
- 2b-iv — onboarding (join public list / private join-code via a `SECURITY DEFINER` fn) + a "wall members / make admin" screen.
- 2c — RLS tenant isolation + per-board admin enforcement server-side (replaces the hardcoded-email route policy + permissive `board_settings` writes). Billing later.

### Key facts / IDs
- **The Barn** board_id = `1c97fee6-285a-4774-a185-cb5f17e60acf`, slug `the-barn`, private. Currently the ONLY wall.
- Supabase project URL host: `omsucewpjhfqjnpqdmsh.supabase.co`. Free plan → **no Supabase backups** (use the backup script below).
- Dev test user (autologin via `.env.local`): `claude-test`, id `b97b6928-fdce-4da1-902f-962b57cbe3e5`, member of The Barn.
- Rollback tags: `v1.3-pre-multi-wall`, `v1.4-pre-multiwall-2a`. Local data backups in `backups/` (gitignored).

## Locked design decisions (do not re-litigate)
1. **One account → many walls**, data siloed per wall, switch between them.
2. **Each wall is public or private** (private = join code). Yonder = public, The Barn = private.
3. **Any member can set routes**; a per-wall **admin** role is only for managing the wall.
4. **Wall setup is admin-driven** (no self-serve "any gym signs up" yet — that's post-billing). Paul can appoint per-wall admins (e.g. make Jake a Yonder admin) — the *ability* is built in 2b-iv; don't assign anyone yet.
5. **Barn holds: migrate INTO the DB** for a uniform per-wall model — **but keep `src/data/holds.json` as the documented revert** and snapshot live hold data first.

---

## 2b-ii task spec (the next job)

**Goal:** holds + board image become per-wall, loaded uniformly from the DB, with The Barn migrated in **without changing a single hold ID** and rendering **identically** before/after.

### Steps
1. **Backup first** (free plan, no Supabase backups):
   `node --env-file=.env.local scripts/backup_tables.mjs pre-2b-ii`
   Also tag: `git tag -a v1.5-pre-multiwall-2b-ii -m "..." && git push origin v1.5-pre-multiwall-2b-ii`.
2. **Per-board hold storage.** Today (three-layer, all GLOBAL): `src/data/holds.json` base (~25 holds) + `board_settings['hold_overrides']` + `board_settings['custom_holds']`, merged in `useCustomHolds.js`. Also global: `board_settings['board_image_config']` and `holds.json.boardRegion`.
   **Recommended target:** one blob per board — `board_settings` key `holds_<boardId>` = the board's full hold array (collapses the three layers into one per-board set; re-detection/`merge_holds.py` still preserves IDs by merging into that set). Plus `board_image_config_<boardId>` and a per-board `boardRegion` (store in `boards.specs` jsonb or alongside the holds blob). Add helpers to `db.js` (all table access goes through db.js — see CLAUDE.md). *Validate this approach as fresh Opus before building; alternative is per-board `hold_overrides_<id>`/`custom_holds_<id>` keys keeping the three layers.*
3. **Migrate The Barn:** seed `holds_<barnId>` from the **current merged effective holds** (so what's live now is preserved exactly — IDs, positions, polygons, metadata). The Barn's `boardRegion` + image config → per-board too. Provide the migration as **SQL/script for Paul to review & run** (show him first; he confirms backups). `holds.json` stays in the repo as revert.
4. **Make `useCustomHolds(boardId)` board-aware** — load the active wall's holds from the DB; CRUD operates on that wall's set. Make board-image config per-board too (App.jsx loads `board_image_config_<activeBoardId>`).
5. **Verify the Barn is byte-identical in behaviour:** same holds, same IDs, same positions, same image. Diff the migrated hold set against `holds.json`+overrides+customs. Open a couple of existing routes and confirm holds still render in the right places (this is the whole risk — routes reference holds by ID).

### ⚠️ Critical constraints
- **HOLD ID PRESERVATION is the #1 rule.** Routes reference holds by ID; a scrambled/changed ID silently breaks every route. See CLAUDE.md "Board Image Updates & Hold Detection." Migrate IDs verbatim.
- **All Supabase table access goes through `src/lib/db.js`** (per CLAUDE.md). Add per-board hold/image helpers there.
- `board_settings` is writable by any authenticated user (2a permissive RLS) — fine for now; tenant-isolation hardening is 2c.
- New routes/sessions stamp `board_id` via the `boardCol()` helper in App.jsx + a DB column default (The Barn) as backstop. Don't break that.

## Verification + workflow gotchas (learned this session)
- **Build to syntax-check:** `npm run build` (fast). Commit+push to `main` after each step (Vercel auto-deploys; user preference is auto-push).
- **Preview is flaky here:** dev servers are short-lived — restart with `preview_start` name `barn-board`. `preview_eval`/`preview_click` can hit a **hidden/background browser context** (you'll see `bodyW: 0`, `visibilityState: hidden`), so a click in one context may not match a screenshot/snapshot in another. **To verify interactive state reliably, do it in ONE deterministic eval** (e.g. normalize state → click → `await` a short delay → read DOM, all in one IIFE). React state updates are async, so never check the DOM synchronously right after `.click()`.
- **Migrations:** show Paul the SQL; he runs it in the Supabase SQL editor and confirms backups. Supabase shows a generic "destructive operations" warning for any DDL/`UPDATE`/`DROP` — that's normal.
- Schema verified against prod via `scripts/dump_schema.sql` (now a single-result query).

## Definition of done for 2b-ii — ✅ MET (2026-06-05)
Holds + image are per-wall in the DB; The Barn migrated with all IDs preserved and rendering identically (verified by opening existing routes); `useCustomHolds`/image config board-aware; `holds.json` retained as revert; backup taken; committed + pushed; CLAUDE.md schema + CURRENT_STATE.md updated; this brief updated with 2b-ii status. ✅ All done — see commit `48ea2b6`.
