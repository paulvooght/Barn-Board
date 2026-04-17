# Session 4 Brief — Image Update Wizard Still Not Aligning Holds

*Written at end of Session 3 — 2026-04-17. Start Session 4 in a fresh thread with this as context.*

## One-line summary
The board image update wizard (5 steps: `upload → crop → align → fineTune → confirm`) is live but still does not produce a result where hold outlines match the physical holds in the uploaded image. The user has an idea for a different approach and will explain it in the new thread.

## What happened in Session 3

Session 3 went through **three** approaches, all either wrong or insufficient:

**Attempt 1 — Replace warp with per-image `boardRegion` recalibration.**
Thesis: no warp needed; just mark the 4 physical board corners in the new photo and store them as a per-image `boardRegion` in `board_image_config`. Result: didn't work — phone photos always have perspective distortion, so the "physical board corners" form a trapezoid, and storing that as a rectangle via bounding box produced wrong alignments. Rectangle-locked pins also prevented expressing the trapezoid at all. Reverted.

**Attempt 2 — Free-quad pins + perspective warp to `holds.json`'s `boardRegion` rectangle.**
Thesis: let the user mark 4 physical board corners freely; warp so those map to the 4 corners of `boardRegion` in old-image pixel space; output a canvas at old-image dimensions. Result: produced ugly warps with black borders, poor visual hold alignment. Failed testing. Reverted.

**Attempt 3 (current state) — Restore Session-2 align UX with opacity overlay + add fine-tune step.**
Thesis: user drags 4 free pins to visually overlay the new image onto the old image using an opacity slider (judging alignment by hold positions visible through the overlay). Warp produces output at old-image dimensions matching the old image. A subsequent FineTuneStep allows translate + uniform scale to nudge final placement. Result (screenshot in conversation): **holds still don't line up with physical holds in the uploaded image.** See the pasted screenshot showing hold outlines scattered away from physical holds.

## What is currently built (as of last commit `0405425`)

**Wizard steps:** `upload → crop → align → fineTune → confirm`

**AlignStep** (`src/components/BoardImageUpdateView.jsx`):
- Workspace: old image rendered at natural dimensions, centered inside a 1.5× bleed area (25% padding each side). Dark gray bleed background.
- Blue `#0047FF` outline around old image marks the "canvas window"
- Old image: full opacity base layer
- New cropped image: overlaid with user-controlled opacity (default 0.6) and live `matrix3d` CSS transform from 4 free-dragging pins
- Pins start at 4 corners of old image (workspace coords); can drag anywhere in the workspace including bleed
- "Show holds" toggle — optional hold overlay on top of old image
- "Crop too small" warning if cropped canvas < 80% of old image dimensions
- Loupe magnifier during touch pin drag
- Pinch zoom (max 5×) + single-finger pan when zoomed
- On Next: `srcQuad` = 4 pins converted to cropped-canvas pixel coords; `dstQuad` = `[[0,0],[oldW,0],[0,oldH],[oldW,oldH]]`; warp output is a canvas at old image dimensions

**FineTuneStep:**
- Takes warped canvas as input
- Translate (single-finger drag) + uniform scale only (pinch / wheel / slider, clamp 0.5–2.0). No independent x/y scale.
- Hold overlay fixed to workspace — user moves image underneath
- Reset button
- On Next: composes a new canvas at old-image dims with translate+scale applied; this is what gets uploaded

**ConfirmStep:**
- Renders composed canvas (fine-tune output) with hold overlay
- "Adjust alignment" → back to AlignStep (pins preserved)
- "Fine tune" → back to FineTuneStep (transform preserved)
- "Save" → uploads composed canvas as 4 variants (full, 2000w, 1200w, 800w)

**`boardRegion`:** single source of truth in `src/data/holds.json`. Never per-image. Components (BoardView, BoardSetupView, HoldEditorView) all read from `holdsData` at module level.

**Cache busting:** `cacheVersion: Date.now()` written to `board_image_config` on every save; `?v=<cacheVersion>` appended to `imgSrc` and each `imgSrcSet` variant URL.

**Helpers in `BoardImageUpdateView.jsx`:**
- `computeHomography(srcPts, dstPts)` — 8×8 solver
- `perspectiveWarp(sourceCanvas, srcQuad, dstQuad, outW, outH)` — pixel-by-pixel bilinear
- `computePerspectiveCSS(w, h, dst)` — matrix3d builder for live preview

## Why it isn't working (hypotheses worth investigating)

These are unconfirmed — the user has their own idea they'll explain, but for reference:

1. **Visual alignment against the old image ≠ hold alignment.** The user aligns the new photo onto the old photo. But the old photo itself may have slight distortion/offset of holds from `holds.json`'s boardRegion — so even a pixel-perfect match to the old image inherits that offset. `holds.json` was detected from a specific reference photo and may not exactly match the served old image.

2. **`boardRegion` in `holds.json` may not perfectly fit the old image served by the app.** If `holds.json` was made against a slightly different crop of the old photo than what the app currently serves, all holds are systematically off.

3. **The laptop workflow (detect_holds.py + merge_holds.py) uses a different reference.** On laptop, the user presumably runs detection against the new image, merges, and gets a new `holds.json` with matching positions. The phone workflow doesn't re-detect — it relies on the new image matching the old image's geometry. If those don't quite match, everything downstream is off.

4. **The `FineTuneStep`'s free translate+scale may be introducing new offset** rather than correcting it, since the user may have tuned the align step well but then nudged the fine-tune away from it.

5. **The served old image may have changed** (image was replaced in public/ or Supabase) while `holds.json`'s `boardRegion` wasn't re-derived. Check `src/data/holds.json` vs what's actually in `public/Barn_Set_01_V5.jpg` or the Supabase Storage image.

## Relevant files

| File | Purpose |
|---|---|
| `src/components/BoardImageUpdateView.jsx` (~1200 lines) | All wizard step components + warp helpers |
| `src/App.jsx` | `boardImageConfig` state (~line 43); `imgSrc`/`imgSrcSet` with cache-busting (~line 478); `handleBoardImageSave` (~line 1085); renders `<BoardImageUpdateView>` (~line 1700) |
| `src/data/holds.json` | `boardRegion` (single source of truth) + all hold polygons |
| `scripts/detect_holds.py` | Laptop-side detection (not part of app runtime) |
| `scripts/merge_holds.py` | Laptop-side merge that preserves hold IDs (not part of app runtime) |
| `CLAUDE.md` | Operating manual; "Board Image Coordinate System" section |
| `CURRENT_STATE.md` | Has the full Session 3 timeline and what's built |

## Rollback points

| Tag | State |
|---|---|
| `v1.1-pre-session-3` | Before Session 3 started. Has Session-2 align step with opacity + trim phase. No fine-tune step. Pre-revert of per-image boardRegion. |

To roll back fully: `git reset --hard v1.1-pre-session-3` (destructive — only if user explicitly asks).

## Commits in Session 3

```
0405425 Task J: add bleed area and canvas window outline to AlignStep
fc88255 Session 3 final: update docs for align+fineTune+confirm wizard
4f44628 Task I: add canvas fine-tune step (translate + uniform scale) between align and confirm
baaf7c2 Task H: restore align-with-opacity step (4 free pins, live matrix3d preview, show-holds toggle, crop-too-small warning)
c1e49fd Session 3 corrected: update docs for free-quad warp wizard (reverts per-image boardRegion thesis)
d61a4e3 Task G: free-quad warp wizard — pins on physical board corners, warp to fixed boardRegion, upload warped canvas
fc4cfac Task F: restore warp helpers, revert boardRegion plumbing, remove back-compat
cf0e20d Session 3 review: update CURRENT_STATE.md and CLAUDE.md for boardRegion recalibration wizard
12c665f Task E: back-compat auto-prompt for pre-Session-3 uploads + image URL cache busting
c7a9a23 Task D: delete dead warp/align code (computeHomography, perspectiveWarp, AlignStep, matrix3d preview)
4d4f021 Task C: rewire wizard to upload → crop → markCorners → confirm with hold overlay
dcf446b Task B: add MarkCornersStep component for boardRegion recalibration
068fbbd Task A: plumb boardRegion as prop, derive from boardImageConfig with holds.json fallback
```

## For Session 4

User will describe their new approach in a fresh thread. Relevant context: they've now tried three approaches; they're looking at a screenshot where holds visibly do not align after going through the full wizard. The existing 5-step wizard code is all in `BoardImageUpdateView.jsx` and can be rebuilt, replaced, or removed as needed. The warp math helpers (`computeHomography`, `perspectiveWarp`, `computePerspectiveCSS`) are solid and reusable.

Follow standard CLAUDE.md 3-phase workflow: Phase 1 design with the user, Phase 2 orchestrated Sonnet subagents, Phase 3 review.
