# The Barn — wall source assets

The Barn predates the `board-assets/<slug>/` convention, so its source files stay
where they've always been (moving them would touch load-bearing paths for the live
wall — not worth the risk). This file is just a pointer.

- **board_id:** `1c97fee6-285a-4774-a185-cb5f17e60acf` · **slug:** `the-barn` · **visibility:** private

| Asset | Location |
|-------|----------|
| Board image (+ variants) | `public/Barn_Set_01_V7.jpg` (also the app's bundled first-paint fallback) |
| Base holds + boardRegion | `src/data/holds.json` (legacy seed/revert; live holds are in `board_settings['holds_<id>']`) |
| Legacy global keys (revert path) | `board_settings`: `custom_holds`, `hold_overrides`, `board_image_config` |

New walls (Yonder onward) keep their source assets under `board-assets/<slug>/`.
