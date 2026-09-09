#!/usr/bin/env python3
"""
diff_new_holds.py — compare an old published board photo against a new,
already-aligned photo of the same wall and report what physically changed
on the board (new holds appeared, existing holds moved, existing holds
vanished).

This is a READ-ONLY reporting tool:
  - It never writes to Supabase (only GETs the wall's live hold array).
  - It never touches src/data/holds.json or anything under src/.
  - IDs are never assigned here — new candidates get "id": null; a human
    reviews the overlay + JSON, then a separate merge step assigns IDs.

Why illumination-invariant comparison matters
-----------------------------------------------
A plain cv2.absdiff between two board photos shot under different exposure/
white-balance is dominated by huge, low-frequency lighting-difference blobs
that bury the real (small, local) changes. This script instead:

  1. Grayscales both images.
  2. Local z-score normalises each pixel against a large-radius local
     mean/std (Gaussian sigma, default 100 — see local_zscore()'s docstring
     for why this is bigger than the spec's illustrative "~25": at 25, a
     large new hold's own pixels dominated its local baseline and
     self-cancelled almost entirely), which cancels slowly-varying
     illumination while keeping local structure (edges, texture, holds).
  3. Diffs the two z-score fields ("struct_diff") — illumination-invariant.
  4. Adds a chroma cue: LAB a/b channels, each re-centred on a LOCAL mean
     (same sigma) rather than a single global median — see chroma_field()'s
     docstring for why: this board's V7->V8 exposure/white-balance shift is
     regional (the lower panel reads noticeably greyer in V8), not uniform,
     so a single global median left the whole lower panel flagged as
     "changed" (a ~300k px blob) until this was made local.
  5. A pixel is "changed" if struct_diff OR chroma_diff crosses its
     threshold. Morphological open+close cleans up speckle, then connected
     components become "blobs". Blobs centred within ~2% of the board-crop
     edge are dropped as alignment/blur boundary artifacts (mirroring
     detect_holds.py's own EDGE_MARGIN_PCT rejection).

Each surviving blob is classified against the wall's existing hold polygons
(dilated ~6px) by coverage fraction into NEW / CHANGED / INTERIOR, exactly
per spec (coverage against ALL live holds, no exceptions — see the long
comment above the existing-hold-mask code for a known limitation this
implies: a couple of hold RECORDS on this board already read as bare
plywood in the reference photo, so a genuinely new hold landing on that
stale footprint can score high coverage and land in CHANGED/INTERIOR rather
than NEW. meanStructDiff/meanChromaDiff are attached to every CHANGED/
INTERIOR entry, and INTERIOR blobs are also drawn on the overlay (thin
orange, distinct from the four spec'd categories) so a human reviewer can
still catch one of these by eye instead of it being silently invisible).
Existing holds are separately checked for VANISHED (high structural diff +
the aligned image reading plywood-like in that hold's footprint).

For each NEW blob, GrabCut carves a real polygon (falling back to the blob's
own contour if GrabCut degenerates), emitted in exactly the shape the app's
hold records use — ready to hand to a later ID-assigning merge step.

Usage
-----
    python3 scripts/diff_new_holds.py \\
        --reference public/Barn_Set_01_V7.jpg \\
        --aligned path/to/v8_warped_to_v7.jpg \\
        --board the-barn \\
        --overlay board-assets/_diff/the-barn_v7_v8_review.jpg

Requirements: cv2, numpy, Pillow, requests (all already used elsewhere in
this repo). No new dependencies.
"""

import argparse
import importlib.util
import json
import math
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

try:
    import numpy as np
    import cv2
except ImportError as e:
    print(f"Error: missing dependency — {e}")
    print("  pip3 install numpy opencv-python-headless")
    sys.exit(1)

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT = REPO_ROOT / "board-assets" / "_diff" / "holds_new_candidates.json"
DEFAULT_OVERLAY = REPO_ROOT / "board-assets" / "_diff" / "overlay_review.jpg"

# ─── Reuse detect_holds.py's colour palette + plywood helpers verbatim ───────
# ("import or mirror its palette — do not invent a new one")
_dh_spec = importlib.util.spec_from_file_location(
    "detect_holds", REPO_ROOT / "scripts" / "detect_holds.py"
)
detect_holds_mod = importlib.util.module_from_spec(_dh_spec)
_dh_spec.loader.exec_module(detect_holds_mod)
classify_contour_colour = detect_holds_mod.classify_contour_colour
estimate_plywood_color = detect_holds_mod.estimate_plywood_color
is_plywood_coloured = detect_holds_mod.is_plywood_coloured


# ─── Env / Supabase (read-only) ───────────────────────────────────────────────

def load_env():
    """Load .env.local from repo root; same pattern as publish_board_image.py."""
    env_path = REPO_ROOT / ".env.local"
    env = {}
    if not env_path.exists():
        return env
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            k, _, v = line.partition("=")
            env[k.strip()] = v.strip()
    return env


def resolve_board(base_url, headers, board_arg):
    """Resolve a slug or uuid to (id, slug, name) via a read-only GET."""
    import re
    import requests

    is_uuid = bool(re.match(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-", board_arg, re.I))
    field = "id" if is_uuid else "slug"
    url = f"{base_url}/rest/v1/boards?{field}=eq.{board_arg}&select=id,slug,name"
    r = requests.get(url, headers={**headers, "Accept": "application/json"}, timeout=15)
    if r.status_code != 200:
        print(f"Error resolving board '{board_arg}': {r.status_code} {r.text}")
        sys.exit(1)
    rows = r.json()
    if not rows:
        print(f"Error: no board with {field}='{board_arg}'.")
        sys.exit(1)
    row = rows[0]
    return row["id"], row["slug"], row.get("name")


def fetch_live_holds(base_url, headers, board_id):
    """Read-only GET of the wall's full hold array from board_settings."""
    import requests

    key = f"holds_{board_id}"
    url = f"{base_url}/rest/v1/board_settings?key=eq.{key}&select=data"
    r = requests.get(url, headers={**headers, "Accept": "application/json"}, timeout=15)
    if r.status_code != 200:
        print(f"Error fetching {key}: {r.status_code} {r.text}")
        sys.exit(1)
    rows = r.json()
    if not rows:
        print(f"Error: no board_settings row for key='{key}'.")
        sys.exit(1)
    data = rows[0]["data"]
    holds = data if isinstance(data, list) else data.get("holds", [])
    return holds


def load_holds_file(path):
    data = json.loads(Path(path).read_text())
    holds = data if isinstance(data, list) else data.get("holds", [])
    return holds


# ─── Geometry helpers ─────────────────────────────────────────────────────────

def parse_board_region(s):
    parts = [float(x.strip()) for x in s.split(",")]
    if len(parts) != 4:
        print(f"Error: --board-region must be 'L,T,W,H' (got '{s}')")
        sys.exit(1)
    left, top, width, height = parts
    return {"left": left, "top": top, "width": width, "height": height}


def board_rect_px(region, img_w, img_h):
    """Board rectangle in FULL-IMAGE pixel space, per CLAUDE.md's convention."""
    left = region["left"] / 100 * img_w
    top = region["top"] / 100 * img_h
    w = region["width"] / 100 * img_w
    h = region["height"] / 100 * img_h
    return int(round(left)), int(round(top)), int(round(w)), int(round(h))


def hold_polygon_crop_px(hold, board_w, board_h):
    """A hold's polygon in board-crop pixel space (falls back to a circle
    approximation from cx/cy/r if no polygon is present)."""
    poly = hold.get("polygon")
    if poly and len(poly) >= 3:
        return np.array(
            [[p[0] / 100 * board_w, p[1] / 100 * board_h] for p in poly],
            dtype=np.float32,
        )
    cx = hold.get("cx", 50) / 100 * board_w
    cy = hold.get("cy", 50) / 100 * board_h
    r = hold.get("r", 3.0) / 100 * max(board_w, board_h)
    theta = np.linspace(0, 2 * np.pi, 16, endpoint=False)
    return np.stack([cx + r * np.cos(theta), cy + r * np.sin(theta)], axis=1).astype(np.float32)


def fill_poly_mask(shape_hw, poly_px):
    mask = np.zeros(shape_hw, dtype=np.uint8)
    cv2.fillPoly(mask, [poly_px.astype(np.int32)], 255)
    return mask


def polygon_bbox(poly_px):
    x0 = float(np.min(poly_px[:, 0]))
    y0 = float(np.min(poly_px[:, 1]))
    x1 = float(np.max(poly_px[:, 0]))
    y1 = float(np.max(poly_px[:, 1]))
    return x0, y0, x1 - x0, y1 - y0


def crop_px_to_full_bbox(bbox_crop, board_left_px, board_top_px):
    x, y, w, h = bbox_crop
    return [round(x + board_left_px, 1), round(y + board_top_px, 1), round(w, 1), round(h, 1)]


def px_to_board_pct(poly_px, board_w, board_h, round_to=2):
    return [
        [round(float(p[0]) / board_w * 100, round_to), round(float(p[1]) / board_h * 100, round_to)]
        for p in poly_px
    ]


# ─── Illumination-invariant diff ──────────────────────────────────────────────

def local_zscore(gray_f32, sigma=100.0, eps=3.0):
    """z = (img - local_mean) / (local_std + eps), local stats via a wide
    Gaussian. Cancels global/slowly-varying illumination while keeping local
    structure. eps (in 0-255 units) prevents blow-up in near-flat regions.

    sigma default deviates from the spec's illustrative "~25": measured
    directly on this image pair, sigma=25 caused near-total self-cancellation
    for a real, visually-confirmed new hold (a ~140x100px black volcanic
    rock). At that pixel, local_mean(aligned) came out to 139.8 against a raw
    value of 144 — the "local background" estimate was tracking the rock's
    own dark pixels almost exactly, because the blur's effective footprint
    was comparable to the object's size, giving z_aligned=0.07 (indistinguishable
    from flat plywood) despite an obvious visual change. Sweeping sigma
    40/60/80/100/130 on that exact ROI showed the fraction of the rock's
    bbox clearing (t1,t2) rise from 1.3% (sigma=25) to ~26% (sigma=100) and
    plateau after that, while the known problem region (the lower panel's
    V7->V8 lighting/white-balance shift) only grew from 0.57% to 1.23% of
    its area over the same sweep — nowhere near reconstituting the giant
    lighting blob a global correction produced. sigma=100 was chosen as the
    point of diminishing returns for the former with limited cost to the
    latter."""
    mean = cv2.GaussianBlur(gray_f32, (0, 0), sigma)
    sqmean = cv2.GaussianBlur(gray_f32 * gray_f32, (0, 0), sigma)
    var = np.clip(sqmean - mean * mean, 0, None)
    std = np.sqrt(var)
    return (gray_f32 - mean) / (std + eps)


def chroma_field(bgr, sigma=100.0):
    """LAB a/b channels, re-centred on a LOCAL (large-radius Gaussian) mean
    rather than a single global median.

    A single global median a/b turned out to be too crude here: The Barn's
    V7->V8 exposure/white-balance shift is not uniform across the photo —
    the lower panel reads noticeably greyer in V8 than V7 while the rest of
    the board barely shifts. A global median can't cancel a *regional* cast
    like that (it leaves the whole lower panel flagged as "changed", which
    is exactly the giant lighting-blob failure mode this script exists to
    avoid). Subtracting a wide local mean cancels slowly-varying regional
    colour casts the same way local_zscore cancels regional brightness
    casts, while still keeping local chroma structure (a real hold's colour
    against its immediate surroundings).
    """
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB).astype(np.float32)
    a, b = lab[:, :, 1], lab[:, :, 2]
    a_local_mean = cv2.GaussianBlur(a, (0, 0), sigma)
    b_local_mean = cv2.GaussianBlur(b, (0, 0), sigma)
    return a - a_local_mean, b - b_local_mean


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--reference", required=True, help="Old published board photo.")
    ap.add_argument("--aligned", required=True, help="New photo, already warped into the reference frame.")
    ap.add_argument("--board", default=None, metavar="SLUG_OR_ID", help="Fetch this wall's live holds (read-only GET).")
    ap.add_argument("--holds-file", default=None, metavar="PATH", help="Local holds JSON instead of --board.")
    ap.add_argument("--board-region", default="1.0,0.5,98.0,97.0", help="Percentages 'L,T,W,H' of the image (default matches The Barn).")
    ap.add_argument("--output", default=str(DEFAULT_OUTPUT), help="Where to write the candidates JSON.")
    ap.add_argument("--overlay", default=str(DEFAULT_OVERLAY), help="Annotated review JPEG path.")
    ap.add_argument("--min-area", type=int, default=150,
                     help="Minimum blob area in reference-frame pixels. Lowered from the spec's "
                          "illustrative 250: on this image pair, 250 excluded a visually-confirmed "
                          "genuine small new hold (a ~164px grey chip) and marginally excluded the "
                          "confirmed new teal foot chip (248px). 150 sits in a clean gap below both — "
                          "the next-largest blobs under it (101-130px) are a repeating pattern next to "
                          "the bottom mounting-rail brackets, more likely a lighting/hardware artifact "
                          "than new holds (see the script's module docstring).")
    ap.add_argument("--debug-dir", default=None, help="Dump intermediate masks here for diagnosis.")
    ap.add_argument("--t1", type=float, default=1.7, help="Structural (z-score) diff threshold.")
    ap.add_argument("--t2", type=float, default=16.0, help="Chroma (LAB a/b) diff threshold.")
    ap.add_argument("--sigma", type=float, default=100.0,
                     help="Local-baseline Gaussian sigma for both the structural z-score and the "
                          "chroma re-centring. See local_zscore()'s docstring for why this is 100, "
                          "not the spec's illustrative ~25.")
    args = ap.parse_args()

    if not args.board and not args.holds_file:
        print("Error: one of --board / --holds-file is required.")
        sys.exit(1)

    out_path = Path(args.output)
    if out_path.resolve() == (REPO_ROOT / "src" / "data" / "holds.json").resolve():
        print("Refusing to write to src/data/holds.json — pick a different --output path.")
        sys.exit(1)

    # ── Load images ───────────────────────────────────────────────────────
    ref_img = cv2.imread(args.reference)
    aligned_img = cv2.imread(args.aligned)
    if ref_img is None:
        print(f"Error: could not load --reference {args.reference}")
        sys.exit(1)
    if aligned_img is None:
        print(f"Error: could not load --aligned {args.aligned}")
        sys.exit(1)
    if ref_img.shape[:2] != aligned_img.shape[:2]:
        print(f"Error: image size mismatch — reference {ref_img.shape[:2]} vs aligned {aligned_img.shape[:2]}. "
              "The aligned image must be warped into the reference's exact pixel frame first.")
        sys.exit(1)
    img_h, img_w = ref_img.shape[:2]
    print(f"Image size: {img_w}x{img_h}")

    region = parse_board_region(args.board_region)
    bx, by, bw, bh = board_rect_px(region, img_w, img_h)
    print(f"Board region px: left={bx} top={by} w={bw} h={bh}")

    ref_crop = ref_img[by:by + bh, bx:bx + bw]
    aligned_crop = aligned_img[by:by + bh, bx:bx + bw]

    # ── Load holds (read-only) ──────────────────────────────────────────────
    if args.holds_file:
        holds = load_holds_file(args.holds_file)
        print(f"Loaded {len(holds)} holds from {args.holds_file}")
    else:
        env = load_env()
        base_url = env.get("VITE_SUPABASE_URL", "").rstrip("/")
        service_key = env.get("SUPABASE_SERVICE_ROLE_KEY", "")
        if not base_url or not service_key:
            print("Error: VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local.")
            sys.exit(1)
        headers = {"apikey": service_key, "Authorization": f"Bearer {service_key}"}
        board_id, board_slug, board_name = resolve_board(base_url, headers, args.board)
        print(f"Board: {board_name or board_slug} ({board_slug} / {board_id})")
        holds = fetch_live_holds(base_url, headers, board_id)
        print(f"Fetched {len(holds)} live holds (read-only GET; nothing written).")

    # ── Illumination-invariant structural diff ──────────────────────────────
    ref_gray = cv2.cvtColor(ref_crop, cv2.COLOR_BGR2GRAY).astype(np.float32)
    aligned_gray = cv2.cvtColor(aligned_crop, cv2.COLOR_BGR2GRAY).astype(np.float32)

    z_ref = local_zscore(ref_gray, sigma=args.sigma)
    z_aligned = local_zscore(aligned_gray, sigma=args.sigma)
    struct_diff = np.abs(z_ref - z_aligned)
    struct_diff = cv2.GaussianBlur(struct_diff, (7, 7), 0)

    # ── Illumination-robust chroma diff ──────────────────────────────────────
    a_ref, b_ref = chroma_field(ref_crop, sigma=args.sigma)
    a_al, b_al = chroma_field(aligned_crop, sigma=args.sigma)
    da = a_ref - a_al
    db = b_ref - b_al
    chroma_diff = np.sqrt(da * da + db * db)
    chroma_diff = cv2.GaussianBlur(chroma_diff, (5, 5), 0)

    print(f"struct_diff: mean={struct_diff.mean():.3f} p99={np.percentile(struct_diff, 99):.3f} max={struct_diff.max():.3f}")
    print(f"chroma_diff: mean={chroma_diff.mean():.3f} p99={np.percentile(chroma_diff, 99):.3f} max={chroma_diff.max():.3f}")

    changed_bool = (struct_diff > args.t1) | (chroma_diff > args.t2)
    changed_u8 = (changed_bool.astype(np.uint8)) * 255

    k_open = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    k_close = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15))
    mask_open = cv2.morphologyEx(changed_u8, cv2.MORPH_OPEN, k_open)
    mask_final = cv2.morphologyEx(mask_open, cv2.MORPH_CLOSE, k_close)

    if args.debug_dir:
        dbg = Path(args.debug_dir)
        dbg.mkdir(parents=True, exist_ok=True)
        def norm_save(arr, name, clip=None):
            a = arr.copy()
            if clip:
                a = np.clip(a, 0, clip)
            a = (a / (a.max() + 1e-6) * 255).astype(np.uint8)
            cv2.imwrite(str(dbg / name), a)
        norm_save(struct_diff, "struct_diff.png", clip=args.t1 * 4)
        norm_save(chroma_diff, "chroma_diff.png", clip=args.t2 * 4)
        cv2.imwrite(str(dbg / "changed_raw.png"), changed_u8)
        cv2.imwrite(str(dbg / "changed_final.png"), mask_final)
        print(f"Debug masks written to {dbg}/")

    # ── Connected components ─────────────────────────────────────────────
    n_labels, labels_img, stats, centroids = cv2.connectedComponentsWithStats(mask_final, connectivity=8)
    all_areas = sorted((int(stats[i, cv2.CC_STAT_AREA]) for i in range(1, n_labels)), reverse=True)
    print(f"Connected components (pre area-filter): {n_labels - 1}")
    print(f"Largest blob areas: {all_areas[:10]}")

    # Blobs whose centroid sits within EDGE_MARGIN_PCT of the board-crop
    # boundary are almost always alignment/blur boundary artefacts (the
    # homography warp has its highest residual error at the corners, and a
    # wide Gaussian's border handling isn't exact right at the crop edge) —
    # not physical holds. detect_holds.py rejects detections the same way
    # (its own EDGE_MARGIN_PCT=3.0); mirrored here at a slightly tighter 2.0
    # since genuine new holds on this board sit well clear of the edges.
    EDGE_MARGIN_PCT = 2.0
    blobs = []
    dropped_edge = 0
    for lbl in range(1, n_labels):
        area = int(stats[lbl, cv2.CC_STAT_AREA])
        if area < args.min_area:
            continue
        x, y, w, h = (int(stats[lbl, cv2.CC_STAT_LEFT]), int(stats[lbl, cv2.CC_STAT_TOP]),
                      int(stats[lbl, cv2.CC_STAT_WIDTH]), int(stats[lbl, cv2.CC_STAT_HEIGHT]))
        ccx, ccy = centroids[lbl]
        cx_pct, cy_pct = ccx / bw * 100, ccy / bh * 100
        if (cx_pct < EDGE_MARGIN_PCT or cx_pct > 100 - EDGE_MARGIN_PCT or
                cy_pct < EDGE_MARGIN_PCT or cy_pct > 100 - EDGE_MARGIN_PCT):
            dropped_edge += 1
            continue
        blobs.append({"label": lbl, "area": area, "bbox": (x, y, w, h)})
    print(f"Blobs after min-area({args.min_area}) filter: {len(blobs) + dropped_edge} "
          f"({dropped_edge} further dropped as board-edge artifacts, {len(blobs)} remain)")

    # ── Hold polygons (board-crop px) ───────────────────────────────────────
    hold_polys_crop = {h.get("id"): hold_polygon_crop_px(h, bw, bh) for h in holds}
    active_ids = list(hold_polys_crop.keys())

    # ── Colour-palette plywood reference (aligned image, board crop) ────────
    aligned_hsv_crop = cv2.cvtColor(aligned_crop, cv2.COLOR_BGR2HSV)
    print("\nEstimating plywood colour in aligned image (for VANISHED classification)...")
    ply_hsv, ply_std = estimate_plywood_color(aligned_hsv_crop)

    def hold_interior_bool(poly_px):
        core_mask_u8 = fill_poly_mask((bh, bw), poly_px)
        erode_k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
        core_eroded = cv2.erode(core_mask_u8, erode_k)
        interior_mask = core_eroded if core_eroded.sum() > 0 else core_mask_u8
        return interior_mask > 0

    def median_hsv(hsv_img, interior_bool):
        hh = hsv_img[:, :, 0][interior_bool]
        ss = hsv_img[:, :, 1][interior_bool]
        vv = hsv_img[:, :, 2][interior_bool]
        return float(np.median(hh)), float(np.median(ss)), float(np.median(vv))

    # NOTE on a known limitation (see the script's module docstring / the
    # commit message for the concrete example found while tuning this): a
    # small number of hold RECORDS on this board have polygons that already
    # read as bare plywood in the REFERENCE photo — i.e. the physical hold
    # vanished before V7 was even taken, but the record was never removed
    # (by design; routes may still reference it). Two single-image heuristics
    # were tried to detect and exclude these ("ghost in reference") so a
    # genuinely new hold landing on that stale footprint wouldn't be buried
    # in INTERIOR: (a) reference-image colour vs. plywood — flagged 74/200
    # holds, wildly over-broad because many real holds are deliberately
    # wood/grey-toned; (b) colour AND local Laplacian edge-energy vs. a
    # plywood baseline — cut it to 23/200, but visually confirmed genuine
    # holds (edge-energy ~28-40) and visually confirmed blank plywood
    # (edge-energy ~27-33) overlap too much to separate reliably. Per this
    # task's own stop-and-report rule, that pre-filter was dropped rather
    # than tuned further to look better on this one image pair. Classification
    # below therefore follows the spec exactly (coverage against ALL 200 live
    # holds' polygons) — meanStructDiff/meanChromaDiff are attached to every
    # CHANGED/INTERIOR entry so a human reviewer can still spot a
    # high-structural-change "INTERIOR" blob (glare/chalk should score low;
    # a full physical swap like the one above scores high even at 99%+
    # coverage) instead of the script silently guessing.

    # ── Existing-hold mask (dilated ~6px) ───────────────────────────────────
    DILATE_PX = 6
    dilate_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * DILATE_PX + 1, 2 * DILATE_PX + 1))

    existing_mask = np.zeros((bh, bw), dtype=np.uint8)
    for hid in active_ids:
        cv2.fillPoly(existing_mask, [hold_polys_crop[hid].astype(np.int32)], 255)
    existing_mask_dilated = cv2.dilate(existing_mask, dilate_kernel)
    existing_bool = existing_mask_dilated > 0

    def bbox_dict(ids):
        out = {}
        for hid in ids:
            x0, y0, w0, h0 = polygon_bbox(hold_polys_crop[hid])
            out[hid] = (x0 - DILATE_PX, y0 - DILATE_PX, x0 + w0 + DILATE_PX, y0 + h0 + DILATE_PX)
        return out

    active_bbox = bbox_dict(active_ids)

    def overlapping_ids_for_blob(blob_mask, bbox, candidate_bbox):
        """Which hold ids (from candidate_bbox) actually overlap this blob,
        via bbox pre-filter + local dilated-polygon rasterisation. (Not via
        connected-component labels on the combined mask — on this densely
        packed board, dilating ~200 holds by 6px merges many of them into a
        handful of giant connected regions, so a label-based lookup would
        attribute nearly every hold id to nearly every blob.)"""
        bx0, by0, bw0, bh0 = bbox
        ids = []
        for hid, (hx0, hy0, hx1, hy1) in candidate_bbox.items():
            if hx1 < bx0 or hx0 > bx0 + bw0 or hy1 < by0 or hy0 > by0 + bh0:
                continue
            rx0, ry0 = int(max(0, min(hx0, bx0))), int(max(0, min(hy0, by0)))
            rx1, ry1 = int(min(bw, max(hx1, bx0 + bw0))), int(min(bh, max(hy1, by0 + bh0)))
            if rx1 <= rx0 or ry1 <= ry0:
                continue
            local_blob = blob_mask[ry0:ry1, rx0:rx1]
            poly_local = hold_polys_crop[hid] - [rx0, ry0]
            hmask = np.zeros_like(local_blob, dtype=np.uint8)
            cv2.fillPoly(hmask, [poly_local.astype(np.int32)], 255)
            hmask = cv2.dilate(hmask, dilate_kernel)
            if np.any(local_blob & (hmask > 0)):
                ids.append(hid)
        return sorted(ids)

    candidates_new = []
    changed_list = []
    interior_list = []

    for blob in blobs:
        lbl = blob["label"]
        blob_mask = (labels_img == lbl)
        area = blob["area"]
        bx0, by0, bw0, bh0 = blob["bbox"]

        overlap_bool = blob_mask & existing_bool
        coverage = float(overlap_bool.sum()) / float(area)
        mean_struct = round(float(struct_diff[blob_mask].mean()), 3)
        mean_chroma = round(float(chroma_diff[blob_mask].mean()), 3)

        bbox_full = crop_px_to_full_bbox((bx0, by0, bw0, bh0), bx, by)

        if coverage < 0.25:
            # NEW candidate — carve a real polygon with GrabCut.
            candidate = build_new_candidate(
                blob_mask, (bx0, by0, bw0, bh0), area, aligned_crop, aligned_hsv_crop, bw, bh,
            )
            candidate["_diag"] = {
                "index": len(candidates_new),
                "bboxPx": bbox_full,
                "areaPx": area,
                "coverage": round(coverage, 3),
                "meanStructDiff": mean_struct,
                "meanChromaDiff": mean_chroma,
            }
            candidates_new.append(candidate)
        elif coverage < 0.85:
            overlapping_hold_ids = overlapping_ids_for_blob(blob_mask, blob["bbox"], active_bbox)
            changed_list.append({
                "index": len(changed_list),
                "bboxPx": bbox_full,
                "areaPx": area,
                "coverage": round(coverage, 3),
                "meanStructDiff": mean_struct,
                "meanChromaDiff": mean_chroma,
                "overlappingHoldIds": overlapping_hold_ids,
            })
        else:
            overlapping_hold_ids = overlapping_ids_for_blob(blob_mask, blob["bbox"], active_bbox)
            interior_list.append({
                "index": len(interior_list),
                "bboxPx": bbox_full,
                "areaPx": area,
                "coverage": round(coverage, 3),
                "meanStructDiff": mean_struct,
                "meanChromaDiff": mean_chroma,
                "overlappingHoldIds": overlapping_hold_ids,
            })

    # ── VANISHED: existing holds with high struct_diff + plywood-like ──────
    # colour in the aligned image — a presence-to-absence transition between
    # V7 and V8.
    vanished_list = []
    VANISHED_STRUCT_MEAN_T = args.t1 * 0.85
    for hid in active_ids:
        poly_px = hold_polys_crop[hid]
        interior_bool = hold_interior_bool(poly_px)
        if interior_bool.sum() == 0:
            continue
        mean_struct = float(struct_diff[interior_bool].mean())
        if mean_struct <= VANISHED_STRUCT_MEAN_T:
            continue
        med_h, med_s, med_v = median_hsv(aligned_hsv_crop, interior_bool)
        plywood_like = is_plywood_coloured(med_h, med_s, med_v, ply_hsv, ply_std)
        if not plywood_like:
            continue
        x0, y0, w0, h0 = polygon_bbox(poly_px)
        vanished_list.append({
            "holdId": hid,
            "bboxPx": crop_px_to_full_bbox((x0, y0, w0, h0), bx, by),
            "meanStructDiff": round(mean_struct, 3),
            "plywoodLike": True,
        })

    print(f"\nNEW candidates: {len(candidates_new)}")
    print(f"CHANGED blobs:  {len(changed_list)}")
    print(f"INTERIOR blobs: {len(interior_list)}")
    print(f"VANISHED holds: {len(vanished_list)}")

    # ── Write JSON output ─────────────────────────────────────────────────
    out_data = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "reference": args.reference,
        "aligned": args.aligned,
        "boardRegion": region,
        "candidates": [strip_diag(c) for c in candidates_new],
        "changed": changed_list,
        "interior": interior_list,
        "vanished": vanished_list,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out_data, indent=2))
    print(f"\nWrote {out_path}")

    # ── Overlay ──────────────────────────────────────────────────────────
    if args.overlay:
        overlay_path = Path(args.overlay)
        overlay_path.parent.mkdir(parents=True, exist_ok=True)
        draw_overlay(aligned_img, holds, region, img_w, img_h, candidates_new, changed_list, vanished_list,
                     interior_list, overlay_path)
        print(f"Wrote overlay {overlay_path}")


def strip_diag(candidate):
    """Return the candidate with its '_diag' debug block merged to the top
    level (bboxPx/areaPx/coverage/index) alongside the pure hold-shape
    fields, so the object is both mergeable and reviewable."""
    out = dict(candidate)
    diag = out.pop("_diag", {})
    out.update(diag)
    return out


def build_new_candidate(blob_mask, bbox, blob_area, aligned_crop_bgr, aligned_hsv_crop, board_w, board_h):
    """GrabCut a real polygon for a NEW blob; fall back to the blob's own
    contour if GrabCut degenerates. Emits exactly the hold-record shape."""
    bx0, by0, bw0, bh0 = bbox
    pad = 20
    x0 = max(0, bx0 - pad)
    y0 = max(0, by0 - pad)
    x1 = min(board_w, bx0 + bw0 + pad)
    y1 = min(board_h, by0 + bh0 + pad)

    roi_bgr = aligned_crop_bgr[y0:y1, x0:x1]
    blob_roi = blob_mask[y0:y1, x0:x1].astype(np.uint8) * 255

    core_k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (13, 13))
    core = cv2.erode(blob_roi, core_k)
    if core.sum() == 0:
        core = blob_roi

    gc_mask = np.full(roi_bgr.shape[:2], cv2.GC_PR_BGD, np.uint8)
    gc_mask[blob_roi > 0] = cv2.GC_PR_FGD
    gc_mask[core > 0] = cv2.GC_FGD
    border = 5
    if gc_mask.shape[0] > 2 * border and gc_mask.shape[1] > 2 * border:
        gc_mask[:border, :] = cv2.GC_BGD
        gc_mask[-border:, :] = cv2.GC_BGD
        gc_mask[:, :border] = cv2.GC_BGD
        gc_mask[:, -border:] = cv2.GC_BGD

    final_poly_roi = None
    confidence = "medium"
    try:
        bgd_model = np.zeros((1, 65), np.float64)
        fgd_model = np.zeros((1, 65), np.float64)
        cv2.grabCut(roi_bgr, gc_mask, (0, 0, 1, 1), bgd_model, fgd_model, 5, cv2.GC_INIT_WITH_MASK)
        fg = np.where((gc_mask == cv2.GC_FGD) | (gc_mask == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)
        contours, _ = cv2.findContours(fg, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if contours:
            cnt = max(contours, key=cv2.contourArea)
            gc_area = cv2.contourArea(cnt)
            approx = cv2.approxPolyDP(cnt, 1.5, True)
            ratio = gc_area / max(blob_area, 1)
            if len(approx) >= 4 and 0.3 <= ratio <= 3.0:
                final_poly_roi = approx.reshape(-1, 2).astype(np.float32)
                confidence = "high"
    except cv2.error:
        pass

    if final_poly_roi is None:
        contours, _ = cv2.findContours(blob_roi, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cnt = max(contours, key=cv2.contourArea) if contours else None
        if cnt is None:
            # Degenerate blob — synthesize a small square so downstream code
            # always has a valid polygon.
            final_poly_roi = np.array([[0, 0], [bw0, 0], [bw0, bh0], [0, bh0]], dtype=np.float32)
        else:
            approx = cv2.approxPolyDP(cnt, 1.5, True)
            final_poly_roi = approx.reshape(-1, 2).astype(np.float32)
        confidence = "medium"

    # ROI-local -> board-crop pixel coords
    final_poly_crop = final_poly_roi + np.array([x0, y0], dtype=np.float32)

    x0p, y0p, w0p, h0p = polygon_bbox(final_poly_crop)
    cx_pct = round((x0p + w0p / 2) / board_w * 100, 1)
    cy_pct = round((y0p + h0p / 2) / board_h * 100, 1)
    w_pct = round(w0p / board_w * 100, 1)
    h_pct = round(h0p / board_h * 100, 1)
    r_pct = round(max(w0p, h0p) / 2 / max(board_w, board_h) * 100, 1)
    r_pct = max(r_pct, 1.5)

    poly_mask = fill_poly_mask((board_h, board_w), final_poly_crop)
    color = classify_contour_colour(aligned_hsv_crop, poly_mask)

    return {
        "id": None,
        "cx": cx_pct,
        "cy": cy_pct,
        "r": r_pct,
        "w_pct": w_pct,
        "h_pct": h_pct,
        "polygon": px_to_board_pct(final_poly_crop, board_w, board_h),
        "color": color,
        "confidence": confidence,
        "size": size_of_area(blob_area),
        "notes": "",
        "custom": True,
        "verified": False,
    }


def size_of_area(area):
    if area > 5000:
        return "large"
    elif area > 2000:
        return "medium"
    return "small"


def short_id_label(ids, max_shown=2):
    """Compact a list of hold ids for an on-image label: strip the noisy
    'custom_' prefix and cap how many are spelled out (the JSON keeps the
    full list either way) — a long comma-joined id list otherwise runs off
    the edge of the image and becomes unreadable."""
    if not ids:
        return "?"
    short = [i[len("custom_"):] if i.startswith("custom_") else i for i in ids]
    if len(short) <= max_shown:
        return ",".join(short)
    return ",".join(short[:max_shown]) + f"+{len(short) - max_shown}"


def put_label(img, text, pos, color, font_scale=0.75, thickness=2):
    """A readable label: a dark backer rectangle behind coloured text."""
    (tw, th), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, font_scale, thickness)
    x, y = int(pos[0]), int(pos[1])
    cv2.rectangle(img, (x - 2, y - th - 6), (x + tw + 2, y + 4), (0, 0, 0), -1)
    cv2.putText(img, text, (x, y), cv2.FONT_HERSHEY_SIMPLEX, font_scale, color, thickness, cv2.LINE_AA)


def draw_overlay(full_img, holds, region, img_w, img_h, candidates_new, changed_list, vanished_list,
                  interior_list, out_path):
    img = full_img.copy()
    bx, by, bw, bh = board_rect_px(region, img_w, img_h)

    # Existing 200 holds — thin green outline.
    for h in holds:
        poly_px = hold_polygon_crop_px(h, bw, bh) + np.array([bx, by], dtype=np.float32)
        cv2.polylines(img, [poly_px.astype(np.int32)], True, (0, 200, 0), 1, cv2.LINE_AA)

    # INTERIOR — not in the spec's 4 drawn categories, but drawn anyway (thin
    # orange, visually subordinate to the categories below) because coverage
    # against a stale hold record can bury a genuinely new hold in here (see
    # the module docstring) — a human should be able to spot that by eye
    # rather than it being silently invisible outside the JSON.
    for c in interior_list:
        x, y, w, h = [int(v) for v in c["bboxPx"]]
        cv2.rectangle(img, (x, y), (x + w, y + h), (0, 165, 255), 1)
        put_label(img, f"int{c['index']}", (x, max(y - 6, 12)), (0, 165, 255), font_scale=0.5, thickness=1)

    # NEW — thick red outline + numbered label.
    for i, c in enumerate(candidates_new):
        poly_full = (np.array(c["polygon"], dtype=np.float32) / 100 * [bw, bh]) + [bx, by]
        cv2.polylines(img, [poly_full.astype(np.int32)], True, (0, 0, 255), 3, cv2.LINE_AA)
        cx = int(np.mean(poly_full[:, 0]))
        cy = int(np.mean(poly_full[:, 1]))
        put_label(img, f"NEW {i}", (cx - 20, cy - 12), (0, 0, 255))

    # CHANGED — thick magenta box + overlapping hold id(s).
    for c in changed_list:
        x, y, w, h = c["bboxPx"]
        x, y, w, h = int(x), int(y), int(w), int(h)
        cv2.rectangle(img, (x, y), (x + w, y + h), (255, 0, 255), 3)
        put_label(img, short_id_label(c["overlappingHoldIds"]), (x, max(y - 8, 14)), (255, 0, 255))

    # VANISHED — thick blue box + hold id.
    for v in vanished_list:
        x, y, w, h = v["bboxPx"]
        x, y, w, h = int(x), int(y), int(w), int(h)
        cv2.rectangle(img, (x, y), (x + w, y + h), (255, 128, 0), 3)
        put_label(img, short_id_label([v["holdId"]]), (x, max(y - 8, 14)), (255, 128, 0))

    cv2.imwrite(str(out_path), img, [cv2.IMWRITE_JPEG_QUALITY, 92])


if __name__ == "__main__":
    main()
