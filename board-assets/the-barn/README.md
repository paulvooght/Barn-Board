# The Barn — wall source assets

The Barn predates the `board-assets/<slug>/` convention, so its *live/published*
source files stay where they've always been (moving them would touch
load-bearing paths for the live wall — not worth the risk). This directory
additionally holds the **V7 → V8 image-alignment working set** (2026-09-09).

- **board_id:** `1c97fee6-285a-4774-a185-cb5f17e60acf` · **slug:** `the-barn` · **visibility:** private

| Asset | Location |
|-------|----------|
| Board image (+ variants) — **currently published** | `public/Barn_Set_01_V7.jpg` (also the app's bundled first-paint fallback) |
| Base holds + boardRegion | `src/data/holds.json` (legacy seed/revert; live holds are in `board_settings['holds_<id>']`, 200 holds) |
| Legacy global keys (revert path) | `board_settings`: `custom_holds`, `hold_overrides`, `board_image_config` |

New walls (Yonder onward) keep their source assets under `board-assets/<slug>/`.

## V7 → V8 image alignment (2026-09-09)

The board got a new photo (`Barn_Set_01_V8`), but the camera moved slightly
between shots. The Barn's 200 live hold polygons are calibrated to V7's exact
pixel frame, and 38 live routes reference them by ID — re-detecting holds
against the new photo would scramble every ID. So instead of moving the
holds, we **warp V8 into V7's pixel frame** with `scripts/align_board_image.py`
(SIFT+RANSAC homography), keeping every hold record byte-identical.

| File | What |
|------|------|
| `Barn_Set_01_V7.jpg` | Copy of the currently-published reference image (`public/Barn_Set_01_V7.jpg`) — the frame all 200 holds are calibrated to. Alignment input. |
| `Barn_Set_01_V8_raw.jpg` | The untouched new photo as shot (copy of `public/Barn_Set_01_V8.jpg`). Kept as the source for any future re-alignment. |
| `Barn_Set_01_V8.jpg` | **Aligned output** — V8 warped into V7's exact frame. This is what would get published (via `publish_board_image.py`) to replace the live image without touching any hold data. |
| `Barn_Set_01_V8.jpg.align.json` | Full alignment report: keypoint/match/inlier counts, RANSAC reprojection error, the 3×3 homography, and per-corner+centre displacement. |
| `_holds_snapshot_2026-09-09.json` | Read-only snapshot of the live `board_settings['holds_<id>']` array (200 holds), fetched via REST GET for QA-overlay purposes only. Not a source of truth — the live table is. |
| `_v8_aligned_holds_overlay.jpg` | QA overlay: all 200 hold polygons drawn on the aligned V8 image, to visually confirm they still land correctly. |

### Regenerating the aligned image
```bash
python3 scripts/align_board_image.py \
  --reference board-assets/the-barn/Barn_Set_01_V7.jpg \
  --new board-assets/the-barn/Barn_Set_01_V8_raw.jpg \
  --output board-assets/the-barn/Barn_Set_01_V8.jpg \
  --overlay board-assets/the-barn/_v8_aligned_holds_overlay.jpg \
  --holds board-assets/the-barn/_holds_snapshot_2026-09-09.json
```

### Alignment result (2026-09-09 run)
- 4781 / 4918 SIFT keypoints (reference / new); 612 good matches (Lowe 0.75); **427 RANSAC inliers** (69.8%).
- Mean reprojection error **0.840 px**, max **2.955 px** (well under the 3.0 px gate).
- Corner/centre displacement (how far the camera's view moved): top-left 21.2 px, top-right 42.8 px, bottom-left 19.2 px, bottom-right 6.6 px, centre 22.9 px.
- Aligned output is exactly 1500×1463, matching the reference.
- Border-fill (`BORDER_REPLICATE`, pixels outside the new photo's actual coverage): 48,282 px = 2.20% of the frame, all at the outer edges as expected — no black stripe.
- Pure-black pixels (BGR sum < 10) in the aligned output: **2**, both interior (not in the border-fill region) — traced back through the homography to genuinely near-black source pixels in the raw photo (a dark gap/shadow on the board), pushed slightly darker by cubic interpolation. Not an alignment artifact.
- Visual QA (`_v8_aligned_holds_overlay.jpg`): all 200 outlines track their holds tightly across the whole board, including the highest-displacement corner (top-right) — no region shows visible drift.

**This alignment has NOT been published.** `Barn_Set_01_V8.jpg` here is a
candidate replacement for `public/Barn_Set_01_V7.jpg` — publishing (uploading
to Supabase storage + writing `board_image_config`) is a separate, later,
explicitly-gated step via `scripts/publish_board_image.py`.
