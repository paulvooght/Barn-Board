#!/usr/bin/env python3
"""
reproject_holds.py — move a wall's hold outlines onto a NEW board photo.

THE RULE (CLAUDE.md): routes reference holds by ID. This script NEVER invents,
renames or drops an ID. It only moves geometry: every hold keeps its id, name,
holdTypes, colour, positivity, material — everything except where it sits.

Why a homography instead of re-detecting and matching:
  Re-detection guesses at hold outlines from pixels and then has to pair them up
  with the old ones by proximity — two chances to be wrong, and it throws away
  hand-tuned outlines. The camera moved as a rigid change of viewpoint, so the
  SAME transform maps every hold from the old photo to the new one, exactly.
  We already measure that transform for alignment; here we apply its inverse to
  the polygons instead of to the pixels. The photo is never touched.

Usage:
  python3 scripts/reproject_holds.py \
      --holds board-assets/the-barn/_holds_snapshot_2026-09-09.json \
      --align board-assets/the-barn/Barn_Set_01_V8.jpg.align.json \
      --new-image board-assets/the-barn/Barn_Set_01_V8_raw.jpg \
      --output board-assets/the-barn/_holds_reprojected_v8.json \
      --overlay board-assets/the-barn/_v8_raw_holds_overlay.jpg

Output is an `--update` file for scripts/merge_board_holds.mjs, which enforces
the ID-preservation invariants before anything reaches Supabase.
"""
import argparse, json, sys
from pathlib import Path
import cv2, numpy as np


def load_holds(p):
    d = json.loads(Path(p).read_text())
    return d['holds'] if isinstance(d, dict) and 'holds' in d else d


def pct_to_px(cx, cy, br, w, h):
    return ((br['left'] + cx / 100.0 * br['width']) / 100.0 * w,
            (br['top'] + cy / 100.0 * br['height']) / 100.0 * h)


def px_to_pct(x, y, br, w, h):
    return ((x / w * 100.0 - br['left']) / br['width'] * 100.0,
            (y / h * 100.0 - br['top']) / br['height'] * 100.0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--holds', required=True)
    ap.add_argument('--align', required=True, help='.align.json holding homography_new_to_reference')
    ap.add_argument('--new-image', required=True)
    ap.add_argument('--output', required=True)
    ap.add_argument('--overlay')
    ap.add_argument('--board-region', default='1.0,0.5,98.0,97.0')
    ap.add_argument('--max-shift', type=float, default=6.0,
                    help='abort if any hold moves more than this many board %% (sanity gate)')
    a = ap.parse_args()

    L, T, W, H = [float(v) for v in a.board_region.split(',')]
    br = {'left': L, 'top': T, 'width': W, 'height': H}

    holds = load_holds(a.holds)
    align = json.loads(Path(a.align).read_text())
    # H maps NEW photo -> REFERENCE photo. Holds live in the REFERENCE frame,
    # so we need the inverse to carry them into the NEW photo's frame.
    H_new_to_ref = np.array(align['homography_new_to_reference'], dtype=np.float64)
    H_ref_to_new = np.linalg.inv(H_new_to_ref)

    img = cv2.imread(a.new_image)
    if img is None:
        sys.exit(f'cannot read {a.new_image}')
    ih, iw = img.shape[:2]
    rw, rh = align['reference_size']['width'], align['reference_size']['height']
    if (rw, rh) != (iw, ih):
        sys.exit(f'frame size mismatch: reference {rw}x{rh} vs new image {iw}x{ih}')

    def carry(pts_pct):
        px = np.array([pct_to_px(x, y, br, iw, ih) for x, y in pts_pct], dtype=np.float64)
        out = cv2.perspectiveTransform(px.reshape(-1, 1, 2), H_ref_to_new).reshape(-1, 2)
        return [px_to_pct(x, y, br, iw, ih) for x, y in out]

    updates, shifts, skipped = [], [], []
    for hold in holds:
        poly = hold.get('polygon')
        if not poly or len(poly) < 3:
            skipped.append(hold['id'])
            continue
        new_poly = carry(poly)
        (ncx, ncy), = carry([(hold['cx'], hold['cy'])])
        xs = [p[0] for p in new_poly]; ys = [p[1] for p in new_poly]
        w_pct = max(xs) - min(xs); h_pct = max(ys) - min(ys)
        shift = float(np.hypot(ncx - hold['cx'], ncy - hold['cy']))
        shifts.append(shift)
        u = {'id': hold['id'],
             'cx': round(ncx, 2), 'cy': round(ncy, 2),
             'polygon': [[round(x, 2), round(y, 2)] for x, y in new_poly],
             'w_pct': round(w_pct, 2), 'h_pct': round(h_pct, 2)}
        # r is a radius in board %; scale it by the local linear scale change.
        if isinstance(hold.get('r'), (int, float)) and hold.get('w_pct'):
            ow = hold.get('w_pct') or 1; oh = hold.get('h_pct') or 1
            s = 0.5 * (w_pct / ow + h_pct / oh)
            u['r'] = round(hold['r'] * s, 2)
        updates.append(u)

    shifts = np.array(shifts)
    print(f'holds reprojected : {len(updates)}   (no polygon, skipped: {len(skipped)})')
    print(f'shift in board %  : min {shifts.min():.2f}  mean {shifts.mean():.2f}  max {shifts.max():.2f}')
    print(f'shift in pixels   : mean {shifts.mean()/100*br["width"]/100*iw:.1f}  '
          f'max {shifts.max()/100*br["width"]/100*iw:.1f}')
    if shifts.max() > a.max_shift:
        sys.exit(f'ABORT: a hold moved {shifts.max():.2f} board %% (> --max-shift {a.max_shift}). '
                 'That is too far for a camera nudge — check the homography.')

    ids_in = [h['id'] for h in holds]
    ids_out = [u['id'] for u in updates] + skipped
    assert sorted(ids_in) == sorted(ids_out), 'ID SET CHANGED — refusing to write'
    print(f'ID set preserved  : {len(ids_in)} in, {len(ids_out)} out, identical')

    Path(a.output).write_text(json.dumps({
        'generatedAt': __import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(),
        'source_holds': a.holds, 'align_report': a.align, 'new_image': a.new_image,
        'boardRegion': br, 'skipped_no_polygon': skipped, 'updates': updates,
    }, indent=2))
    print(f'wrote {a.output}')

    if a.overlay:
        ov = img.copy()
        for u in updates:
            pts = np.array([pct_to_px(x, y, br, iw, ih) for x, y in u['polygon']], np.int32)
            cv2.polylines(ov, [pts], True, (0, 255, 0), 2)
            x, y = pct_to_px(u['cx'], u['cy'], br, iw, ih)
            cv2.circle(ov, (int(x), int(y)), 2, (0, 0, 255), -1)
        cv2.putText(ov, 'holds reprojected onto UNDISTORTED V8', (20, 40),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.1, (255, 0, 255), 3)
        cv2.imwrite(a.overlay, ov, [cv2.IMWRITE_JPEG_QUALITY, 92])
        print(f'wrote {a.overlay}')


if __name__ == '__main__':
    main()
