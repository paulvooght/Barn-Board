# Barn Board — Project Overview

A climbing route logger for a private angle-adjustable climbing wall (a "board"). Built as a single-page React app designed primarily for phone use at the wall. The owner photographs their board, detects hold positions with a Python script, then uses the app to define climbing routes by tapping holds on the photo, logging grades, angles, and session data.

---

## What the App Does

### Core Loop
1. **Board photo** is displayed full-width with detected climbing holds overlaid as SVG polygons
2. **Route creation** — tap holds on the board photo to build a route, assign a grade and angle, save
3. **Route viewing** — select a saved route to see it highlighted on the board (dimmed background, bright hold cutouts)
4. **Session tracking** — start a session timer, log sends and attempts, end session for a summary

### Key Features
- **Hold Manager** — full-screen polygon editor for defining/editing hold boundaries on the board photo
- **Multi-grade support** — same route can have different grades at different board angles (e.g. V3 at 30°, V5 at 45°)
- **Two grade systems** — V-Grade (V0–V15) and Font (3–8C) with automatic bi-directional conversion
- **Playlists** — group routes into named playlists for structured sessions
- **YouTube integration** — attach beta videos to routes via URL
- **Session summaries** — duration, sends, attempts, routes created, angles climbed
- **Hold detection** — Python script auto-detects hold positions from a board photograph

---

## Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| UI Framework | React 18 | Functional components + hooks only |
| Build Tool | Vite 6 | Dev server on port 5173 |
| Persistence | localStorage | All data lives in the browser |
| Hold Detection | Python 3 (Pillow + numpy) | One-time script, outputs JSON |
| Styling | Inline styles + CSS custom properties | No CSS framework |
| State | useState + custom hooks | No Redux/Zustand/etc. |
| Routing | None | View state machine in App.jsx |

**Zero runtime dependencies** beyond React and ReactDOM.

---

## How to Run

```bash
# Install dependencies
npm install

# Start dev server (accessible on local network for phone testing)
npm run dev
# → http://localhost:5173 (desktop)
# → http://<your-local-ip>:5173 (phone, same WiFi)

# Production build
npm run build
```

### Re-detecting holds from a board photo
```bash
pip install Pillow numpy
# Place straight-on board photo as public/Barn_Board_Reset_02_C.jpg
python3 scripts/detect_holds.py
# → Updates src/data/holds.json
```

---

## File Structure

```
barn-board/
├── public/
│   └── Barn_Board_Reset_02_C.jpg     # Board photograph
├── scripts/
│   ├── detect_holds.py               # Hold detection from photo
│   └── process_board_image.py        # Image preprocessing utilities
├── src/
│   ├── main.jsx                      # React entry point
│   ├── App.jsx                       # Root component — view state machine, all route/session CRUD
│   ├── App.css                       # Global styles + CSS custom properties
│   ├── data/
│   │   └── holds.json                # Auto-detected hold positions + polygons
│   ├── components/
│   │   ├── BoardView.jsx             # Board photo + SVG overlay + zoom/pan + dimming
│   │   ├── BoardSetupView.jsx        # Hold Manager — full polygon editor
│   │   ├── HoldEditorView.jsx        # Single hold polygon editor
│   │   ├── HoldOverlay.jsx           # SVG rendering for one hold (outline + label)
│   │   ├── ModeSelector.jsx          # Hold type buttons (Start/Hand/Foot/etc.)
│   │   ├── RouteForm.jsx             # Route creation/edit form
│   │   ├── RouteList.jsx             # Saved routes list with filtering/sorting/playlists
│   │   ├── RouteCard.jsx             # Single route card in list
│   │   ├── Settings.jsx              # Settings page — grade system, board specs
│   │   ├── SessionSummary.jsx        # Post-session stats screen
│   │   └── TagPicker.jsx             # Multi-select chips for hold types, techniques, styles
│   ├── hooks/
│   │   ├── useLocalStorage.js        # localStorage-backed useState
│   │   ├── useCustomHolds.js         # Three-layer hold data merging
│   │   └── useUndoRedo.js            # Undo/redo state snapshots (max 50)
│   └── utils/
│       ├── constants.js              # Grades, modes, colors, board specs, YouTube helpers
│       └── polygonUtils.js           # Polygon math — centroid, rotate, scale, point-in-polygon, split
└── package.json
```

---

## Architecture Deep-Dive

### 1. View State Machine (App.jsx)

The app has no router. Navigation is a `view` state variable with these values:

```
board ──────→ create ──────→ (save) → routes
  │              └── tap holds on board, fill form, save route
  │
  ├──────→ routes ─────────→ viewRoute (dimmed board + highlighted holds)
  │                              ├── edit → create (pre-filled)
  │                              └── delete → routes
  │
  ├──────→ settings ───────→ setupBoard (Hold Manager, full-screen overlay)
  │              └── grade system, board specs, session history
  │
  ├──────→ addHold / editHold (single hold polygon editor)
  │
  └──────→ sessionSummary (after ending a session)
```

**App.jsx** is the single source of truth for all data. It owns:
- `routes` — array of saved climbing routes (localStorage)
- `settings` — grade system preference (localStorage)
- `sessions` — completed session history (localStorage)
- `activeSession` — current session in progress (localStorage, survives reload)
- `playlists` — named route groups (localStorage)
- `holdSelection` — which holds are selected and what type (start/hand/foot/etc.)
- All CRUD functions for routes, sessions, playlists, angle grades

### 2. Three-Layer Hold Data (useCustomHolds.js)

Hold data comes from three sources, merged in order:

```
Layer 1: src/data/holds.json          ← Auto-detected by Python script
Layer 2: barnboard_hold_overrides     ← localStorage edits to existing holds
Layer 3: barnboard_custom_holds       ← localStorage user-created holds
```

The `useCustomHolds` hook merges these into a single `allHolds` array:
- Base holds from JSON, with overrides applied on top
- Hidden base holds are filtered out
- Custom holds appended at the end
- `replaceAllHolds()` — used by the Hold Manager to do a full replacement (hides all base holds, stores everything as custom)

### 3. Board Image Coordinate System

All hold positions use **percentage coordinates within the board area** (not the full image):

```
Full image (e.g. 4000x3000 pixels)
┌─────────────────────────────────┐
│  padding                        │
│  ┌───────────────────────────┐  │
│  │  BOARD AREA               │  │ ← boardRegion defines this rectangle
│  │  hold.cx = 50 means       │  │    as % of full image
│  │  center of board           │  │
│  │  hold.cy = 0 = top edge   │  │
│  │  hold.cy = 100 = bottom   │  │
│  └───────────────────────────┘  │
└─────────────────────────────────┘
```

The `boardRegion` object in holds.json defines: `{ left: 3.4, top: 2.9, width: 92.3, height: 94.4 }`

To convert hold percentage → SVG pixel: `svgX = imgW × (boardRegion.left/100) + (hold.cx/100) × imgW × (boardRegion.width/100)`

### 4. SVG Overlay System

The board photo is displayed as an `<img>` with an absolutely-positioned `<svg>` on top:

```
<div style="transform: translate(panX, panY) scale(zoom)">  ← zoom/pan wrapper
  <img src="board.jpg" />                                    ← photo
  <svg viewBox="0 0 naturalWidth naturalHeight"              ← overlay
       preserveAspectRatio="xMidYMid meet">
    <HoldOverlay ... />  ← returns <g> with polygon/ellipse + label
    <HoldOverlay ... />
    ...
  </svg>
</div>
```

**Critical: SVG coordinate conversion** uses `svg.getScreenCTM().inverse()` to convert screen pixels → SVG coordinates. This correctly handles `preserveAspectRatio` letterboxing AND CSS zoom/pan transforms. Never use `getBoundingClientRect()` division — it breaks with letterboxing.

### 5. Route View Dimming

When viewing a saved route, the board is dimmed except for the selected holds:

```svg
<defs>
  <mask id="holdMask">
    <rect fill="white" ... />          ← white = show dim overlay
    <polygon fill="black" ... />       ← black = cut out for each selected hold
  </mask>
</defs>
<rect fill="black" opacity="0.5" mask="url(#holdMask)" />  ← the dim overlay
```

This creates the effect where the board photo appears darkened but selected holds show at full brightness.

### 6. Zoom and Pan

Both BoardView and BoardSetupView implement zoom/pan:
- CSS `transform: translate(x,y) scale(s)` on a wrapper div
- State in both React state (for renders) AND refs (for event handlers — avoids stale closures)
- **Pinch zoom** — two-touch distance tracking
- **Mouse wheel** — three-tier dampening for trackpad vs. mouse:
  - deltaY < 10 → trackpad gentle (×1.02)
  - deltaY < 50 → moderate (×1.04)
  - deltaY ≥ 50 → mouse wheel (×1.12)
- **Pan** — single-finger/mouse drag (only when zoomed > 1×)
- **Reset** — double-click/tap returns to 1× zoom

---

## Data Shapes

### Hold Object
```json
{
  "id": "hold_001",
  "color": "cyan",
  "size": "medium",
  "cx": 45.2,              // % within board area
  "cy": 32.8,              // % within board area
  "w_pct": 5.1,            // width as % of board
  "h_pct": 3.4,            // height as % of board
  "r": 2.55,               // radius (max of w/h ÷ 2)
  "polygon": [[42.1, 31.0], [48.3, 31.2], [48.1, 34.6], [42.3, 34.4]],  // vertices as [x%, y%]
  "confidence": "high",    // "high" or "medium" (from detection)
  "verified": true,
  "custom": false,          // true if user-created
  "area": 12500,            // pixel area from detection
  "notes": ""
}
```

### Route Object
```json
{
  "id": "1711234567890",
  "name": "Crimpy Traverse",
  "grade": "V4",
  "angle": 35,
  "setter": "Paul",
  "youtubeUrl": "https://youtu.be/abc123",
  "holds": {
    "hold_001": "start",
    "hold_005": "hand",
    "hold_012": "hand",
    "hold_003": "foot",
    "hold_018": "finish"
  },
  "holdTypes": ["Crimps", "Edges"],
  "techniques": ["Body tension"],
  "styles": ["Technical"],
  "rating": 4,
  "sent": true,
  "angleGrades": [
    { "angle": 40, "grade": "V5", "sent": false },
    { "angle": 45, "grade": "V6", "sent": true }
  ],
  "createdAt": "2026-03-15T10:30:00.000Z",
  "updatedAt": "2026-03-20T14:15:00.000Z"
}
```

### Session Object
```json
{
  "id": "1711234567890",
  "startTime": "2026-03-20T18:00:00.000Z",
  "endTime": "2026-03-20T20:15:00.000Z",
  "boardAngle": 35,
  "anglesClimbed": [30, 35, 40],
  "routesSent": ["route_id_1", "route_id_2"],
  "routesAttempted": ["route_id_1", "route_id_2", "route_id_3"],
  "routesCreated": ["route_id_4"],
  "sends": [
    { "routeId": "route_id_1", "angle": 35, "grade": "V4", "time": "2026-03-20T18:30:00.000Z" }
  ]
}
```

### localStorage Keys
| Key | Contents |
|-----|----------|
| `barnboard_routes` | Array of route objects |
| `barnboard_settings` | `{ gradeSystem: 'V' | 'Font' }` |
| `barnboard_sessions` | Array of completed session objects |
| `barnboard_active_session` | Current session object or null |
| `barnboard_playlists` | Array of `{ id, name, routeIds: [] }` |
| `barnboard_custom_holds` | Array of user-created hold objects |
| `barnboard_hold_overrides` | `{ [holdId]: { ...overrides, hidden?: true } }` |

---

## Component-by-Component Guide

### App.jsx (~700 lines)
The root component. Owns all state and CRUD logic. Renders the header (with navigation and session timer), then conditionally renders the active view. Key responsibilities:
- View state machine (`view` state variable)
- Route CRUD (create, edit, delete, rate, toggle sent)
- Session management (start, end, log sends/attempts)
- Playlist management (create, delete, rename, add/remove routes)
- Angle-grade management (add/remove grade at specific angle, swap headline)
- Grade system conversion (converts all existing routes when system changes)
- Hold selection tracking during route creation
- Hold Manager save handler (remaps hold IDs in existing routes)

### BoardView.jsx (~420 lines)
Renders the board photo with SVG overlay. Used in three contexts:
1. **Board view** — just the photo with subtle hold outlines
2. **Create mode** — interactive, tapping holds assigns them to the route
3. **View route** — dimmed photo with bright hold cutouts and labels

Handles zoom/pan (pinch, wheel, drag) and touch/mouse event separation.

### BoardSetupView.jsx — Hold Manager (~1030 lines)
Full-screen overlay for editing hold polygons. Accessed from Settings. Two main toolbar tools:

**Select tool:**
- Click holds to select/multi-select
- Drag vertices to reshape
- Secondary toolbar: + Vertex, Copy, Confirm (medium→high confidence), Select All, Delete, Rotate slider, Scale slider
- Multi-select rotation/scale uses board center (50, 50); single-select uses hold centroid
- `snapshotOrigPolys()` pattern prevents cumulative rotation/scale drift

**Draw tool:**
- Secondary toolbar: Polygon/Lasso toggle
- **Polygon mode** — click to place vertices, click first vertex to close, then Create Hold
- **Lasso mode** — click and drag freehand, mouse up auto-closes and simplifies path
  - Uses Ramer-Douglas-Peucker simplification with tolerance 0.15 (3× more detail than default 0.5)
- Both modes auto-select the new hold and switch to Select tool after creation

**Copy** (internal state, not a toolbar button):
- Triggered from Select toolbar → copies selected hold polygon
- Click board to place → new hold created and selected

Save & Exit writes all holds back to the main app via `replaceAllHolds()`.

### HoldOverlay.jsx (~130 lines)
Renders a single hold as SVG elements:
- **Unselected**: very subtle white outline (12% opacity)
- **Selected**: bold colored outline (10px stroke) + outer glow + label pill below hold
- Labels: START (green), TOP (red), FOOT (yellow), HAND (purple)
- Regular hand holds get a small bright dot instead of a label

### HoldEditorView.jsx
Individual hold polygon editor. Lets you draw/redraw a hold's polygon boundary, set hold metadata (name, color, hold types, positivity).

### ModeSelector.jsx
Row of hold type buttons for route creation: Start, Hand, Foot, Hand Only, Finish. Each colored to match its selection type.

### RouteForm.jsx
Form for route creation/editing: name input, grade picker (dropdown), angle slider (18°–55°), setter name, YouTube URL input, tag pickers for hold types/techniques/styles.

### RouteList.jsx
Scrollable list of saved routes with:
- Sort by date/grade/rating (tap to toggle direction)
- Filter by grade range, hide sent routes, filter by hold type/style
- Playlists — create, rename, delete, view routes in playlist
- Each route rendered as a RouteCard

### RouteCard.jsx
Compact card showing: grade pill, route name, sent checkbox, 5-star rating. Tapping opens route view; checkboxes and stars are independently interactive.

### Settings.jsx
- Grade system toggle (V-Grade / Font) with conversion chart
- Hold Manager button → opens BoardSetupView
- Session history → expandable list, tap to view summary
- Board specs table (physical dimensions, angle range, hold counts)
- Beta features section

### SessionSummary.jsx
Post-session stats: duration, sends per grade, routes attempted but not sent, routes created, angles climbed. Shown automatically when a session is ended.

### TagPicker.jsx
Reusable multi-select component. Renders a row of chip buttons; tapping toggles selection. Used for hold types (Crimps, Slopers, etc.), techniques (Heel hooks, Dynos, etc.), and styles (Powerful, Technical, etc.).

---

## Custom Hooks

### useLocalStorage(key, initialValue)
Drop-in replacement for `useState` that persists to localStorage. Reads initial value from storage on mount, writes on every update. Returns `[value, setValue]`.

### useCustomHolds()
Merges the three hold data layers. Returns `{ allHolds, addHold, updateHold, deleteHold, replaceAllHolds }`.

### useUndoRedo(initialState)
Generic undo/redo with state snapshots. Max 50 undo entries. Returns `{ state, setState, undo, redo, canUndo, canRedo, reset }`. Used by the Hold Manager for undoable hold edits.

---

## Polygon Utilities (polygonUtils.js)

All coordinates in board-area percentages (0–100).

| Function | Purpose |
|----------|---------|
| `simplifyPath(points, tolerance)` | Ramer-Douglas-Peucker path simplification. Tolerance 0.5 (default) or 0.15 (lasso) |
| `pointInPolygon(px, py, polygon)` | Raycast algorithm — is point inside polygon? |
| `distToPolygonEdge(px, py, polygon)` | Minimum perpendicular distance from point to any polygon edge |
| `centroid(polygon)` | Average of all vertices |
| `boundingBox(polygon)` | Returns `{ minX, maxX, minY, maxY, w, h }` |
| `rotatePolygon(polygon, cx, cy, angleDeg)` | Rotate around center point |
| `scalePolygon(polygon, factor, cx, cy)` | Scale around center point |
| `translatePolygon(polygon, dx, dy)` | Move by delta |
| `splitPolygonWithLine(polygon, lineStart, lineEnd)` | Bisect polygon with a cutting line → `[poly1, poly2]` |
| `findHoldAtPoint(px, py, holds, tapRadius)` | Find which hold a point is inside (polygon check + edge proximity + center distance) |
| `holdFromPolygon(polygon, id, color)` | Create a complete hold object from a polygon (auto-calculates centroid, bbox, size) |

---

## Hold Detection (scripts/detect_holds.py)

Multi-pass Python detection from a board photograph:

1. **Pass 1 — Color HSV detection (high confidence):** Scans for specific hold colors (cyan, yellow, black, purple, green) using tight HSV thresholds. Finds contours, filters by area ≥ 1500px.

2. **Pass 2 — Canny edge detection (medium confidence):** Edge-based detection for holds missed by color. Area threshold ≥ 800px.

3. **Plywood filtering:** Samples board edge colors to build a plywood HSV profile. Rejects contours whose median color matches plywood.

4. **Edge margin filtering:** Rejects holds within 3% of image edges (usually shadows).

5. **Polygon simplification:** Each contour is simplified to ≤ 40 vertices using Douglas-Peucker with epsilon = 0.01 × arc length.

Output: `src/data/holds.json` containing `{ boardRegion, detectedAt, holds: [...] }`

---

## Visual Design

### Color System
| Variable | Value | Usage |
|----------|-------|-------|
| `--bg-primary` | `#FFAB94` (peach) | Page background |
| `--bg-card` | `rgba(255,255,255,0.65)` | Card backgrounds |
| `--text-primary` | `#4A2520` (dark brown) | Main text |
| `--accent` | `#0047FF` (blue) | Interactive elements, links |
| `--yellow` | `#FFE800` | Grade pills, star ratings |

### Typography
- **Body:** DM Sans (Google Fonts)
- **Headings/Mono:** Space Mono (Google Fonts)
- Mobile-first, max-width 480px

### Hold Selection Colors
| Mode | Color | Hex |
|------|-------|-----|
| Start | Green | `#22a870` |
| Hand | Blue | `#0047FF` |
| Foot | Gold | `#D4A000` |
| Hand Only | Purple | `#c084fc` |
| Finish | Red | `#FF5252` |

### Hold Manager Outlines
- High confidence: solid green, 10px stroke
- Medium confidence: dashed red, 10px stroke
- Selected: cyan outline with draggable vertex circles

---

## Critical Implementation Patterns

### Touch vs Mouse Event Separation
Mobile browsers fire synthesized mouse events 300ms after touch events. Every interactive surface uses:
```js
const lastTouchTimeRef = useRef(0);
const isSynthesizedMouse = () => Date.now() - lastTouchTimeRef.current < 500;

// In touchstart handler:
lastTouchTimeRef.current = Date.now();

// In mousedown handler:
if (isSynthesizedMouse()) return;  // ignore synthetic event
```

### Stale Closure Prevention
Event handlers capture `useState` values at render time. Between `setState()` and re-render, the captured value is stale. Solution: use refs for values read in event handlers:
```js
const [closed, setClosed] = useState(false);
const closedRef = useRef(false);
// Keep ref in sync:
useEffect(() => { closedRef.current = closed; }, [closed]);
// In event handler, read ref:
if (closedRef.current) { ... }
```

### Rotation/Scale Drift Prevention
When rotating or scaling selected holds, always transform from the original polygon captured at interaction start — never from the already-transformed polygon:
```js
function snapshotOrigPolys() {
  // Save original polygons before any transformation
  origPolysRef.current = { ... };
  setSelectRotation(0);
  setSelectScale(100);
}
// Each slider change rotates/scales from origPolys, not current state
```

### SVG Coordinate Conversion
```js
const ctm = svg.getScreenCTM();
const pt = svg.createSVGPoint();
pt.x = clientX; pt.y = clientY;
const svgPt = pt.matrixTransform(ctm.inverse());
// svgPt.x, svgPt.y are now in SVG viewBox coordinates
```

---

## Grade System

Two parallel grade systems with bidirectional conversion (Rockfax chart):

| V-Grade | Font |
|---------|------|
| VB | 3 |
| V0 | 4 |
| V1 | 5 |
| V2 | 5+ |
| V3 | 6A |
| V4 | 6B |
| V5 | 6C |
| V6 | 7A |
| V7 | 7A+ |
| V8 | 7B |
| V9 | 7B+ |
| V10 | 7C |
| V11 | 7C+ |
| V12 | 8A |

Changing the grade system in settings automatically converts all existing route grades.

---

## Board Specifications

| Spec | Value |
|------|-------|
| Width | 4.8m |
| Height | 4.5m |
| Hinge offset (concrete) | 0.6m |
| Hinge offset (matting) | 0.3m |
| Angle range | 18° (near vertical) to 55° (very steep) |

---

## Known Constraints

- **localStorage is port-tied** — routes/holds are lost if the dev server port changes
- **No backend** — all data is browser-local, no sync between devices
- **Board photo must be straight-on** — hold detection assumes minimal perspective distortion
- **Single board** — the app is designed for one specific board
