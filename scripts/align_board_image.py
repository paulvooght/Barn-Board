#!/usr/bin/env python3
"""
Align a new board photo into the pixel frame of the currently-published
reference image, so existing hold polygons (calibrated to the reference
image's exact pixels) stay byte-identical when the photo is swapped.

Why this exists: hold positions are stored as percentages of the board
region *within a specific photo*. If the camera moves even slightly between
shots, every hold would need to shift too — but hold IDs are load-bearing
(routes reference them). Instead of re-detecting/re-numbering holds, this
script warps the NEW photo to match the OLD photo's frame via a SIFT+RANSAC
homography, so the old holds still land in the right place on the new image.

Usage:
    python3 scripts/align_board_image.py \\
        --reference public/Barn_Set_01_V7.jpg \\
        --new public/Barn_Set_01_V8.jpg \\
        --output board-assets/the-barn/Barn_Set_01_V8.jpg \\
        --overlay board-assets/the-barn/_v8_aligned_holds_overlay.jpg \\
        --holds board-assets/the-barn/_holds_snapshot_2026-09-09.json

Algorithm:
    1. Load --reference and --new with cv2, convert to grayscale.
    2. cv2.SIFT_create(8000): detect + compute keypoints/descriptors on both.
    3. cv2.BFMatcher().knnMatch(desc_new, desc_ref, k=2), Lowe ratio test (0.75).
    4. cv2.findHomography(src=new_pts, dst=ref_pts, cv2.RANSAC, 3.0)
       -> H maps NEW pixel coords onto REFERENCE pixel coords.
    5. cv2.warpPerspective(new_img, H, (ref_w, ref_h),
           flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
       BORDER_REPLICATE is deliberate: a plain warp leaves a black border of
       missing pixels (the new photo doesn't perfectly cover the old frame
       after warping) — replicating the edge pixels outward reads as a smear
       of out-of-focus plywood, which is far less jarring than a black stripe.
       Do not change this to BORDER_CONSTANT.
    6. Write the aligned JPEG at quality 95.

Writes a report to stdout and to <output>.align.json (keypoint/match/inlier
counts, RANSAC reprojection error stats, the homography matrix, image
dimensions, and per-point displacement at the reference frame's 4 corners
+ centre). Aborts (no output written) if --min-inliers or --max-residual
is violated.

Board-generic: works for any wall (The Barn today, Yonder or others later)
— it only needs a reference image and a new photo, nothing hardcoded.

This script makes NO writes to Supabase and does not publish anything.
Optionally draws a QA overlay of hold polygons (from --holds) on the
aligned output, using the same board-% -> pixel conversion as the app
(see CLAUDE.md "Board Image Coordinate System"):
    px_x = (L + cx/100 * W) / 100 * img_w
    px_y = (T + cy/100 * H) / 100 * img_h

Dependencies (already installed globally — do not add any / do not venv):
    cv2 (opencv-python-headless), numpy, Pillow
"""

import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np


def parse_board_region(s: str) -> dict:
    parts = [p.strip() for p in s.split(",")]
    if len(parts) != 4:
        raise argparse.ArgumentTypeError(
            f"--board-region must be 'L,T,W,H' (4 comma-separated numbers), got: {s!r}"
        )
    try:
        left, top, width, height = (float(p) for p in parts)
    except ValueError as e:
        raise argparse.ArgumentTypeError(f"--board-region values must be numeric: {e}")
    return {"left": left, "top": top, "width": width, "height": height}


def load_holds_file(path: Path) -> list:
    raw = json.loads(path.read_text())
    if isinstance(raw, dict) and "holds" in raw:
        holds = raw["holds"]
    elif isinstance(raw, list):
        holds = raw
    else:
        raise ValueError(
            f"{path}: expected a bare array of holds or {{'holds': [...]}}, "
            f"got top-level type {type(raw).__name__}"
        )
    return holds


def compute_homography(ref_gray: np.ndarray, new_gray: np.ndarray):
    """
    Returns (H, report_dict). H maps NEW pixel coords -> REFERENCE pixel coords.
    report_dict carries keypoint/match/inlier stats and reprojection error.
    """
    sift = cv2.SIFT_create(8000)
    kp_ref, desc_ref = sift.detectAndCompute(ref_gray, None)
    kp_new, desc_new = sift.detectAndCompute(new_gray, None)

    bf = cv2.BFMatcher()
    knn_matches = bf.knnMatch(desc_new, desc_ref, k=2)

    good_matches = []
    for pair in knn_matches:
        if len(pair) != 2:
            continue
        m, n = pair
        if m.distance < 0.75 * n.distance:
            good_matches.append(m)

    if len(good_matches) < 4:
        raise RuntimeError(
            f"Only {len(good_matches)} good matches found (need at least 4 to fit a homography)."
        )

    src_pts = np.float32([kp_new[m.queryIdx].pt for m in good_matches]).reshape(-1, 1, 2)
    dst_pts = np.float32([kp_ref[m.trainIdx].pt for m in good_matches]).reshape(-1, 1, 2)

    H, mask = cv2.findHomography(src_pts, dst_pts, cv2.RANSAC, 3.0)
    if H is None:
        raise RuntimeError("cv2.findHomography failed to find a homography.")

    inlier_mask = mask.ravel().astype(bool)
    n_inliers = int(inlier_mask.sum())

    # Reprojection error on inliers only: apply H to each inlier src point,
    # compare to its matched dst point.
    src_inliers = src_pts[inlier_mask].reshape(-1, 2)
    dst_inliers = dst_pts[inlier_mask].reshape(-1, 2)

    ones = np.ones((src_inliers.shape[0], 1), dtype=np.float64)
    src_h = np.hstack([src_inliers.astype(np.float64), ones])  # Nx3
    proj_h = (H @ src_h.T).T  # Nx3
    proj_xy = proj_h[:, :2] / proj_h[:, 2:3]

    errors = np.linalg.norm(proj_xy - dst_inliers, axis=1)
    mean_err = float(errors.mean()) if len(errors) else float("nan")
    max_err = float(errors.max()) if len(errors) else float("nan")

    report = {
        "keypoints_reference": len(kp_ref),
        "keypoints_new": len(kp_new),
        "good_matches": len(good_matches),
        "inliers": n_inliers,
        "inlier_ratio": (n_inliers / len(good_matches)) if good_matches else 0.0,
        "mean_reprojection_error_px": mean_err,
        "max_reprojection_error_px": max_err,
    }
    return H, report


def corner_displacement(H: np.ndarray, ref_w: int, ref_h: int) -> dict:
    """
    For the 4 corners + centre of the REFERENCE frame, find where that point
    came from in the NEW image (apply H^-1) and report the displacement
    (dx, dy, magnitude) relative to the same pixel location in the reference
    frame — i.e. how far the camera's view of that point moved.
    """
    H_inv = np.linalg.inv(H)
    points = {
        "top_left": (0, 0),
        "top_right": (ref_w - 1, 0),
        "bottom_left": (0, ref_h - 1),
        "bottom_right": (ref_w - 1, ref_h - 1),
        "centre": (ref_w / 2.0, ref_h / 2.0),
    }
    out = {}
    for label, (x, y) in points.items():
        src = np.array([x, y, 1.0], dtype=np.float64)
        mapped = H_inv @ src
        mapped_xy = mapped[:2] / mapped[2]
        dx = float(mapped_xy[0] - x)
        dy = float(mapped_xy[1] - y)
        out[label] = {
            "reference_xy": [x, y],
            "new_image_xy": [float(mapped_xy[0]), float(mapped_xy[1])],
            "dx": dx,
            "dy": dy,
            "magnitude": float(np.hypot(dx, dy)),
        }
    return out


def draw_overlay(aligned_bgr: np.ndarray, holds: list, board_region: dict, out_path: Path):
    img = aligned_bgr.copy()
    img_h, img_w = img.shape[:2]
    L, T, W, H_ = board_region["left"], board_region["top"], board_region["width"], board_region["height"]

    for hold in holds:
        cx = hold.get("cx")
        cy = hold.get("cy")
        polygon = hold.get("polygon")

        def to_px(px_pct, py_pct):
            px_x = (L + px_pct / 100.0 * W) / 100.0 * img_w
            px_y = (T + py_pct / 100.0 * H_) / 100.0 * img_h
            return int(round(px_x)), int(round(px_y))

        if polygon:
            pts = np.array([to_px(px, py) for px, py in polygon], dtype=np.int32)
            cv2.polylines(img, [pts], isClosed=True, color=(0, 255, 0), thickness=2)

        if cx is not None and cy is not None:
            cx_px, cy_px = to_px(cx, cy)
            cv2.circle(img, (cx_px, cy_px), 4, (0, 0, 255), thickness=-1)

    cv2.imwrite(str(out_path), img, [cv2.IMWRITE_JPEG_QUALITY, 95])


def main():
    parser = argparse.ArgumentParser(
        description=(
            "Warp a new board photo into a reference photo's exact pixel frame "
            "(SIFT+RANSAC homography), so existing hold polygons stay valid."
        )
    )
    parser.add_argument("--reference", required=True, metavar="PATH",
                        help="The currently-published image that holds are calibrated to.")
    parser.add_argument("--new", required=True, metavar="PATH",
                        help="The raw new photo to align.")
    parser.add_argument("--output", required=True, metavar="PATH",
                        help="Where to write the aligned JPEG.")
    parser.add_argument("--overlay", default=None, metavar="PATH",
                        help="Optional: write a QA overlay JPEG with hold polygons drawn.")
    parser.add_argument("--holds", default=None, metavar="PATH",
                        help="Optional: JSON file (array or {'holds':[...]}) used only for the overlay.")
    parser.add_argument("--board-region", default="1.0,0.5,98.0,97.0", metavar="L,T,W,H",
                        help="Board region as percentages, for the overlay's coordinate conversion. "
                             "Default: 1.0,0.5,98.0,97.0")
    parser.add_argument("--min-inliers", type=int, default=100, metavar="N",
                        help="Abort if RANSAC finds fewer than N inliers. Default: 100")
    parser.add_argument("--max-residual", type=float, default=3.0, metavar="PX",
                        help="Abort if mean RANSAC reprojection error on inliers exceeds this many "
                             "pixels. Default: 3.0")
    args = parser.parse_args()

    board_region = parse_board_region(args.board_region)

    ref_path = Path(args.reference)
    new_path = Path(args.new)
    output_path = Path(args.output)

    if not ref_path.exists():
        print(f"Error: --reference file not found: {ref_path}")
        sys.exit(1)
    if not new_path.exists():
        print(f"Error: --new file not found: {new_path}")
        sys.exit(1)

    print(f"Reference : {ref_path}")
    print(f"New photo : {new_path}")

    ref_img = cv2.imread(str(ref_path))
    new_img = cv2.imread(str(new_path))
    if ref_img is None:
        print(f"Error: cv2 could not read reference image: {ref_path}")
        sys.exit(1)
    if new_img is None:
        print(f"Error: cv2 could not read new image: {new_path}")
        sys.exit(1)

    ref_h, ref_w = ref_img.shape[:2]
    new_h, new_w = new_img.shape[:2]
    print(f"Reference size : {ref_w}x{ref_h}")
    print(f"New size       : {new_w}x{new_h}")

    ref_gray = cv2.cvtColor(ref_img, cv2.COLOR_BGR2GRAY)
    new_gray = cv2.cvtColor(new_img, cv2.COLOR_BGR2GRAY)

    print("\nComputing SIFT + RANSAC homography (new -> reference) ...")
    try:
        H, match_report = compute_homography(ref_gray, new_gray)
    except RuntimeError as e:
        print(f"Error: {e}")
        sys.exit(1)

    print(f"  Keypoints (reference) : {match_report['keypoints_reference']}")
    print(f"  Keypoints (new)       : {match_report['keypoints_new']}")
    print(f"  Good matches (Lowe)   : {match_report['good_matches']}")
    print(f"  RANSAC inliers        : {match_report['inliers']} "
          f"({match_report['inlier_ratio']*100:.1f}% of good matches)")
    print(f"  Mean reprojection err : {match_report['mean_reprojection_error_px']:.3f} px")
    print(f"  Max reprojection err  : {match_report['max_reprojection_error_px']:.3f} px")

    displacement = corner_displacement(H, ref_w, ref_h)
    print("\nDisplacement (reference-frame point <- where it came from in the new photo):")
    for label, d in displacement.items():
        print(f"  {label:12s}: dx={d['dx']:+7.2f}  dy={d['dy']:+7.2f}  |mag|={d['magnitude']:6.2f} px")

    # ── Gate checks ────────────────────────────────────────────────────
    ok = True
    if match_report["inliers"] < args.min_inliers:
        print(f"\nABORT: inliers ({match_report['inliers']}) < --min-inliers ({args.min_inliers})")
        ok = False
    if match_report["mean_reprojection_error_px"] > args.max_residual:
        print(f"\nABORT: mean reprojection error ({match_report['mean_reprojection_error_px']:.3f} px) "
              f"> --max-residual ({args.max_residual} px)")
        ok = False
    if not ok:
        sys.exit(1)

    # ── Warp ──────────────────────────────────────────────────────────
    print(f"\nWarping new image into reference frame ({ref_w}x{ref_h}), "
          "INTER_CUBIC + BORDER_REPLICATE ...")
    aligned = cv2.warpPerspective(
        new_img, H, (ref_w, ref_h),
        flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE,
    )

    # Border-fill diagnostics: warp an all-255 mask with BORDER_CONSTANT=0.
    mask_src = np.full((new_h, new_w), 255, dtype=np.uint8)
    coverage_mask = cv2.warpPerspective(
        mask_src, H, (ref_w, ref_h),
        flags=cv2.INTER_NEAREST, borderMode=cv2.BORDER_CONSTANT, borderValue=0,
    )
    border_filled = int((coverage_mask == 0).sum())
    total_px = ref_w * ref_h
    border_filled_pct = 100.0 * border_filled / total_px

    bgr_sum = aligned.astype(np.int32).sum(axis=2)
    pure_black_count = int((bgr_sum < 10).sum())

    print(f"\nBorder-fill (pixels outside the new photo's coverage, replicated): "
          f"{border_filled} / {total_px} ({border_filled_pct:.3f}%)")
    print(f"Pure-black pixels in aligned output (BGR sum < 10): {pure_black_count}")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(output_path), aligned, [cv2.IMWRITE_JPEG_QUALITY, 95])
    print(f"\nWrote aligned image: {output_path}  ({ref_w}x{ref_h})")

    # ── Report JSON ──────────────────────────────────────────────────
    report = {
        "reference_image": str(ref_path),
        "new_image": str(new_path),
        "output_image": str(output_path),
        "reference_size": {"width": ref_w, "height": ref_h},
        "new_size": {"width": new_w, "height": new_h},
        "match_report": match_report,
        "homography_new_to_reference": H.tolist(),
        "displacement": displacement,
        "border_fill": {
            "pixel_count": border_filled,
            "total_pixels": total_px,
            "percent": border_filled_pct,
        },
        "pure_black_pixel_count": pure_black_count,
        "min_inliers_threshold": args.min_inliers,
        "max_residual_threshold": args.max_residual,
        "passed": ok,
    }
    report_path = output_path.with_name(output_path.name + ".align.json")
    report_path.write_text(json.dumps(report, indent=2))
    print(f"Wrote report: {report_path}")

    # ── Optional overlay ────────────────────────────────────────────────
    if args.overlay:
        if not args.holds:
            print("\nWarning: --overlay given without --holds; skipping overlay.")
        else:
            holds_path = Path(args.holds)
            if not holds_path.exists():
                print(f"\nWarning: --holds file not found: {holds_path}; skipping overlay.")
            else:
                holds = load_holds_file(holds_path)
                overlay_path = Path(args.overlay)
                overlay_path.parent.mkdir(parents=True, exist_ok=True)
                draw_overlay(aligned, holds, board_region, overlay_path)
                print(f"Wrote QA overlay ({len(holds)} holds): {overlay_path}")

    print("\nDone.")


if __name__ == "__main__":
    main()
