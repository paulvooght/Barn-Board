# Handover — Copy/Paste Polish, then Multi-wall 2c (2026-06-07)

Self-contained brief for a **fresh Opus thread**. Two jobs, in order:
1. **Copy/paste polish** in the Hold Manager (design approved — build it).
2. **Multi-wall 2c** — RLS tenant isolation + per-board server-side admin enforcement.

**Read first, in order:** `CLAUDE.md` → `CURRENT_STATE.md` (top entries) → this file → `git log --oneline -15`.
**HEAD when written:** `dd7acdf` (working tree clean except `.claude/settings.local.json`, which is local and never committed).

---

## Where we are (the recent arc)
- **Hold-detection redesign** (object-first SAM) shipped earlier; the in-app **live-SAM "Tap" tool was built, tested, then REMOVED** (2026-06-07) — best-of-3 ≈ single-guess on this dense, *repeated-hold* wall; copy/paste fits better. Encode/decode scripts parked. (See `docs/HOLD_DETECTION_HANDOVER.md`.) This is **why copy/paste polish is next** — the owner's wall reuses the same physical holds, so "outline one, stamp the rest" is the high-value workflow.
- **Multi-wall 2a / 2b-i / 2b-ii / 2b-iii / 2b-iv — all DONE & deployed.** 2b-iv (this session) added join/onboarding + member management in a Settings **"Walls"** section (header switcher removed); migration `007_board_membership_fns.sql` added 5 SECURITY DEFINER fns. See `MULTIWALL_2B_HANDOVER.md`. **2b is complete.**
- **Now:** copy/paste polish (Task 1), then **2c** (Task 2) — the last multi-wall hardening before billing.

### Key facts / IDs
- **The Barn** board_id `1c97fee6-285a-4774-a185-cb5f17e60acf`, slug `the-barn`, **private** (owner wants it public — flip via the new Settings → Walls → Manage → "Make public" toggle; not yet done).
- **Yonder** board_id `275dfaa7-1df9-4fe7-8332-c2795eb9ebe7`, slug `yonder`, **public**, owner/admin **Paul** (`9390639e-cd23-432b-94dc-fab38185f062`). ~225 holds (owner has been tidying it in-app), **0 routes** (so hold IDs are still editable).
- Dev autologin user **`claude-test`** (`b97b6928-fdce-4da1-902f-962b57cbe3e5`) — **member** (not admin) of The Barn + Yonder. To reach the admin-gated **Hold Manager** in preview, use a **temporary dev admin-bypass** then revert (see Conventions).
- Supabase project host `omsucewpjhfqjnpqdmsh.supabase.co`. Free plan → no Supabase backups; use `scripts/backup_tables.mjs`.

---

## TASK 1 — Copy/paste polish (APPROVED design — build this)

**Goal:** make stamping repeated holds fast. File: **`src/components/BoardSetupView.jsx`** (the Hold Manager). This is the most complex, load-bearing file — touch/pan/coordinate code is "DO NOT CHANGE casually" (CLAUDE.md). The changes below are additive to the existing copy/paste flow.

### What exists today (anchors by function, line numbers drift)
- `copySelected()` — copies the first selected hold → `clipboard` state, `setActiveTool(TOOLS.COPY)`, `clearSelection()`. **Already bound to `Cmd/Ctrl+C`** in the keyboard `useEffect` (`if (isMeta && e.key==='c' && selectedId) copySelected()`).
- `doPaste(pct)` — translates `clipboard.polygon` so its centroid lands on the click `pct` (board-%), mints a `custom_<ts>` hold (carries color/name/holdTypes/positivity), adds it. **Currently single-paste:** resets `clipboard=null`, `setActiveTool(TOOLS.SELECT)`, selects the new hold.
- `handleClick(pct)` COPY branch: `if (activeTool===TOOLS.COPY){ if(clipboard) doPaste(pct); return; }`.
- Keyboard `useEffect` (~L367–396): Cmd+Z/redo, Delete/Backspace, **Cmd+C**, Cmd+A, **Esc** (cancels paste/draw/selection). Deps array includes `clipboard`, `selectedId`, etc.
- COPY-mode toolbar block: `{activeTool===TOOLS.COPY && clipboard && ( … <button …>Cancel</button> )}` — **currently Cancel only**.
- `Copy` button in the selection-actions row: `<button onClick={copySelected} … >Copy</button>`.
- Styling: `secBtnStyle` (secondary button), CSS vars (`--accent`, `--accent-dim`, `--border`, `--bg-card`, `--text-secondary`, `--text-dim`).
- SVG render: holds drawn as `<polygon>` via `toSvgX/toSvgY`. **Coordinate conversion uses `getBoundingClientRect()` + letterbox math (NOT `getScreenCTM`)** in BoardSetupView (iOS Safari). `getSvgScale()` helper exists. `lastTouchTimeRef` guards synthesized mouse after touch.

### Build (the approved flow)
1. **State:** `pasteMode` ('single' default | 'multi') + a `pasteModeRef` mirror (handlers read the ref — React closures go stale). `placedCount` (for the Multi counter). Set `pasteMode='single'` on copy.
2. **Shift modifier (laptop):** add a `shiftHeldRef` updated on `keydown`/`keyup` of Shift (extend the keyboard `useEffect` or add listeners). Touch has no shift.
3. **`doPaste(pct)`:** compute `const stay = pasteModeRef.current==='multi' || shiftHeldRef.current;`. Create + add the hold (same translate logic). Then:
   - `stay` → **keep** `clipboard` + stay in COPY mode (no reset); `placedCount++`; do **not** change selection.
   - `!stay` → reset `clipboard=null`, `setActiveTool(SELECT)`, select the new hold (current behavior).
   - **Shift and pasteMode are INDEPENDENT** — shift does NOT flip pasteMode. So in single mode: holding Shift keeps stamping, a normal click stamps the last one and exits. In multi mode: every click stamps until **Done**, regardless of shift.
4. **COPY-mode toolbar** → replace Cancel-only with: **[Single] · [Multi / Done] · Cancel** + a small **"Placed N"** while in multi + a one-line hint.
   - **Single**: active style when `pasteMode==='single'`; onClick → `setPasteMode('single')` (stay in COPY).
   - **Multi/Done**: label = `pasteMode==='multi' ? 'Done' : 'Multi'`. onClick → if 'single' → `setPasteMode('multi')`; if 'multi' → **exit** (`clipboard=null`, `activeTool=SELECT`, reset pasteMode/placedCount).
   - **Cancel**: same exit.
   - Match the existing `secBtnStyle` / accent-toggle look (see the Mode toggle + WallsSettings.jsx for the active-button pattern).
5. **Ghost preview — APPROVED, ADD IT (laptop/mouse only):** while in COPY mode, on `mousemove` over the board, render a **translucent dashed `<polygon>`** of `translatePolygon(clipboard.polygon, dx, dy)` centred at the cursor (board-%), so placement is visible before clicking. Touch has no hover → no preview (tap places directly). 
   - Convert cursor→board-% with the **existing letterbox conversion** (NOT getScreenCTM). Store in a `pastePreviewPct` state/ref; clear on mouseleave / tool switch / paste-exit. Render it in the SVG overlay near the hold-render loop.
   - ⚠️ **Integrate WITHOUT disturbing pan/touch.** Only track on mouse move when `activeTool===TOOLS.COPY`; ignore synthesized mouse after touch (`lastTouchTimeRef`). Don't change the pan/zoom or touch handlers.
6. Keep `Cmd/Ctrl+C` (already works). Keep Esc = cancel.

### Verify (laptop viewport primary; also check touch)
- Hold Manager is admin-gated; `claude-test` is a member → use the **dev admin-bypass** (`const isActiveBoardAdmin = activeBoard?.role === 'admin' || import.meta.env.DEV; /* REVERT */`) to reach it, then **revert before committing**. Switch to a wall with holds (Yonder).
- Flow: Copy a hold → **Single** (one stamp → Select); **Multi** (stamp several → "Placed N" → **Done** → Select); **Shift+click** keeps stamping, a normal click ends it; **Cmd+C** copies; **ghost preview** follows the cursor; **Esc** cancels.
- `npm run build` green; zero console errors. Verify mouse AND a touch viewport (touch: buttons only — no shift/preview). Commit + push each step.
- **Note:** board setup is **laptop-first**; phone is a welcome bonus, not a goal (memory `feedback-laptop-first-setup`) — don't let touch/preview edge cases block the laptop flow.

---

## TASK 2 — Multi-wall 2c (RLS tenant isolation) — AFTER copy/paste

**Goal:** replace the "pragmatic trust" / permissive RLS (fine for friends) with real per-wall isolation + per-board admin enforcement, server-side. This is **sensitive** (RLS mistakes lock people out) — do a **Phase-1 design pass + show Paul all SQL before running**, backup + rollback tag first.

**What 2c must do (from CURRENT_STATE "Admin model is split" + "Multi-Wall Readiness"):**
- **Routes:** replace the **hardcoded-email** policy (`paul@thisisyonder.com` can edit/delete others' routes) with **per-board roles** (`board_members.role='admin'`), so each wall's admin manages *that* wall. Scope route read/write to board membership.
- **`board_settings`:** currently writable by **any authenticated user** (holds + image config). Tighten to **board admins** of the relevant `<boardId>` key. (Keys: `holds_<id>`, `board_image_config_<id>`, `playlists_<userId>`, legacy globals.)
- **`board_members` / `boards`:** tighten the permissive 2a policies (boards `authenticated read true`; members `join-self` / `leave-self`) → members see only their walls' data; public walls discoverable; private walls joined only via the **`join_board_by_code`** DEFINER fn (already built). The **007 SECURITY DEFINER fns re-check perms internally** and are 2c-forward-compatible — keep using them for privileged ops.
- **`sessions` / `user_route_data`:** scope by board / owner.
- **Client:** default `isAdmin` to **false** (currently fails open when `VITE_ADMIN_EMAIL` unset).
- Verify nobody gets locked out: test as a member, an admin, and a non-member, on a throwaway wall (the 2b-iv pattern — `/tmp/zz_test_wall.mjs` is a good template). Schema reconcile via `scripts/dump_schema.sql`.

---

## Conventions / gotchas (this project)
- **Auto-commit + push to `main`** after each working step (Vercel auto-deploys; owner preference). **Always `git add <explicit files>` — never `git add -A`** (`.claude/settings.local.json` must never be committed).
- **Migrations: show Paul the SQL first.** He runs it in the Supabase **SQL editor** (DDL can't go via the service-role REST API). Plain INSERT/UPDATE/RPC-calls can go through a service-role `.mjs` (see `scripts/seed_yonder.mjs`). Take **backup + rollback tag** before DB changes: `node --env-file=.env.local scripts/backup_tables.mjs <label>`; `git tag -a vX.Y-… && git push origin vX.Y-…`.
- **Preview is flaky:** dev servers are short-lived — restart with `preview_start` name `barn-board`. Verify interactive state in **one deterministic eval** (normalize → act → `await` → read DOM); eval/click can hit a hidden `bodyW:0` context (memory `feedback_preview_multicontext`). React state is async — never read the DOM synchronously after `.click()`.
- **Dev admin-bypass** to reach admin-gated UI as `claude-test`: temporarily `|| import.meta.env.DEV` on `isActiveBoardAdmin` (App.jsx ~L53), **revert before commit**. NB: server-side RPCs still enforce real admin — for full admin RPC tests, make `claude-test` a real admin of a **throwaway wall** (see `/tmp/zz_test_wall.mjs` from 2b-iv: create / seed-admin / prep-code / teardown).
- **Workflow:** Opus designs → (optionally) orchestrates → reviews; announce phases; update `CLAUDE.md` + `CURRENT_STATE.md` + the relevant handover after each step. This session did precision edits directly (the fragile files) rather than spawning subagents — either is fine; correctness on `BoardSetupView.jsx`/`App.jsx` is paramount.
- **Laptop-first** for setup; phone is a bonus (memory `feedback-laptop-first-setup`).
