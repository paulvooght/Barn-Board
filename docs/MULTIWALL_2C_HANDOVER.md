# Handover — Multi-wall 2c (DONE) → close-out + billing next  (2026-06-08)

Self-contained brief for a **fresh Opus thread**. **2c is built, verified, and deployed.** This
hands over: (1) exactly what 2c did so you can understand/sanity-check it, (2) the open close-out
items, (3) the next milestone (billing).

**Read first, in order:** `CLAUDE.md` (esp. *Admin System* + the `007`/`008` migration entries) →
`CURRENT_STATE.md` (top entries) → **this file** → `supabase/migrations/008_rls_tenant_isolation.sql`
→ `scripts/verify_2c_rls.mjs` → `git log --oneline -12`.

**HEAD when written:** `2c6842f` (working tree clean except `.claude/settings.local.json`, which is
local and must never be committed).

---

## Where we are
Two pieces of work completed this session:

- **Task 1 — Hold-Manager copy/paste polish + on-image rotate/scale handles — DONE.**
  - `2f6b85d` copy/paste: **Single / Multi** paste modes (+ "Placed N"), **Shift-to-keep-stamping**
    (independent of mode), kept **Cmd/Ctrl+C**, **ghost preview** (mouse-only, dashed, follows cursor).
  - `49a0179` handles: any **single** selected hold shows an on-image **rotate** dot-on-a-stalk
    (orbits centroid, follows cursor 1:1) + **scale** square at the bbox corner; **sliders removed**;
    **multi-select transform removed** (owner's choice); handles hide in vertex-edit. Reuses the
    existing transform engine (snapshot→apply→undo-coalesce) and mirrors the vertex-drag pattern, so
    **no pan/touch/coordinate code was touched**. Verified live + geometry node-checked.
  - ⏳ **Only loose end:** I drove the handle drags with *synthetic* events — a real **laptop
    feel-test** (handle size/position, the after-release "snap to north") hasn't happened. Easy to tune.

- **Task 2 — Multi-wall 2c: RLS tenant isolation + per-board admin enforcement — DONE & DEPLOYED.**
  - `31d78ea` **app-side** (shipped first, forward-compatible): dropped the silent Barn auto-join →
    wall-less/new accounts land on a **"Join a wall to get started" onboarding screen** (reuses
    `WallsSettings` with a new `onboarding` flag + a `boardsResolved` splash gate); `onWallJoined`
    now lands+loads unconditionally; `isAdmin` (comment mod) **defaults false**.
  - `f68a23b` **RLS** — `008_rls_tenant_isolation.sql` **applied to prod** (atomic `begin/commit`):
    - helpers `app_is_member(uuid)` / `app_is_admin(uuid)` (SECURITY DEFINER, no RLS recursion);
    - **routes**: read = member of the board; insert = own **and** member; update/delete own (kept);
      **admin-any = board admin** (the hardcoded `paul@thisisyonder.com` policy is GONE);
    - **board_settings**: read stays authenticated; **write = board admin of the key's board** (any
      key ending in a board uuid → that board's admin; `playlists_<uid>` → that user; legacy globals
      → Barn admin) — closes the "any authed user can overwrite any wall's holds" hole;
    - **board_members**: self-join **public walls only** (private → `join_board_by_code` 007 fn);
      open self-leave removed (→ `leave_board` fn, last-admin-guarded);
    - **boards**: read = public OR member; **user_route_data**: read scoped to your walls;
      **sessions**: owner-private (unchanged).
  - `2c6842f` docs.
  - **Verified:** `scripts/verify_2c_rls.mjs` → **22/22** as a real user (anon client, `claude-test`):
    non-member fully walled off; member create-own-only (can't edit others' routes or write
    board_settings); board admin full control; private join-by-code + leave fns work; wrong code
    rejected; **no lockout** on Barn+Yonder. App smoke clean (Yonder renders 225 holds, 0 console
    errors). Backup **`pre-2c`** (135 rows, in `backups/`); rollback tag **`v1.8-pre-multiwall-2c`**;
    a commented **ROLLBACK block** is at the bottom of `008`.

**Multi-wall rollout is now 2a → 2b-i → 2b-ii → 2b-iii → 2b-iv → 2c all ✅. Billing is the next milestone.**

---

## Key facts / IDs
- **The Barn** `1c97fee6-285a-4774-a185-cb5f17e60acf`, slug `the-barn`, **PRIVATE**, owner/admin **Paul** (`9390639e-cd23-432b-94dc-fab38185f062`).
- **Yonder** `275dfaa7-1df9-4fe7-8332-c2795eb9ebe7`, slug `yonder`, **PUBLIC**, owner/admin Paul. ~225 holds, **0 routes** (hold IDs still editable).
- **`claude-test`** `b97b6928-fdce-4da1-902f-962b57cbe3e5` — dev-autologin user, **member (not admin)** of both walls.
- Supabase host `omsucewpjhfqjnpqdmsh.supabase.co`. Free plan → no managed backups; use `scripts/backup_tables.mjs <label>`.

---

## OPEN ITEMS (this thread's job)

1. **DECISION (ask Paul first): make The Barn public?** — *Most important.* Auto-join is gone, so a
   brand-new signup lands on onboarding and can only join a **public** wall (today only **Yonder**) or
   a **private** wall by code. **The Barn is private** → new people can't reach it unless Paul either
   flips it public (**Settings → Walls → Manage The Barn → "Make public"**, which calls the
   `set_board_visibility` fn) or shares its join code. Existing Barn members are unaffected.
2. **Hands-on verify Task 1** on a real laptop — rotate/scale handle *feel* (size/position; the
   snap-to-north after release). Tune `renderTransformHandles` in `BoardSetupView.jsx` if wanted.
3. **Live onboarding test** with a genuinely wall-less account — `claude-test` always has walls, so
   either create a throwaway no-membership user, or temporarily force the gate (see how I did it in
   `git show 31d78ea` / the session). Confirm: join public → lands on board with data; join-by-code →
   same; Sign out works.
4. **Hardening (not blocking, before a 200-user wall):**
   - `user_route_data` read policy uses a **per-row membership subquery**; prod has **no `user_id`
     indexes** — add indexes (`routes(board_id)`, `user_route_data(route_id)`, `board_members(user_id)`)
     before scale.
   - Comment moderation still uses the **global** `profiles.is_admin` (comments aren't per-wall) — make
     per-wall if/when needed.
   - `profiles.display_name` is **globally unique** (two walls can't both have a "Dave") — revisit for
     true multi-tenant.
5. **NEXT MILESTONE: billing** (per-wall plans/limits). No design exists yet — start with a Phase-1
   design pass + confirm with Paul.

---

## Conventions / gotchas (this project)
- **Auto-commit + push to `main`** after each working step (Vercel auto-deploys). **Always
  `git add <explicit files>` — never `git add -A`** (`.claude/settings.local.json` must never be committed).
- **Migrations: show Paul the SQL first**, he runs it in the Supabase **SQL editor** (DDL can't go via
  the service-role REST API). Plain DML/RPC can go through a service-role `.mjs`. **Backup + rollback
  tag before any DB change:** `node --env-file=.env.local scripts/backup_tables.mjs <label>` ; `git tag -a vX.Y-… && git push origin vX.Y-…`.
- **Verify RLS with a node script** (`scripts/verify_2c_rls.mjs` is the template: service-role for
  setup/teardown + anon client signed in as `claude-test` for the real policies) — **not** the preview.
  ⚠️ Running `signInWithPassword`/`signOut` for `claude-test` in a side script **invalidates the
  browser autologin session** (`AuthApiError: Invalid Refresh Token`) — harmless test artifact; restart
  the preview afterward. (Memory: `feedback-rls-verification`.)
- **Preview is flaky/multi-context** — verify with eval *data* + screenshots, not layout; servers are
  short-lived (restart with `preview_start` name `barn-board`). Occasionally an eval lands in a
  *visible, non-degenerate* context where real coords work; usually it's the hidden `bodyW:0` one.
  (Memory: `feedback-preview-multicontext`.)
- **Dev admin-bypass** to reach admin-gated UI as `claude-test`: temporarily
  `const isActiveBoardAdmin = activeBoard?.role === 'admin' || import.meta.env.DEV;` (App.jsx ~L53),
  **revert before commit**. Server-side RPCs/RLS still enforce real admin — for real admin tests make
  `claude-test` an admin of a **throwaway wall** (see `scripts/verify_2c_rls.mjs`).
- **Rollback 2c if ever needed:** uncomment + run the ROLLBACK block at the bottom of
  `supabase/migrations/008_rls_tenant_isolation.sql` (restores the permissive policies + drops the
  helpers); for code, `git checkout v1.8-pre-multiwall-2c`.
- **Laptop-first** for board setup; phone is a bonus (memory `feedback-laptop-first-setup`).
- **Workflow:** Opus designs → (optionally) orchestrates Sonnet → reviews; announce phases; update
  `CLAUDE.md` + `CURRENT_STATE.md` + a handover after each step. Fragile files
  (`BoardSetupView.jsx`, `App.jsx`) — precision edits, correctness is paramount.

---

## Kickoff prompt for the new thread
> Continuing the Barn Board app. Multi-wall **2c is already DONE & deployed** — your job is to
> sanity-check it and close out the loose ends, then start **billing**. Read these IN ORDER before
> doing anything:
>   1. `CLAUDE.md` (esp. *Admin System* + migrations `007`/`008`)
>   2. `CURRENT_STATE.md` (top entries)
>   3. `docs/MULTIWALL_2C_HANDOVER.md`  ← self-contained brief; **OPEN ITEMS** is your task list
>   4. `supabase/migrations/008_rls_tenant_isolation.sql` + `scripts/verify_2c_rls.mjs`
> Then skim `git log --oneline -12` (HEAD should be the 2c handover commit).
>
> This is an Opus thread. Follow design → build → verify; commit+push to `main` after each working
> step (NEVER `git add -A`); show me any SQL before it runs; backup + rollback tag before DB changes.
>
> Start by: (a) asking me whether to **make The Barn public** (auto-join is gone, so new signups can
> currently only reach Yonder or a private wall by code — see OPEN ITEM 1), and (b) re-running
> `node --env-file=.env.local scripts/verify_2c_rls.mjs` to confirm 2c is still green (22/22). Then
> walk me through the remaining OPEN ITEMS and propose where to begin on billing.
