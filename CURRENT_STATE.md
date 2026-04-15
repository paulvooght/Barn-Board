# CURRENT_STATE.md — What's Working, What's Not, What's Fragile

*Last updated: 2026-04-04*

## Genuinely Working

### Core Features
- **Auth** — email/password login via Supabase, session persistence, admin check via VITE_ADMIN_EMAIL
- **Route creation** — tap holds on board image, assign modes (start/hand/foot/handOnly/finish), fill form, save
- **Route editing** — edit existing routes, change holds, update metadata
- **Route deletion** — with confirmation
- **Route viewing** — dimmed board with full-intensity hold cutouts via SVG mask
- **Route list** — sorting (date, grade, rating), filtering (grade range, rating, hold types, styles), hide-sent toggle
- **Playlists** — create, rename, delete, add/remove routes, view filtered by playlist
- **Grade systems** — V-Grade / Font toggle with conversion
- **Star ratings** — 1-5 on route cards
- **Sent tracking** — mark routes sent, per-angle-grade sent tracking
- **Angle-grade system** — multiple angle/grade combos per route

### Hold Management
- **Three-layer hold data** — base JSON + overrides + custom holds, all syncing to Supabase
- **Hold Manager** (admin only) — Select/Draw/Copy tools with undo/redo
- **Hold Manager modes** — Boundaries mode (edit polygons) and Hold Info mode (view/edit metadata)
- **Hold polygon editor** — draw vertices, reshape, delete, add vertex on edge
- **Hold metadata** — name, color (12 options), hold types (10), positivity (-5 to +5), material (Wood/PU/Fibreglass/Dual-tex)
- **Hold info cards** — tap hold in metadata mode to see summary, "Edit Hold" button
- **Hold info from route view** — "Hold Info" toggle below board when viewing a route, tap route holds to see metadata
- **Copy/paste holds** — copy hold → place → rotate → drag → done
- **Bulk operations** — "Delete all medium" confidence holds, "Select All"

### Session Tracking
- **Start/Stop session** — timer-based, records board angle
- **Log sends** — route + angle + grade per send
- **Log attempts** — track attempted routes
- **Session summary** — duration, sends breakdown, hardest grade, angles climbed
- **Deduplication** — won't double-count sends of the same route at same angle

### Data & Sync
- **Supabase storage** — routes, sessions, playlists, hold overrides, custom holds
- **Multi-device sync** — data re-fetched when tab becomes visible
- **localStorage migration** — existing data auto-migrated on first Supabase login
- **Immediate flush** — critical writes (save route, end session) sync instantly
- **Debounced sync** — non-critical changes sync after 1500ms

### Hold Warning System
- **Missing hold detection** — routes flag holds that no longer exist on board
- **Ghost outlines** — missing holds shown as dotted outlines using stored snapshots
- **Fix route flow** — edit route to remove/replace missing holds
- **Warning dots** — use physical hold color from snapshots (not selection type color)
- **Auto-strip on save** — missing hold IDs removed from route on save

### Auto Hold Type Collection
- **Route form auto-fills** hold type tags from individual holds' metadata
- **TagPicker highlights** auto-detected types with bold + ✦ indicator
- **Additive only** — auto-types are added to user selections, never removed

## Known Bugs / Issues

### ⚠️ Hold IDs scrambled after board image replacement (ACTIVE — needs fix)
- Board image was replaced and `detect_holds.py` re-ran, overwriting `holds.json`
- All 24 original hold IDs now point to different physical holds (IDs assigned by sort order, new holds interspersed)
- Existing routes reference old hold IDs → holds render in wrong positions
- **Fix designed**: spatial matching to restore old IDs + assign new IDs to 19 newly detected holds
- See TASK_SPEC.md for the complete repair plan

### Multi-device sync is visibility-based, not real-time
- Data only refreshes when switching back to the tab (visibilitychange event)
- If both devices are open simultaneously, changes won't appear until you switch away and back
- Playlists use the same mechanism — create on laptop, must tab-switch on phone to see it

### Session tracking edge cases
- Session summary may show duplicate route sends if the same route is marked sent multiple times at different points
- Personal best count may be off by one in edge cases with the deduplication logic

### Hold Manager image sizing
- Recently fixed (`xMidYMin meet`), but the SVG-over-image alignment is sensitive to CSS changes
- Any change to the flex container, image sizing, or preserveAspectRatio will break hold boundary alignment
- Must test on BOTH phone AND laptop after any change to BoardSetupView layout

## Fragile / Risky Areas

### BoardSetupView.jsx (~1280 lines)
- **Most complex file in the app** — handles 3 tools, 2 modes, copy/paste, undo/redo, vertex editing, zoom/pan
- Touch/mouse event handling is carefully tuned — any change risks mobile breakage
- The `preserveAspectRatio="xMidYMin meet"` fix was hard-won — do not change to `xMidYMid`
- Copy/paste rotation uses `_origPoly` pattern to prevent drift — don't refactor this

### App.jsx (~1900 lines)
- **Growing too large** — handles view state, route CRUD, session tracking, Supabase sync, hold data, playlists, and rendering for multiple views
- State is complex — many `useState` hooks with interdependencies
- Supabase sync logic (debounced + immediate flush) is interleaved with UI logic
- Potential refactor target but risky due to interconnected state

### Touch Event Handling (all interactive SVG components)
- `lastTouchTimeRef` + `isSynthesizedMouse()` pattern is non-obvious but essential
- Removing or altering these guards causes ghost clicks on mobile
- Must be preserved in BoardSetupView, HoldEditorView, and BoardView

### Coordinate System
- All hold positions are board-area percentages (0-100), not image percentages
- `boardRegion` in holds.json defines the mapping
- If the board photo changes, `boardRegion` must be recalibrated or hold positions break
- The Python detection script outputs the correct boardRegion for each photo

## Recent Important Changes (March–April 2026)
1. **Supabase integration** — migrated from pure localStorage to Supabase + localStorage cache
2. **Auth system** — email/password with admin-only Hold Manager access
3. **Multi-device sync** — tab visibility re-fetch
4. **Hold Manager SVG fix** — `xMidYMid` → `xMidYMin` for correct alignment on all screen sizes
5. **Hold Info mode** — metadata viewing/editing in Hold Manager and route view
6. **Auto hold type collection** — route form pre-fills from hold metadata
7. **Session tracking improvements** — deduplication, stop button, summary fixes
8. **Playlists** — create/manage route playlists with Supabase sync
9. **Hold warning system** — ghost outlines, remove buttons, auto-strip on save
10. **iOS PWA keyboard fix** — removed `maximum-scale=1.0`/`user-scalable=no` from viewport (suppressed keyboard in standalone mode); pinch-zoom now blocked via CSS `touch-action: pan-x pan-y` on `#root` instead

## Technical Debt
- **App.jsx is too large** (~1900 lines) — could benefit from extracting Supabase sync, session tracking, and route management into custom hooks
- **No tests** — zero automated tests, all testing is manual
- **No error boundaries** — Supabase failures can leave app in broken state
- **No offline mode** — if Supabase is unreachable, the app loads from localStorage cache but new writes may fail silently
- **Inline styles everywhere** — no CSS modules or styled components, all styles are inline objects
- **No loading states** — Supabase data loads asynchronously but no skeleton/spinner UI

## What Feels Stable vs Unstable

### Stable
- Route creation flow (hold selection → form → save)
- Board image rendering with zoom/pan
- Route view dimming mask
- Grade system conversion
- Hold polygon math (polygonUtils.js)
- Three-layer hold data architecture
- Auth flow

### Less Stable
- Hold Manager layout/sizing (sensitive to CSS changes, must test both phone + laptop)
- Supabase sync timing (immediate vs debounced, edge cases with rapid changes)
- Session tracking deduplication
- Multi-device data freshness

## Not Yet Built — Multi-User / Social Features
The app is designed for multiple users sharing one board (see CLAUDE.md "Social / Multi-User Model"). The following need implementation:

- **Per-user sent status** — currently `sent` is stored on the route itself. Needs to be per-user so each climber tracks their own sends independently.
- **Per-user star ratings with community average** — currently rating is stored on the route. Needs per-user ratings with the card showing the average of all users' ratings.
- **Creator-only editing** — currently any logged-in user can edit any route. Need `creatorId` on routes and edit button only shown to the creator.
- **Setter search/filter** — filter route list by setter name to find favourite route-setters.
- **Shared playlists** — playlists are currently private per user. Add option to share a playlist with other users.
- **Per-user angle-grade sent tracking** — `angleGrades[].sent` should be per-user, not on the shared route record.

## Board Image Update Feature (Session 1 — 2026-04-12)

### What's Built
- **Dynamic image loading** — board image URL loaded from `board_image_config` in `board_settings` table, with fallback to static files in `public/`
- **Upload wizard** — `BoardImageUpdateView.jsx` — 3-step wizard (Upload → Crop → Confirm) accessible from Settings (admin only)
- **Supabase Storage upload** — saves 4 responsive sizes (full, 2000w, 1200w, 800w) to `board-images` bucket
- **Image rename** — user can name the image (auto-increments version, e.g. `Barn_Set_01_V6`)
- **Error handling** — upload failures show user-friendly error in the wizard
- **Multi-device sync** — `board_image_config` re-fetched on tab visibility change

### What's Built (Session 2 — 2026-04-15)
- **Perspective warp / align step** — 4-corner alignment step between crop and confirm (upload → crop → align → confirm)
- `AlignStep` component in `BoardImageUpdateView.jsx` — oversized workspace (20% padding), 4 draggable corner pins, background opacity slider, Skip option
- Canvas-based triangle mesh warp (10×10 grid = 200 triangles) — applies on pin release, renders in-place preview
- Touch handling follows `lastTouchTimeRef` pattern, 44px hit targets, window-level move/end listeners

### What's NOT Built Yet (Session 3)
- Phone UX testing and polish
- "Revert to previous image" option
- Cache busting for new image URLs

### Supabase Setup Required
- A `board-images` Storage bucket must exist (the code attempts to create it on first upload, but Supabase may require manual creation via dashboard if RLS blocks `createBucket`)

## Recent Changes
- **2026-04-15** — Session 2: Added `AlignStep` perspective warp component to `BoardImageUpdateView.jsx`. Wizard is now 4 steps. `perspectiveWarp()` helper uses canvas triangle mesh. Memoized `toDataURL` to prevent jank during pin drag.
