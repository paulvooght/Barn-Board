#!/usr/bin/env python3
"""
Process a raw board photo: detect the rectangular plywood board, replace
everything outside it with a solid colour, and save as the app's background.

Usage:
    python3 scripts/process_board_image.py

Input:  public/Barn_Board_reset_01.JPG
Output: public/Board background.jpg
"""

import sys
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
INPUT_FILE = 'Barn_Board_reset_01.JPG'
OUTPUT_FILE = 'Board background.jpg'
BG_COLOR = (255, 171, 148)  # #FFAB94 — app peach background
BORDER_PX = 30
OUTPUT_MAX_WIDTH = 1400


def detect_board_rectangle(img):
    """
    Detect the plywood board using a grid-based flood fill from the center.

    1. Divide image into a grid of blocks
    2. For each block, compute plywood pixel density
    3. Flood fill from the center (definitely board) to adjacent blocks
       that have SOME plywood — even blocks with big holds have SOME plywood
       around the hold edges and bolt holes
    4. The flood won't cross to barn structure because there's a clear
       gap of zero-plywood blocks (wooden beam, metal roof, etc.)
    """
    scale = 4
    small = img.resize((img.width // scale, img.height // scale), Image.LANCZOS)
    arr = np.array(small, dtype=float)
    h, w = arr.shape[:2]
    r, g, b = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]
    brightness = (r + g + b) / 3.0
    saturation = np.max(arr, axis=2) - np.min(arr, axis=2)

    # Plywood detection: light, warm, low saturation
    plywood = (
        (brightness > 130) & (brightness < 230) &
        (saturation < 60) &
        (r > 125) & (g > 110) & (b > 80) &
        (r > b + 10)
    )

    # Divide into grid blocks
    block_size = 20  # pixels at 1/4 scale = 80px at full res
    grid_h = h // block_size
    grid_w = w // block_size

    # Compute plywood density per block
    grid = np.zeros((grid_h, grid_w))
    for gy in range(grid_h):
        for gx in range(grid_w):
            y0 = gy * block_size
            x0 = gx * block_size
            block = plywood[y0:y0 + block_size, x0:x0 + block_size]
            grid[gy, gx] = block.sum() / block.size

    # Flood fill from center — any block with >5% plywood is reachable
    # (even blocks dominated by a hold still have some plywood at edges)
    density_threshold = 0.05
    center_y, center_x = grid_h // 2, grid_w // 2
    visited = np.zeros((grid_h, grid_w), dtype=bool)
    board_blocks = []

    queue = deque([(center_y, center_x)])
    visited[center_y, center_x] = True

    while queue:
        gy, gx = queue.popleft()
        board_blocks.append((gy, gx))
        for dy, dx in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
            ny, nx = gy + dy, gx + dx
            if 0 <= ny < grid_h and 0 <= nx < grid_w and not visited[ny, nx]:
                if grid[ny, nx] > density_threshold:
                    visited[ny, nx] = True
                    queue.append((ny, nx))

    if not board_blocks:
        print("Warning: board detection failed")
        return 0, 0, img.width, img.height

    # Get bounding box of board blocks
    bys = [b[0] for b in board_blocks]
    bxs = [b[1] for b in board_blocks]
    top_block = min(bys)
    bottom_block = max(bys)
    left_block = min(bxs)
    right_block = max(bxs)

    # Convert back to pixel coordinates (original scale)
    left = int(left_block * block_size * scale)
    right = int((right_block + 1) * block_size * scale)
    top = int(top_block * block_size * scale)
    bottom = int((bottom_block + 1) * block_size * scale)

    # Clamp to image bounds
    left = max(0, left)
    right = min(img.width, right)
    top = max(0, top)
    bottom = min(img.height, bottom)

    # Small inset to clip edge artifacts
    inset = 20
    left += inset
    right -= inset
    top += inset
    bottom -= inset

    print(f"  Grid: {grid_w}x{grid_h} blocks, {len(board_blocks)} are board")
    print(f"  Board rectangle: ({left}, {top}) to ({right}, {bottom})")
    print(f"  Board size: {right - left}x{bottom - top} px")

    return left, top, right, bottom


def process_image(input_path, output_path):
    """Detect board rectangle, replace background, crop, add border."""
    print(f"Loading {input_path}...")
    img = Image.open(input_path).convert('RGB')
    print(f"  Image size: {img.width}x{img.height}")

    print("Detecting board edges...")
    left, top, right, bottom = detect_board_rectangle(img)

    # Replace everything outside the rectangle with peach
    print("Replacing background...")
    arr = np.array(img)
    mask = np.ones(arr.shape[:2], dtype=bool)
    mask[top:bottom, left:right] = False
    arr[mask] = BG_COLOR
    img = Image.fromarray(arr)

    # Crop to board + tiny margin
    margin = 5
    crop_left = max(0, left - margin)
    crop_top = max(0, top - margin)
    crop_right = min(img.width, right + margin)
    crop_bottom = min(img.height, bottom + margin)
    board = img.crop((crop_left, crop_top, crop_right, crop_bottom))
    bw, bh = board.size
    print(f"  Cropped: {bw}x{bh}")

    # Scale down
    if bw > OUTPUT_MAX_WIDTH:
        ratio = OUTPUT_MAX_WIDTH / bw
        new_w = OUTPUT_MAX_WIDTH
        new_h = int(bh * ratio)
        board = board.resize((new_w, new_h), Image.LANCZOS)
        bw, bh = board.size
        print(f"  Scaled to: {bw}x{bh}")

    # Final image with peach border
    out_w = bw + 2 * BORDER_PX
    out_h = bh + 2 * BORDER_PX
    output = Image.new('RGB', (out_w, out_h), BG_COLOR)
    output.paste(board, (BORDER_PX, BORDER_PX))

    output.save(output_path, 'JPEG', quality=92)
    print(f"\nSaved: {output_path}")
    print(f"  Final size: {out_w}x{out_h}")
    return out_w, out_h, bw, bh


def main():
    script_dir = Path(__file__).parent
    project_root = script_dir.parent
    input_path = project_root / 'public' / INPUT_FILE
    output_path = project_root / 'public' / OUTPUT_FILE

    if not input_path.exists():
        print(f"Error: Input not found at {input_path}")
        sys.exit(1)

    out_w, out_h, bw, bh = process_image(str(input_path), str(output_path))

    left_pct = round(BORDER_PX / out_w * 100, 1)
    top_pct = round(BORDER_PX / out_h * 100, 1)
    width_pct = round(bw / out_w * 100, 1)
    height_pct = round(bh / out_h * 100, 1)
    print(f"\n  Board region for detect_holds.py:")
    print(f"    BOARD_LEFT_PCT   = {left_pct}")
    print(f"    BOARD_TOP_PCT    = {top_pct}")
    print(f"    BOARD_RIGHT_PCT  = {round(left_pct + width_pct, 1)}")
    print(f"    BOARD_BOTTOM_PCT = {round(top_pct + height_pct, 1)}")


if __name__ == '__main__':
    main()
