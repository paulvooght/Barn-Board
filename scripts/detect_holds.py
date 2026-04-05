#!/usr/bin/env python3
"""
Hold detection script for Barn Board route logger.

Multi-pass approach with confidence scoring:
  Pass 1 — Colour-based detection (high confidence)
    Detects saturated holds (cyan, yellow, purple, black) against plywood
    using HSV colour classification. Strict thresholds to avoid false positives.

  Pass 2 — Edge-based detection (medium confidence)
    Uses Canny edge detection + contour finding for holds that blend with
    the plywood (wood-coloured holds, subtle tones). Only reports contours
    not already covered by Pass 1. Much stricter filtering.

  Confidence scoring:
    HIGH   — Strong colour match, good size, clean shape → green solid outline
    MEDIUM — Edge-detected or borderline colour → red dashed outline
    LOW    — Too small, near edges, plywood noise → discarded

Usage:
    python3 scripts/detect_holds.py

Requirements:
    pip install Pillow numpy opencv-python-headless
"""

import json
import math
import sys
import os
from pathlib import Path

try:
    from PIL import Image
    import numpy as np
    import cv2
except ImportError as e:
    print(f"Error: missing dependency — {e}")
    print("  pip3 install Pillow numpy opencv-python-headless")
    sys.exit(1)

# ─── Configuration ────────────────────────────────────────────────────

DISPLAY_IMAGE = 'Barn_Set_01_V5.jpg'
WHITE_BG_IMAGE = 'Barn_Set_01_V5_holds.jpg'  # white-bg version (optional)

# Board crop region (percentage of image dimensions)
# Updated for cropped image without yellow/white border
BOARD_LEFT_PCT = 1.0
BOARD_TOP_PCT = 0.5
BOARD_RIGHT_PCT = 99.0
BOARD_BOTTOM_PCT = 97.5

# Size filters — raised to reject small plywood artifacts
MIN_HOLD_AREA = 800        # px — minimum area for a valid hold
MAX_HOLD_AREA = 150000     # px — reject huge blobs
MIN_HOLD_DIM = 20          # px — minimum bounding box dimension

# Confidence thresholds
HIGH_CONFIDENCE_MIN_AREA = 1500    # High-confidence needs decent size
MEDIUM_CONFIDENCE_MIN_AREA = 800   # Medium needs to be clearly visible

# Edge margin — holds touching board edge are likely border artifacts
EDGE_MARGIN_PCT = 3.0

# Max board fraction — reject detections spanning too much of the board
MAX_BOARD_FRACTION = 0.18


# ─── Plywood Background Modelling ────────────────────────────────────

def estimate_plywood_color(hsv_board):
    """Estimate the dominant plywood background colour from the board image."""
    rows, cols = hsv_board.shape[:2]
    margin_y = int(rows * 0.08)
    margin_x = int(cols * 0.08)

    # Sample strips along the edges where holds are unlikely
    samples = []
    samples.append(hsv_board[margin_y:margin_y + 40, cols // 4:3 * cols // 4])
    samples.append(hsv_board[rows - margin_y - 40:rows - margin_y, cols // 4:3 * cols // 4])
    samples.append(hsv_board[rows // 4:3 * rows // 4, margin_x:margin_x + 40])
    samples.append(hsv_board[rows // 4:3 * rows // 4, cols - margin_x - 40:cols - margin_x])

    all_samples = np.concatenate([s.reshape(-1, 3) for s in samples])

    # Filter to likely plywood (low saturation, decent value)
    mask = (all_samples[:, 1] < 70) & (all_samples[:, 2] > 110)
    if mask.sum() < 50:
        mask = np.ones(len(all_samples), dtype=bool)

    ply = all_samples[mask]
    med_h = np.median(ply[:, 0])
    med_s = np.median(ply[:, 1])
    med_v = np.median(ply[:, 2])

    # Also compute std dev to understand the plywood colour spread
    std_h = np.std(ply[:, 0])
    std_s = np.std(ply[:, 1])
    std_v = np.std(ply[:, 2])

    print(f"  Plywood HSV: H={med_h:.0f}±{std_h:.0f} S={med_s:.0f}±{std_s:.0f} V={med_v:.0f}±{std_v:.0f}")
    return (med_h, med_s, med_v), (std_h, std_s, std_v)


def is_plywood_coloured(h, s, v, ply_hsv, ply_std):
    """Check if a pixel's HSV values are within plywood colour range."""
    ph, ps, pv = ply_hsv
    sh, ss, sv = ply_std
    # Generous bounds: within ~2.5 std devs of plywood
    h_ok = abs(h - ph) < max(sh * 2.5, 15)
    s_ok = s < ps + max(ss * 2.5, 25)
    v_ok = abs(v - pv) < max(sv * 2.5, 40)
    return h_ok and s_ok and v_ok


# ─── Pass 1: Colour-based Detection ──────────────────────────────────

def detect_by_colour(bgr_board, hsv_board, ply_hsv, ply_std):
    """
    Detect holds that have strong colour contrast against plywood.
    Strict thresholds to minimize false positives.
    """
    h, s, v = hsv_board[:, :, 0], hsv_board[:, :, 1], hsv_board[:, :, 2]
    rows, cols = hsv_board.shape[:2]

    # CYAN/BLUE: hue 85-130, strong saturation
    is_cyan = (h > 85) & (h < 130) & (s > 80) & (v > 100)

    # YELLOW: hue 18-35, strong saturation, bright
    is_yellow = (h > 18) & (h < 35) & (s > 100) & (v > 150)

    # PURPLE: hue 125-165, decent saturation
    is_purple = (h > 125) & (h < 165) & (s > 50) & (v > 60)

    # BLACK: very dark — must be genuinely dark, not just shadow
    is_black = (v < 60) & (s < 80)

    colour_masks = {
        'cyan': is_cyan,
        'yellow': is_yellow,
        'purple': is_purple,
        'black': is_black,
    }

    all_components = []
    for colour_name, mask in colour_masks.items():
        mask_u8 = (mask.astype(np.uint8) * 255)
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        mask_u8 = cv2.morphologyEx(mask_u8, cv2.MORPH_CLOSE, kernel, iterations=2)
        mask_u8 = cv2.morphologyEx(mask_u8, cv2.MORPH_OPEN, kernel, iterations=1)

        contours, _ = cv2.findContours(mask_u8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        for cnt in contours:
            area = cv2.contourArea(cnt)
            if area < MIN_HOLD_AREA or area > MAX_HOLD_AREA:
                continue

            x, y, w, h_bb = cv2.boundingRect(cnt)
            if w < MIN_HOLD_DIM and h_bb < MIN_HOLD_DIM:
                continue
            if w > cols * MAX_BOARD_FRACTION or h_bb > rows * MAX_BOARD_FRACTION:
                continue

            # Reject very elongated shapes (board seams, tape)
            aspect = max(w, h_bb) / max(min(w, h_bb), 1)
            if aspect > 6:
                continue

            M = cv2.moments(cnt)
            if M['m00'] == 0:
                continue
            cx = M['m10'] / M['m00']
            cy = M['m01'] / M['m00']

            # Edge rejection — holds at board edges are border artifacts
            cx_pct = cx / cols * 100
            cy_pct = cy / rows * 100
            if (cx_pct < EDGE_MARGIN_PCT or cx_pct > 100 - EDGE_MARGIN_PCT or
                    cy_pct < EDGE_MARGIN_PCT or cy_pct > 100 - EDGE_MARGIN_PCT):
                continue  # Discard entirely

            # Solidity check
            hull = cv2.convexHull(cnt)
            hull_area = cv2.contourArea(hull)
            solidity = area / hull_area if hull_area > 0 else 0
            if solidity < 0.3:
                continue

            # Confidence: high for good-sized colour matches
            confidence = 'high' if area >= HIGH_CONFIDENCE_MIN_AREA else 'medium'

            all_components.append({
                'contour': cnt,
                'area': area,
                'cx': cx, 'cy': cy,
                'x': x, 'y': y, 'w': w, 'h': h_bb,
                'color': colour_name,
                'confidence': confidence,
                'source': 'colour',
            })

    print(f"  Pass 1 (colour): {len(all_components)} components")
    for colour_name in colour_masks:
        count = sum(1 for c in all_components if c['color'] == colour_name)
        if count > 0:
            hi = sum(1 for c in all_components if c['color'] == colour_name and c['confidence'] == 'high')
            print(f"    {colour_name}: {count} ({hi} high)")

    return all_components


# ─── Pass 2: Edge-based Detection ────────────────────────────────────

def detect_by_edges(bgr_board, hsv_board, existing_mask, ply_hsv, ply_std):
    """
    Use Canny edge detection for holds that blend with plywood.
    Much stricter: only detects clear, well-defined contours.
    """
    rows, cols = bgr_board.shape[:2]

    grey = cv2.cvtColor(bgr_board, cv2.COLOR_BGR2GRAY)

    # CLAHE for contrast
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    grey = clahe.apply(grey)

    blurred = cv2.GaussianBlur(grey, (5, 5), 1.5)

    # Higher Canny thresholds = fewer false edges
    edges = cv2.Canny(blurred, 50, 150)

    # Moderate dilation to close gaps
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    edges = cv2.dilate(edges, kernel, iterations=1)
    edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel, iterations=2)

    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    components = []
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < MEDIUM_CONFIDENCE_MIN_AREA or area > MAX_HOLD_AREA:
            continue

        x, y, w, h_bb = cv2.boundingRect(cnt)
        if w < MIN_HOLD_DIM and h_bb < MIN_HOLD_DIM:
            continue
        if w > cols * MAX_BOARD_FRACTION or h_bb > rows * MAX_BOARD_FRACTION:
            continue

        aspect = max(w, h_bb) / max(min(w, h_bb), 1)
        if aspect > 5:
            continue

        hull = cv2.convexHull(cnt)
        hull_area = cv2.contourArea(hull)
        solidity = area / hull_area if hull_area > 0 else 0
        if solidity < 0.35:
            continue

        M = cv2.moments(cnt)
        if M['m00'] == 0:
            continue
        cx = M['m10'] / M['m00']
        cy = M['m01'] / M['m00']

        # Edge rejection
        cx_pct = cx / cols * 100
        cy_pct = cy / rows * 100
        if (cx_pct < EDGE_MARGIN_PCT or cx_pct > 100 - EDGE_MARGIN_PCT or
                cy_pct < EDGE_MARGIN_PCT or cy_pct > 100 - EDGE_MARGIN_PCT):
            continue

        # Check overlap with Pass 1
        cx_int, cy_int = int(cx), int(cy)
        if 0 <= cy_int < rows and 0 <= cx_int < cols:
            if existing_mask[cy_int, cx_int]:
                continue

        cnt_mask = np.zeros((rows, cols), dtype=np.uint8)
        cv2.drawContours(cnt_mask, [cnt], -1, 255, -1)
        overlap = cv2.bitwise_and(cnt_mask, existing_mask.astype(np.uint8) * 255)
        overlap_ratio = overlap.sum() / max(cnt_mask.sum(), 1)
        if overlap_ratio > 0.3:
            continue

        # Check if this is just plywood — sample pixels inside the contour
        h_vals = hsv_board[:, :, 0][cnt_mask > 0]
        s_vals = hsv_board[:, :, 1][cnt_mask > 0]
        v_vals = hsv_board[:, :, 2][cnt_mask > 0]

        if len(h_vals) > 0:
            med_h = np.median(h_vals)
            med_s = np.median(s_vals)
            med_v = np.median(v_vals)

            # If the contour's colour is within plywood range, skip it
            if is_plywood_coloured(med_h, med_s, med_v, ply_hsv, ply_std):
                # Only keep if it has significantly different texture/value
                v_contrast = abs(med_v - ply_hsv[2])
                s_contrast = abs(med_s - ply_hsv[1])
                if v_contrast < 30 and s_contrast < 20:
                    continue

        color = classify_contour_colour(hsv_board, cnt_mask)

        components.append({
            'contour': cnt,
            'area': area,
            'cx': cx, 'cy': cy,
            'x': x, 'y': y, 'w': w, 'h': h_bb,
            'color': color,
            'confidence': 'medium',
            'source': 'edge',
        })

    print(f"  Pass 2 (edges): {len(components)} components")
    return components


def classify_contour_colour(hsv_board, mask):
    """Classify a contour's colour by sampling pixels inside it."""
    h_vals = hsv_board[:, :, 0][mask > 0]
    s_vals = hsv_board[:, :, 1][mask > 0]
    v_vals = hsv_board[:, :, 2][mask > 0]

    if len(h_vals) == 0:
        return 'unknown'

    med_h = np.median(h_vals)
    med_s = np.median(s_vals)
    med_v = np.median(v_vals)

    if med_v < 60:
        return 'black'
    if med_s > 80 and 85 < med_h < 130:
        return 'cyan'
    if med_s > 80 and 18 < med_h < 35 and med_v > 140:
        return 'yellow'
    if med_s > 50 and 125 < med_h < 165:
        return 'purple'
    if med_s < 30 and med_v > 70:
        return 'grey'
    return 'wood'


# ─── Polygon Generation ───────────────────────────────────────────────

def contour_to_polygon(contour, board_w, board_h, max_points=40):
    """Convert an OpenCV contour to a polygon in board-area percentages."""
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


# ─── Deduplication ────────────────────────────────────────────────────

def deduplicate(components, board_w, board_h):
    """Remove duplicate detections, preferring higher confidence and larger area."""
    conf_order = {'high': 0, 'medium': 1}
    components.sort(key=lambda c: (conf_order.get(c['confidence'], 2), -c['area']))

    deduped = []
    for comp in components:
        cx, cy = comp['cx'], comp['cy']
        is_dupe = False

        for existing in deduped:
            dist = math.hypot(cx - existing['cx'], cy - existing['cy'])
            min_dim = min(comp['w'], comp['h'], existing['w'], existing['h'])
            threshold = max(min_dim * 0.6, board_w * 0.025)

            if dist < threshold:
                is_dupe = True
                break

            # Bounding box overlap check
            x1 = max(comp['x'], existing['x'])
            y1 = max(comp['y'], existing['y'])
            x2 = min(comp['x'] + comp['w'], existing['x'] + existing['w'])
            y2 = min(comp['y'] + comp['h'], existing['y'] + existing['h'])
            if x1 < x2 and y1 < y2:
                overlap_area = (x2 - x1) * (y2 - y1)
                smaller_area = min(comp['area'], existing['area'])
                if overlap_area > smaller_area * 0.35:
                    is_dupe = True
                    break

        if not is_dupe:
            deduped.append(comp)

    return deduped


# ─── Spurious Detection Filter ───────────────────────────────────────

def filter_spurious(components):
    """Remove small black detections inside larger holds (bolt holes etc)."""
    filtered = []
    for comp in components:
        if comp['color'] == 'black' and comp['area'] < 3000:
            inside_larger = False
            for other in components:
                if other is comp or other['area'] < comp['area'] * 2:
                    continue
                margin = 15
                if (other['x'] - margin <= comp['cx'] <= other['x'] + other['w'] + margin and
                        other['y'] - margin <= comp['cy'] <= other['y'] + other['h'] + margin):
                    inside_larger = True
                    break
            if inside_larger:
                continue
        filtered.append(comp)
    return filtered


# ─── Main Detection ───────────────────────────────────────────────────

def detect_holds(image_path):
    """Run multi-pass hold detection on the board image."""
    img_bgr = cv2.imread(str(image_path))
    if img_bgr is None:
        print(f"Error: could not load image {image_path}")
        sys.exit(1)

    img_h, img_w = img_bgr.shape[:2]
    print(f"Image size: {img_w}x{img_h}")

    # Crop to board region
    board_left = int(img_w * BOARD_LEFT_PCT / 100)
    board_top = int(img_h * BOARD_TOP_PCT / 100)
    board_right = int(img_w * BOARD_RIGHT_PCT / 100)
    board_bottom = int(img_h * BOARD_BOTTOM_PCT / 100)
    board_w = board_right - board_left
    board_h = board_bottom - board_top

    print(f"Board region: {board_w}x{board_h} px")

    bgr_board = img_bgr[board_top:board_bottom, board_left:board_right]
    hsv_board = cv2.cvtColor(bgr_board, cv2.COLOR_BGR2HSV)

    # Estimate plywood background
    print("\nEstimating plywood background...")
    ply_hsv, ply_std = estimate_plywood_color(hsv_board)

    # Pass 1: Colour-based detection
    print("\nPass 1: Colour-based detection...")
    colour_components = detect_by_colour(bgr_board, hsv_board, ply_hsv, ply_std)

    # Build mask of Pass 1 detections
    pass1_mask = np.zeros((board_h, board_w), dtype=bool)
    for comp in colour_components:
        cv2.drawContours(pass1_mask.view(np.uint8), [comp['contour']], -1, 1, -1)

    # Pass 2: Edge-based detection
    print("\nPass 2: Edge-based detection...")
    edge_components = detect_by_edges(bgr_board, hsv_board, pass1_mask, ply_hsv, ply_std)

    # Combine and deduplicate
    all_components = colour_components + edge_components
    print(f"\nTotal before dedup: {len(all_components)}")

    all_components = deduplicate(all_components, board_w, board_h)
    print(f"After dedup: {len(all_components)}")

    all_components = filter_spurious(all_components)
    print(f"After spurious filter: {len(all_components)}")

    # Sort by position
    all_components.sort(key=lambda c: (c['cy'], c['cx']))

    # Count by confidence
    high_count = sum(1 for c in all_components if c['confidence'] == 'high')
    med_count = sum(1 for c in all_components if c['confidence'] == 'medium')
    print(f"\nFinal: {len(all_components)} holds ({high_count} high, {med_count} medium confidence)")

    # Build output
    holds = []
    for i, comp in enumerate(all_components):
        cx_pct = round(comp['cx'] / board_w * 100, 1)
        cy_pct = round(comp['cy'] / board_h * 100, 1)
        w_pct = round(comp['w'] / board_w * 100, 1)
        h_pct = round(comp['h'] / board_h * 100, 1)
        area = comp['area']

        if area > 5000:
            size = 'large'
        elif area > 2000:
            size = 'medium'
        else:
            size = 'small'

        r_pct = round(max(comp['w'], comp['h']) / 2 / max(board_w, board_h) * 100, 1)
        r_pct = max(r_pct, 1.5)

        polygon = contour_to_polygon(comp['contour'], board_w, board_h)

        conf_icon = '●' if comp['confidence'] == 'high' else '○'
        print(f"  {conf_icon} hold_{i + 1}: {comp['color']} {size} "
              f"at ({cx_pct}%, {cy_pct}%) {comp['confidence']} [{comp['source']}]")

        holds.append({
            'id': f'hold_{i + 1}',
            'color': comp['color'],
            'size': size,
            'cx': cx_pct,
            'cy': cy_pct,
            'w_pct': w_pct,
            'h_pct': h_pct,
            'r': r_pct,
            'area': area,
            'polygon': polygon,
            'confidence': comp['confidence'],
            'verified': comp['confidence'] == 'high',
            'notes': '',
        })

    return {
        'boardRegion': {
            'left': BOARD_LEFT_PCT,
            'top': BOARD_TOP_PCT,
            'width': round(BOARD_RIGHT_PCT - BOARD_LEFT_PCT, 1),
            'height': round(BOARD_BOTTOM_PCT - BOARD_TOP_PCT, 1),
        },
        'imageFile': DISPLAY_IMAGE,
        'detectedAt': __import__('datetime').date.today().isoformat(),
        'holds': holds,
    }


# ─── Debug Overlay ────────────────────────────────────────────────────

def save_debug_overlay(image_path, data, output_path):
    """Save a debug image with hold outlines drawn on the board."""
    img = cv2.imread(str(image_path))
    img_h, img_w = img.shape[:2]

    board_left = int(img_w * BOARD_LEFT_PCT / 100)
    board_top = int(img_h * BOARD_TOP_PCT / 100)
    board_right = int(img_w * BOARD_RIGHT_PCT / 100)
    board_bottom = int(img_h * BOARD_BOTTOM_PCT / 100)
    board_w = board_right - board_left
    board_h = board_bottom - board_top

    for hold in data['holds']:
        poly = hold['polygon']
        pts = np.array([[
            int(p[0] / 100 * board_w + board_left),
            int(p[1] / 100 * board_h + board_top),
        ] for p in poly], dtype=np.int32)

        # Green for high, red for medium
        if hold['confidence'] == 'high':
            color = (0, 200, 0)
            cv2.polylines(img, [pts], True, color, 3)
        else:
            color = (0, 0, 220)
            for j in range(len(pts)):
                p1 = tuple(pts[j])
                p2 = tuple(pts[(j + 1) % len(pts)])
                dist = math.hypot(p2[0] - p1[0], p2[1] - p1[1])
                n_dashes = max(int(dist / 20), 1)
                for k in range(0, n_dashes, 2):
                    t1 = k / n_dashes
                    t2 = min((k + 1) / n_dashes, 1.0)
                    dp1 = (int(p1[0] + t1 * (p2[0] - p1[0])), int(p1[1] + t1 * (p2[1] - p1[1])))
                    dp2 = (int(p1[0] + t2 * (p2[0] - p1[0])), int(p1[1] + t2 * (p2[1] - p1[1])))
                    cv2.line(img, dp1, dp2, color, 2)

        # Label
        label = f"{hold['id']} ({hold['confidence'][0]})"
        cx_px = int(hold['cx'] / 100 * board_w + board_left)
        cy_px = int(hold['cy'] / 100 * board_h + board_top)
        cv2.putText(img, label, (cx_px - 30, cy_px - 10),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.4, color, 1)

    cv2.imwrite(str(output_path), img)
    print(f"\nDebug overlay saved to: {output_path}")


# ─── Entry Point ──────────────────────────────────────────────────────

def main():
    import argparse
    parser = argparse.ArgumentParser(description='Detect holds on a board image.')
    parser.add_argument('--output', default=None,
                        help='Write detection results to this file instead of src/data/holds.json')
    parser.add_argument('--force', action='store_true',
                        help='Overwrite src/data/holds.json even if it already has holds (DANGEROUS)')
    args = parser.parse_args()

    script_dir = Path(__file__).parent
    project_root = script_dir.parent
    default_output = project_root / 'src' / 'data' / 'holds.json'

    # Resolve output path
    if args.output:
        output_path = Path(args.output)
        if not output_path.is_absolute():
            output_path = Path.cwd() / output_path
    else:
        output_path = default_output

    # Safety check: warn before overwriting holds.json if it already has holds
    if output_path.resolve() == default_output.resolve() and not args.force:
        if default_output.exists():
            try:
                existing = json.loads(default_output.read_text())
                existing_count = len(existing.get('holds', []))
                if existing_count > 0:
                    print(f"\n⚠️  WARNING: {default_output} already has {existing_count} holds.")
                    print("Direct overwrite will scramble hold IDs and break existing routes!\n")
                    print("Safe workflow:")
                    print("  python3 scripts/detect_holds.py --output src/data/holds_new.json")
                    print("  python3 scripts/merge_holds.py src/data/holds.json src/data/holds_new.json --dry-run")
                    print("  python3 scripts/merge_holds.py src/data/holds.json src/data/holds_new.json\n")
                    print("To force overwrite anyway (DANGEROUS): add --force")
                    sys.exit(1)
            except (json.JSONDecodeError, KeyError):
                pass  # Corrupted file — allow overwrite

    white_bg_path = project_root / 'public' / WHITE_BG_IMAGE
    display_path = project_root / 'public' / DISPLAY_IMAGE

    if white_bg_path.exists():
        detect_path = white_bg_path
        print(f"Using white-background image: {detect_path}")
    elif display_path.exists():
        detect_path = display_path
        print(f"Using display image (plywood): {detect_path}")
    else:
        print(f"Error: No image found at {display_path} or {white_bg_path}")
        sys.exit(1)

    print(f"Output: {output_path}\n")

    data = detect_holds(str(detect_path))

    os.makedirs(output_path.parent, exist_ok=True)
    with open(output_path, 'w') as f:
        json.dump(data, f, indent=2)

    print(f"\nWrote {len(data['holds'])} holds to {output_path}")

    high = sum(1 for h in data['holds'] if h['confidence'] == 'high')
    medium = sum(1 for h in data['holds'] if h['confidence'] == 'medium')
    print(f"  {high} high confidence (green solid)")
    print(f"  {medium} medium confidence (red dashed)")

    debug_path = project_root / 'public' / 'debug_detection.jpg'
    save_debug_overlay(str(detect_path), data, str(debug_path))


if __name__ == '__main__':
    main()
