# Multi-Wall — Handover Brief (for a fresh thread)

*Written 2026-06-05, kept current across the 2b arc. Now orients a fresh thread for **2b-iv** (2a / 2b-i / 2b-ii / 2b-iii are done & deployed). Archive this to `docs/archive/` when 2b is complete (after 2b-iv).*

## How to use this brief
New thread: **read in this order** → `CLAUDE.md` → `CURRENT_STATE.md` → this file → `git log --oneline -20`. That's the full picture. Use an **Opus** thread (sensitive design + build). Follow the project's workflow (design → verify → commit+push each step).

---

## Where we are
Building **multi-wall** (multiple climbing boards as separate communities; one account can belong to many; switch between them). Phased rollout:

- **2a — plumbing — DONE & deployed.** Migration `004_boards_multiwall.sql` applied to prod: `boards` + `board_members` tables; `board_id` on `routes`/`sessions` (backfilled + defaulted to The Barn); all users enrolled as members.
- **2b-i — scoping + switcher + per-wall admin — DONE & deployed** (commit `cb7c89e`). Reads/writes scope to the active wall; header `WallSwitcher` (shows only when in 2+ walls); `resolveActiveBoard()`/`switchBoard()`/`myBoards`/`isActiveBoardAdmin` in App.jsx; per-wall admin gates Hold Manager / image wizard / the Climber⇄Admin toggle (Settings).
- **2b-ii — holds & board image per wall — DONE & deployed (2026-06-05, commit `48ea2b6`).** Per-board `holds_<boardId>` / `board_image_config_<boardId>` / `boards.specs.boardRegion`; migration `005_holds_per_board.sql` (+ `scripts/migrate_holds_to_board.mjs`) seeded The Barn from `custom_holds` verbatim (all base hidden → effective set == custom_holds), **every ID preserved**, 275/275 route refs resolve. `useCustomHolds(user, boardId, seedFromLegacy)` board-aware; old global keys + `holds.json` kept as revert. Backup `pre-2b-ii`, tag `v1.5-pre-multiwall-2b-ii`. Verified in preview (Barn renders identically).
- **2b-iii — stand Yonder up (photo + holds). ✅ DONE & deployed (2026-06-05).** Yonder is live: `boards` row `275dfaa7-1df9-4fe7-8332-c2795eb9ebe7` (slug `yonder`, **public**, owner/admin Paul; `claude-test` member), `holds_<id>` (108 auto-detected holds), `board_image_config_<id>`, `boards.specs.boardRegion {1,0.5,98,97}`, image in the bucket (cropped-to-board ~1990×1216). Migration `006_yonder_board.sql` (+ executable twin `scripts/seed_yonder.mjs`, dry-run + `--commit`). All three carried-over follow-ups resolved:
  1. **Per-board image naming ✅** — wizard default name namespaced per wall (App.jsx `activeBoardImageDefault`); the bootstrap published as `Yonder_Set_01_V1`.
  2. **New-wall `boardRegion` setup ✅** — established by cropping the photo to the board (region ≈ full, `{1,0.5,98,97}`); the **architectural prereq** (components were ignoring the per-wall `boardRegion` prop and reading `holds.json`) was fixed first — `BoardView`/`BoardSetupView`/`HoldEditorView`/`BoardImageUpdateView` now consume the prop. `GuidedCameraStep` deferred (region **and** photo dims still Barn-hardcoded; capture-aid only).
  3. **`publish_board_image.py --board <slug|id>` ✅** — writes `board_image_config_<id>`, reads `board-assets/<slug>/`.
  - First holds: `detect_holds.py` got an **expanded colour palette** (red/orange/green/blue/pink) + a **watershed split** for touching holds (67 → 108). ⚠️ Partial seed — **refine in Hold Manager before Yonder gets routes** (IDs freeze once referenced). The crop was widened L/R post-publish (edge holds were clipped) — re-crop → re-detect → re-seed → re-publish, clean only because there were no routes. New per-wall source-asset convention: `board-assets/<slug>/`.
- **2b-iv — onboarding/join + members management. ✅ DONE & deployed (2026-06-07).** Consolidated into a Settings **"Walls"** section (the header switcher was removed): switch wall, join a wall (public list + join-by-code), admin-only manage-members (promote/demote with last-admin guard, public/private toggle, leave). Migration **`007_board_membership_fns.sql`** = 5 SECURITY DEFINER fns (`join_board_by_code`, `get_board_members`, `set_member_role`, `leave_board`, `set_board_visibility`); `WallsSettings.jsx` + `db.js` wrappers + `App.jsx` handlers (auto-switch after join). Verified on a throwaway wall (real RPCs, no bypass); backup `pre-2b-iv`, tag `v1.7-pre-multiwall-2b-iv`. **2b is now complete** — archive this brief to `docs/archive/` when starting 2c. (Yonder's hold set: the owner has been tidying it in-app; now ~225 holds.)
- 2c — RLS tenant isolation + per-board admin enforcement server-side (replaces the hardcoded-email route policy + permissive `board_settings` writes). Billing later.

### Key facts / IDs
- **The Barn** board_id = `1c97fee6-285a-4774-a185-cb5f17e60acf`, slug `the-barn`, private.
- **Yonder** board_id = `275dfaa7-1df9-4fe7-8332-c2795eb9ebe7`, slug `yonder`, public (no join code), owner/admin Paul (`9390639e-cd23-432b-94dc-fab38185f062`). Added in 2b-iii.
- Supabase project URL host: `omsucewpjhfqjnpqdmsh.supabase.co`. Free plan → **no Supabase backups** (use the backup script below).
- Dev test user (autologin via `.env.local`): `claude-test`, id `b97b6928-fdce-4da1-902f-962b57cbe3e5`, member of The Barn.
- Rollback tags: `v1.3-pre-multi-wall`, `v1.4-pre-multiwall-2a`, `v1.5-pre-multiwall-2b-ii`, `v1.6-pre-multiwall-2b-iii`. Local data backups in `backups/` (gitignored).
- **Paul** user_id `9390639e-cd23-432b-94dc-fab38185f062` (display name "Paul V"; admin of both walls). Other profiles: Jake `9ad1fcca-…`, JB `d988720e-…`, Climber McGee `10c57ef8-…`.

## Locked design decisions (do not re-litigate)
1. **One account → many walls**, data siloed per wall, switch between them.
2. **Each wall is public or private** (private = join code). Yonder = public, The Barn = private.
3. **Any member can set routes**; a per-wall **admin** role is only for managing the wall.
4. **Wall setup is admin-driven** (no self-serve "any gym signs up" yet — that's post-billing). Paul can appoint per-wall admins (e.g. make Jake a Yonder admin) — the *ability* is built in 2b-iv; don't assign anyone yet.
5. **Barn holds: migrate INTO the DB** for a uniform per-wall model — **but keep `src/data/holds.json` as the documented revert** and snapshot live hold data first.

---

## 2b-iv task spec (the next job)

**Goal:** onboarding + membership management. Public walls become **discoverable + joinable** in-app; private walls **joinable by join-code**; a per-wall **admin** can view members and **promote/demote** admin. Wall *creation* stays admin-driven/manual (SQL) for now — self-serve gym signup is post-billing. **Do this Phase-1 design pass as fresh Opus and confirm the open questions with Paul before building.**

### What exists to build on (from 2a / 2b-i)
- `db.js`: `fetchBoards()` (all boards + `visibility` + `specs`), `fetchBoardBySlug`, `fetchMyMemberships(userId)`, `joinBoard(boardId, userId, role)` (idempotent upsert). All table access goes through db.js (auth + realtime + the new RPC are the only exceptions).
- App.jsx: `resolveActiveBoard()` (login → loads `myBoards` with roles, auto-joins The Barn for membership-less accounts), `switchBoard()`, `myBoards`, `isActiveBoardAdmin`. Header `WallSwitcher` renders only at **2+ walls**.
- `boards` has `visibility` ('public'|'private') + a `join_code` (text, nullable). `board_members` PK `(board_id, user_id)`, `role` ('admin'|'member').

### The three pieces
1. **Public-wall discovery + join.** UI listing **public** walls the user isn't in (`fetchBoards()` → filter to public & not in `myBoards`), each with **Join** → `joinBoard(...)` → re-resolve `myBoards` so the switcher updates. Yonder is the first wall this makes reachable (it's public but currently undiscoverable in-app).
2. **Private-wall join by code.** Enter a code → add membership via a **`SECURITY DEFINER`** Postgres fn `join_board_by_code(p_code text)` (migration `007_…`) that looks up `boards.join_code`, inserts `(board_id, auth.uid(), 'member')`, returns the board. Rationale: joining a wall you can't yet *see* needs elevated privilege, and a DEFINER fn is **forward-compatible with 2c** RLS (a client insert also works under today's permissive RLS — don't rely on it). Wrap the call in db.js (`supabase.rpc(...)`). NB: **The Barn is private with no `join_code` set** — set one if it should be joinable by code.
3. **Members / make-admin screen.** Admin-only (gate on `isActiveBoardAdmin`), scoped to the active wall: list members with display names (`board_members` × `profiles`), show role, let an admin **promote member→admin / demote admin→member**. Helpers: `db.fetchBoardMembers(boardId)`, `db.setMemberRole(boardId, userId, role)`. **Guard the last admin** (a wall must never reach zero admins; block self-demotion when you're the only one). This is decision #4's "appoint per-wall admins" ability — build it, but **don't assign anyone to Yonder yet**.

### Where it plugs in
- **View state machine + nav:** add views (e.g. `joinWall`, `wallMembers`) or Settings sections; the `WallSwitcher` dropdown is the natural home for "Join another wall…" and (admins) "Manage members".
- **App.jsx:** after a join, re-resolve membership so `myBoards` + the switcher refresh; optionally auto-switch to the joined wall.

### Open questions to confirm with Paul (Phase 1)
1. UI placement — Settings sections vs dedicated views vs WallSwitcher-dropdown entries?
2. Should The Barn get a `join_code` (private, none set)? Who can see a wall's code (admins, on the members screen)?
3. Auto-switch to a wall right after joining?
4. Member-management scope — just role promote/demote, or also **remove member** / **leave wall**?
5. Confirm the `SECURITY DEFINER` RPC for join-by-code (vs a client-side insert under today's permissive RLS).

### ⚠️ Constraints
- **All table access via `src/lib/db.js`**; wrap the RPC there too.
- **Show Paul any SQL (the `007` RPC migration) before running**; he applies in the SQL editor OR authorises a service-role `--commit` script (the 2b-iii pattern — `seed_yonder.mjs`).
- **Backup + rollback tag first:** `node --env-file=.env.local scripts/backup_tables.mjs pre-2b-iv`; `git tag -a v1.7-pre-multiwall-2b-iv … && git push origin v1.7-pre-multiwall-2b-iv`.
- RLS is still **permissive (2a)** — 2b-iv works within that; real tenant isolation is **2c**. Build join-by-code as a DEFINER fn so it survives 2c.
- **Don't appoint any Yonder admin yet** (decision #4 — build the ability only).

### Pending carry-overs (track, not blockers)
- **Yonder Hold-Manager refine pass** — prune false positives + add missed holds on Yonder's 108-hold seed **before Yonder gets routes** (IDs freeze once referenced). Paul (admin) does this in-app.
- **GuidedCameraStep board-awareness** — deferred from 2b-iii (region + photo dims still Barn-hardcoded; a background-task chip exists).

## Verification + workflow gotchas (learned this session)
- **Build to syntax-check:** `npm run build` (fast). Commit+push to `main` after each step (Vercel auto-deploys; user preference is auto-push).
- **Preview is flaky here:** dev servers are short-lived — restart with `preview_start` name `barn-board`. `preview_eval`/`preview_click` can hit a **hidden/background browser context** (you'll see `bodyW: 0`, `visibilityState: hidden`), so a click in one context may not match a screenshot/snapshot in another. **To verify interactive state reliably, do it in ONE deterministic eval** (e.g. normalize state → click → `await` a short delay → read DOM, all in one IIFE). React state updates are async, so never check the DOM synchronously right after `.click()`.
- **Migrations:** **show Paul the SQL first.** Then either he runs it in the Supabase SQL editor, OR (his call — 2b-iii precedent) he authorises Claude to apply it via a service-role `.mjs` twin (dry-run by default + `--commit`, idempotent upserts — see `scripts/seed_yonder.mjs` / `migrate_holds_to_board.mjs`). Service-role can't run arbitrary DDL via PostgREST, so a `SECURITY DEFINER` *function* (2b-iv's `007`) must be created in the SQL editor; plain INSERT/UPDATE/RPC-calls can go through a service-role script.
- **Preview multi-context gotcha** is now also in Claude's project memory (`feedback_preview_multicontext.md`): eval/click often hit a hidden `bodyW:0` context (degenerate layout); board-switches propagate via localStorage but view-state changes don't. Verify with eval **data** checks + screenshots, not layout.
- Schema verified against prod via `scripts/dump_schema.sql` (now a single-result query).

## Definition of done for 2b-iv
Public walls discoverable + joinable in-app; private walls joinable by code (via the `SECURITY DEFINER` RPC — migration shown to Paul first); a wall admin can view members + promote/demote admin with a **last-admin guard**; `myBoards` + the switcher refresh after a join; new table access goes through `db.js`; backup + rollback tag taken; committed + pushed each step; CLAUDE.md + CURRENT_STATE.md + this brief updated; verified in preview (as `claude-test`: discover + join a public wall; as Paul/admin: open Yonder's members screen + promote/demote — then revert the test change). **Don't appoint a real Yonder admin** — just prove the ability.

### History (done & deployed)
- **2b-ii** ✅ (commit `48ea2b6`) — holds + image per-wall in the DB; The Barn migrated with all IDs preserved, renders identically. Tag `v1.5-pre-multiwall-2b-ii`.
- **2b-iii** ✅ (commits `7a604f4`→`0056348`) — Yonder stood up (board + members + 108 holds + image + region); `boardRegion` prop fix; per-board image naming + `publish_board_image.py --board`; `006_yonder_board.sql` + `seed_yonder.mjs`. Tag `v1.6-pre-multiwall-2b-iii`.
