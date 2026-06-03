# CLAUDE.md — Operating Manual for Claude Code

## What This App Is
Climbing route logger for a private angle-adjustable climbing board (4.8m wide x 4.5m tall, 18-55 degrees). The owner is learning to code via vibe coding — explain decisions clearly and keep things approachable. Primary use is on a phone at the board, also used on laptop for setup.

### Social / Multi-User Model
Multiple users share one physical board. Any user can create routes, and all routes are visible to everyone — so you climb problems set by others with different styles, preferences, and abilities. This creates variety and pushes climbers outside their comfort zone (you can't just set what you're good at). Users can search/filter by setter to find favourite route-setters.

**What's per-user (private):**
- **Sent status** — each user tracks their own sends independently. Climber A may have sent a route while Climber B hasn't.
- **Star ratings** — each user submits their own rating. The route card shows the **community average** of all ratings. The same star UI both displays the average and lets the user contribute their own.
- **Playlists** — users create private playlists to organise routes for their sessions. Playlists can optionally be shared between users.
- **Sessions** — each user's session data (sends, attempts, angles climbed) is their own.

**What's shared (community):**
- **Routes** — visible to all users, but only the **creator can edit** the route (name, holds, grade, metadata).
- **Hold types, techniques, styles** — set by the route creator only. Other users can view this info but not change it.
- **Angle-grades** — shared across all users (e.g. "V4 at 30°, V5 at 35°").
- **Hold data** — one physical board, hold positions/metadata shared by all users.
- **Comments** — anyone can post on any route; everyone sees them. The route creator's name is highlighted yellow with a 'setter' pill. Admin can hard-delete; users can flag 'Neg' for admin review, or 'Like' with a thumb.

## Tech Stack
- **React 18** + **Vite 6** — no router, no state library, single-page app with view state machine
- **Supabase** — auth (email/password), database (routes, sessions, playlists, hold data)
- **localStorage** — local cache layer, auto-migrated to Supabase on first login
- **Python 3** (Pillow + numpy) — hold detection script only (not part of the app runtime)
- **Hosted on Vercel** — auto-deploys from GitHub `main` branch
- **GitHub repo:** `paulvooght/Barn-Board` (public)

## Architecture

### View State Machine (App.jsx)
```
board → create        (route creation / editing with hold selection on board)
board → routes        (saved route list: playlists, filtering, sorting, shared playlists)
board → viewRoute     (view saved route on dimmed board; swipe carousel between routes)
board → sessions      (Sessions tab: climber card, heat map, history — behind beta toggle)
board → settings      (grade system, Hold Manager, board image, beta features, account)
board → sessionSummary (session recap after Stop Session)
sessions/settings → sessionEdit (edit a past session)
settings → setupBoard (Hold Manager — BoardSetupView)
settings → updateBoardImage (board image wizard — BoardImageUpdateView)
board → holdSelect / addHold / editHold (HoldEditorView — polygon + metadata editor)
```

### Three-Layer Hold Data (useCustomHolds.js)
1. `src/data/holds.json` — base holds, auto-detected by Python script (25 holds)
2. `hold_overrides` (Supabase `board_settings` + localStorage cache) — edits to detected holds
3. `custom_holds` (Supabase `board_settings` + localStorage cache) — user-created holds
4. `replaceAllHolds()` — bulk replacement from Hold Manager (hides base holds, stores all as custom)

### Supabase Schema
| Table | PK | Content |
|-------|----------|---------|
| `routes` | `id` (text) | `user_id` (creator), `data` (route JSON, per-user fields stripped), timestamps |
| `user_route_data` | (`user_id`, `route_id`) | per-user `sent`, `flashed`, `attempted`, `rating`, `angle_sends[]`, `angle_flashes[]`, `angle_attempts[]`, `grade_suggestions` (jsonb), timestamps |
| `sessions` | `id` (text) | `user_id`, `data` (full session JSON), timestamps |
| `board_settings` | `key` (text) | `data` (JSON blob) — shared board config |
| `profiles` | `user_id` | `display_name` (globally unique), `is_admin`, timestamps |
| `route_comments` | `id` | `route_id`, `user_id`, `body`, `likes[]`, `flags[]`, timestamps |
| `shared_playlists` | `id` | `user_id`, `name`, `creator_name`, `route_ids[]`, timestamps |

**Storage:** `board-images` bucket — full + 800w/1200w/2000w variants per board image.

**board_settings keys:** `hold_overrides`, `custom_holds`, `board_image_config`, `playlists_${userId}`

**Schema is captured in `supabase/migrations/`:**
- `000_core_tables.sql` (backfill) — `routes`, `sessions`, `board_settings`, `user_route_data`, `shared_playlists`. **Structures AND RLS verified against live prod (2026-06-03)** — `000` mirrors production exactly (column types/defaults, policy names, roles, expressions). Numbered `000` so fresh rebuilds create base tables before later ALTERs. Re-check anytime with `scripts/dump_schema.sql`. Note: prod has **no FK constraints** and **no `user_id` indexes** — `000` reproduces that faithfully.
- `001_profiles.sql`, `002_route_comments.sql`, `003_user_route_data_angle_states.sql` — profiles, comments, and the `user_route_data` angle columns.
- `scripts/dump_schema.sql` — paste into the Supabase SQL editor to dump live RLS/defaults/FKs/indexes for reconciliation (the parts OpenAPI can't expose).

### Supabase Sync Pattern
- **Immediate flush** on critical writes (save route, end session)
- **Debounced 1500ms** on non-critical changes
- **Realtime subscription** on the `routes` table (INSERT/UPDATE/DELETE) — instant cross-device route sync via `supabase.channel('routes-realtime')`
- **Tab visibility listener** — re-fetches all data when tab becomes visible (catch-all sync)
- **Offline pending-route queue** (`pendingRouteSync.js`) — localStorage-backed; a created route is queued before the network call and retried on load, tab-visibility, and the `online` event, so it can't vanish if the network blinks
- **First login migration** — moves localStorage data to Supabase automatically

### Data Access Layer (`src/lib/db.js`)
- **All Supabase TABLE access goes through `src/lib/db.js`.** Components/hooks never call `supabase.from(...)` directly — use `db.fetchRoutes()`, `db.upsertUserRouteData(...)`, `db.fetchComments(...)`, etc. Each helper is a thin 1:1 wrapper (same columns, conflict keys, payload) returning `{ data, error }`.
- **Why:** one home for column names + conflict keys, and the place a `board_id` filter gets added once for multi-wall (instead of ~35 call sites).
- **Exceptions (stay on `supabase` directly):** auth (`supabase.auth.*` in AuthView/Settings/App) and the realtime channel (`supabase.channel('routes-realtime')` in App). These aren't table access.
- **Rule:** when adding a new query, add a helper to `db.js` rather than calling `supabase.from(...)` in a component.

### Admin System
- `VITE_ADMIN_EMAIL` env var determines the admin user
- Only admin sees Hold Manager button in Settings
- Hold data (overrides + custom holds) is shared across all users (one physical board)
- Admin status is now sourced from `profiles.is_admin` (set manually via SQL after first signup). `VITE_ADMIN_EMAIL` remains as a bootstrap fallback so the first admin isn't locked out before promoting their profile row.
- ⚠️ **Admin enforcement is split (verified against live RLS 2026-06-03):**
  - **Routes:** editing/deleting *others'* routes is gated server-side to a **hardcoded email** (`paul@thisisyonder.com`) in RLS — not `profiles.is_admin`.
  - **Comments:** delete uses `profiles.is_admin` (a different mechanism).
  - **`board_settings` (hold data + image config):** writable by **any authenticated user** server-side — so Hold-Manager / image-wizard edits are protected *only* by the client-side `isAdmin` gate, which **fails open** when `VITE_ADMIN_EMAIL` is unset.
  - **Fixes:** default `isAdmin` to `false`; tighten `board_settings` writes before a public wall; replace the hardcoded-email route policy with per-board roles (`board_members`) for multi-wall — otherwise only Paul can admin any wall.

### Key Files
*Line counts are approximate (rounded) — kept loosely in sync, don't treat as exact.*

| File | Lines | Purpose |
|------|-------|---------|
| `src/App.jsx` | ~3040 | View state machine; route/session/playlist CRUD; per-user data & community grades; **all four sync paths** (immediate + debounce + realtime + offline queue). Also defines `ViewRouteHeader` (~680 lines), `NewAngleSuggestionRow`, `NavButton` inline. **Refactor target.** |
| `src/components/BoardView.jsx` | ~535 | Board image + SVG overlay + zoom/pan + route-view dimming |
| `src/components/BoardSetupView.jsx` | ~2270 | Hold Manager — Select/Draw/Copy tools, Boundaries/Hold-Info/Heatmap modes, undo/redo, lasso, copy-paste, vertex edit. **Most complex file.** |
| `src/components/BoardImageUpdateView.jsx` | ~1790 | Board-image wizard: upload → crop → align → fine-tune → confirm, with perspective warp |
| `src/components/HoldEditorView.jsx` | ~810 | Individual hold polygon + metadata editor |
| `src/components/HoldOverlay.jsx` | ~126 | SVG per-hold render for route view (outlines + labels) |
| `src/components/RouteList.jsx` | ~890 | Routes list: sort, filter (incl. setter search), hide-sent, playlists + shared-playlist browse |
| `src/components/RouteCard.jsx` | ~182 | Route card (grade, angle, 4-state send, rating, missing-hold indicator) |
| `src/components/RouteViewCard.jsx` | ~319 | Full viewRoute presentation for one route (used by the swipe carousel) |
| `src/components/RouteForm.jsx` | ~226 | Route create/edit form with auto hold-type collection |
| `src/components/SentCycleButton.jsx` | ~92 | 4-state send control: empty → tried → sent → flash |
| `src/components/Settings.jsx` | ~860 | Display name, grade system + chart, admin/climber mode, board specs, beta toggles, account (sign out, change password), session history |
| `src/components/SessionsView.jsx` | ~332 | Sessions tab orchestrator (period picker + climber card + heat map + cards) |
| `src/components/ClimberCard.jsx` | ~380 | Headline stats, strengths/weaknesses, climber-type, period deltas |
| `src/components/HoldHeatMap.jsx` | ~366 | Hold-usage heat-map overlay on the board image |
| `src/components/PeriodPicker.jsx` | ~255 | Session / week / month / all-time period selector |
| `src/components/UnfinishedBusinessCard.jsx` | ~208 | Routes tried but not yet sent |
| `src/components/SessionRoutesCard.jsx` | ~194 | Routes logged in one session (collapsible) |
| `src/components/SessionHistoryAccordion.jsx` | ~198 | Collapsible past-session list |
| `src/components/SessionSummary.jsx` | ~348 | Session recap after Stop Session |
| `src/components/SessionEditView.jsx` | ~886 | Edit a past session (sends, angles, times) |
| `src/components/CommentsSection.jsx` | ~315 | Comment thread on viewRoute — fetch, post, like, flag, admin-delete |
| `src/components/CommentItem.jsx` | ~292 | Single comment row — name/setter pill, like/flag/delete |
| `src/components/GuidedCameraStep.jsx` | ~426 | Camera-guidance overlay for board-image capture |
| `src/components/AuthView.jsx` | ~88 | Email/password login + signup |
| `src/components/ModeSelector.jsx` | ~28 | Hold-selection mode buttons |
| `src/components/TagPicker.jsx` | ~42 | Multi-select tag picker with auto-highlight |
| `src/components/Icon.jsx` | ~37 | Inline SVG icon set |
| `src/hooks/useCustomHolds.js` | ~147 | Three-layer hold data + Supabase sync |
| `src/hooks/useLocalStorage.js` | ~27 | localStorage-backed React state |
| `src/hooks/useUndoRedo.js` | ~106 | Undo/redo state snapshots (max 50) |
| `src/lib/supabase.js` | ~12 | Supabase client init + `ADMIN_EMAIL` export |
| `src/utils/constants.js` | ~195 | Grades, grade conversion, modes, colours, hold types, board specs, YouTube helpers, default board image |
| `src/utils/sessionStats.js` | ~701 | Pure stats engine for Sessions/Climber Card (periods, deltas, heat) |
| `src/utils/heatMap.js` | ~157 | Pure hold-usage counting for the heat map |
| `src/utils/polygonUtils.js` | ~272 | Polygon math — centroid, bbox, translate, rotate, hit-test |
| `src/utils/nameGenerator.js` | ~36 | Random route-name suggestions |
| `src/utils/pendingRouteSync.js` | ~67 | localStorage offline queue for unsynced routes |
| `src/data/holds.json` | — | Base hold positions + polygons + `boardRegion` |
| `scripts/detect_holds.py` | — | Python hold detection from board photo |
| `scripts/merge_holds.py` | — | ID-preserving merge of re-detected holds |
| `scripts/publish_board_image.py` | — | Upload image variants + write `board_image_config` |

### Board Image Coordinate System
- Hold positions (`cx`, `cy`) are **percentages within the BOARD AREA** (0-100), not the full image
- Board region within the photo defined in `holds.json`: `boardRegion: { left, top, width, height }` — single source of truth. The image-update wizard perspective-warps any new photo so the physical board fits this region exactly.
- Conversion: `SVG_x = boardRegion.left% × imgW + (hold.cx / 100) × boardRegion.width% × imgW`
- SVG overlays use `viewBox="0 0 naturalWidth naturalHeight"`
- **BoardView** uses `preserveAspectRatio="none"` (image fills width)
- **BoardSetupView** uses `preserveAspectRatio="xMidYMin meet"` (image may be height-constrained on laptop — YMin aligns SVG to top matching image's flex-start alignment)
- Coordinate conversion uses `svg.getScreenCTM().inverse()` for accuracy across zoom/pan

## Data Shapes

### Route (shared — stored in `routes` table)
```json
{
  "id": "timestamp", "name": "", "grade": "V3", "angle": 30,
  "setter": "", "creatorId": "user_id", "youtubeUrl": "",
  "holds": { "holdId": "start|hand|foot|handOnly|finish" },
  "holdSnapshots": { "holdId": { "cx", "cy", "polygon", "w_pct", "h_pct", "r", "color", "holdTypes" } },
  "holdTypes": ["Jugs"], "techniques": ["Heel hooks"], "styles": ["Power"],
  "angleGrades": [{ "angle": 30, "grade": "V4" }],
  "createdAt": "ISO", "updatedAt": "ISO"
}
```
*Only the creator (matched by `creatorId`) can edit the route.*

### Per-User Route Data (one row per user per route — `user_route_data` table)
```json
{
  "sent": false, "flashed": false, "attempted": false,
  "rating": 0,
  "angleSends": [30], "angleFlashes": [], "angleAttempts": [30],
  "gradeSuggestions": { "headline": "V4", "angles": { "30": "V4" } }
}
```
*All per-user. Send state is a 4-state cycle (empty → tried → sent → flash), tracked both route-wide (`sent`/`flashed`/`attempted`) and per-angle (`angleSends`/`angleFlashes`/`angleAttempts`). The route card shows the **community average** rating and **community-consensus** grade (derived in App.jsx from everyone's `gradeSuggestions`, re-normalised to the viewer's grade system).*
```

### Hold
```json
{
  "id": "hold_1|custom_123", "cx": 50, "cy": 30,
  "w_pct": 5, "h_pct": 3, "r": 0,
  "polygon": [[x, y], ...],
  "color": "cyan", "confidence": "high",
  "name": "", "holdTypes": ["Crimp"], "positivity": 0, "material": "Wood"
}
```

### Session
```json
{
  "id": "timestamp", "startTime": "ISO", "endTime": "ISO",
  "boardAngle": 30,
  "sends": [{ "routeId": "", "angle": 30, "grade": "V3", "time": "ISO" }],
  "routesAttempted": ["id"], "routesCreated": ["id"], "anglesClimbed": [30, 35]
}
```

## Selection Modes (Route Creation)
| Mode | Color | Purpose |
|------|-------|---------|
| `start` | `#34d399` green | Starting hold |
| `hand` | `#22d3ee` cyan | Regular hand hold |
| `foot` | `#fbbf24` yellow | Foot-only hold |
| `handOnly` | `#c084fc` purple | Hand-only hold |
| `finish` | `#f87171` red | Finish/top hold |

## Style Guide
- **Peach background** `#FFAB94`, white cards, dark text `#1A0A00`
- **Accent blue** `#0047FF`
- **Fonts:** DM Sans (body), **Kodchasan** (headings) — both **self-hosted** via `@fontsource` (imported in `src/main.jsx`), bundled + service-worker precached. No Google Fonts round-trip, no flash-of-fallback after first load. Use the CSS vars `var(--font-body)` / `var(--font-heading)` (defined in `src/App.css`), not hardcoded family strings.
- **Mobile-first** — max-width 480px, primary use on phone
- Warm industrial aesthetic, minimal chrome, high information density
- Hold overlays: 10px stroke width for visibility
- Route view: dimmed board with full-intensity hold cutouts via SVG mask
- Hold Manager: green outlines (high confidence), red dashed (medium confidence)

## Coding Rules

### Touch vs Mouse (CRITICAL — DO NOT CHANGE)
- All interactive SVG surfaces handle touch and mouse **separately**
- `lastTouchTimeRef` pattern: stamp `Date.now()` on touchstart, ignore mouse within 500ms
- Use refs (`closedRef`, etc.) for state in event handlers — React closures go stale
- Vertex `onTouchStart` must ALWAYS `e.stopPropagation()`
- Track touch vertex drag via `touch.identifier` (not `setPointerCapture`)

### SVG Coordinate Conversion (CRITICAL — DO NOT CHANGE)
- **BoardView** (route creation/viewing): uses `getScreenCTM().inverse()` — no CSS zoom transform, so CTM is accurate
- **BoardSetupView** (Hold Manager): uses `getBoundingClientRect()` + manual letterbox math — because `getScreenCTM()` doesn't reliably include CSS `transform: scale()` on non-SVG ancestors in iOS Safari
- The letterbox math accounts for `preserveAspectRatio="xMidYMin meet"`: compute `uniformScale = min(rect.w/vbW, rect.h/vbH)`, then `xOffset` for xMid centering and `yOffset=0` for YMin
- `getSvgScale()` helper in BoardSetupView returns screen-pixels-per-SVG-unit using the same approach
- Pixel-distance checks: use `getSvgScale()` in BoardSetupView, `getScreenCTM().a` in BoardView

### Route View Dimming
- SVG mask: white base (full dim) + black polygon cutouts for selected holds
- Dimming rect: `fill="black"` + `opacity="0.5"` + `mask="url(#holdMask)"`

### Zoom/Pan
- CSS `transform: translate(x,y) scale(s)` on wrapper div
- State in both React state and refs (for event handlers)
- Mouse wheel: three-tier dampening (deltaY <10 gentle, <50 moderate, >=50 normal)
- Single-finger pan only when zoomed > 1x

### Copy/Paste (BoardSetupView)
- `_origPoly` stored on hold during paste → rotate always from original (prevents drift)
- `_pasteCx`, `_pasteCy` track placement — cleaned up on Done

## Environment Variables
```
VITE_SUPABASE_URL=https://xxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
VITE_ADMIN_EMAIL=user@email.com
```
Set in **Vercel project settings** for production AND `.env.local` for local dev.

### Optional: dev autologin for UI verification
The app supports a dev-only autologin so Claude (or any developer) can run preview-based UI tests without manually signing in past the Supabase auth screen. Add these to `.env.local` (NEVER to Vercel — they're hard-disabled in production by `import.meta.env.DEV`):
```
VITE_DEV_AUTOLOGIN=true
VITE_DEV_AUTOLOGIN_EMAIL=claude-test@…   # a dedicated test user
VITE_DEV_AUTOLOGIN_PASSWORD=…
```
Implementation lives in `src/App.jsx` (auth `useEffect`). One-time setup: create a dedicated test user in Supabase (Auth → Users → Add user → tick "Auto Confirm User"), then add the three vars above.

**For Claude doing UI verification in a worktree:** `.env.local` is gitignored, so a fresh worktree won't have it. Copy from the main repo: `cp /path/to/main/repo/.env.local /path/to/worktree/.env.local`. Vite reads env vars at startup, so restart `npm run dev` after copying.

## Running & Deploying
```bash
npm install
npm run dev              # Local dev at http://localhost:5173
git push origin main     # Auto-deploys to Vercel
```

## Board Image Updates & Hold Detection (CRITICAL — READ BEFORE TOUCHING HOLDS)

### Why This Matters
Routes reference holds by ID (`hold_1`, `hold_5`, etc.). If hold IDs change or scramble, **every existing route silently breaks** — holds render in wrong positions. This is the most destructive thing that can happen to the app's data.

### The Danger
`detect_holds.py` assigns IDs sequentially by sorted position (`hold_1`, `hold_2`, ...). If the board photo changes — even slightly — and new holds are detected between existing ones, **every ID after the insertion point shifts**. `hold_5` becomes a completely different physical hold. All routes referencing the old `hold_5` now point to the wrong place.

### Safe Workflow: Additive Hold Merge
**NEVER run `detect_holds.py` and directly overwrite `holds.json`.** Instead:

```bash
# Step 1: Detect holds from new photo into a SEPARATE file
python3 scripts/detect_holds.py --output src/data/holds_new.json

# Step 2: Merge new detections into existing holds (preserves IDs)
python3 scripts/merge_holds.py src/data/holds.json src/data/holds_new.json

# Step 3: Review the merge report, then commit

# Step 4: Publish the new image to Supabase (uploads + writes board_image_config)
python3 scripts/publish_board_image.py Barn_Set_01_V6
```

Step 4 uploads all four image sizes (full + 800w/1200w/2000w responsive variants) to the `board-images` Supabase storage bucket, then upserts `board_settings` with `key='board_image_config'`. This is the same config the in-app wizard writes, so both code-based and wizard-based updates flow through a single source of truth — whichever ran last wins. The app picks up the new image on next load or tab switch.

**`SUPABASE_SERVICE_ROLE_KEY` must be set in `.env.local`** (not in Vercel). The service-role key is required because storage uploads and direct `board_settings` writes bypass RLS. Find it in the Supabase dashboard under Project Settings → API. The app itself uses the anon key (`VITE_SUPABASE_ANON_KEY`) — the service-role key is for local developer scripts only and must never be committed or exposed in production.

The merge script:
1. **Spatially matches** each new detection to the nearest existing hold (within 5% distance threshold)
2. **Matched holds**: keeps the OLD ID, optionally updates position/polygon if the new detection is more accurate
3. **Unmatched new holds**: assigned new sequential IDs continuing from the highest existing number (e.g., `hold_44`, `hold_45`)
4. **Unmatched old holds**: flagged as "possibly removed from board" but NOT deleted (routes may still reference them)
5. Outputs a merge report showing what matched, what's new, what's orphaned

### NEVER Do These
- ❌ Run `detect_holds.py` and let it overwrite `holds.json` directly
- ❌ Use "Reset All" in Hold Manager when routes exist (wipes all IDs)
- ❌ Use `replaceAllHolds()` — it converts all IDs to `custom_` prefix, breaking route references
- ❌ Manually renumber hold IDs
- ❌ Delete holds that existing routes reference

### Safe Operations
- ✅ Add new holds via Hold Manager (gets `custom_` + timestamp ID — unique, never collides)
- ✅ Edit hold position/polygon in Hold Manager (keeps same ID)
- ✅ Use merge script after re-detection (preserves IDs)
- ✅ Hide holds via overrides (`hidden: true`) — reversible

### Re-detecting Holds (Raw Detection Only)
```bash
pip install Pillow numpy opencv-python-headless requests
python3 scripts/detect_holds.py    # Writes to holds_new.json (NOT holds.json)
```

## Development Workflow

**3-phase single-session system: Opus designs, orchestrates Sonnet subagents, and reviews — all in one Code tab session.**

Subagents run in isolated contexts. Only short summaries return to Opus, keeping the parent session lean. The heavy work (file reads, edits, builds) happens in disposable subagent contexts.

**Phase announcements (REQUIRED):** At the start of each phase, announce it clearly so the user always knows where they are:
- `## Phase 1: Design` — when beginning design discussion
- `## Phase 2: Execution` — when launching the first subagent
- `## Phase 3: Review` — when beginning the review after all subagents complete

### When to skip Opus (go straight to Sonnet)
| Task | Use |
|---|---|
| Typo, colour change, single CSS tweak | Sonnet directly |
| Single-component change describable in one sentence | Sonnet directly |
| Bug with known cause and file | Sonnet directly |
| Multi-file feature, anything with design decisions | Full 3-phase workflow |
| Bug with unknown root cause | Opus + systematic debugging |

### Phase 1: Design Intent (Opus)
Before any code is written, bring the feature to an Opus Code session.

- Read CLAUDE.md and CURRENT_STATE.md for full context
- Ask clarifying questions to surface what's actually wanted
- Present 2-3 design options with tradeoffs
- Get explicit sign-off on the chosen approach
- **Output:** An approved design with a precise task list (file paths, verification steps)

### Phase 2: Orchestrated Execution (Opus → Sonnet subagents)
After approval, Opus orchestrates execution without leaving the session.

- Opus spawns sequential Sonnet subagents via `Agent(model: "sonnet")`, one per task
- Each subagent prompt includes: the task spec, relevant file paths, and CLAUDE.md coding rules
- Opus reviews each subagent's result before spawning the next — adapts remaining tasks if needed
- Task boundaries are decided by **cognitive scope** (can the subagent hold the whole task?), not by counting changes. Tightly coupled changes stay together.
- Each subagent commits and pushes on completion
- After all tasks complete, Opus appends a timestamped entry to CURRENT_STATE.md's **Recent Changes** section

**Subagent prompt template:**
> Read CLAUDE.md and CURRENT_STATE.md. You are in BUILDER mode.
> **Task:** [specific task description]
> **Files:** [file paths to read/modify]
> **Constraints:** [what NOT to change]
> **Verification:** [how to confirm it works]
> After completing: run `npm run build`, then `git add`, `git commit`, and `git push origin main`. A task is NOT done until the push succeeds.

**BUILDER RULES (for subagents):**
- Stay strictly within task scope. Note concerns rather than redesigning.
- After completing and verifying `npm run build`, **always commit AND push to `main`**. Vercel auto-deploys from `main` — local-only commits are invisible to the user. A task is NOT complete until `git push` succeeds.
- If something seems like a design problem (not a code bug), stop and report back to Opus rather than hacking around it.

### Phase 3: Review & Synthesis (Opus)
Still in the same session, after all subagents complete. Announce `## Phase 3: Review` then:

- Read the updated CURRENT_STATE.md
- Check for drift, contradictions, or fragilities introduced
- Integrate Recent Changes entries into the proper CURRENT_STATE.md sections
- Confirm the picture is coherent
- **Report to the user** with a brief summary: which files were changed, what was done, and any concerns. Keep it scannable — a few bullet points, not paragraphs.

### Debug Protocol (for subagents)
When something isn't working:
1. **Stop.** Do not try a fix yet.
2. State the root cause hypothesis in one sentence.
3. Identify what evidence would confirm or disprove it.
4. Only then implement a fix, with evidence it's resolved.
5. After 3 failed attempts, **stop and report back** — do not keep guessing.
6. If the issue appears to be a **design problem** (not just a code bug), escalate to Opus: "This needs design review" — do not hack around a flawed approach.

---

## Things That Must Not Change Casually
- **Hold IDs** — routes reference holds by ID. Changing/scrambling IDs breaks all routes. See "Board Image Updates" section.
- Three-layer hold data architecture (JSON → overrides → custom)
- SVG coordinate system (percentage-based within board area)
- Touch event handling in BoardSetupView / HoldEditorView
- `closedRef` / `lastTouchTimeRef` / `vertexDragActive` ref patterns
- Hold polygon format (`[[x_pct, y_pct], ...]` as % of board area)
- Coordinate conversion approach per component (getScreenCTM in BoardView, getBoundingClientRect+letterbox in BoardSetupView)
- Route view dimming mask pattern
- Copy/paste `_origPoly` / `_pasteCx` / `_pasteCy` pattern
- Trackpad zoom dampening tiers
- `preserveAspectRatio="xMidYMin meet"` in BoardSetupView (not xMidYMid — causes vertical offset)
- Supabase sync flush timing (immediate on save, debounced otherwise)
- Tab visibility re-fetch (multi-device sync mechanism)

## Common Pitfalls
- **Synthesized mouse on mobile** — browsers fire mouse events ~300ms after touch. Guard with `isSynthesizedMouse()`.
- **Stale closures** — `useState` values go stale in event handlers. Use refs.
- **SVG coordinates in BoardView** — use `getScreenCTM().inverse()` (no CSS zoom transform). **In BoardSetupView** — use `getBoundingClientRect()` + letterbox math (CSS zoom breaks `getScreenCTM()` on iOS Safari).
- **BoardSetupView preserveAspectRatio** — must be `xMidYMin meet` (not `xMidYMid`). Image is top-aligned (flex-start), SVG must match.
- **Draw close detection** — use pixel-distance via getScreenCTM scale, not board-percentage.
- **Copy/paste rotation drift** — always rotate from `_origPoly`, not current polygon.
- **Multi-device sync** — data re-fetched on tab visibility change, not real-time. Must switch tabs or refresh.
- **Board photo shadows** — detection picks up edge shadows. Filter by position and area.
- **Touch targets** — minimum 44px equivalent for mobile.
- **Hold ID stability** — NEVER re-run detection and overwrite holds.json directly. IDs are sequential by position — adding holds between existing ones scrambles every ID after the insertion. Use `merge_holds.py` to preserve IDs. See "Board Image Updates" section.
