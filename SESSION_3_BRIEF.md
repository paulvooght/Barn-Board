# Session 3 Brief — Replace Warp with Board-Corner Recalibration

*Written: 2026-04-17 at the end of Session 2. Start Session 3 in a fresh thread with this as context.*

## One-line summary
Delete the perspective-warp pipeline entirely. Replace it with a single "mark board corners" step that writes a per-image `boardRegion` into `board_image_config`. Holds render correctly on the new image without any warping, because `boardRegion` is recalibrated rather than the image being distorted to match the old `boardRegion`.

---

## Why this is happening

### What Session 2 built
Session 2 added a 4-step wizard: **upload → crop → align → trim → confirm**. The align step lets the user drag 4 pins to perspective-warp the new photo to match the old. Trim crops the warp output to the old image's bounds. Confirm shows the output before upload.

The math works. The output matches the live CSS preview. The warp quality is good (pixel-by-pixel homography with bilinear interpolation, no triangle seams).

### Why it doesn't actually solve the problem
Hold positions are stored as percentages of a `boardRegion` rectangle, which is itself stored as percentages of the image. The coordinate formula:

```
SVG_x = boardRegion.left% × imgW + (hold.cx / 100) × boardRegion.width% × imgW
```

For holds to render correctly on the new image, the **physical board corners** must sit at the same `boardRegion` percentages as on the old image.

The align step asks the user to align the **4 corners of their cropped new photo** to 4 points on the old photo. But those photo corners are not the same thing as the physical board corners. The only way the current system produces correct hold positions is if:

1. The user's new photo is cropped **exactly** to the image area of the old photo (not the board area — the full image), AND
2. The 4 pins are placed **exactly** at the 4 corners of that same image area

In practice this is impossible to do by eye, even with zoom and loupes. The user reported: "I have used zoom in our align tool and I am confident the new image is an almost pixel perfect match to the old, yet the hold outlines are way off."

They're right. It's a structural mismatch between what the UI asks for (image-corner alignment) and what the hold math needs (physical-board-corner alignment). More alignment precision can't fix it.

### The fix
Let the new image be whatever the user uploaded. Don't warp it. Instead, ask the user to mark the 4 physical board corners on the new image. Store those 4 points as the new `boardRegion`. Hold `cx`/`cy` percentages stay identical because they're relative to `boardRegion`, not to the image.

Result: new image is undistorted, holds line up because `boardRegion` is actually correct for that specific image. If holds look slightly off, the user adjusts the 4 corner pins — a meaningful correction loop.

---

## Architecture changes

### Data model change: `board_image_config` gains `boardRegion`

Currently `board_image_config` (stored in Supabase `board_settings` table under key `board_image_config`) has roughly:
```json
{
  "baseUrl": "https://xxx.supabase.co/storage/v1/object/public/board-images",
  "imageName": "Barn_Set_01_V6"
}
```

After Session 3:
```json
{
  "baseUrl": "...",
  "imageName": "Barn_Set_01_V6",
  "boardRegion": { "left": 7.8, "top": 4.2, "width": 84.5, "height": 91.6 }
}
```

Where `left/top/width/height` are percentages of the image's natural dimensions — **defining where the physical board sits inside the image**. This has the same shape as the existing `boardRegion` in `src/data/holds.json`, which is read today by everything that renders the board.

Resolution-independence is preserved: because `boardRegion` is percentages, it works across the `-800w`, `-1200w`, `-2000w`, and full-size variants in `srcSet`.

### App-level change: read `boardRegion` from config, fall back to holds.json

Wherever the app currently reads `boardRegion` (check `BoardView.jsx`, `BoardSetupView.jsx`, `HoldEditorView.jsx`, and any other component that positions holds), it needs to prefer `boardImageConfig.boardRegion` if present, otherwise fall back to `holds.json`'s `boardRegion`.

**Important**: `boardImageConfig` lives in `App.jsx` state (`boardImageConfig`, set by `loadDataFromSupabase`). The `boardRegion` needs to be plumbed down to components that currently import from `holds.json`. The cleanest way is probably to compute an `effectiveBoardRegion` in `App.jsx` and pass it as a prop, or expose it via a tiny context/hook. Confirm which in the Phase 1 design discussion.

### Wizard redesign: replace 5 steps with 3

**Before:** upload → crop → align → trim → confirm
**After:** upload → crop → **mark corners** → confirm

- **Upload** — unchanged
- **Crop** — unchanged (rough crop to remove background clutter, not precise)
- **Mark corners** — NEW. Shows the cropped new image. User places/drags 4 pins on the 4 physical board corners (TL / TR / BL / BR). Pin positions become percentages → new `boardRegion`. Loupe UX carries over (crosshair + magnifier on touch drag).
- **Confirm** — shows the new image with **all existing holds overlaid** using the new `boardRegion`. This is the real validation: if holds line up, we're done. If not, user taps "Adjust corners" to go back and nudge pins, with the hold overlay still visible.

### Delete from `BoardImageUpdateView.jsx`
- `computeHomography` function
- `perspectiveWarp` function
- `computePerspectiveCSS` function
- The entire `AlignStep` component (including both `align` and `trim` phases)
- The inline trim-phase loupe
- `matrix3d` CSS preview math
- The zoom/pan state and pinch-zoom handlers that exist specifically for the align/trim phases (unless the new "mark corners" step reuses them — fine to keep in that case)

That's roughly **800+ lines of code deleted**. Net simplification.

### Keep from Session 2 work
- The crop step (`CropStep`) and its loupe — still useful
- `canvasToBlob`, `resizeToBlob`, `autoIncrementName` helpers
- Multi-resolution upload (full + 2000w + 1200w + 800w)
- Supabase Storage upload flow
- `board_image_config` write path (just add `boardRegion` to the payload)
- Error handling, naming UX, cache-busting considerations

---

## New component: `MarkCornersStep`

### Inputs
- `croppedCanvas` — the cropped new image as a canvas (natural size)
- `previousBoardRegion` — the current effective `boardRegion` (used to pre-position pins as a best guess, so the user drags from somewhere sensible rather than all 4 pins stacked at origin)
- `holds` — the list of holds (to render as overlay preview in the confirm step — but this step itself may not need them; the confirm step does)

### Outputs (via `onDone` callback)
- `boardRegion: { left, top, width, height }` — percentages of cropped image natural dimensions

### UI
- Full-width container showing the cropped new image at display scale
- 4 pins at corners of `previousBoardRegion` as starting positions
- Draggable pins with 44px hit targets, touch + mouse support via `lastTouchTimeRef` pattern
- Pinch-to-zoom and single-finger pan when zoomed (reuse from Session 2's AlignStep)
- Loupe magnifier on touch drag (reuse the CropStep loupe, which already has the crosshair + circle UI)
- Labels on each pin: "TL", "TR", "BL", "BR"
- Next button → passes computed `boardRegion` to parent

### Math
```js
const boardRegion = {
  left:   (pins[0].x / imgWidth)  * 100,
  top:    (pins[0].y / imgHeight) * 100,
  width:  ((pins[3].x - pins[0].x) / imgWidth)  * 100,
  height: ((pins[3].y - pins[0].y) / imgHeight) * 100,
};
```

**Note**: this assumes an axis-aligned board region, which is what the current `boardRegion` model assumes. If any of the 4 pins ends up not forming a rectangle (e.g. user tilted them), we compute the bounding box. Discuss in Phase 1 whether to enforce rectangle (e.g. TR.y snaps to TL.y) or allow free placement and use bounding box.

---

## New component: `ConfirmStep` (or enhanced existing confirm)

### What it does
- Shows the new image at normal display size
- Renders the existing hold overlays on top using the new `boardRegion`
- Provides "Looks right — Save" and "Adjust corners" buttons
- Optional: show a highlighted subset of holds (e.g. corners of the board, a few scattered holds) so the user doesn't have to squint at 43 overlapping polygons

### Why this is critical
This is the real validation. Alignment precision in the wizard doesn't matter; what matters is that the holds land on their physical counterparts. If a handful of holds are consistently off in one direction, the user drags one pin and checks again. This is the correction loop.

---

## Files likely to change

| File | Change |
|---|---|
| `src/components/BoardImageUpdateView.jsx` | Delete AlignStep + warp fns. Add MarkCornersStep. Rewire wizard steps. |
| `src/App.jsx` | Derive `effectiveBoardRegion` from `boardImageConfig ?? holds.json`. Pass to children. Save `boardRegion` in the `board_image_config` upload payload. |
| `src/components/BoardView.jsx` | Accept `boardRegion` prop (or read from context); use in SVG coordinate math. |
| `src/components/BoardSetupView.jsx` | Same — accept `boardRegion` prop/context for Hold Manager. |
| `src/components/HoldEditorView.jsx` | Same. |
| `src/components/HoldOverlay.jsx` | Check if it reads boardRegion directly — if so, same. |
| `src/data/holds.json` | Unchanged. Still the fallback. |
| `CURRENT_STATE.md` | Append Recent Changes entry. |
| `CLAUDE.md` | Update the "Board Image Coordinate System" section to note that `boardRegion` can come from `board_image_config`. |

---

## Phase 1 design questions to settle before coding

1. **Prop vs context for `boardRegion`?** App.jsx already passes a lot of props. Probably a small `useBoardRegion()` hook reading from a context is cleanest. Or just add it to the existing prop drilling. Decide based on how many components need it.

2. **Rectangle-enforcing or free-quad pins?** Enforcing a rectangle (TR locked to TL.y, BR to BL.y, etc.) is simpler and matches the current `boardRegion` model. Free-quad + bounding box is more forgiving if the camera was slightly tilted but adds confusion. Recommend **rectangle-enforcing** with a small rotation control later if needed.

3. **Back-compat with pre-Session-3 uploads?** If a user already uploaded a V6 image during Session 2 (with warp), its `board_image_config` won't have `boardRegion`. They'll fall back to `holds.json`'s `boardRegion`, which is correct for the **old** V5 image, not V6. Result: holds off on V6. **Mitigation**: when the user first opens the wizard in Session 3, detect config-without-boardRegion and prompt them to re-mark corners on the current image. Or accept that they need to re-run the wizard once. Discuss.

4. **Cache busting** — still on the Session 2 TODO list. Session 3 is the right time to fix it (append `?v=timestamp` to the image URL when a new one is saved, or rename on each upload — auto-increment already does this, so it's likely fine).

5. **"Revert to previous image" option** — also on the Session 2 TODO list. Could be included in Session 3 or deferred. Low priority; up to the user.

---

## Safe tag / rollback

Before Session 3 changes:

```bash
git tag v1.1-pre-session-3
git push origin v1.1-pre-session-3
```

If Session 3 goes sideways, `git checkout v1.1-pre-session-3` gets back to Session 2's state (which at least produces visually aligned previews even if holds don't line up).

---

## Workflow

Follow the standard CLAUDE.md 3-phase workflow:

1. **Phase 1 — Design (Opus):** Read CLAUDE.md, CURRENT_STATE.md, and this brief. Confirm architecture decisions above with the user (especially questions 1, 2, 3). Produce a precise task list with file paths.
2. **Phase 2 — Execution (Opus orchestrates Sonnet subagents):** One subagent per cognitively-scoped task. Each subagent commits + pushes. Suggested task split:
   - Task A: Data plumbing — add `boardRegion` to `board_image_config` schema, read in App.jsx, expose to components
   - Task B: Build `MarkCornersStep` component with touch/mouse/zoom/loupe
   - Task C: Rewire wizard steps (delete AlignStep, insert MarkCornersStep, update ConfirmStep to render hold overlay preview)
   - Task D: Delete dead code (computeHomography, perspectiveWarp, computePerspectiveCSS, AlignStep)
   - Task E: Back-compat handling for images uploaded before Session 3
3. **Phase 3 — Review (Opus):** Integrate Recent Changes into CURRENT_STATE.md. Check for drift. Report to user.

---

## Files to read first in the new session

- `CLAUDE.md` — operating manual, coordinate system, touch-handling rules
- `CURRENT_STATE.md` — what's working/fragile (especially sections on Hold Manager and Board Image Update)
- `SESSION_3_BRIEF.md` — this file
- `src/components/BoardImageUpdateView.jsx` — current wizard (will be heavily edited)
- `src/App.jsx` — board image config handling (~line 95–230 for load, ~line 1050–1090 for save)
- `src/data/holds.json` — current `boardRegion` shape (just for reference)

Ignore (old Session 2 design docs, potentially misleading now):
- `SESSION_2_BRIEF.md` — Session 2 is done, its approach is superseded
- `TASK_SPEC_BOARD_IMAGE_UPDATE.md` — if it describes warp-based approach, the math is obsolete

---

## What the user should expect after Session 3

- Uploading a new image is visually simpler: crop, mark 4 corners, confirm with holds preview, save.
- Holds line up because `boardRegion` was recalibrated for the new image — not because the new image was distorted to fake the old `boardRegion`.
- The new image is the real photo, no perspective warp artifacts.
- If holds look off after upload, one tap takes the user back to the corner-marking step with the hold overlay visible, and dragging a single pin shifts the whole hold overlay rigidly — easy to fix.
- Significantly less code in `BoardImageUpdateView.jsx`.
