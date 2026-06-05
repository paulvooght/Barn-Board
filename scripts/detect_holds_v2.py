#!/usr/bin/env python3
"""
detect_holds_v2.py — Object-first (FastSAM) hold detector for Barn Board.

Replaces the colour-based detect_holds.py approach for dense spray walls where
chalk/specular/shadow pixels fall outside every colour band and shatter holds.

Pipeline
--------
1. FastSAM everything-mode  →  raw mask proposals (764 at default max_det=1000)
2. Size / aspect / edge filters  →  drop non-hold masks
3. Plywood-colour reject  →  drop tan false positives the size filter misses
4. Bolt-hole grid reject  →  tiny round isolated dark dots
5. Nested-mask dedup  →  greedy, keep larger, drop if >60% inside kept mask
6. Colour label (post-hoc)  →  median of most-saturated core pixels → 9-colour palette
7. Export holds-JSON  →  same shape as detect_holds.py (merge_holds.py compatible)

Key design decisions
--------------------
* Colour is AGNOSTIC at detection time. A wrong label is cosmetic and never
  affects geometry — much better than missing a hold entirely.
* Recall-first: settings lean toward over-detection; a human prunes later.
* Polygon format identical to detect_holds.py: [[x_pct, y_pct], ...] as % of
  board area (not full image). merge_holds.py works unchanged.

Usage
-----
  # Create isolated venv (only needed once):
  python3 -m venv /tmp/holds_venv
  /tmp/holds_venv/bin/pip install -r scripts/requirements-detect.txt

  # Run on Yonder image (FastSAM weights auto-download on first run ~90 MB):
  /tmp/holds_venv/bin/python scripts/detect_holds_v2.py \\
      --image board-assets/yonder/Yonder_Set_01_V1.jpg

  # Optional flags:
  #   --output path/to/out.json        default: src/data/holds_new_v2.json
  #   --board-region "L,T,W,H"         percent; default 0,0,100,100 (full image)
  #   --overlay path/to/debug.jpg      default: board-assets/yonder/_detect_v2_overlay.jpg
  #   --force                          overwrite src/data/holds.json if targeted

Requirements
------------
  ultralytics >= 8.2  (FastSAM) — see scripts/requirements-detect.txt
  torch, opencv-python, numpy, Pillow  (pulled in automatically by ultralytics)

  Do NOT install ultralytics into your global python3 — it drags in ~1.5 GB of
  PyTorch. Use the /tmp venv shown above.
"""

import argparse
import json
import math
import os
import sys
from datetime import date
from pathlib import Path

try:
    import cv2
    import numpy as np
except ImportError as e:
    print(f"Error: missing dependency — {e}")
    print("  Run in a venv with: pip install -r scripts/requirements-detect.txt")
    sys.exit(1)

# ─── Defaults ─────────────────────────────────────────────────────────────────

DEFAULT_IMAGE = "board-assets/yonder/Yonder_Set_01_V1.jpg"
DEFAULT_OUTPUT = "src/data/holds_new_v2.json"
DEFAULT_OVERLAY = "board-assets/yonder/_detect_v2_overlay.jpg"
DEFAULT_BOARD_REGION = "0,0,100,100"  # full image (already-cropped published images)

# FastSAM model — try x first (better recall), fall back to s
FASTSAM_MODELS = ["FastSAM-x.pt", "FastSAM-s.pt"]

# FastSAM inference settings (recall-first). These defaults are the recall-tuned
# values validated on Yonder (193 holds vs ~220 true, ~88%). imgsz=1536 is the
# key small-hold lever; CPU cost is fine for a one-time batch. Override via CLI.
FASTSAM_IMGSZ = 1536
FASTSAM_CONF = 0.10
FASTSAM_IOU = 0.7
FASTSAM_MAX_DET = 1000

# ─── Size & Shape Filters ─────────────────────────────────────────────────────

# Area as fraction of board area. MIN tuned down to ~0.018% (~345px) to keep
# small foot-chips; plywood-reject + bolt-grid filters guard against grain noise.
MIN_AREA_FRAC = 0.00018   # below this → bolt-hole / noise
MAX_AREA_FRAC = 0.020     # above this → panel / plywood section

# Span: reject any mask wider or taller than 50% of board dimension
MAX_SPAN_FRAC = 0.50

# Bounding-box fill (mask area / bbox area) — drops hollow rings
MIN_BBOX_FILL = 0.25

# Aspect ratio: max(w,h)/min(w,h) — drops seams, tape, long thin props
MAX_ASPECT = 6.0

# Edge margin (board-% from edge) — holds touching board edge are artifacts
EDGE_MARGIN_PCT = 2.0

# ─── Plywood / Bolt-hole Filters ─────────────────────────────────────────────

# Bolt-hole: tiny + round + area < this (in pixels at full scale)
BOLT_AREA_MAX_PX = 700
BOLT_MAX_DIM_PX = 18
# Aspect check for bolt-holes (near-square)
BOLT_ASPECT_MAX = 1.8

# Nested-mask dedup: drop a mask if this fraction sits inside a larger kept mask.
# 0.75 (not 0.60) so a small hold resting ON a big hold survives dedup.
NESTED_OVERLAP_THRESH = 0.75

# Plywood Lab model reject: mask is plywood if interior median is within
# this many normalised-spread units of the plywood Lab cluster
PLY_DIST_THRESH = 4.5


# ─── Plywood Colour Model (Lab) ───────────────────────────────────────────────

def build_plywood_model(lab: np.ndarray):
    """Robust plywood Lab model via modal (a,b) peak, same as _proto_bg.py.

    Returns (pL, pa, pb), (sL, sa, sb) — median and spread.
    """
    a = lab[:, :, 1].astype(np.float32)
    b = lab[:, :, 2].astype(np.float32)
    L = lab[:, :, 0].astype(np.float32)

    # 2-D histogram of quantised (a,b); plywood is dominant peak
    aq = np.clip(a, 100, 156).astype(int)
    bq = np.clip(b, 100, 156).astype(int)
    hist = np.zeros((157, 157), np.float32)
    np.add.at(hist, (aq, bq), 1.0)
    hist = cv2.GaussianBlur(hist, (5, 5), 1.0)
    pa, pb = np.unravel_index(np.argmax(hist), hist.shape)
    pa, pb = float(pa), float(pb)

    near = (np.abs(a - pa) < 4) & (np.abs(b - pb) < 4)
    pL = float(np.median(L[near])) if near.sum() else float(np.median(L))
    sa = float(np.std(a[near])) if near.sum() else 3.0
    sb = float(np.std(b[near])) if near.sum() else 3.0
    sL = float(np.std(L[near])) if near.sum() else 20.0

    # Floor spreads so grain noise doesn't inflate them
    return (pL, pa, pb), (max(sL, 12.0), max(sa, 2.0), max(sb, 2.0))


def is_plywood_mask(mask_px: np.ndarray, lab: np.ndarray,
                    ply_mean, ply_std) -> bool:
    """Return True if this mask's median Lab is inside the plywood cluster."""
    pL, pa, pb = ply_mean
    sL, sa, sb = ply_std
    sel = mask_px > 0
    if sel.sum() < 10:
        return False
    mL = float(np.median(lab[:, :, 0][sel]))
    ma = float(np.median(lab[:, :, 1][sel]))
    mb = float(np.median(lab[:, :, 2][sel]))
    dist = math.sqrt(((mL - pL) / sL) ** 2 +
                     ((ma - pa) / sa) ** 2 +
                     ((mb - pb) / sb) ** 2)
    return dist < PLY_DIST_THRESH


# ─── Colour Classification (post-hoc) ────────────────────────────────────────

def classify_colour(bgr_board: np.ndarray, mask_px: np.ndarray) -> str:
    """Label by the most-saturated core pixels (same logic as _proto_bg.py).

    Chalk / specular pixels are low-saturation; using only the high-saturation
    core gives a far more stable label than a plain median over all pixels.
    """
    hsv = cv2.cvtColor(bgr_board, cv2.COLOR_BGR2HSV)
    sel = mask_px > 0
    if sel.sum() == 0:
        return "unknown"

    S = hsv[:, :, 1][sel].astype(np.float32)
    H = hsv[:, :, 0][sel].astype(np.float32)
    V = hsv[:, :, 2][sel].astype(np.float32)

    # Use the top-saturation third if the hold has any saturated core
    if S.size >= 9 and float(np.percentile(S, 70)) > 60:
        thr = float(np.percentile(S, 60))
        core = S >= thr
        Hh = float(np.median(H[core]))
        Ss = float(np.median(S[core]))
        Vv = float(np.median(V[core]))
    else:
        Hh = float(np.median(H))
        Ss = float(np.median(S))
        Vv = float(np.median(V))

    # OpenCV HSV: H in [0,179], S/V in [0,255]
    if Vv < 60:
        return "black"
    if Ss < 35 and Vv > 200:
        return "white"
    if Ss < 35:
        return "grey"
    h = Hh
    if h < 8 or h > 170:
        return "red"
    if h < 18:
        return "orange"
    if h < 35:
        return "yellow"
    if h < 82:
        return "green"
    if h < 100:
        return "cyan"
    if h < 128:
        return "blue"
    if h < 150:
        return "purple"
    return "pink"


# ─── Polygon Conversion ────────────────────────────────────────────────────────

def contour_to_polygon(contour, board_w: int, board_h: int,
                       max_points: int = 40) -> list:
    """Convert an OpenCV contour to a polygon in board-area percentages.

    Direct port of detect_holds.py's contour_to_polygon so the output shape
    is identical and merge_holds.py works unchanged.
    """
    epsilon = 0.01 * cv2.arcLength(contour, True)
    approx = cv2.approxPolyDP(contour, epsilon, True)

    while len(approx) > max_points and epsilon < 0.1 * cv2.arcLength(contour, True):
        epsilon *= 1.5
        approx = cv2.approxPolyDP(contour, epsilon, True)

    polygon = []
    for pt in approx:
        x_pct = round(pt[0][0] / board_w * 100, 2)
        y_pct = round(pt[0][1] / board_h * 100, 2)
        polygon.append([x_pct, y_pct])
    return polygon


# ─── FastSAM ─────────────────────────────────────────────────────────────────

def load_fastsam():
    """Import ultralytics and load FastSAM model (tries x then s)."""
    try:
        from ultralytics import FastSAM  # noqa: PLC0415
    except ImportError:
        print("Error: ultralytics not installed.")
        print("  python3 -m venv /tmp/holds_venv")
        print("  /tmp/holds_venv/bin/pip install -r scripts/requirements-detect.txt")
        sys.exit(1)

    for model_name in FASTSAM_MODELS:
        try:
            model = FastSAM(model_name)
            print(f"  Loaded model: {model_name}")
            return model
        except Exception as e:
            print(f"  Could not load {model_name}: {e}")
    print("Error: could not load any FastSAM model.")
    sys.exit(1)


def run_fastsam(model, image_path: str) -> list:
    """Run FastSAM everything-mode and return a list of (H,W) binary uint8 masks.

    Returns each mask as a uint8 numpy array (255 = foreground, 0 = background),
    already cropped to the full image size.
    """
    results = model(
        image_path,
        device="cpu",
        retina_masks=True,
        imgsz=FASTSAM_IMGSZ,
        conf=FASTSAM_CONF,
        iou=FASTSAM_IOU,
        max_det=FASTSAM_MAX_DET,
        verbose=False,
    )

    masks = []
    for r in results:
        if r.masks is None:
            continue
        # r.masks.data is (N, H, W) tensor on CPU
        data = r.masks.data.cpu().numpy()  # float32 0/1
        for i in range(data.shape[0]):
            m = (data[i] > 0.5).astype(np.uint8) * 255
            masks.append(m)

    print(f"  FastSAM raw proposals: {len(masks)}")
    return masks


# ─── Filtering Pipeline ────────────────────────────────────────────────────────

def crop_mask_to_board(mask_full: np.ndarray,
                       bl: int, bt: int, bw: int, bh: int) -> np.ndarray:
    """Crop a full-image mask to the board region."""
    return mask_full[bt:bt + bh, bl:bl + bw]


def filter_masks(masks_full: list, bgr_board: np.ndarray,
                 bl: int, bt: int, bw: int, bh: int,
                 img_w: int, img_h: int,
                 ply_mean, ply_std) -> list:
    """Apply all filters.  Returns list of dicts with keys:
       mask_board (uint8 H×W), contour, area, cx, cy, x, y, w, h

    img_w, img_h: full image dimensions (before board crop) — used to
    correctly resize FastSAM masks that come back at imgsz rather than
    the original image resolution.
    """
    lab_board = cv2.cvtColor(bgr_board, cv2.COLOR_BGR2LAB)
    board_area = bw * bh
    kept = []
    stats = dict(total=len(masks_full), size=0, span=0, bbox_fill=0,
                 aspect=0, edge=0, plywood=0, bolt=0)

    for mask_full in masks_full:
        # FastSAM with retina_masks=True returns masks at original image resolution.
        # If the mask shape doesn't match, resize it to the full image dims first.
        mh, mw = mask_full.shape[:2]
        if mh != img_h or mw != img_w:
            mask_resized = cv2.resize(mask_full, (img_w, img_h),
                                      interpolation=cv2.INTER_NEAREST)
        else:
            mask_resized = mask_full

        mask_b = mask_resized[bt:bt + bh, bl:bl + bw]
        if mask_b.shape != (bh, bw):
            mask_b = cv2.resize(mask_b, (bw, bh), interpolation=cv2.INTER_NEAREST)

        area = int(cv2.countNonZero(mask_b))

        # ── 1. Area band ────────────────────────────────────────────────
        if area < board_area * MIN_AREA_FRAC or area > board_area * MAX_AREA_FRAC:
            stats["size"] += 1
            continue

        # Find contour from mask
        cnts, _ = cv2.findContours(mask_b, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not cnts:
            continue
        cnt = max(cnts, key=cv2.contourArea)
        x, y, w, h = cv2.boundingRect(cnt)

        # ── 2. Span — reject mask wider/taller than 50% of board ────────
        if w > bw * MAX_SPAN_FRAC or h > bh * MAX_SPAN_FRAC:
            stats["span"] += 1
            continue

        # ── 3. Bounding-box fill ─────────────────────────────────────────
        bbox_area = w * h
        if bbox_area > 0 and area / bbox_area < MIN_BBOX_FILL:
            stats["bbox_fill"] += 1
            continue

        # ── 4. Aspect ratio ───────────────────────────────────────────────
        aspect = max(w, h) / max(min(w, h), 1)
        if aspect > MAX_ASPECT:
            stats["aspect"] += 1
            continue

        # ── 5. Edge margin ────────────────────────────────────────────────
        M = cv2.moments(cnt)
        if M["m00"] == 0:
            continue
        cx = M["m10"] / M["m00"]
        cy = M["m01"] / M["m00"]
        cx_pct = cx / bw * 100
        cy_pct = cy / bh * 100
        if (cx_pct < EDGE_MARGIN_PCT or cx_pct > 100 - EDGE_MARGIN_PCT or
                cy_pct < EDGE_MARGIN_PCT or cy_pct > 100 - EDGE_MARGIN_PCT):
            stats["edge"] += 1
            continue

        # ── 6. Plywood reject ─────────────────────────────────────────────
        if is_plywood_mask(mask_b, lab_board, ply_mean, ply_std):
            stats["plywood"] += 1
            continue

        # ── 7. Bolt-hole grid reject ──────────────────────────────────────
        if (area < BOLT_AREA_MAX_PX and
                max(w, h) < BOLT_MAX_DIM_PX and
                max(w, h) / max(min(w, h), 1) < BOLT_ASPECT_MAX):
            stats["bolt"] += 1
            continue

        kept.append({
            "mask_board": mask_b,
            "contour": cnt,
            "area": area,
            "cx": cx, "cy": cy,
            "x": x, "y": y, "w": w, "h": h,
        })

    print(f"  Rejected — size: {stats['size']}, span: {stats['span']}, "
          f"bbox_fill: {stats['bbox_fill']}, aspect: {stats['aspect']}, "
          f"edge: {stats['edge']}, plywood: {stats['plywood']}, bolt: {stats['bolt']}")
    print(f"  Passed filters: {len(kept)}")
    return kept


def dedup_nested(candidates: list) -> list:
    """Greedy nested-mask dedup: sort by area desc, drop a mask if >60% of it
    sits inside an already-kept mask.

    This handles over-split holds where FastSAM produces a big mask and several
    smaller masks for the same physical object.
    """
    # Sort largest first
    candidates.sort(key=lambda c: -c["area"])
    kept = []

    for c in candidates:
        is_nested = False
        cm = c["mask_board"]
        cm_area = c["area"]
        for k in kept:
            km = k["mask_board"]
            if km.shape != cm.shape:
                continue
            overlap = int(cv2.countNonZero(cv2.bitwise_and(cm, km)))
            if cm_area > 0 and overlap / cm_area > NESTED_OVERLAP_THRESH:
                is_nested = True
                break
        if not is_nested:
            kept.append(c)

    print(f"  After nested dedup: {len(kept)}")
    return kept


# ─── Main Detection ────────────────────────────────────────────────────────────

def detect_holds_v2(image_path: str, board_region: dict) -> dict:
    """Full pipeline. Returns the holds-JSON dict ready for serialisation."""
    bgr_full = cv2.imread(image_path)
    if bgr_full is None:
        print(f"Error: cannot load image {image_path}")
        sys.exit(1)

    img_h, img_w = bgr_full.shape[:2]
    print(f"Image: {img_w}×{img_h}")

    # Board crop in pixels
    bl = int(img_w * board_region["left"] / 100)
    bt = int(img_h * board_region["top"] / 100)
    bw = int(img_w * board_region["width"] / 100)
    bh = int(img_h * board_region["height"] / 100)
    print(f"Board crop: {bw}×{bh} px  (left={bl}, top={bt})")

    bgr_board = bgr_full[bt:bt + bh, bl:bl + bw]

    # Build plywood model on the board crop
    print("\nBuilding plywood Lab model...")
    lab_board = cv2.cvtColor(bgr_board, cv2.COLOR_BGR2LAB)
    ply_mean, ply_std = build_plywood_model(lab_board)
    print(f"  Plywood Lab: L={ply_mean[0]:.0f}±{ply_std[0]:.0f}  "
          f"a={ply_mean[1]:.0f}±{ply_std[1]:.1f}  b={ply_mean[2]:.0f}±{ply_std[2]:.1f}")

    # Run FastSAM
    print("\nRunning FastSAM...")
    model = load_fastsam()
    masks_full = run_fastsam(model, image_path)

    # Filter
    print("\nFiltering masks...")
    candidates = filter_masks(masks_full, bgr_board, bl, bt, bw, bh,
                              img_w, img_h, ply_mean, ply_std)

    # Nested dedup
    print("\nNested-mask deduplication...")
    candidates = dedup_nested(candidates)

    # Sort by position (top-to-bottom, left-to-right) for clean IDs
    candidates.sort(key=lambda c: (c["cy"], c["cx"]))

    # Build output holds
    holds = []
    for i, c in enumerate(candidates):
        cx_pct = round(c["cx"] / bw * 100, 1)
        cy_pct = round(c["cy"] / bh * 100, 1)
        w_pct = round(c["w"] / bw * 100, 1)
        h_pct = round(c["h"] / bh * 100, 1)
        area_px = c["area"]

        if area_px > 5000:
            size = "large"
        elif area_px > 2000:
            size = "medium"
        else:
            size = "small"

        r_pct = round(max(c["w"], c["h"]) / 2 / max(bw, bh) * 100, 1)
        r_pct = max(r_pct, 1.5)

        polygon = contour_to_polygon(c["contour"], bw, bh)
        color = classify_colour(bgr_board, c["mask_board"])
        confidence = "high" if area_px >= 1500 else "medium"

        holds.append({
            "id": f"hold_{i + 1}",
            "color": color,
            "size": size,
            "cx": cx_pct,
            "cy": cy_pct,
            "w_pct": w_pct,
            "h_pct": h_pct,
            "r": r_pct,
            "area": area_px,
            "polygon": polygon,
            "confidence": confidence,
            "verified": confidence == "high",
            "notes": "",
        })

    return {
        "boardRegion": board_region,
        "imageFile": os.path.basename(image_path),
        "detectedAt": date.today().isoformat(),
        "holds": holds,
    }


# ─── Debug Overlay ─────────────────────────────────────────────────────────────

def save_debug_overlay(image_path: str, data: dict, overlay_path: str,
                       board_region: dict) -> None:
    """Draw hold outlines on the photo and save to overlay_path."""
    img = cv2.imread(image_path)
    if img is None:
        print(f"Warning: cannot load {image_path} for overlay.")
        return
    img_h, img_w = img.shape[:2]
    bl = int(img_w * board_region["left"] / 100)
    bt = int(img_h * board_region["top"] / 100)
    bw = int(img_w * board_region["width"] / 100)
    bh = int(img_h * board_region["height"] / 100)

    colour_palette = {
        "red":     (0, 0, 255),
        "orange":  (0, 140, 255),
        "yellow":  (0, 230, 255),
        "green":   (0, 200, 0),
        "cyan":    (255, 220, 0),
        "blue":    (255, 80, 0),
        "purple":  (200, 0, 160),
        "pink":    (180, 0, 255),
        "black":   (80, 80, 80),
        "white":   (255, 255, 255),
        "grey":    (160, 160, 160),
        "unknown": (0, 255, 255),
    }

    for hold in data["holds"]:
        poly = hold["polygon"]
        pts = np.array([[
            int(p[0] / 100 * bw + bl),
            int(p[1] / 100 * bh + bt),
        ] for p in poly], dtype=np.int32)

        col = colour_palette.get(hold["color"], (0, 255, 255))
        cv2.polylines(img, [pts], True, col, 2, cv2.LINE_AA)

        # Label: id + colour initial
        cx_px = int(hold["cx"] / 100 * bw + bl)
        cy_px = int(hold["cy"] / 100 * bh + bt)
        label = f"{hold['id'].replace('hold_', '')}:{hold['color'][0]}"
        cv2.putText(img, label, (cx_px - 12, cy_px + 4),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.3, col, 1, cv2.LINE_AA)

    # Summary text
    n = len(data["holds"])
    cv2.putText(img, f"{n} holds (FastSAM v2)", (20, 40),
                cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 0, 0), 4)
    cv2.putText(img, f"{n} holds (FastSAM v2)", (20, 40),
                cv2.FONT_HERSHEY_SIMPLEX, 1.0, (255, 255, 255), 2)

    os.makedirs(os.path.dirname(os.path.abspath(overlay_path)), exist_ok=True)
    cv2.imwrite(overlay_path, img)
    print(f"\nOverlay saved: {overlay_path}")


# ─── Report ───────────────────────────────────────────────────────────────────

def print_report(data: dict) -> None:
    holds = data["holds"]
    n = len(holds)
    print(f"\n{'='*50}")
    print(f"Total holds detected: {n}")

    from collections import Counter
    colour_counts = Counter(h["color"] for h in holds)
    size_counts = Counter(h["size"] for h in holds)
    conf_counts = Counter(h["confidence"] for h in holds)

    print("\nBy colour:")
    for col, cnt in sorted(colour_counts.items(), key=lambda x: -x[1]):
        print(f"  {col:10s} {cnt:3d}")

    print("\nBy size:")
    for sz in ["large", "medium", "small"]:
        print(f"  {sz:8s} {size_counts.get(sz, 0):3d}")

    print("\nBy confidence:")
    print(f"  high   {conf_counts.get('high', 0):3d}")
    print(f"  medium {conf_counts.get('medium', 0):3d}")
    print(f"{'='*50}\n")


# ─── Entry Point ──────────────────────────────────────────────────────────────

def main():
    global FASTSAM_IMGSZ, FASTSAM_CONF, FASTSAM_MAX_DET, MIN_AREA_FRAC, MAX_AREA_FRAC, NESTED_OVERLAP_THRESH, FASTSAM_MODELS

    script_dir = Path(__file__).parent
    project_root = script_dir.parent

    parser = argparse.ArgumentParser(
        description="Detect climbing holds using FastSAM (colour-agnostic object-first)."
    )
    parser.add_argument(
        "--image", default=DEFAULT_IMAGE,
        help=f"Path to board photo (default: {DEFAULT_IMAGE})"
    )
    parser.add_argument(
        "--output", default=DEFAULT_OUTPUT,
        help=f"Output JSON path (default: {DEFAULT_OUTPUT})"
    )
    parser.add_argument(
        "--board-region", default=DEFAULT_BOARD_REGION, dest="board_region",
        help='Board region as "left,top,width,height" in %% of image (default: 0,0,100,100)'
    )
    parser.add_argument(
        "--overlay", default=DEFAULT_OVERLAY,
        help=f"Debug overlay image path (default: {DEFAULT_OVERLAY})"
    )
    parser.add_argument(
        "--force", action="store_true",
        help="Overwrite src/data/holds.json even if it already has holds (DANGEROUS)"
    )
    # ── Recall / quality knobs (override the module defaults) ──────────────────
    parser.add_argument("--imgsz", type=int, default=FASTSAM_IMGSZ,
                        help=f"FastSAM inference size; raise for small-hold recall (default {FASTSAM_IMGSZ})")
    parser.add_argument("--conf", type=float, default=FASTSAM_CONF,
                        help=f"FastSAM confidence; lower = more proposals (default {FASTSAM_CONF})")
    parser.add_argument("--max-det", type=int, default=FASTSAM_MAX_DET, dest="max_det",
                        help=f"FastSAM max detections (default {FASTSAM_MAX_DET})")
    parser.add_argument("--min-area-frac", type=float, default=MIN_AREA_FRAC, dest="min_area_frac",
                        help=f"Min hold area as fraction of board area; lower keeps small chips (default {MIN_AREA_FRAC})")
    parser.add_argument("--max-area-frac", type=float, default=MAX_AREA_FRAC, dest="max_area_frac",
                        help=f"Max hold area as fraction of board area (default {MAX_AREA_FRAC})")
    parser.add_argument("--nested-overlap", type=float, default=NESTED_OVERLAP_THRESH, dest="nested_overlap",
                        help=f"Drop a mask if this fraction sits inside a larger kept mask; raise to keep small holds overlapping big ones (default {NESTED_OVERLAP_THRESH})")
    parser.add_argument("--model", default=None,
                        help="Force a specific FastSAM weight (e.g. FastSAM-x.pt or FastSAM-s.pt); default tries x then s")
    args = parser.parse_args()

    # Apply knob overrides to the module-level constants the pipeline reads.
    FASTSAM_IMGSZ = args.imgsz
    FASTSAM_CONF = args.conf
    FASTSAM_MAX_DET = args.max_det
    MIN_AREA_FRAC = args.min_area_frac
    MAX_AREA_FRAC = args.max_area_frac
    NESTED_OVERLAP_THRESH = args.nested_overlap
    if args.model:
        FASTSAM_MODELS = [args.model]
    print(f"Knobs: imgsz={FASTSAM_IMGSZ} conf={FASTSAM_CONF} max_det={FASTSAM_MAX_DET} "
          f"min_area_frac={MIN_AREA_FRAC} nested_overlap={NESTED_OVERLAP_THRESH} models={FASTSAM_MODELS}")

    # Resolve image path
    image_path = Path(args.image)
    if not image_path.is_absolute():
        image_path = Path.cwd() / image_path
    if not image_path.exists():
        # Try relative to project root
        image_path = project_root / args.image
    if not image_path.exists():
        print(f"Error: image not found: {args.image}")
        sys.exit(1)

    # Resolve output path
    output_path = Path(args.output)
    if not output_path.is_absolute():
        output_path = Path.cwd() / output_path
    default_holds = (project_root / "src" / "data" / "holds.json").resolve()

    # Safety guard — same as detect_holds.py
    if output_path.resolve() == default_holds and not args.force:
        if default_holds.exists():
            try:
                existing = json.loads(default_holds.read_text())
                existing_count = len(existing.get("holds", []))
                if existing_count > 0:
                    print(f"\n⚠️  WARNING: {default_holds} already has {existing_count} holds.")
                    print("Direct overwrite will scramble hold IDs and break existing routes!\n")
                    print("Safe workflow:")
                    print("  python3 scripts/detect_holds_v2.py --output src/data/holds_new_v2.json")
                    print("  python3 scripts/merge_holds.py src/data/holds.json src/data/holds_new_v2.json --dry-run")
                    print("  python3 scripts/merge_holds.py src/data/holds.json src/data/holds_new_v2.json\n")
                    print("To force overwrite anyway (DANGEROUS): add --force")
                    sys.exit(1)
            except (json.JSONDecodeError, KeyError):
                pass

    # Parse board region
    try:
        parts = [float(x.strip()) for x in args.board_region.split(",")]
        if len(parts) != 4:
            raise ValueError("need exactly 4 values")
        board_region = {"left": parts[0], "top": parts[1],
                        "width": parts[2], "height": parts[3]}
    except Exception as e:
        print(f"Error: --board-region must be 'L,T,W,H' in percent — {e}")
        sys.exit(1)

    # Resolve overlay path
    overlay_path = Path(args.overlay)
    if not overlay_path.is_absolute():
        overlay_path = Path.cwd() / overlay_path

    print(f"Image:        {image_path}")
    print(f"Output:       {output_path}")
    print(f"Overlay:      {overlay_path}")
    print(f"Board region: {board_region}\n")

    # Run detection
    data = detect_holds_v2(str(image_path), board_region)

    # Use full relative path as imageFile (informative)
    try:
        data["imageFile"] = str(image_path.relative_to(project_root))
    except ValueError:
        data["imageFile"] = str(image_path)

    # Write JSON
    os.makedirs(output_path.parent, exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(data, f, indent=2)
    print(f"Wrote {len(data['holds'])} holds to {output_path}")

    # Report
    print_report(data)

    # Debug overlay
    save_debug_overlay(str(image_path), data, str(overlay_path), board_region)


if __name__ == "__main__":
    main()
