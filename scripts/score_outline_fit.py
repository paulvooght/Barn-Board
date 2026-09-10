#!/usr/bin/env python3
"""
score_outline_fit.py — score each hold's CURRENT outline against the CURRENT
board photo, directly. Board-generic. READ-ONLY: no Supabase writes, ever;
the board photo is opened with cv2.imread and never written back to.

Why this exists (see CURRENT_STATE.md / the task that produced this script):
A previous approach ranked holds by how much two auto-outline METHODS
(GrabCut vs SAM) disagreed with each other. That measures "two algorithms
couldn't agree" — not "the outline is wrong" — and produced ~130 holds to
review, most of them fine. This script instead asks one question per hold:
does THIS outline, drawn on THIS photo, actually look like it belongs there?

Method, in one paragraph:
Build a statistical model of "bare plywood" by sampling colour (CIE LAB) and
local texture (blurred |Laplacian|, i.e. how visually busy a patch is) from
image pixels far from every hold's polygon. Plywood is tan, fairly uniform,
and low-relief, so that sample forms a tight cluster; anything far from it
in colour+texture space is "not plywood" (i.e. probably a hold, a shadow, a
bolt, etc). Score every hold's outline against that model:
  emptiness       — is the outline's OWN interior mostly plywood-like?
                     (high => outline may be sitting on bare wall: never
                     mounted, or removed)
  spill           — is plywood showing up specifically near the INSIDE edge
                     of the outline? (high => outline is bigger than the
                     physical hold)
  leakage         — does non-plywood material, CONTIGUOUS with the hold's
                     own interior, extend into a ring just OUTSIDE the
                     outline? (high => the hold extends past its outline)
  edge_alignment  — does the outline boundary actually sit on a real image
                     edge (Sobel gradient), or float over uniform pixels?
                     (low => outline doesn't track any real edge)
These combine into one fit_score (0 = perfect fit, 1 = clearly wrong) with
weights stated in FIT_WEIGHTS below and in the RESULTS.md this script writes.

Percentage-based metrics are noisier on small holds (few interior pixels ->
a handful of stray pixels swings the fraction a lot). Countered with additive
(Laplace-style) shrinkage of each fraction toward the board's own population
mean, weighted down as the hold's pixel count grows — see `shrink()`. This is
reported explicitly (SHRINK_K, and a rank-vs-size correlation check) so it is
possible to tell whether the top-N is just "the N smallest holds" in disguise.

Reuses scripts/reproject_holds.py's pct_to_px/px_to_pct — do not rewrite that
maths (CLAUDE.md, "SVG Coordinate Conversion").

Usage:
    python3 scripts/score_outline_fit.py \\
        --board the-barn --image board-assets/the-barn/Barn_Set_01_V8.jpg \\
        --output board-assets/the-barn/_outline_fit/ranked.json \\
        --overlay board-assets/the-barn/_outline_fit/review_top.jpg \\
        --top 15

    # Offline (no Supabase read), from a local holds snapshot:
    python3 scripts/score_outline_fit.py \\
        --holds-file board-assets/the-barn/_holds_snapshot_2026-09-09.json \\
        --image board-assets/the-barn/Barn_Set_01_V8.jpg \\
        --output /tmp/ranked.json --overlay /tmp/review.jpg
"""
import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts"))
from reproject_holds import pct_to_px, px_to_pct  # noqa: E402  (reuse, don't rewrite the maths)


# ════════════════════════════════ tunables (stated here + echoed to RESULTS.md) ══
# edge_gate = 1 - EDGE_GATE_STRENGTH * edge_alignment   (0..1; small when the
#             boundary sits on a real image edge, ~1 when it doesn't)
# fit_score = FIT_WEIGHTS['emptiness'] * emptiness * edge_gate
#           + FIT_WEIGHTS['spill']     * spill     * edge_gate
#           + FIT_WEIGHTS['leakage']   * leakage
#           + FIT_WEIGHTS['edge']      * (1 - edge_alignment)
#
# Calibration on The Barn (see RESULTS.md) found emptiness/spill ALONE
# systematically false-positive on a whole colourway of matte grey/stone
# holds that sit close to plywood in colour+texture but are real, correctly
# outlined holds — while edge_alignment (does the boundary sit on a real
# image edge?) separated the two confirmed-bad reference holds (0.54, 0.56)
# from every one of those false positives (1.00) cleanly. So edge_alignment
# is used TWICE: once as its own weighted term, and once as a GATE that
# discounts emptiness/spill when a real boundary is present — a crisp,
# correctly-placed edge is strong direct evidence that something is
# physically there, which should outweigh "the fill colour looks close to
# plywood" almost regardless of how close that colour match is. The gate
# never reaches exactly 0 (EDGE_GATE_STRENGTH < 1) because an edge can
# coincidentally land on a T-nut grid line or a wood-grain seam.
# emptiness still gets the largest base weight of the two gated terms —
# "sits on nothing" is the clearest defect this method can see once a real
# boundary is ruled out. leakage is left UNGATED (a different phenomenon —
# material escaping a good boundary, not an ambiguous fill colour).
EDGE_GATE_STRENGTH = 0.85
FIT_WEIGHTS = {"emptiness": 0.35, "spill": 0.15, "leakage": 0.20, "edge": 0.30}

# LAB colour distance weighting for the plywood model: chroma (a*, b*) carries
# the tan colour signature and is far more lighting-invariant than lightness
# (L*), which shifts a lot with shadow/glare across the board. L* is kept but
# down-weighted rather than dropped, so a hold that's simply very dark/bright
# (not tan) still separates from plywood.
LAB_WEIGHTS = {"L": 0.3, "A": 1.0, "B": 1.0}
TEXTURE_WEIGHT = 0.6  # added (not squared) so a textured pixel never "buys back" plywood-like colour

PLYWOOD_PERCENTILE = 92.0   # self-calibrated plywood/not-plywood cut: this %ile of the SAMPLE's own distance
LOCAL_MARGIN_MADS = 3.0     # per-hold adaptive cut: local ring median + this many robust-MADs of the ring
MIN_LOCAL_MARGIN = 0.35     # floor on that margin, in distance units, for a near-zero-variance ring
SHRINK_K = 120              # pseudo-count for small-hold shrinkage (see shrink())
BAND_FRACTION = 0.18        # boundary band width, as a fraction of the hold's half-extent
BOUNDARY_STEP_PX = 2.0      # spacing between boundary-alignment sample points
GRAD_REF_PERCENTILE = 90.0  # "what a strong real edge looks like on this photo"

REASONS = {
    "emptiness": "outline sits mostly on bare plywood — possible hold that was never mounted, or removed",
    "spill": "outline is larger than the hold",
    "leakage": "hold extends beyond its outline",
    "edge": "outline doesn't follow the hold's edge",
}

PANEL_IMG = 320   # min panel image side, px (deliverable requires >= 260px)
PANEL_TEXT_H = 76
PANEL_PAD = 12
GRID_COLS = 3
FONT = cv2.FONT_HERSHEY_SIMPLEX
FONT_SCALE = 0.6
FONT_THICK = 2


# ════════════════════════════════ read-only Supabase loader (same pattern as ═════
# scripts/publish_board_image.py's load_env / resolve_board; GET-only, no writes,
# matching scripts/guided_reoutline.py's live-holds fetch) ════════════════════════

def load_env():
    """Load .env.local from repo root; return a dict of key=value pairs."""
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
    is_uuid = bool(re.match(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-", board_arg, re.I))
    field = "id" if is_uuid else "slug"
    url = f"{base_url}/rest/v1/boards?{field}=eq.{board_arg}&select=id,slug,name"
    import requests
    r = requests.get(url, headers={**headers, "Accept": "application/json"}, timeout=15)
    if r.status_code != 200:
        sys.exit(f"Error resolving board '{board_arg}': {r.status_code} {r.text}")
    rows = r.json()
    if not rows:
        sys.exit(f"Error: no board with {field}='{board_arg}'.")
    row = rows[0]
    return row["id"], row["slug"], row.get("name")


def fetch_live_holds(base_url, headers, board_id):
    import requests
    key = f"holds_{board_id}"
    url = f"{base_url}/rest/v1/board_settings?key=eq.{key}&select=data"
    r = requests.get(url, headers={**headers, "Accept": "application/json"}, timeout=30)
    if r.status_code != 200:
        sys.exit(f"Error fetching {key}: {r.status_code} {r.text}")
    rows = r.json()
    if not rows or not isinstance(rows[0].get("data"), list):
        sys.exit(f"Error: board_settings['{key}'] missing or not an array (read-only GET).")
    return rows[0]["data"], key


def load_holds(args):
    """Returns (holds, label). Read-only in both branches — no Supabase writes."""
    if args.holds_file:
        d = json.loads(Path(args.holds_file).read_text())
        holds = d["holds"] if isinstance(d, dict) and "holds" in d else d
        if not isinstance(holds, list):
            sys.exit(f"{args.holds_file}: expected a list of holds or {{'holds': [...]}}")
        return holds, f"--holds-file {args.holds_file}"

    if not args.board:
        sys.exit("Provide --board <slug|uuid> or --holds-file PATH.")

    env = load_env()
    base_url = env.get("VITE_SUPABASE_URL", "").rstrip("/")
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not base_url or not service_key:
        sys.exit("Missing VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local "
                  "(read-only GET still needs these).")
    headers = {"apikey": service_key, "Authorization": f"Bearer {service_key}"}
    board_id, board_slug, board_name = resolve_board(base_url, headers, args.board)
    holds, holds_key = fetch_live_holds(base_url, headers, board_id)
    print(f"Board: {board_name or board_slug} ({board_slug})  id={board_id}")
    print(f"Fetched {holds_key}: {len(holds)} holds  (read-only GET)")
    return holds, f"--board {args.board} (live {holds_key})"


# ════════════════════════════════ geometry helpers ═══════════════════════════

def poly_pct_to_px(poly_pct, br, w, h):
    return np.array([pct_to_px(x, y, br, w, h) for x, y in poly_pct], dtype=np.float64)


def polygon_area_pct2(poly_pct):
    """Shoelace area, in (board %)^2 — a size measure independent of the
    bounding-box w_pct*h_pct field (which over-counts concave/irregular holds)."""
    p = np.array(poly_pct, dtype=np.float64)
    x, y = p[:, 0], p[:, 1]
    return float(0.5 * abs(np.dot(x, np.roll(y, 1)) - np.dot(y, np.roll(x, 1))))


def board_bbox_px(br, iw, ih):
    x0, y0 = pct_to_px(0, 0, br, iw, ih)
    x1, y1 = pct_to_px(100, 100, br, iw, ih)
    x0, x1 = sorted([x0, x1])
    y0, y1 = sorted([y0, y1])
    return (max(0, int(np.floor(x0))), max(0, int(np.floor(y0))),
            min(iw, int(np.ceil(x1))), min(ih, int(np.ceil(y1))))


def fill_mask(shape, poly_px):
    m = np.zeros(shape, np.uint8)
    pts = np.round(poly_px).astype(np.int32)
    if len(pts) >= 3:
        cv2.fillPoly(m, [pts], 1)
    return m.astype(bool)


def erode_mask(mask, px):
    k = max(1, int(round(px)))
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * k + 1, 2 * k + 1))
    return cv2.erode(mask.astype(np.uint8), kernel).astype(bool)


def dilate_mask(mask, px):
    k = max(1, int(round(px)))
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * k + 1, 2 * k + 1))
    return cv2.dilate(mask.astype(np.uint8), kernel).astype(bool)


def sample_boundary(poly_px, step_px=BOUNDARY_STEP_PX):
    pts = []
    n = len(poly_px)
    for i in range(n):
        p0, p1 = poly_px[i], poly_px[(i + 1) % n]
        seg_len = float(np.hypot(p1[0] - p0[0], p1[1] - p0[1]))
        steps = max(1, int(seg_len / step_px))
        for s in range(steps):
            t = s / steps
            pts.append((p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t))
    return pts


# ════════════════════════════════ plywood model ═══════════════════════════════

def all_holds_mask(holds, br, iw, ih):
    mask = np.zeros((ih, iw), np.uint8)
    for h in holds:
        poly = h.get("polygon")
        if not poly or len(poly) < 3:
            continue
        pts = np.round(poly_pct_to_px(poly, br, iw, ih)).astype(np.int32)
        cv2.fillPoly(mask, [pts], 1)
    return mask.astype(bool)


def median_hold_halfextent_px(holds, br, iw, ih):
    sizes = []
    for h in holds:
        poly = h.get("polygon")
        if not poly or len(poly) < 3:
            continue
        pts = poly_pct_to_px(poly, br, iw, ih)
        w_px = pts[:, 0].max() - pts[:, 0].min()
        h_px = pts[:, 1].max() - pts[:, 1].min()
        sizes.append(0.25 * (w_px + h_px))  # avg of the two half-extents
    return float(np.median(sizes)) if sizes else 15.0


def texture_energy_map(gray):
    lap = cv2.Laplacian(gray.astype(np.float32), cv2.CV_32F, ksize=3)
    return cv2.blur(np.abs(lap), (5, 5))


def gradient_magnitude_map(gray):
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    return cv2.magnitude(gx, gy)


def build_plywood_model(img_bgr, candidate_mask):
    lab = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2LAB).astype(np.float32)
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    energy = texture_energy_map(gray)

    L, A, B = lab[..., 0], lab[..., 1], lab[..., 2]
    Ls, As, Bs, Es = L[candidate_mask], A[candidate_mask], B[candidate_mask], energy[candidate_mask]

    stats = {
        "n_samples": int(candidate_mask.sum()),
        "L_mean": float(np.median(Ls)), "L_std": float(np.std(Ls) + 1e-6),
        "A_mean": float(np.median(As)), "A_std": float(np.std(As) + 1e-6),
        "B_mean": float(np.median(Bs)), "B_std": float(np.std(Bs) + 1e-6),
        "E_mean": float(np.median(Es)), "E_std": float(np.std(Es) + 1e-6),
    }

    def combined_dist(Lc, Ac, Bc, Ec):
        dL = (Lc - stats["L_mean"]) / stats["L_std"]
        dA = (Ac - stats["A_mean"]) / stats["A_std"]
        dB = (Bc - stats["B_mean"]) / stats["B_std"]
        dE = np.maximum(0.0, (Ec - stats["E_mean"]) / stats["E_std"])
        return np.sqrt(LAB_WEIGHTS["L"] * dL ** 2 + LAB_WEIGHTS["A"] * dA ** 2
                        + LAB_WEIGHTS["B"] * dB ** 2) + TEXTURE_WEIGHT * dE

    sample_dist = combined_dist(Ls, As, Bs, Es)
    threshold = float(np.percentile(sample_dist, PLYWOOD_PERCENTILE))
    stats["threshold"] = threshold
    stats["sample_dist_median"] = float(np.median(sample_dist))

    full_dist = combined_dist(L, A, B, energy)
    plywood_score = 1.0 / (1.0 + full_dist)   # continuous, 1 = very plywood-like
    is_plywood = full_dist <= threshold

    # Local-max-filter the gradient map ONCE here (5x5, matching the boundary
    # sampling window) so every downstream read — the per-hold edge_alignment
    # lookup and the global percentile reference below — is on the same scale.
    grad_raw = gradient_magnitude_map(gray)
    grad_maxfilt = cv2.dilate(grad_raw, cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5)))
    # full_dist (continuous "distance from plywood") is returned too: some holds
    # on this board are a grey/stone colourway that sits close to plywood in the
    # GLOBAL colour model, but still shows local contrast against ITS OWN
    # immediate surround — see the locally-adaptive threshold in score_hold_raw.
    return stats, plywood_score, is_plywood, grad_maxfilt, full_dist


# ════════════════════════════════ per-hold scoring ════════════════════════════

def score_hold_raw(hold, br, iw, ih, dist_map, global_threshold,
                    all_hold_mask, grad_mag, global_grad_ref):
    """First pass: raw (unshrunk) metrics + the pixel counts shrinkage needs.

    Uses a LOCALLY-adaptive plywood cut rather than one global threshold. Some
    of this board's holds are a grey/stone colourway that sits close to
    plywood in the GLOBAL colour model (verified on real holds during
    calibration — see RESULTS.md) but a real hold still shows SOME contrast
    against its own immediate surround, even when that surround-vs-hold gap
    is smaller than surround-vs-vivid-hold. Comparing each hold's core
    against a threshold anchored to ITS OWN ring (excluding any pixels that
    land inside a *different*, neighbouring hold's polygon) catches that;
    comparing everything to one global cut does not.
    """
    poly = hold.get("polygon")
    if not poly or len(poly) < 3:
        return None

    poly_px = poly_pct_to_px(poly, br, iw, ih)
    xs, ys = poly_px[:, 0], poly_px[:, 1]
    w_px = float(xs.max() - xs.min())
    h_px = float(ys.max() - ys.min())
    half_extent = 0.25 * (w_px + h_px)
    band_px = max(1.5, BAND_FRACTION * half_extent)

    # The local plywood-calibration annulus sits FURTHER OUT than the
    # boundary band: a real hold casts a faint shadow / has antialiasing
    # right at its own edge, and sampling that as "local plywood" would drag
    # the baseline toward the hold's own colour — silently making the
    # threshold MORE permissive right where it needs to be strict. skip_px
    # clears that halo before the calibration ring starts.
    skip_px = 2.0 * band_px
    calib_outer_px = skip_px + 2.0 * band_px

    pad = calib_outer_px + 3
    x0 = max(0, int(np.floor(xs.min() - pad)))
    y0 = max(0, int(np.floor(ys.min() - pad)))
    x1 = min(iw, int(np.ceil(xs.max() + pad)))
    y1 = min(ih, int(np.ceil(ys.max() + pad)))
    local_shape = (y1 - y0, x1 - x0)
    local_poly = poly_px - [x0, y0]

    interior = fill_mask(local_shape, local_poly)
    n_interior = int(interior.sum())
    if n_interior == 0:
        return None

    core = erode_mask(interior, band_px)
    n_core = int(core.sum())
    if n_core == 0:
        # hold too small for the boundary band to leave any deep interior —
        # fall back to the full interior for BOTH core and band so a tiny
        # hold still gets scored, just without the emptiness/spill split.
        core = interior
        n_core = n_interior
    band = interior & (~core)
    ring = dilate_mask(interior, band_px) & (~interior)             # tight annulus, for leakage
    calib_ring = dilate_mask(interior, calib_outer_px) & (~dilate_mask(interior, skip_px))

    dist_local = dist_map[y0:y1, x0:x1]
    other_holds_local = all_hold_mask[y0:y1, x0:x1] & (~interior)
    calib_baseline_mask = calib_ring & (~other_holds_local)  # exclude a neighbour's own territory

    n_calib_baseline = int(calib_baseline_mask.sum())
    if n_calib_baseline >= 20:
        calib_dists = dist_local[calib_baseline_mask]
        local_median = float(np.median(calib_dists))
        local_mad = float(np.median(np.abs(calib_dists - local_median))) * 1.4826 + 1e-6
        margin = max(LOCAL_MARGIN_MADS * local_mad, MIN_LOCAL_MARGIN)
        adaptive_threshold = local_median + margin
        used_local = True
    else:
        # not enough clean local plywood to calibrate against (hold crowded
        # by neighbours, or right at the image/board edge) — fall back to
        # the global cut.
        adaptive_threshold = global_threshold
        used_local = False

    is_plywood_local = dist_local <= adaptive_threshold

    # emptiness looks ONLY at the deep interior (core), deliberately excluding
    # the boundary band. A real hold's outline nearly always has a thin rim of
    # shadow/antialiasing/mounting-screw plywood right at its own edge, even
    # when correctly drawn — for a LARGE hold that rim is a tiny fraction of
    # the interior, but for a SMALL hold the same pixel-width rim can be most
    # of it. Testing only the core removes that size-correlated edge effect
    # instead of trying to average it away after the fact.
    emptiness_raw = float(is_plywood_local[core].mean())
    n_band = int(band.sum())
    spill_raw = float(is_plywood_local[band].mean()) if n_band > 0 else emptiness_raw

    not_plywood_local = ~is_plywood_local
    n_ring = int(ring.sum())
    leakage_raw = 0.0
    if n_ring > 0:
        cc_input = (not_plywood_local & (interior | ring)).astype(np.uint8)
        num, labels = cv2.connectedComponents(cc_input, connectivity=8)
        if num > 1:
            interior_labels = labels[interior]
            interior_labels = interior_labels[interior_labels != 0]
            if interior_labels.size:
                vals, counts = np.unique(interior_labels, return_counts=True)
                dominant = vals[np.argmax(counts)]
                leak_component = labels == dominant
                leakage_raw = float((leak_component & ring).sum()) / n_ring

    # grad_mag passed in is already local-max-filtered (see build_plywood_model /
    # main): a direct per-pixel lookup here is on the SAME scale as
    # global_grad_ref below (both are "max gradient within a ~5x5 neighbourhood"),
    # so the two are comparable. (Earlier version took an extra max() over a
    # window here but compared it against a percentile of UN-maxed single-pixel
    # values -> apples-to-oranges -> edge_alignment saturated at 1.0 for every
    # hold. Fixed by max-filtering once, up front, and sampling that directly.)
    lh, lw = local_shape
    align_vals = []
    for bx, by in sample_boundary(local_poly):
        ix, iy = int(round(bx)), int(round(by))
        if 0 <= iy < lh and 0 <= ix < lw:
            align_vals.append(float(grad_mag[y0 + iy, x0 + ix]))
    edge_raw = float(np.mean(align_vals)) if align_vals else 0.0
    edge_alignment = float(min(1.0, edge_raw / global_grad_ref)) if global_grad_ref > 0 else 0.0

    return {
        "emptiness_raw": emptiness_raw, "n_interior": n_interior, "n_core": n_core,
        "spill_raw": spill_raw, "n_band": n_band,
        "leakage_raw": leakage_raw, "n_ring": n_ring,
        "edge_alignment": edge_alignment, "edge_raw": edge_raw,
        "w_px": w_px, "h_px": h_px,
        "bbox_local": (x0, y0, x1, y1),
        "area_pct2": polygon_area_pct2(poly),
        "used_local_threshold": used_local, "adaptive_threshold": adaptive_threshold,
    }


def shrink(raw, prior, n, k=SHRINK_K):
    """Laplace-style shrinkage of a fraction toward the population prior,
    weighted down as the pixel count backing it grows. A hold with only a
    handful of interior pixels gets pulled toward "typical"; a hold with a
    large interior is barely moved."""
    return (raw * n + prior * k) / (n + k)


# ════════════════════════════════ overlay / contact sheet ════════════════════

def wrap_text(text, max_chars):
    words = text.split()
    lines, cur = [], ""
    for w in words:
        trial = (cur + " " + w).strip()
        if len(trial) > max_chars and cur:
            lines.append(cur)
            cur = w
        else:
            cur = trial
    if cur:
        lines.append(cur)
    return lines


def make_panel(img, entry, rank):
    iw_img = img.shape[1]
    ih_img = img.shape[0]
    x0, y0, x1, y1 = entry["bbox_local_full"]
    # pad generously for context beyond the tight scoring bbox
    pad = max(40, int(0.9 * 0.25 * (entry["w_px"] + entry["h_px"])))
    cx0, cy0 = max(0, x0 - pad), max(0, y0 - pad)
    cx1, cy1 = min(iw_img, x1 + pad), min(ih_img, y1 + pad)
    crop = img[cy0:cy1, cx0:cx1].copy()
    ch, cw = crop.shape[:2]
    if ch == 0 or cw == 0:
        crop = np.zeros((10, 10, 3), np.uint8)
        ch, cw = 10, 10

    scale = min(PANEL_IMG / cw, PANEL_IMG / ch)
    new_w, new_h = max(1, int(cw * scale)), max(1, int(ch * scale))
    resized = cv2.resize(crop, (new_w, new_h), interpolation=cv2.INTER_LINEAR)

    canvas_img = np.full((PANEL_IMG, PANEL_IMG, 3), 235, np.uint8)
    ox, oy = (PANEL_IMG - new_w) // 2, (PANEL_IMG - new_h) // 2
    canvas_img[oy:oy + new_h, ox:ox + new_w] = resized

    poly_px = entry["poly_px_full"]
    pts = ((poly_px - [cx0, cy0]) * scale + [ox, oy]).astype(np.int32)
    cv2.polylines(canvas_img, [pts], True, (0, 0, 255), 2, cv2.LINE_AA)

    panel = np.full((PANEL_IMG + PANEL_TEXT_H, PANEL_IMG, 3), 255, np.uint8)
    panel[:PANEL_IMG, :, :] = canvas_img

    header = f"#{rank}  {entry['id']}  fit={entry['fit_score']:.2f}"
    cv2.putText(panel, header, (6, PANEL_IMG + 20), FONT, FONT_SCALE, (0, 0, 0), FONT_THICK, cv2.LINE_AA)
    for i, line in enumerate(wrap_text(entry["reason"], 38)[:2]):
        cv2.putText(panel, line, (6, PANEL_IMG + 42 + i * 20), FONT, 0.5, (60, 60, 60), 2, cv2.LINE_AA)
    return panel


def build_contact_sheet(img, top_entries, out_path):
    panels = [make_panel(img, e, i + 1) for i, e in enumerate(top_entries)]
    if not panels:
        return
    ph, pw = panels[0].shape[:2]
    n = len(panels)
    cols = GRID_COLS
    rows = int(np.ceil(n / cols))
    header_h = 46
    sheet = np.full((header_h + rows * (ph + PANEL_PAD) + PANEL_PAD,
                      cols * (pw + PANEL_PAD) + PANEL_PAD, 3), 255, np.uint8)
    cv2.putText(sheet, f"outline fit review - top {n} worst (score_outline_fit.py)",
                (PANEL_PAD, 32), FONT, 0.8, (0, 0, 0), 2, cv2.LINE_AA)
    for i, panel in enumerate(panels):
        r, c = divmod(i, cols)
        y = header_h + PANEL_PAD + r * (ph + PANEL_PAD)
        x = PANEL_PAD + c * (pw + PANEL_PAD)
        sheet[y:y + ph, x:x + pw] = panel
    cv2.imwrite(str(out_path), sheet, [cv2.IMWRITE_JPEG_QUALITY, 92])


# ════════════════════════════════ main ════════════════════════════════════════

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--board", help="board slug or uuid; read-only GET of holds_<boardId>")
    ap.add_argument("--holds-file", help="local holds JSON instead of --board (also read-only)")
    ap.add_argument("--image", required=True, help="board photo (read-only, never modified)")
    ap.add_argument("--output", required=True, help="ranked JSON output path")
    ap.add_argument("--overlay", required=True, help="review contact-sheet JPEG output path")
    ap.add_argument("--top", type=int, default=15)
    ap.add_argument("--board-region", default="1.0,0.5,98.0,97.0")
    args = ap.parse_args()

    if not args.board and not args.holds_file:
        sys.exit("Provide --board <slug|uuid> or --holds-file PATH.")

    L, T, W, H = [float(v) for v in args.board_region.split(",")]
    br = {"left": L, "top": T, "width": W, "height": H}

    holds, label = load_holds(args)
    print(f"Holds source: {label}")

    img = cv2.imread(args.image)
    if img is None:
        sys.exit(f"cannot read {args.image}")
    ih, iw = img.shape[:2]
    print(f"Image: {args.image}  {iw}x{ih}")

    # ── plywood model ──────────────────────────────────────────────────────
    hold_mask = all_holds_mask(holds, br, iw, ih)
    half_extent = median_hold_halfextent_px(holds, br, iw, ih)
    dilate_px = max(12, int(round(0.5 * half_extent)))
    bx0, by0, bx1, by1 = board_bbox_px(br, iw, ih)
    region_mask = np.zeros((ih, iw), bool)
    region_mask[by0:by1, bx0:bx1] = True
    dilated_holds = dilate_mask(hold_mask, dilate_px)
    candidate_mask = region_mask & (~dilated_holds)
    print(f"Plywood sampling: median hold half-extent {half_extent:.1f}px, "
          f"buffer {dilate_px}px, {int(candidate_mask.sum())} candidate px "
          f"({100 * candidate_mask.sum() / max(1, region_mask.sum()):.1f}% of board bbox)")

    ply_stats, plywood_score, is_plywood, grad_mag, dist_map = build_plywood_model(img, candidate_mask)
    print(f"Plywood model: LAB median L={ply_stats['L_mean']:.1f} a={ply_stats['A_mean']:.1f} "
          f"b={ply_stats['B_mean']:.1f}  texture_energy median={ply_stats['E_mean']:.2f}  "
          f"threshold(p{PLYWOOD_PERCENTILE:g})={ply_stats['threshold']:.2f}  n={ply_stats['n_samples']}")

    grad_in_region = grad_mag[by0:by1, bx0:bx1]
    global_grad_ref = float(np.percentile(grad_in_region, GRAD_REF_PERCENTILE))
    print(f"Global gradient reference (p{GRAD_REF_PERCENTILE:g} of board bbox): {global_grad_ref:.1f}")

    # ── pass 1: raw metrics ────────────────────────────────────────────────
    raw = {}
    no_polygon = []
    for h in holds:
        r = score_hold_raw(h, br, iw, ih, dist_map, ply_stats["threshold"],
                            hold_mask, grad_mag, global_grad_ref)
        if r is None:
            no_polygon.append(h.get("id"))
            continue
        raw[h["id"]] = r
    if no_polygon:
        print(f"Skipped (no usable polygon): {len(no_polygon)} -> {no_polygon}")

    prior_emptiness = float(np.mean([r["emptiness_raw"] for r in raw.values()]))
    prior_spill = float(np.mean([r["spill_raw"] for r in raw.values()]))
    prior_leakage = float(np.mean([r["leakage_raw"] for r in raw.values()]))
    print(f"Population priors: emptiness={prior_emptiness:.3f} spill={prior_spill:.3f} "
          f"leakage={prior_leakage:.3f}  (shrink k={SHRINK_K})")
    n_local = sum(1 for r in raw.values() if r["used_local_threshold"])
    print(f"Locally-adaptive plywood threshold used for {n_local}/{len(raw)} holds "
          f"(rest fell back to the global cut — crowded neighbours or board edge)")

    # ── pass 2: shrink + combine ───────────────────────────────────────────
    by_id = {h["id"]: h for h in holds}
    results = []
    for hid, r in raw.items():
        h = by_id[hid]
        emptiness = shrink(r["emptiness_raw"], prior_emptiness, r["n_core"])
        spill = shrink(r["spill_raw"], prior_spill, r["n_band"])
        leakage = shrink(r["leakage_raw"], prior_leakage, r["n_ring"])
        edge = r["edge_alignment"]
        edge_gate = 1.0 - EDGE_GATE_STRENGTH * edge

        contributions = {
            "emptiness": FIT_WEIGHTS["emptiness"] * emptiness * edge_gate,
            "spill": FIT_WEIGHTS["spill"] * spill * edge_gate,
            "leakage": FIT_WEIGHTS["leakage"] * leakage,
            "edge": FIT_WEIGHTS["edge"] * (1 - edge),
        }
        fit_score = float(min(1.0, max(0.0, sum(contributions.values()))))
        top_factor = max(contributions, key=contributions.get)
        reason = REASONS[top_factor]

        poly_px_full = poly_pct_to_px(h["polygon"], br, iw, ih)
        x0l, y0l, x1l, y1l = r["bbox_local"]

        results.append({
            "id": hid,
            "fit_score": round(fit_score, 4),
            "reason": reason,
            "reason_key": top_factor,
            "emptiness": round(emptiness, 4), "emptiness_raw": round(r["emptiness_raw"], 4),
            "spill": round(spill, 4), "spill_raw": round(r["spill_raw"], 4),
            "leakage": round(leakage, 4), "leakage_raw": round(r["leakage_raw"], 4),
            "edge_alignment": round(edge, 4),
            "w_pct": h.get("w_pct"), "h_pct": h.get("h_pct"),
            "area_pct2": round(r["area_pct2"], 4),
            "n_interior_px": r["n_interior"],
            "used_local_threshold": r["used_local_threshold"],
            "_poly_px_full": poly_px_full, "_bbox_local_full": (x0l, y0l, x1l, y1l),
            "_w_px": r["w_px"], "_h_px": r["h_px"],
        })

    results.sort(key=lambda e: e["fit_score"], reverse=True)
    for i, e in enumerate(results):
        e["rank"] = i + 1

    # ── write ranked.json (drop the internal _-prefixed geometry helpers) ──
    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    clean = [{k: v for k, v in e.items() if not k.startswith("_")} for e in results]
    out_path.write_text(json.dumps({
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": label, "image": args.image, "boardRegion": br,
        "weights": FIT_WEIGHTS, "edge_gate_strength": EDGE_GATE_STRENGTH, "shrink_k": SHRINK_K,
        "plywood_model": {k: v for k, v in ply_stats.items()},
        "global_grad_ref": global_grad_ref,
        "n_holds_scored": len(clean), "n_no_polygon": len(no_polygon), "no_polygon_ids": no_polygon,
        "holds": clean,
    }, indent=2))
    print(f"wrote {out_path}  ({len(clean)} holds scored)")

    # ── overlay contact sheet ───────────────────────────────────────────────
    top_n = results[:args.top]
    for e in top_n:
        e["poly_px_full"] = e["_poly_px_full"]
        e["bbox_local_full"] = e["_bbox_local_full"]
        e["w_px"] = e["_w_px"]
        e["h_px"] = e["_h_px"]
    overlay_path = Path(args.overlay)
    overlay_path.parent.mkdir(parents=True, exist_ok=True)
    build_contact_sheet(img, top_n, overlay_path)
    print(f"wrote {overlay_path}  (top {len(top_n)})")

    # ── console summary ─────────────────────────────────────────────────────
    print(f"\nTop {len(top_n)} worst-fitting outlines:")
    for e in top_n:
        print(f"  #{e['rank']:<3} {e['id']:<24} fit={e['fit_score']:.3f}  "
              f"(empty={e['emptiness']:.2f} spill={e['spill']:.2f} leak={e['leakage']:.2f} "
              f"edge={e['edge_alignment']:.2f})  {e['reason']}")

    # correlation check: is this ranking just "the smallest holds"?
    areas = np.array([e["area_pct2"] for e in results])
    scores = np.array([e["fit_score"] for e in results])
    if len(areas) > 2 and areas.std() > 0 and scores.std() > 0:
        corr = float(np.corrcoef(areas, scores)[0, 1])
    else:
        corr = float("nan")
    smallest_ids = set(e["id"] for e in sorted(results, key=lambda e: e["area_pct2"])[:args.top])
    top_ids = set(e["id"] for e in top_n)
    overlap = len(smallest_ids & top_ids)
    print(f"\nSize-bias check: corr(fit_score, area_pct2) = {corr:.3f}  "
          f"(0 = no size relationship); overlap between top-{args.top}-worst and "
          f"top-{args.top}-smallest = {overlap}/{args.top}")

    return results, ply_stats, corr, overlap


if __name__ == "__main__":
    main()
