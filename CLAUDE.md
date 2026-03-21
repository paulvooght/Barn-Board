# CLAUDE.md — Instructions for Claude Code

## Context
Climbing route logger for a private angle-adjustable climbing board. The owner is learning to code via vibe coding — explain decisions clearly and keep things approachable. Primary use is on a phone at the board.

## Tech Stack
- **React 18** + **Vite 6** — no other runtime dependencies
- **Python 3** (Pillow + numpy) — hold detection script only
- **localStorage** — all persistence (routes, settings, hold overrides, custom holds)
- **No router, no state management library** — single-page app with view state machine

## Architecture

### View State Machine (App.jsx)
`board` → `create` → route creation with hold selection on board
`board` → `routes` → saved route list
`board` → `viewRoute` → view a saved route on the board (dimmed image, highlighted holds)
`board` → `settings` → grade system, board specs, Hold Manager access
`settings` → `setupBoard` → full Hold Manager (BoardSetupView)
`board` → `addHold` / `editHold` → individual hold polygon editor (HoldEditorView)

### Three-Layer Hold Data (useCustomHolds.js)
1. `src/data/holds.json` — base holds, auto-detected by Python script (25 holds with confidence + polygons)
2. `barnboard_hold_overrides` (localStorage) — edits to existing holds (position, polygon, metadata)
3. `barnboard_custom_holds` (localStorage) — user-created holds
4. `replaceAllHolds()` — bulk replacement from Hold Manager (hides base holds, stores all as custom)

### Key Files
| File | Purpose |
|------|---------|
| `src/App.jsx` | View state machine, route CRUD, navigation (446 lines) |
| `src/components/BoardView.jsx` | Board image + SVG overlay + zoom/pan + image dimming for route view (419 lines) |
| `src/components/BoardSetupView.jsx` | **Hold Manager** — full hold editing overlay with Select/Draw/Copy tools (931 lines) |
| `src/components/HoldOverlay.jsx` | SVG `<g>` per hold — route view highlighting with labels (126 lines) |
| `src/components/HoldEditorView.jsx` | Individual polygon editor — draw/edit hold boundaries, hold metadata |
| `src/components/ModeSelector.jsx` | Hold selection mode buttons (start/hand/foot/handOnly/finish) |
| `src/components/RouteForm.jsx` | Route creation/edit form (name, grade, angle, tags) |
| `src/components/RouteList.jsx` | Saved routes list with filtering |
| `src/components/RouteCard.jsx` | Individual route card in list |
| `src/components/Settings.jsx` | Settings page — grade system, Hold Manager button, board specs (158 lines) |
| `src/components/TagPicker.jsx` | Multi-select tag picker for hold types, techniques, styles |
| `src/hooks/useCustomHolds.js` | Three-layer hold data merging + replaceAllHolds |
| `src/hooks/useLocalStorage.js` | localStorage-backed React state |
| `src/hooks/useUndoRedo.js` | Undo/redo state snapshots (max 50 entries) |
| `src/utils/constants.js` | Grades, modes, colors, labels, board specs |
| `src/utils/polygonUtils.js` | Polygon math — centroid, bounding box, translate, rotate, point-in-polygon (263 lines) |
| `src/data/holds.json` | Auto-detected hold positions + polygons + confidence levels |
| `scripts/detect_holds.py` | Python hold detection from board photo (multi-pass with plywood filtering) |

### Board Image Coordinate System
- Hold positions (`cx`, `cy`) are **percentages within the BOARD AREA**, not the full image
- Board region within the photo: `left 3.4%, top 2.9%, width 92.3%, height 94.4%`
- To position overlays: `left = BOARD.left + (hold.cx / 100) * BOARD.width`
- The board image aspect ratio must be preserved
- SVG overlay uses `viewBox="0 0 naturalWidth naturalHeight"` with `preserveAspectRatio="none"`
- Coordinate conversion uses `svg.getScreenCTM().inverse()` for accuracy across zoom/pan states

## Current Feature Set

### Hold Manager (BoardSetupView.jsx)
Full-screen hold editing overlay accessed from Settings. Three tools:
- **Select** — click holds to select, drag vertices to reshape, delete, add vertices, edit metadata
- **Draw** — click to place vertices, click first vertex to close loop (14px screen-distance threshold via getScreenCTM)
- **Copy** — click hold to copy → click to place → rotate with slider → drag to reposition → Done

Features: undo/redo, zoom/pan (pinch + trackpad + mouse wheel), "Delete all medium" bulk action, Save & Exit writes to main board.

Hold outlines: 10px stroke width, green solid (high confidence), red dashed (medium confidence). Selected holds show cyan outline with vertex handles.

### Route Creation
1. Tap "+ CREATE ROUTE" button (below board image)
2. Select hold type mode (start/hand/foot/handOnly/finish)
3. Tap holds on board to assign them
4. Fill in route form (name, grade, angle, tags)
5. Save → stored in localStorage

### Route Viewing
- Select route from list → board shows with **dimmed background image** (50% opacity mask over non-hold areas)
- Selected holds render at **full image intensity** (masked cutouts in the dimming overlay)
- Hold outlines: 10px stroke, colors match selection type (green=start, cyan=hand, yellow=foot, purple=handOnly, red=finish)
- Labels (Start, Foot, Top, Hand Only) positioned **below** each hold to avoid blocking small holds
- Unselected holds hidden — only route holds visible

### Settings Page
- Grade system toggle (V-Grade / Font)
- Hold Manager button (opens BoardSetupView)
- Board specs table (width, height, angle range, hold counts)

### Hold Detection (scripts/detect_holds.py)
Multi-pass Python detection:
- **Pass 1 (colour HSV):** High confidence — detects cyan, yellow, black, purple, green holds with tight thresholds
- **Pass 2 (Canny edges):** Medium confidence — edge-based detection for missed holds
- **Plywood filtering:** Samples board edge colors, rejects contours matching plywood HSV
- **Thresholds:** MIN_HOLD_AREA=800, HIGH_CONFIDENCE_MIN_AREA=1500, EDGE_MARGIN_PCT=3.0
- Grey detection removed (was main source of false positives on plywood grain)

## Key Product Decisions

### Hold Selection Modes (route creation)
- `start` — starting hold (green #34d399)
- `hand` — regular hand hold (cyan #22d3ee)
- `foot` — foot-only hold (yellow #fbbf24)
- `handOnly` — hand-only hold (purple #c084fc)
- `finish` — finish/top hold (red #f87171)

### Hold Metadata (per hold, via HoldEditorView)
- Name, colour (9 options), hold types (Jug/Crimp/Sloper/Pinch/etc + Macro), positivity slider (-5 to +5)

### Route Data Shape
```json
{ "id", "name", "grade", "angle", "holds": { "[holdId]": "selectionType" },
  "holdTypes": [], "techniques": [], "styles": [], "rating": 0-5,
  "createdAt", "updatedAt" }
```

### Grade Systems
- V-grade: VB, V0, V1 ... V16
- Font: 3, 4, 4+, 5, 5+, 6A, 6A+, 6B, 6B+, 6C, 6C+, 7A, 7A+, 7B, 7B+, 7C, 7C+, 8A, 8A+, 8B, 8B+

### Board Angle
- Range: 18° (near vertical) to 55° (very steep), stored as integer degrees

## Coding Conventions

### Touch vs Mouse Event Handling (CRITICAL)
- **All interactive SVG surfaces must handle touch and mouse SEPARATELY** — never rely on synthesized click/mouse events on mobile
- Use `lastTouchTimeRef` pattern: stamp `Date.now()` on every touchstart, ignore mouse events within 500ms (`isSynthesizedMouse()` guard)
- Use refs (`closedRef`, etc.) for state that event handlers read — React closures go stale between `setState` and re-render
- Vertex circle `onTouchStart` must ALWAYS call `e.stopPropagation()` to prevent SVG tap handler from seeing vertex touches
- Track touch-based vertex drag via `touch.identifier` matching (not `setPointerCapture`)

### SVG Coordinate Conversion (CRITICAL)
- Use `svg.getScreenCTM().inverse()` to convert screen coordinates → SVG coordinates
- This correctly accounts for SVG `preserveAspectRatio` letterboxing AND CSS zoom/pan transforms
- Never use simple `getBoundingClientRect()` division — it breaks when SVG has letterboxing
- For pixel-distance checks (e.g. draw close detection), use `getScreenCTM().a` as the scale factor

### SVG Overlay Pattern
- BoardView renders `<svg>` over `<img>`, both inside a CSS-transformed zoom/pan wrapper
- HoldOverlay returns `<g>` elements (NOT divs) — polygon if available, else ellipse
- Hit targets on SVG circles need generous radius for mobile touch (HANDLE_R + HIT_EXTRA)

### Route View Dimming Pattern (BoardView.jsx)
- SVG mask with white base (full dim) + black polygon cutouts for selected holds
- Dimming rectangle uses the mask: `fill="black"` with `opacity="0.5"` and `mask="url(#holdMask)"`
- Creates effect where board is dimmed but selected holds show at full intensity

### Zoom/Pan
- CSS `transform: translate(x,y) scale(s)` on a wrapper div
- State in both React state (for renders) and refs (for event handlers)
- Pinch zoom via two-touch distance tracking
- Mouse wheel / trackpad zoom with **three-tier dampening**: deltaY <10 = gentle (1.02/0.98), <50 = moderate (1.04/0.96), >=50 = normal (1.12/0.9)
- Single-finger/mouse drag to pan (only when zoomed > 1x)

### Copy/Paste Flow (BoardSetupView)
1. Click Copy tool → click hold to copy it to clipboard
2. Click board to place copy at location
3. **Rotate** with slider (applies rotation from original polygon around paste center)
4. **Drag to move** — mousedown/touchstart on pasted hold starts whole-hold drag
5. Click **Done** to finish (clears clipboard, returns to Select tool)
- Internal state: `_pasteCx`, `_pasteCy`, `_origPoly` stored on hold during paste phase, cleaned up on Done
- `applyRotationToPasted()` always rotates from `_origPoly` to avoid cumulative rotation drift

## Running the Project
```bash
npm install
npm run dev          # Dev server — access via http://localhost:5173
                     # Phone access: http://<your-local-ip>:5173 (same WiFi)
```

## Re-detecting Holds
```bash
pip install Pillow numpy
# Place straight-on board photo as public/Board\ background.jpg
python3 scripts/detect_holds.py
# Updates src/data/holds.json with polygon outlines
# Review output — filter shadows at edges, verify small jibs detected
```

## Style Guide
- Warm industrial aesthetic — peach bg (#FFAB94), white cards, dark text (#1A0A00)
- Accent: blue #0047FF
- Fonts: DM Sans (body), Space Mono (headings/monospace)
- Mobile-first — max-width 480px, primary use on phone
- Minimal UI chrome, high information density
- Hold overlays: 10px stroke width for visibility against board photo
- Route view: dimmed board image with full-intensity hold cutouts
- Hold Manager: green=high confidence, red dashed=medium confidence outlines

## Common Pitfalls
- **Synthesized mouse events on mobile** — after every touch, browsers fire mousedown/mouseup/click ~300ms later. These WILL trigger mouse handlers and cause ghost interactions. Always guard with `isSynthesizedMouse()`.
- **Stale closures in event handlers** — `useState` values captured in closures go stale between `setState()` and re-render. Use refs (`closedRef.current`) for values read in touch/mouse handlers.
- **SVG coordinate conversion** — never use simple `getBoundingClientRect()` math. Use `getScreenCTM().inverse()` which correctly handles `preserveAspectRatio` letterboxing and CSS transforms.
- **Board photo shadows** — hold detection picks up shadows at left/right edges. Filter by position >3% from edges and area <15000px.
- **Small cyan jibs** — can be very small (40px area). Keep minimum detection threshold low.
- **Touch targets** — hold overlay hit targets need minimum 44px equivalent for mobile.
- **Image filename case** — file is `Board background.jpg`; macOS is case-insensitive but Linux is not.
- **localStorage is port-tied** — routes are lost if dev server port changes. Will be resolved at deployment.
- **Trackpad zoom sensitivity** — trackpad sends many small deltaY events vs mouse wheel sending few large ones. Must use tiered dampening.
- **Draw close detection** — must use pixel-distance (via getScreenCTM scale factor) not board-percentage distance. Otherwise threshold changes with zoom level.
- **Copy/paste rotation drift** — always rotate from original polygon (`_origPoly`), not current polygon. Rotating an already-rotated polygon causes cumulative floating-point drift.

## Things to Avoid Changing Casually
- The three-layer hold data architecture (JSON → overrides → custom)
- The SVG coordinate system (percentage-based within board area)
- Touch event handling in BoardSetupView / HoldEditorView — hard-won mobile compatibility
- The `closedRef` / `lastTouchTimeRef` / `vertexDragActive` ref pattern — these solve real mobile bugs
- Hold polygon data format (`[[x_pct, y_pct], ...]` pairs as % of board area)
- The `getScreenCTM().inverse()` coordinate conversion — this replaces broken `getBoundingClientRect()` math
- Route view dimming mask pattern — carefully tuned SVG mask with hold cutouts
- Copy/paste `_origPoly` / `_pasteCx` / `_pasteCy` pattern — prevents rotation drift
- Trackpad zoom dampening tiers — these were calibrated to feel right
