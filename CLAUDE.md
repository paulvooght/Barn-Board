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
board → create        (route creation with hold selection on board)
board → routes        (saved route list with playlists, filtering, sorting)
board → viewRoute     (view saved route on dimmed board with highlighted holds)
board → settings      (grade system, Hold Manager, sessions, board specs)
board → sessionSummary (session recap after Stop Session)
settings → setupBoard (Hold Manager — BoardSetupView)
board → addHold / editHold (HoldEditorView — polygon + metadata editor)
```

### Three-Layer Hold Data (useCustomHolds.js)
1. `src/data/holds.json` — base holds, auto-detected by Python script (25 holds)
2. `hold_overrides` (Supabase `board_settings` + localStorage cache) — edits to detected holds
3. `custom_holds` (Supabase `board_settings` + localStorage cache) — user-created holds
4. `replaceAllHolds()` — bulk replacement from Hold Manager (hides base holds, stores all as custom)

### Supabase Schema
| Table | PK | Content |
|-------|----------|---------|
| `routes` | `id` (text) | `user_id`, `data` (full route JSON), timestamps |
| `sessions` | `id` (text) | `user_id`, `data` (full session JSON), timestamps |
| `board_settings` | `key` (text) | `data` (JSON blob) — shared across all users |
| `profiles` | `user_id` | `display_name`, `is_admin`, timestamps |
| `route_comments` | `id` | `route_id`, `user_id`, `body`, `likes[]`, `flags[]`, timestamps |

**board_settings keys:** `hold_overrides`, `custom_holds`, `playlists_${userId}`

### Supabase Sync Pattern
- **Immediate flush** on critical writes (save route, end session)
- **Debounced 1500ms** on non-critical changes
- **Tab visibility listener** — re-fetches all data when tab becomes visible (multi-device sync)
- **First login migration** — moves localStorage data to Supabase automatically

### Admin System
- `VITE_ADMIN_EMAIL` env var determines the admin user
- Only admin sees Hold Manager button in Settings
- Hold data (overrides + custom holds) is shared across all users (one physical board)
- Admin status is now sourced from `profiles.is_admin` (set manually via SQL after first signup). `VITE_ADMIN_EMAIL` remains as a bootstrap fallback so the first admin isn't locked out before promoting their profile row.

### Key Files
| File | Lines | Purpose |
|------|-------|---------|
| `src/App.jsx` | ~1900 | View state machine, route/session CRUD, navigation, Supabase sync |
| `src/components/BoardView.jsx` | ~465 | Board image + SVG overlay + zoom/pan + route view dimming |
| `src/components/BoardSetupView.jsx` | ~1280 | Hold Manager — Select/Draw/Copy, Boundaries/Hold Info modes |
| `src/components/HoldEditorView.jsx` | ~800 | Individual hold polygon + metadata editor |
| `src/components/HoldOverlay.jsx` | ~126 | SVG `<g>` per hold — route view highlighting with labels |
| `src/components/RouteList.jsx` | ~706 | Routes list with playlists, filtering, sorting |
| `src/components/RouteCard.jsx` | ~144 | Route card (grade, angle, sent, missing holds indicator) |
| `src/components/RouteForm.jsx` | ~209 | Route create/edit form with auto hold type collection |
| `src/components/Settings.jsx` | ~598 | Settings, sessions list, board specs, sign out |
| `src/components/SessionSummary.jsx` | ~346 | Session recap after climbing |
| `src/components/AuthView.jsx` | ~85 | Email/password login + signup |
| `src/components/ModeSelector.jsx` | ~28 | Hold selection mode buttons |
| `src/components/TagPicker.jsx` | ~42 | Multi-select tag picker with auto-highlight |
| `src/components/CommentsSection.jsx` | ~260 | Comments thread on viewRoute — fetch, post, like, flag, admin-delete |
| `src/components/CommentItem.jsx` | ~165 | Single comment row — name/setter pill, body, like/flag/delete actions |
| `src/hooks/useCustomHolds.js` | ~147 | Three-layer hold data + Supabase sync |
| `src/hooks/useLocalStorage.js` | ~27 | localStorage-backed React state |
| `src/hooks/useUndoRedo.js` | ~70 | Undo/redo state snapshots (max 50) |
| `src/lib/supabase.js` | ~9 | Supabase client init |
| `src/utils/constants.js` | ~145 | Grades, modes, colors, labels, board specs |
| `src/utils/polygonUtils.js` | ~272 | Polygon math — centroid, bbox, translate, rotate, hit-test |
| `src/data/holds.json` | — | Auto-detected hold positions + polygons |
| `scripts/detect_holds.py` | — | Python hold detection from board photo |

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

### Per-User Route Data (per user — separate from route record)
```json
{
  "sent": false,
  "rating": 0-5,
  "angleGrades[].sent": true/false
}
```
*`sent` and `rating` are per-user. Route card shows community average rating.*
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
- **Fonts:** DM Sans (body), Space Mono (headings/monospace)
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
