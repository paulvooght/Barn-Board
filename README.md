# Barn Board — Climbing Route Logger

A web app for logging, grading, rating, and categorising routes on a custom angle-changing climbing board. Think Kilter/Tension/Stokt, but for a private home wall.

## The Board

- **Size:** 4.8m wide × 4.5m tall from the hinge
- **Hinge:** 600mm off concrete, 300mm off matting surface
- **Angle range:** 18° to 55°, controlled by pulley and hoist system
- **Holds:** Currently ~17, eventually ~200 holds of various shapes and sizes
- **Resets:** Holds get reset regularly — remapping must be easy and partial (only update changed holds)

## Core Concept

The app is driven by an **interactive image of the board**. Each hold is individually identified and selectable. Users tap holds to build routes, then tag them with rich metadata. Over time, the accumulated data reveals how different hold types and techniques are affected by angle changes — the intelligence layer that makes this more than a logbook.

## Route Creation Workflow

1. Tap holds on the board image to select them
2. Designate: **Start holds** (green), **Finish hold** (red), **Hand holds** (cyan), **Foot-only** (yellow)
3. Name the route
4. Set grade (V-grade default, Font switchable in settings)
5. Set the board angle (18°–55° slider)
6. Tag metadata:
   - **Hold types:** Crimps, Slopers, Pinches, Jugs, Pockets, Edges, Volumes, Jibs
   - **Techniques:** Heel hooks, Toe hooks, Compression, Dynos, Body tension, Flagging, Drop knee, Bat hang, Campus
   - **Style:** Powerful, Technical, Endurance, Dynamic, Static, Balancey, Reachy, Morpho

## Hold Detection

Holds are auto-detected from a straight-on photo of the board using colour thresholding:
- **Black holds** (macros): detected via low brightness threshold
- **Cyan/turquoise holds** (jibs): high blue+green, low red
- **Purple holds** (small crimps): high blue+red, low green

The detection script lives in `scripts/detect_holds.py`. Output is saved to `src/data/holds.json`.

**Every hold must be individually identified** — even small clustered jibs/footholds must have their own ID.

When holds are reset, re-run detection and it will only flag holds whose positions have changed.

## Tech Stack

- **React** (Vite) — single-page app
- **Local storage** initially, cloud sync later
- **No backend** for Phase 1
- **Mobile-first** design (used at the board on a phone)

## Project Structure

```
barn-board/
├── public/
│   └── board.jpeg          # Straight-on board photo (reference image)
├── scripts/
│   └── detect_holds.py     # Hold auto-detection script
├── src/
│   ├── components/
│   │   ├── BoardView.jsx       # Interactive board with hold overlays
│   │   ├── HoldOverlay.jsx     # Individual hold selection indicator
│   │   ├── ModeSelector.jsx    # Hand/Start/Finish/Foot toggle
│   │   ├── RouteForm.jsx       # Route creation form (name, grade, angle, tags)
│   │   ├── RouteList.jsx       # Browse/filter saved routes
│   │   ├── RouteCard.jsx       # Individual route summary card
│   │   ├── TagPicker.jsx       # Multi-select tag chips
│   │   └── Settings.jsx        # Grade system toggle, board specs
│   ├── data/
│   │   └── holds.json          # Auto-detected hold positions
│   ├── hooks/
│   │   └── useLocalStorage.js  # Persistent local storage hook
│   ├── utils/
│   │   ├── grades.js           # V-grade and Font grade scales
│   │   └── constants.js        # Hold types, techniques, styles, board specs
│   ├── App.jsx
│   ├── App.css
│   └── main.jsx
├── package.json
├── vite.config.js
├── index.html
├── CLAUDE.md                   # Instructions for Claude Code
└── README.md                   # This file
```

## Design Direction

**Industrial/utilitarian** aesthetic — dark theme, minimal chrome, high contrast. This is a tool used in a barn with chalk on your hands. Think dark concrete, exposed steel, functional. Accent colour: cyan (#22d3ee). Typography: DM Sans (body) + Space Mono (headings/data).

## Phases

- [x] **Phase 1:** Interactive board with hold detection, route creation, local storage
- [ ] **Phase 2:** Route browsing with filtering by grade/angle/tags
- [ ] **Phase 3:** Hold management admin (add/remove/reposition after resets)
- [ ] **Phase 4:** Angle-grade analytics and knowledge building
- [ ] **Phase 5:** Cloud sync, multi-user support
