#!/usr/bin/env python3
"""
build_candidates.py — generous per-board "tap-a-hold" candidate library.

The in-app Hold Manager's tap-to-segment works by hit-testing the tapped point
against a precomputed library of plausible hold outlines and dropping in the best
match as an editable hold. This script builds that library: it runs the FastSAM
detector at PERMISSIVE settings (over-generate, keep overlaps) and adds the
appearance-based foot-chip finder, so the library covers far more than the final
detected set — including the small foot chips and holds the strict pipeline filters
out. Tapping anything the library covers gives an instant outline; truly-uncovered
spots fall back to the existing Draw tool.

Output: a JSON of candidate polygons (board-area %), ready to store in
board_settings['hold_candidates_<boardId>'] and load in the app.

Run
---
  /tmp/holds_venv/bin/python scripts/build_candidates.py \
      --image board-assets/yonder/Yonder_Set_01_V1.jpg \
      --board-region "1,0.5,98,97" \
      --output /tmp/yonder_candidates.json
"""
import argparse
import json
import sys
from pathlib import Path

try:
    import cv2
    import numpy as np
except ImportError as e:  # pragma: no cover
    print(f"Error: missing dependency — {e}"); sys.exit(1)

sys.path.insert(0, str(Path(__file__).resolve().parent))
import detect_holds_v2 as d2
import refine_holds as rf


def mask_to_candidate(mask_board, bgr_board, bw, bh, source):
    cnt = rf.largest_contour(mask_board)
    if cnt is None or cv2.contourArea(cnt) < 30:
        return None
    poly = d2.contour_to_polygon(cnt, bw, bh)
    if len(poly) < 3:
        return None
    x, y, w, h = cv2.boundingRect(cnt)
    M = cv2.moments(cnt)
    if M["m00"] == 0:
        return None
    cx = M["m10"] / M["m00"]; cy = M["m01"] / M["m00"]
    area = int(cv2.countNonZero(mask_board))
    return {
        "polygon": poly,
        "cx": round(cx / bw * 100, 2), "cy": round(cy / bh * 100, 2),
        "w_pct": round(w / bw * 100, 2), "h_pct": round(h / bh * 100, 2),
        "area": area,
        "color": d2.classify_colour(bgr_board, mask_board),
        "source": source,
    }


def main():
    ap = argparse.ArgumentParser(description="Build per-board tap candidate library.")
    ap.add_argument("--image", default="board-assets/yonder/Yonder_Set_01_V1.jpg")
    ap.add_argument("--board-region", default="1,0.5,98,97", dest="board_region")
    ap.add_argument("--output", default="/tmp/yonder_candidates.json")
    ap.add_argument("--overlay", default="board-assets/yonder/_candidates_overlay.jpg")
    args = ap.parse_args()

    root = Path(__file__).resolve().parents[1]
    img_path = Path(args.image)
    if not img_path.is_absolute():
        img_path = root / args.image
    p = [float(x) for x in args.board_region.split(",")]
    region = {"left": p[0], "top": p[1], "width": p[2], "height": p[3]}

    # PERMISSIVE settings → over-generate; keep overlaps (tap picks the best one).
    d2.FASTSAM_CONF = 0.05
    d2.FASTSAM_MAX_DET = 1000
    d2.MIN_AREA_FRAC = 0.00006
    d2.NESTED_OVERLAP_THRESH = 0.92  # keep near-duplicates/overlaps as alternatives

    print("Running FastSAM (permissive) via get_candidate_masks …")
    bundle = d2.get_candidate_masks(str(img_path), region)
    crop = bundle["crop"]; bw, bh = crop["bw"], crop["bh"]
    bgr_board = bundle["bgr_board"]; lab = bundle["lab_board"]
    ply_mean, ply_std = bundle["ply_mean"], bundle["ply_std"]
    board_area = bw * bh

    cands = []
    fastsam_masks = []
    for c in bundle["candidates"]:
        m = c["mask_board"]
        fastsam_masks.append(m)
        cd = mask_to_candidate(m, bgr_board, bw, bh, "fastsam")
        if cd:
            cands.append(cd)
    print(f"  FastSAM candidates: {len(cands)}")

    # Appearance foot-chip candidates (depth unused by the rebuilt finder → zeros ok).
    print("Adding appearance foot-chip candidates …")
    depth_zero = np.zeros((bh, bw), np.float32)
    chips = rf.recover_foot_chips(fastsam_masks, bgr_board, lab, depth_zero,
                                  ply_mean, ply_std, board_area)
    nchip = 0
    for m in chips:
        cd = mask_to_candidate(m, bgr_board, bw, bh, "footchip")
        if cd:
            cands.append(cd); nchip += 1
    print(f"  foot-chip candidates: {nchip}")

    # Light dedup: drop near-exact duplicates (same centre & area); keep overlaps.
    cands.sort(key=lambda c: -c["area"])
    kept = []
    for c in cands:
        dup = False
        for k in kept:
            if (abs(c["cx"] - k["cx"]) < 0.4 and abs(c["cy"] - k["cy"]) < 0.4 and
                    abs(c["area"] - k["area"]) / max(k["area"], 1) < 0.10):
                dup = True; break
        if not dup:
            kept.append(c)
    for i, c in enumerate(kept):
        c["id"] = f"cand_{i + 1}"
    print(f"  total candidates after light dedup: {len(kept)}")

    out = {"boardRegion": region, "imageFile": str(args.image),
           "count": len(kept), "candidates": kept}
    Path(args.output).write_text(json.dumps(out))
    print(f"Wrote {len(kept)} candidates → {args.output}")

    # Overlay for visual coverage check.
    img = cv2.imread(str(img_path))
    bl = int(img.shape[1] * region["left"] / 100); bt = int(img.shape[0] * region["top"] / 100)
    for c in kept:
        pts = np.array([[int(pp[0] / 100 * bw + bl), int(pp[1] / 100 * bh + bt)]
                        for pp in c["polygon"]], np.int32)
        col = (0, 200, 255) if c["source"] == "footchip" else (0, 220, 0)
        cv2.polylines(img, [pts], True, col, 1, cv2.LINE_AA)
    ov = Path(args.overlay)
    if not ov.is_absolute():
        ov = root / args.overlay
    cv2.imwrite(str(ov), img)
    print(f"Overlay → {ov}")


if __name__ == "__main__":
    main()
