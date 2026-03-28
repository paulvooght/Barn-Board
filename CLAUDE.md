# CLAUDE.md — Operating Manual for Claude Code

## What This App Is
Climbing route logger for a private angle-adjustable climbing board (4.8m wide x 4.5m tall, 18-55 degrees). The owner is learning to code via vibe coding — explain decisions clearly and keep things approachable. Primary use is on a phone at the board, also used on laptop for setup.

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
- Board region within the photo defined in `holds.json`: `boardRegion: { left, top, width, height }`
- Conversion: `SVG_x = boardRegion.left% × imgW + (hold.cx / 100) × boardRegion.width% × imgW`
- SVG overlays use `viewBox="0 0 naturalWidth naturalHeight"`
- **BoardView** uses `preserveAspectRatio="none"` (image fills width)
- **BoardSetupView** uses `preserveAspectRatio="xMidYMin meet"` (image may be height-constrained on laptop — YMin aligns SVG to top matching image's flex-start alignment)
- Coordinate conversion uses `svg.getScreenCTM().inverse()` for accuracy across zoom/pan

## Data Shapes

### Route
```json
{
  "id": "timestamp", "name": "", "grade": "V3", "angle": 30,
  "setter": "", "youtubeUrl": "",
  "holds": { "holdId": "start|hand|foot|handOnly|finish" },
  "holdSnapshots": { "holdId": { "cx", "cy", "polygon", "w_pct", "h_pct", "r", "color", "holdTypes" } },
  "holdTypes": ["Jugs"], "techniques": ["Heel hooks"], "styles": ["Power"],
  "rating": 0, "sent": false,
  "angleGrades": [{ "angle": 30, "grade": "V4", "sent": true }],
  "createdAt": "ISO", "updatedAt": "ISO"
}
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
- Use `svg.getScreenCTM().inverse()` to convert screen → SVG coordinates
- Handles `preserveAspectRatio` letterboxing AND CSS zoom/pan transforms
- Never use `getBoundingClientRect()` division — breaks with letterboxing
- Pixel-distance checks: use `getScreenCTM().a` as scale factor

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

## Re-detecting Holds
```bash
pip install Pillow numpy
python3 scripts/detect_holds.py    # Updates src/data/holds.json
```

## Things That Must Not Change Casually
- Three-layer hold data architecture (JSON → overrides → custom)
- SVG coordinate system (percentage-based within board area)
- Touch event handling in BoardSetupView / HoldEditorView
- `closedRef` / `lastTouchTimeRef` / `vertexDragActive` ref patterns
- Hold polygon format (`[[x_pct, y_pct], ...]` as % of board area)
- `getScreenCTM().inverse()` coordinate conversion
- Route view dimming mask pattern
- Copy/paste `_origPoly` / `_pasteCx` / `_pasteCy` pattern
- Trackpad zoom dampening tiers
- `preserveAspectRatio="xMidYMin meet"` in BoardSetupView (not xMidYMid — causes vertical offset)
- Supabase sync flush timing (immediate on save, debounced otherwise)
- Tab visibility re-fetch (multi-device sync mechanism)

## Common Pitfalls
- **Synthesized mouse on mobile** — browsers fire mouse events ~300ms after touch. Guard with `isSynthesizedMouse()`.
- **Stale closures** — `useState` values go stale in event handlers. Use refs.
- **SVG coordinates** — never use `getBoundingClientRect()`. Use `getScreenCTM().inverse()`.
- **BoardSetupView preserveAspectRatio** — must be `xMidYMin meet` (not `xMidYMid`). Image is top-aligned (flex-start), SVG must match.
- **Draw close detection** — use pixel-distance via getScreenCTM scale, not board-percentage.
- **Copy/paste rotation drift** — always rotate from `_origPoly`, not current polygon.
- **Multi-device sync** — data re-fetched on tab visibility change, not real-time. Must switch tabs or refresh.
- **Board photo shadows** — detection picks up edge shadows. Filter by position and area.
- **Touch targets** — minimum 44px equivalent for mobile.
