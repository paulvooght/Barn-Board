#!/usr/bin/env python3
"""
Hold detection script for Barn Board route logger.

Detects climbing holds from a straight-on board photo using colour thresholding.
Outputs hold positions as JSON to src/data/holds.json.

Usage:
    1. Take a straight-on photo of the board (good lighting, minimal shadows)
    2. Save as public/barn_board_02.png (or update IMAGE_FILE below)
    3. Run: python3 scripts/detect_holds.py
    4. Review output — check for false positives (shadows, edge artifacts)
    5. Holds marked verified:false should be checked manually

Requirements:
    pip install Pillow numpy
"""

import json
import math
import sys
import os
from pathlib import Path
from collections import deque

try:
    from PIL import Image
    import numpy as np
except ImportError:
    print("Error: requires Pillow and numpy")
    print("  pip install Pillow numpy")
    sys.exit(1)

# ─── Configuration ────────────────────────────────────────────────────
IMAGE_FILE = 'Board background.jpg'   # filename inside public/

# Board crop region within the photo (percentage of image dimensions).
# Calibrated for 'Board background.jpg' (1246x892, peach border surrounds board).
BOARD_LEFT_PCT = 10.5
BOARD_TOP_PCT = 4.0
BOARD_RIGHT_PCT = 90.0
BOARD_BOTTOM_PCT = 96.5

# Detection thresholds
DARK_BRIGHTNESS_THRESHOLD = 80    # Below this = dark hold candidate
CYAN_MIN_BLUE = 130
CYAN_MIN_GREEN = 130
CYAN_MAX_RED = 120
PURPLE_MIN_BLUE = 100
PURPLE_MIN_RED = 80
PURPLE_MAX_GREEN = 110

# Size filters
MIN_HOLD_AREA = 20        # Minimum pixels to count as a hold
MAX_HOLD_AREA = 200000    # Maximum pixels — large volumes included
EDGE_MARGIN_PCT = 1.5     # Ignore detections within this % of board edge

# Polygon sampling
POLYGON_ANGLES = 24      # Number of boundary points to sample per hold


def find_components(mask, min_area=25):
    """Find connected components in a binary mask using flood fill.
    Returns component dicts including pixel coordinate arrays for polygon extraction."""
    h, w = mask.shape
    visited = np.zeros_like(mask, dtype=bool)
    components = []

    for y in range(h):
        for x in range(w):
            if mask[y, x] and not visited[y, x]:
                queue = deque([(y, x)])
                visited[y, x] = True
                pixels = []

                while queue:
                    cy, cx = queue.popleft()
                    pixels.append((cx, cy))

                    for dy, dx in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
                        ny, nx = cy + dy, cx + dx
                        if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not visited[ny, nx]:
                            visited[ny, nx] = True
                            queue.append((ny, nx))

                if len(pixels) >= min_area:
                    xs = [p[0] for p in pixels]
                    ys = [p[1] for p in pixels]
                    components.append({
                        'area': len(pixels),
                        'cx': sum(xs) / len(xs),
                        'cy': sum(ys) / len(ys),
                        'min_x': min(xs), 'max_x': max(xs),
                        'min_y': min(ys), 'max_y': max(ys),
                        'w': max(xs) - min(xs),
                        'h': max(ys) - min(ys),
                        'xs': xs,
                        'ys': ys,
                    })

    return components


def compute_polygon(xs_list, ys_list, cx, cy, board_w, board_h, n_angles=POLYGON_ANGLES):
    """Polar-sample the hold boundary to produce a polygon outline.

    For each of n_angles evenly-spaced directions around the centroid, finds the
    furthest pixel that lies within that angular sector and records its board-area
    percentage coordinate.  Returns a list of [x_pct, y_pct] pairs.
    """
    if not xs_list:
        return []

    xs = np.array(xs_list, dtype=float)
    ys = np.array(ys_list, dtype=float)
    step = 2.0 * math.pi / n_angles
    # Sector half-width with a small overlap so no gaps appear
    tol_sin = math.sin(step * 0.75)

    result = []
    for i in range(n_angles):
        angle = i * step
        cos_a = math.cos(angle)
        sin_a = math.sin(angle)

        dx = xs - cx
        dy = ys - cy
        dist = np.sqrt(dx ** 2 + dy ** 2)

        # Forward projection and perpendicular distance from the ray
        fwd = dx * cos_a + dy * sin_a
        cross = np.abs(dx * sin_a - dy * cos_a)

        # Pixels whose direction is within the angular tolerance
        in_sector = (fwd > 0) & (cross < dist * tol_sin + 0.5)

        if in_sector.any():
            best_idx = int(np.argmax(np.where(in_sector, dist, -1)))
            result.append([
                round(float(xs[best_idx]) / board_w * 100, 2),
                round(float(ys[best_idx]) / board_h * 100, 2),
            ])
        else:
            # No pixel in this direction — project one step from centroid
            result.append([
                round(float(cx + cos_a) / board_w * 100, 2),
                round(float(cy + sin_a) / board_h * 100, 2),
            ])

    return result


def is_valid_hold(comp, board_w, board_h):
    """Filter out false positives: edge shadows, huge areas, extreme aspect ratios."""
    cx_pct = comp['cx'] / board_w * 100
    cy_pct = comp['cy'] / board_h * 100

    if (cx_pct < EDGE_MARGIN_PCT or cx_pct > (100 - EDGE_MARGIN_PCT) or
            cy_pct < EDGE_MARGIN_PCT or cy_pct > (100 - EDGE_MARGIN_PCT)):
        return False

    if comp['area'] > MAX_HOLD_AREA:
        return False

    return True


def detect_holds(image_path):
    """Detect holds from a board photo."""
    img = Image.open(image_path).convert('RGB')
    img_w, img_h = img.size
    print(f"Image size: {img_w}x{img_h}")

    # Crop to board region
    board_left = int(img_w * BOARD_LEFT_PCT / 100)
    board_top = int(img_h * BOARD_TOP_PCT / 100)
    board_right = int(img_w * BOARD_RIGHT_PCT / 100)
    board_bottom = int(img_h * BOARD_BOTTOM_PCT / 100)
    board_w = board_right - board_left
    board_h = board_bottom - board_top

    print(f"Board region: {board_w}x{board_h} px")

    board = img.crop((board_left, board_top, board_right, board_bottom))
    arr = np.array(board)
    r, g, b = arr[:, :, 0].astype(float), arr[:, :, 1].astype(float), arr[:, :, 2].astype(float)
    brightness = (r + g + b) / 3.0

    # Colour masks
    dark_mask   = brightness < DARK_BRIGHTNESS_THRESHOLD
    cyan_mask   = (b > CYAN_MIN_BLUE) & (g > CYAN_MIN_GREEN) & (r < CYAN_MAX_RED) & (brightness > 80)
    purple_mask = (b > PURPLE_MIN_BLUE) & (r > PURPLE_MIN_RED) & (g < PURPLE_MAX_GREEN) & (brightness > 60) & (brightness < 160)

    print("\nDetecting holds...")
    dark_components   = find_components(dark_mask,   MIN_HOLD_AREA)
    cyan_components   = find_components(cyan_mask,   MIN_HOLD_AREA)
    purple_components = find_components(purple_mask, MIN_HOLD_AREA)

    print(f"  Dark regions:   {len(dark_components)}")
    print(f"  Cyan regions:   {len(cyan_components)}")
    print(f"  Purple regions: {len(purple_components)}")

    all_components = []
    for comp in dark_components:
        if is_valid_hold(comp, board_w, board_h):
            all_components.append({**comp, 'color': 'black'})
    for comp in cyan_components:
        if is_valid_hold(comp, board_w, board_h):
            all_components.append({**comp, 'color': 'cyan'})
    for comp in purple_components:
        if is_valid_hold(comp, board_w, board_h):
            all_components.append({**comp, 'color': 'purple'})

    all_components.sort(key=lambda h: (h['cy'], h['cx']))

    holds = []
    for i, comp in enumerate(all_components):
        cx_pct = round(comp['cx'] / board_w * 100, 1)
        cy_pct = round(comp['cy'] / board_h * 100, 1)
        w_pct  = round(comp['w']  / board_w * 100, 1)
        h_pct  = round(comp['h']  / board_h * 100, 1)
        area   = comp['area']

        if area > 5000:
            size = 'large'
        elif area > 1500:
            size = 'medium'
        else:
            size = 'small'

        # r kept for backward compat — half of max dimension relative to board max
        r_pct = round(max(comp['w'], comp['h']) / 2 / max(board_w, board_h) * 100, 1)
        r_pct = max(r_pct, 1.5)

        verified = not (cx_pct < 8 or cx_pct > 92 or cy_pct < 5 or cy_pct > 92)

        polygon = compute_polygon(
            comp.get('xs', []), comp.get('ys', []),
            comp['cx'], comp['cy'],
            board_w, board_h,
        )

        holds.append({
            'id':       f'hold_{i + 1}',
            'color':    comp['color'],
            'size':     size,
            'cx':       cx_pct,
            'cy':       cy_pct,
            'w_pct':    w_pct,
            'h_pct':    h_pct,
            'r':        r_pct,
            'area':     area,
            'polygon':  polygon,
            'verified': verified,
            'notes':    '',
        })

    print(f"\nValid holds detected: {len(holds)}")
    for h in holds:
        status = '✓' if h['verified'] else '?'
        print(f"  {status} {h['id']}: {h['color']} {h['size']} at ({h['cx']}%, {h['cy']}%) "
              f"w={h['w_pct']}% h={h['h_pct']}% area={h['area']}")

    return {
        'boardRegion': {
            'left':   BOARD_LEFT_PCT,
            'top':    BOARD_TOP_PCT,
            'width':  round(BOARD_RIGHT_PCT - BOARD_LEFT_PCT, 1),
            'height': round(BOARD_BOTTOM_PCT - BOARD_TOP_PCT, 1),
        },
        'imageFile':  IMAGE_FILE,
        'detectedAt': __import__('datetime').date.today().isoformat(),
        'holds':      holds,
    }


def main():
    script_dir   = Path(__file__).parent
    project_root = script_dir.parent
    image_path   = project_root / 'public' / IMAGE_FILE
    output_path  = project_root / 'src' / 'data' / 'holds.json'

    if not image_path.exists():
        print(f"Error: Board photo not found at {image_path}")
        print(f"Save your board photo as public/{IMAGE_FILE}")
        sys.exit(1)

    print(f"Detecting holds from: {image_path}")
    print(f"Output: {output_path}\n")

    data = detect_holds(str(image_path))

    os.makedirs(output_path.parent, exist_ok=True)
    with open(output_path, 'w') as f:
        json.dump(data, f, indent=2)

    print(f"\nWrote {len(data['holds'])} holds to {output_path}")
    unverified = sum(1 for h in data['holds'] if not h['verified'])
    if unverified:
        print(f"⚠  {unverified} holds are unverified — check these are real holds, not shadows")


if __name__ == '__main__':
    main()
