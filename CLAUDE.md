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
`board` | `create` | `routes` | `settings` | `viewRoute` | `addHold` | `editHold` | `holdSelect`

### Three-Layer Hold Data (useCustomHolds.js)
1. `src/data/holds.json` — base holds, auto-detected by Python script
2. `barnboard_hold_overrides` (localStorage) — edits to existing holds (position, polygon, metadata)
3. `barnboard_custom_holds` (localStorage) — user-created holds

### Key Files
| File | Purpose |
|------|---------|
| `src/App.jsx` | View state machine, route CRUD, navigation |
| `src/components/BoardView.jsx` | Board image + SVG overlay + zoom/pan (touch + mouse) |
| `src/components/HoldOverlay.jsx` | SVG `<g>` per hold (polygon or ellipse fallback) |
| `src/components/HoldEditorView.jsx` | Polygon editor — draw/edit hold boundaries, hold metadata |
| `src/hooks/useCustomHolds.js` | Three-layer hold data merging |
| `src/utils/constants.js` | Grades, modes, colors, labels, board specs |
| `src/data/holds.json` | Auto-detected hold positions + board region |
| `scripts/detect_holds.py` | Python hold detection from board photo |

### Board Image Coordinate System
- Hold positions (`cx`, `cy`) are **percentages within the BOARD AREA**, not the full image
- Board region within the photo: `left 10.5%, top 4.0%, width 79.5%, height 92.5%`
- To position overlays: `left = BOARD.left + (hold.cx / 100) * BOARD.width`
- The board image aspect ratio must be preserved
- SVG overlay uses `viewBox="0 0 naturalWidth naturalHeight"` with `preserveAspectRatio="none"`

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

### SVG Overlay Pattern
- BoardView renders `<svg>` over `<img>`, both inside a CSS-transformed zoom/pan wrapper
- HoldOverlay returns `<g>` elements (NOT divs) — polygon if available, else ellipse
- Use `svgRef.getBoundingClientRect()` for coordinate conversion — always correct regardless of zoom/pan transform
- Hit targets on SVG circles need generous radius for mobile touch (HANDLE_R + HIT_EXTRA)

### Zoom/Pan
- CSS `transform: translate(x,y) scale(s)` on a wrapper div
- State in both React state (for renders) and refs (for event handlers)
- Pinch zoom via two-touch distance tracking
- Mouse wheel zoom on desktop
- Single-finger/mouse drag to pan (only when zoomed > 1x)

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
- Hold overlays must be clearly visible against the board photo

## Common Pitfalls
- **Synthesized mouse events on mobile** — after every touch, browsers fire mousedown/mouseup/click ~300ms later. These WILL trigger mouse handlers and cause ghost interactions. Always guard with `isSynthesizedMouse()`.
- **Stale closures in event handlers** — `useState` values captured in closures go stale between `setState()` and re-render. Use refs (`closedRef.current`) for values read in touch/mouse handlers.
- **Board photo shadows** — hold detection picks up shadows at left/right edges. Filter by position >3% from edges and area <15000px.
- **Small cyan jibs** — can be very small (40px area). Keep minimum detection threshold low.
- **Touch targets** — hold overlay hit targets need minimum 44px equivalent for mobile.
- **Image filename case** — file may be `Barn_Board_02.png` or `Board background.jpg`; macOS is case-insensitive but Linux is not.
- **localStorage is port-tied** — routes are lost if dev server port changes. Will be resolved at deployment.

## Things to Avoid Changing Casually
- The three-layer hold data architecture (JSON → overrides → custom)
- The SVG coordinate system (percentage-based within board area)
- Touch event handling in HoldEditorView — hard-won mobile compatibility
- The `closedRef` / `lastTouchTimeRef` / `vertexDragActive` ref pattern — these solve real mobile bugs
- Hold polygon data format (`[[x_pct, y_pct], ...]` pairs as % of board area)
