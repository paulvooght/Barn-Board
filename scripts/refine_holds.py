#!/usr/bin/env python3
"""
refine_holds.py — refinement pass over detect_holds_v2's candidate masks.

detect_holds_v2 (FastSAM object-first) gives good recall on dense spray walls
but the OWNER flagged four systematic failures on the Yonder wall:

  F1  MISSED FOOT HOLDS  — small screw-on foot chips in the LOWER (bare) board are
                           deleted by min-area / bolt-grid filters.
  F2  UNDER-SPLIT        — two clearly-different touching holds outlined as ONE mask
                           (different colour and/or a concave waist and/or depth valley).
  F3  SHATTERED-GLASS    — a glossy highlight punched a hole in the mask, so the contour
                           cut straight across in jagged facets.
  F4  DUPLICATE OUTLINES — one physical hold wearing two overlapping masks.

This pass operates on the REAL binary masks (re-exposed from detect_holds_v2 via
get_candidate_masks), not the simplified polygons, and uses a CACHED monocular
depth map (/tmp/_depth_d.npy; LARGER = NEARER) as a flatness gate, a valley signal
for splitting, and a protrusion cue for foot-chip recovery.

RECALL-FIRST / CONSERVATISM is law: it is far worse to DELETE or OVER-MERGE a real
hold than to leave a minor artifact for the human/tap stage. We only drop a
candidate when MULTIPLE cues agree it is not a hold, and only merge/split when
colour AND geometry AND depth all agree.

Pipeline
--------
1. PER-MASK CLEANUP        — fill interior holes (specular/chalk dropouts), light close.
2. SHAPE REGULARIZATION    — smooth contour, trim acute "shard" spikes (fixes F3).
3. COLOUR-AWARE DEDUP/MERGE— merge two masks that overlap a lot OR are adjacent with
                             near-identical Lab colour and no plywood/depth valley
                             between them (fixes F4). Conservative.
4. DEPTH FLATNESS-GATE     — DROP a candidate ONLY if depth-flat AND colour-weak AND
                             small (confidently chalk/reflection/shadow/print).
5. FOOT-CHIP RECOVERY (F1) — find protruding small blobs in depth not already covered,
                             with plausible plastic colour/size; add as new holds.
6. SPLIT ARBITER (F2)      — split a mask that is really 2+ holds, requiring agreement
                             of bimodal Lab colour with a spatial seam AND (depth valley
                             OR concavity waist). Conservative.
7. EXPORT                  — recompute board-% polygons + post-hoc colour labels, final
                             conservative dedup, write refined JSON (schema identical to
                             detect_holds_v2) + full-board overlay.

Output schema is IDENTICAL to detect_holds_v2 so scripts/merge_holds.py works unchanged.

Usage
-----
  /tmp/holds_venv/bin/python scripts/refine_holds.py \\
      --image board-assets/yonder/Yonder_Set_01_V1.jpg \\
      --depth /tmp/_depth_d.npy \\
      --output /tmp/holds_refined.json \\
      --overlay board-assets/yonder/_refine_overlay.jpg

  # Fast iteration: reuse the pickled candidate masks (no FastSAM re-run):
  #   /tmp/holds_venv/bin/python board-assets/yonder/_cache_masks.py   (once)
  #   ... then refine_holds.py --masks-cache /tmp/_cand_masks.pkl
"""

import argparse
import json
import math
import os
import pickle
import sys
from datetime import date
from pathlib import Path

try:
    import cv2
    import numpy as np
except ImportError as e:  # pragma: no cover
    print(f"Error: missing dependency — {e}")
    sys.exit(1)

# Make detect_holds_v2 importable (same scripts/ dir) and reuse its helpers.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import detect_holds_v2 as d2  # noqa: E402


# ─── Tunables (recall-first; conservative) ──────────────────────────────────────

# Depth: noise floor from _depth_proto.py (plywood control |relief| 90th pct ≈ 0.045).
DEPTH_NOISE_FLOOR = 0.045

# Stage 4 — flatness gate (DROP only if ALL agree):
GATE_RELIEF_MAX = 0.030      # interior-vs-ring depth below this = flat
GATE_CHROMA_MAX = 6.0        # plywood-distance below this = colour-weak (near plywood/chalk)
GATE_AREA_MAX_FRAC = 0.0012  # only consider dropping SMALL masks (frac of board area)

# Stage 3 — merge (MERGE only if conditions agree):
MERGE_IOU = 0.45             # heavy overlap → almost certainly duplicate outline
MERGE_CONTAIN = 0.80         # one mask ≥80% inside another → duplicate
MERGE_ADJ_LAB = 9.0          # adjacent + Lab colour within this → same hold split in two
MERGE_ADJ_GAP_PX = 4         # masks within this gap count as "adjacent"

# Stage 5 — foot-chip recovery:
FOOT_REGION_TOP_FRAC = 0.58  # only hunt below this board fraction (the bare lower board)
FOOT_RELIEF_MIN = 0.060      # protrusion well above noise floor (real raised object)
FOOT_MIN_AREA_FRAC = 0.00012 # min chip area (frac of board area)
FOOT_MAX_AREA_FRAC = 0.0030  # max chip area
FOOT_MIN_CHROMA = 7.0        # OR dark/bright object — coloured chip stands off plywood
FOOT_MIN_SOLIDITY = 0.55

# Stage 6 — split arbiter (SPLIT only if colour AND geometry/depth agree):
SPLIT_MIN_AREA_FRAC = 0.0016 # only consider splitting reasonably large masks
SPLIT_LAB_DIST = 30.0        # two colour clusters this far apart in Lab (strong)
SPLIT_BALANCE_MIN = 0.30     # symmetric case: both clusters this frac of the larger
SPLIT_VALLEY_DROP = 0.040    # depth valley along the seam at least this deep
SPLIT_SOLIDITY_MAX = 0.86    # a real waist drops solidity below this
# Asymmetric case (a small distinct-colour hold sharing a mask with a big one, e.g. a
# small orange lobe on a big blue hold). Allowed ONLY when the colour gap is very strong
# AND the minority forms one solid blob of meaningful absolute area AND there's a waist.
SPLIT_ASYM_LAB_DIST = 48.0
SPLIT_ASYM_BALANCE_MIN = 0.045   # minority ≥ ~4.5% of pixels
SPLIT_ASYM_MIN_AREA_FRAC = 0.0010
SPLIT_ASYM_MINOR_SOLIDFRAC = 0.70  # minority cluster must be one coherent blob

# Shape regularization:
SMOOTH_CLOSE_KSIZE = 5       # morphological close disk for smoothing
SHARD_ANGLE_DEG = 38.0       # vertices sharper than this are shard spikes
SHARD_MIN_SOLIDITY = 0.90    # only de-shard low-ish solidity masks (don't touch clean blobs)
SHARD_MIN_AREA_KEEP = 0.75   # de-sharding must retain ≥75% of the body, else it's skipped

# Final dedup (centroid + area, mirrors _proto_bg.py):
FINAL_DEDUP_DIST_FRAC = 0.012
FINAL_DEDUP_AREA_RATIO = 1.30


# ─── Geometry / depth helpers ───────────────────────────────────────────────────

def fill_mask_holes(mask: np.ndarray) -> np.ndarray:
    """Fill bounded interior holes of EACH component (specular/chalk dropouts),
    skipping any hole that touches the image border (that's the outside)."""
    out = np.zeros_like(mask)
    n, lbl, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    for i in range(1, n):
        comp = np.where(lbl == i, 255, 0).astype(np.uint8)
        inv = cv2.bitwise_not(comp)
        nh, hl, hs, _ = cv2.connectedComponentsWithStats(inv, 8)
        filled = comp.copy()
        for j in range(1, nh):
            x, y, w, h, area = hs[j]
            touches = (x == 0 or y == 0 or
                       x + w == mask.shape[1] or y + h == mask.shape[0])
            if touches:
                continue
            filled[hl == j] = 255  # interior hole → fill it
        out = cv2.bitwise_or(out, filled)
    return out


def largest_contour(mask: np.ndarray):
    cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cnts:
        return None
    return max(cnts, key=cv2.contourArea)


def solidity_of(mask: np.ndarray) -> float:
    cnt = largest_contour(mask)
    if cnt is None:
        return 1.0
    a = cv2.contourArea(cnt)
    hull = cv2.convexHull(cnt)
    ha = cv2.contourArea(hull)
    return float(a / ha) if ha > 0 else 1.0


def mask_centroid(mask: np.ndarray):
    cnt = largest_contour(mask)
    if cnt is None:
        return None
    M = cv2.moments(cnt)
    if M["m00"] == 0:
        return None
    return (M["m10"] / M["m00"], M["m01"] / M["m00"])


def local_relief(mask: np.ndarray, depth_board: np.ndarray, ksize: int = 35):
    """Interior depth minus an immediate surrounding ring (larger = nearer = protruding).
    Returns None if the mask/ring is too small to be meaningful."""
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (ksize, ksize))
    ring = cv2.subtract(cv2.dilate(mask, k), mask)
    if cv2.countNonZero(mask) < 30 or cv2.countNonZero(ring) < 30:
        return None
    return float(np.mean(depth_board[mask > 0]) - np.mean(depth_board[ring > 0]))


def chroma_distance(mask: np.ndarray, lab: np.ndarray, ply_mean, ply_std) -> float:
    """How far the mask's median Lab sits from the plywood cluster (in spread units).
    Low = plywood-like / colour-weak; high = clearly a coloured object."""
    pL, pa, pb = ply_mean
    sL, sa, sb = ply_std
    sel = mask > 0
    if sel.sum() < 10:
        return 0.0
    mL = float(np.median(lab[:, :, 0][sel]))
    ma = float(np.median(lab[:, :, 1][sel]))
    mb = float(np.median(lab[:, :, 2][sel]))
    return math.sqrt(((mL - pL) / sL) ** 2 +
                     ((ma - pa) / sa) ** 2 +
                     ((mb - pb) / sb) ** 2)


# ─── Stage 1+2: per-mask cleanup + shape regularization ─────────────────────────

def regularize_mask(mask: np.ndarray) -> np.ndarray:
    """Fill specular holes, lightly close, and trim shard spikes so a smooth hold
    stops ending in jagged straight facets (F3). Keep edges close to the true hold —
    do NOT balloon past it."""
    m = (mask > 0).astype(np.uint8) * 255

    # 1. Fill interior holes (the specular dropout that punched a hole in the mask).
    m = fill_mask_holes(m)

    # 2. Light morphological close to seal hairline notches the highlight left at the
    #    boundary, then open by the same small kernel so we don't balloon.
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (SMOOTH_CLOSE_KSIZE, SMOOTH_CLOSE_KSIZE))
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, k, iterations=1)
    m = fill_mask_holes(m)

    # 3. Shard trim: if the mask is jaggy (lowish solidity from acute spikes, not a
    #    genuine waist), snap toward its convex-hull-smoothed shape but stay inside a
    #    small dilation of the ORIGINAL so we never grow past the real hold.
    sol = solidity_of(m)
    if sol < SHARD_MIN_SOLIDITY:
        cnt = largest_contour(m)
        if cnt is not None and len(cnt) >= 5:
            # Approx + per-vertex acuteness check: drop very acute (shard) vertices.
            peri = cv2.arcLength(cnt, True)
            approx = cv2.approxPolyDP(cnt, 0.008 * peri, True).reshape(-1, 2)
            if len(approx) >= 5:
                keep = []
                npts = len(approx)
                for i in range(npts):
                    p0 = approx[(i - 1) % npts].astype(np.float32)
                    p1 = approx[i].astype(np.float32)
                    p2 = approx[(i + 1) % npts].astype(np.float32)
                    v1 = p0 - p1
                    v2 = p2 - p1
                    n1 = np.linalg.norm(v1)
                    n2 = np.linalg.norm(v2)
                    if n1 < 1e-3 or n2 < 1e-3:
                        continue
                    cosang = float(np.dot(v1, v2) / (n1 * n2))
                    cosang = max(-1.0, min(1.0, cosang))
                    ang = math.degrees(math.acos(cosang))
                    # spike = very acute interior angle (a thin protruding facet)
                    if ang < SHARD_ANGLE_DEG:
                        continue
                    keep.append(approx[i])
                if len(keep) >= 4:
                    smooth = np.zeros_like(m)
                    cv2.fillPoly(smooth, [np.array(keep, np.int32)], 255)
                    # clip to a small dilation of the filled original (never balloon)
                    guard = cv2.dilate(m, cv2.getStructuringElement(
                        cv2.MORPH_ELLIPSE, (3, 3)), iterations=2)
                    smooth = cv2.bitwise_and(smooth, guard)
                    # area-loss cap: de-sharding must retain ≥75% of the hold body, so a
                    # clean hold can never be shrunk away — only true shards get trimmed.
                    if cv2.countNonZero(smooth) >= SHARD_MIN_AREA_KEEP * cv2.countNonZero(m):
                        m = smooth
    return m


# ─── Stage 6: split arbiter ─────────────────────────────────────────────────────

def try_split(mask: np.ndarray, lab: np.ndarray, depth_board: np.ndarray,
              board_area: int):
    """Return a list of sub-masks if this mask is confidently 2 holds, else [mask].

    Conservative: requires bimodal Lab colour with a spatial seam AND (a depth valley
    along the seam OR a genuine concavity waist). Colour bimodality alone is NOT enough
    (most holds shade/specular into two Lab clusters)."""
    area = cv2.countNonZero(mask)
    if area < board_area * SPLIT_MIN_AREA_FRAC:
        return [mask]

    sel = mask > 0
    ys, xs = np.where(sel)
    ab = np.stack([lab[:, :, 1][sel], lab[:, :, 2][sel],
                   lab[:, :, 0][sel] * 0.5], 1).astype(np.float32)
    if ab.shape[0] < 50:
        return [mask]

    crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 12, 1.0)
    _, labels, centers = cv2.kmeans(ab, 2, None, crit, 4, cv2.KMEANS_PP_CENTERS)
    labels = labels.ravel()
    lab_dist = float(np.linalg.norm(centers[0] - centers[1]))
    c0 = int((labels == 0).sum())
    c1 = int((labels == 1).sum())
    minor = min(c0, c1)
    major = max(c0, c1)
    balance = minor / max(major, 1)

    # CUE A: two colour clusters. SYMMETRIC (both substantial) is the safe common case.
    # ASYMMETRIC (a small but very-distinct lobe on a big hold) is allowed only under a
    # much stronger colour gap + coherence bar, checked after we build the blobs.
    symmetric = lab_dist > SPLIT_LAB_DIST and balance > SPLIT_BALANCE_MIN
    asym_candidate = (lab_dist > SPLIT_ASYM_LAB_DIST and
                      balance > SPLIT_ASYM_BALANCE_MIN and
                      minor > board_area * SPLIT_ASYM_MIN_AREA_FRAC)
    if not (symmetric or asym_candidate):
        return [mask]

    # Build the two pixel groups as masks and check spatial seam (they must be two
    # spatially-separable lobes, not salt-and-pepper).
    g0 = np.zeros_like(mask)
    g1 = np.zeros_like(mask)
    g0[ys[labels == 0], xs[labels == 0]] = 255
    g1[ys[labels == 1], xs[labels == 1]] = 255
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    g0 = cv2.morphologyEx(g0, cv2.MORPH_OPEN, k)
    g1 = cv2.morphologyEx(g1, cv2.MORPH_OPEN, k)

    def biggest_frac(g):
        n, _, st, _ = cv2.connectedComponentsWithStats(g, 8)
        if n <= 1:
            return 0.0
        areas = st[1:, cv2.CC_STAT_AREA]
        return float(areas.max() / max(areas.sum(), 1))

    # identify which group is the minority
    a0 = cv2.countNonZero(g0)
    a1 = cv2.countNonZero(g1)
    minor_g, major_g = (g0, g1) if a0 <= a1 else (g1, g0)
    minor_a = min(a0, a1)

    if symmetric:
        # both lobes substantial and each a single clean blob
        if a0 < area * 0.20 or a1 < area * 0.20:
            return [mask]
        if biggest_frac(g0) < 0.65 or biggest_frac(g1) < 0.65:
            return [mask]
    else:
        # asymmetric: the SMALL lobe must be one coherent blob of real size; the big
        # lobe just needs to dominate. This guards against splitting off specular noise.
        if minor_a < area * SPLIT_ASYM_BALANCE_MIN:
            return [mask]
        if biggest_frac(minor_g) < SPLIT_ASYM_MINOR_SOLIDFRAC:
            return [mask]
        if biggest_frac(major_g) < 0.60:
            return [mask]

    # CUE B: geometry / depth agreement.
    sol = solidity_of(mask)
    has_waist = sol < SPLIT_SOLIDITY_MAX

    # depth valley: along the seam between the two centroids, is there a depth dip?
    cen0 = mask_centroid(g0)
    cen1 = mask_centroid(g1)
    has_valley = False
    if cen0 and cen1:
        x0, y0 = cen0
        x1, y1 = cen1
        npts = 25
        seam_vals = []
        for t in np.linspace(0.30, 0.70, npts):
            xi = int(round(x0 + (x1 - x0) * t))
            yi = int(round(y0 + (y1 - y0) * t))
            if 0 <= yi < depth_board.shape[0] and 0 <= xi < depth_board.shape[1]:
                seam_vals.append(float(depth_board[yi, xi]))
        if seam_vals:
            ends = []
            for (xx, yy) in [(x0, y0), (x1, y1)]:
                xi, yi = int(round(xx)), int(round(yy))
                if 0 <= yi < depth_board.shape[0] and 0 <= xi < depth_board.shape[1]:
                    ends.append(float(depth_board[yi, xi]))
            if ends:
                has_valley = (min(np.mean(ends), max(seam_vals)) - min(seam_vals)) > SPLIT_VALLEY_DROP

    if not (has_waist or has_valley):
        return [mask]

    # All agree → split. Assign every mask pixel to the nearer colour cluster's blob,
    # confined to the mask, so the seam is clean.
    g0b = keep_largest_component(g0)
    g1b = keep_largest_component(g1)
    out = assign_to_seeds(mask, [g0b, g1b])
    out = [o for o in out if cv2.countNonZero(o) >= board_area * 0.00018]
    return out if len(out) >= 2 else [mask]


def keep_largest_component(mask: np.ndarray) -> np.ndarray:
    n, lbl, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    if n <= 1:
        return mask
    idx = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    return np.where(lbl == idx, 255, 0).astype(np.uint8)


def assign_to_seeds(mask: np.ndarray, seeds: list) -> list:
    """Assign every mask pixel to the nearest seed region (within mask), via iterative
    confined dilation. Returns one mask per seed."""
    seed_id = np.zeros(mask.shape, np.int32)
    for i, s in enumerate(seeds, start=1):
        seed_id[s > 0] = i
    seed_id[mask == 0] = 0
    grown = seed_id.copy()
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    for _ in range(40):
        empty = (mask > 0) & (grown == 0)
        if not empty.any():
            break
        lab_f = grown.astype(np.float32)
        pooled = cv2.dilate(lab_f, k)
        frontier = empty & (pooled > 0)
        if not frontier.any():
            break
        grown[frontier] = pooled[frontier].astype(np.int32)
    return [np.where(grown == i, 255, 0).astype(np.uint8) for i in range(1, len(seeds) + 1)]


# ─── Stage 5: foot-chip recovery ────────────────────────────────────────────────

def recover_foot_chips(existing_masks: list, bgr_board: np.ndarray,
                       lab: np.ndarray, depth_board: np.ndarray,
                       ply_mean, ply_std, board_area: int) -> list:
    """Find PROTRUDING small blobs in the lower bare board not already covered by a
    hold, with plausible plastic colour/size. Distinguish protruding chips from flush
    or recessed T-nut holes via depth (chips are NEARER → higher depth than surround)."""
    bh, bw = depth_board.shape[:2]
    covered = np.zeros((bh, bw), np.uint8)
    for m in existing_masks:
        covered = cv2.bitwise_or(covered, m)
    covered_d = cv2.dilate(covered, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))

    # Local relief map across the whole board (interior vs a blurred large neighbourhood).
    big = cv2.GaussianBlur(depth_board, (0, 0), 31)
    relief_map = depth_board - big  # >0 where nearer than surround (protruding)

    # Restrict to the lower bare board, away from existing holds.
    region = np.zeros((bh, bw), np.uint8)
    region[int(bh * FOOT_REGION_TOP_FRAC):, :] = 255
    region = cv2.bitwise_and(region, cv2.bitwise_not(covered_d))

    prot = ((relief_map > FOOT_RELIEF_MIN) & (region > 0)).astype(np.uint8) * 255
    prot = cv2.morphologyEx(prot, cv2.MORPH_OPEN,
                            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))
    prot = cv2.morphologyEx(prot, cv2.MORPH_CLOSE,
                            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))

    new = []
    n, lbl, stats, cent = cv2.connectedComponentsWithStats(prot, 8)
    for i in range(1, n):
        area = stats[i, cv2.CC_STAT_AREA]
        if area < board_area * FOOT_MIN_AREA_FRAC or area > board_area * FOOT_MAX_AREA_FRAC:
            continue
        w = stats[i, cv2.CC_STAT_WIDTH]
        h = stats[i, cv2.CC_STAT_HEIGHT]
        if max(w, h) / max(min(w, h), 1) > 4.0:
            continue
        comp = np.where(lbl == i, 255, 0).astype(np.uint8)
        comp = fill_mask_holes(comp)
        if solidity_of(comp) < FOOT_MIN_SOLIDITY:
            continue
        # Confirm true protrusion with the ring-based relief (rejects flush T-nuts).
        r = local_relief(comp, depth_board, ksize=25)
        if r is None or r < FOOT_RELIEF_MIN:
            continue
        # Plausible plastic object: coloured (chroma) OR clearly dark/bright vs plywood.
        chroma = chroma_distance(comp, lab, ply_mean, ply_std)
        sel = comp > 0
        Lmed = float(np.median(lab[:, :, 0][sel]))
        is_objectish = (chroma > FOOT_MIN_CHROMA or Lmed < 80 or Lmed > 225)
        if not is_objectish:
            continue
        new.append(comp)
    return new


# ─── Stage 3: colour-aware dedup / merge ────────────────────────────────────────

def merge_duplicates(masks: list, lab: np.ndarray, depth_board: np.ndarray,
                     ply_mean, ply_std) -> list:
    """Merge pairs that are (a) heavily overlapping/contained (duplicate outline, F4)
    or (b) adjacent with near-identical Lab colour AND no plywood strip / depth valley
    between them. Conservative union-find."""
    n = len(masks)
    parent = list(range(n))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def unite(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    areas = [cv2.countNonZero(m) for m in masks]
    bboxes = []
    for m in masks:
        cnt = largest_contour(m)
        bboxes.append(cv2.boundingRect(cnt) if cnt is not None else (0, 0, 0, 0))

    def bbox_inter(a, b):
        ax, ay, aw, ah = a
        bx, by, bw_, bh_ = b
        ix = max(ax, bx); iy = max(ay, by)
        ix2 = min(ax + aw, bx + bw_); iy2 = min(ay + ah, by + bh_)
        return max(0, ix2 - ix) * max(0, iy2 - iy)

    def med_lab(m):
        sel = m > 0
        return np.array([np.median(lab[:, :, c][sel]) for c in range(3)], np.float32)

    for i in range(n):
        for j in range(i + 1, n):
            if areas[i] == 0 or areas[j] == 0:
                continue
            # cheap bbox reject (but expand for adjacency test)
            bi = bboxes[i]; bj = bboxes[j]
            bi_e = (bi[0] - MERGE_ADJ_GAP_PX, bi[1] - MERGE_ADJ_GAP_PX,
                    bi[2] + 2 * MERGE_ADJ_GAP_PX, bi[3] + 2 * MERGE_ADJ_GAP_PX)
            if bbox_inter(bi_e, bj) == 0:
                continue
            inter = cv2.countNonZero(cv2.bitwise_and(masks[i], masks[j]))
            union = areas[i] + areas[j] - inter
            iou = inter / union if union else 0
            contain = inter / min(areas[i], areas[j]) if min(areas[i], areas[j]) else 0

            # (a) duplicate outline: heavy overlap / containment
            if iou > MERGE_IOU or contain > MERGE_CONTAIN:
                unite(i, j)
                continue

            # (b) adjacent + near-identical colour + no barrier between
            if inter == 0:
                gap = cv2.bitwise_and(
                    cv2.dilate(masks[i], cv2.getStructuringElement(
                        cv2.MORPH_ELLIPSE, (2 * MERGE_ADJ_GAP_PX + 1,) * 2)),
                    masks[j])
                if cv2.countNonZero(gap) == 0:
                    continue  # not actually touching within gap
            lab_dist = float(np.linalg.norm(med_lab(masks[i]) - med_lab(masks[j])))
            if lab_dist > MERGE_ADJ_LAB:
                continue
            # plywood strip between them? a bare-board gap means two DISTINCT holds that
            # merely share a colour — never merge those (the straight-seam depth check
            # alone misses thin plywood gaps; this samples the gap's colour directly).
            gk = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * MERGE_ADJ_GAP_PX + 3,) * 2)
            between = cv2.subtract(
                cv2.bitwise_and(cv2.dilate(masks[i], gk), cv2.dilate(masks[j], gk)),
                cv2.bitwise_or(masks[i], masks[j]))
            if (cv2.countNonZero(between) >= 8 and
                    chroma_distance(between, lab, ply_mean, ply_std) < GATE_CHROMA_MAX):
                continue
            # barrier check: depth valley between the two centroids?
            ci = mask_centroid(masks[i]); cj = mask_centroid(masks[j])
            barrier = False
            if ci and cj:
                vals = []
                for t in np.linspace(0.35, 0.65, 15):
                    xi = int(round(ci[0] + (cj[0] - ci[0]) * t))
                    yi = int(round(ci[1] + (cj[1] - ci[1]) * t))
                    if 0 <= yi < depth_board.shape[0] and 0 <= xi < depth_board.shape[1]:
                        vals.append(float(depth_board[yi, xi]))
                ends = []
                for c in (ci, cj):
                    xi, yi = int(round(c[0])), int(round(c[1]))
                    if 0 <= yi < depth_board.shape[0] and 0 <= xi < depth_board.shape[1]:
                        ends.append(float(depth_board[yi, xi]))
                if vals and ends:
                    barrier = (np.mean(ends) - min(vals)) > SPLIT_VALLEY_DROP
            if not barrier:
                unite(i, j)  # same colour, touching, no valley → one hold

    # Build merged masks per group
    groups = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)
    out = []
    for members in groups.values():
        if len(members) == 1:
            out.append(masks[members[0]])
        else:
            acc = np.zeros_like(masks[members[0]])
            for mi in members:
                acc = cv2.bitwise_or(acc, masks[mi])
            acc = cv2.morphologyEx(acc, cv2.MORPH_CLOSE,
                                   cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
            acc = fill_mask_holes(acc)
            out.append(acc)
    return out


# ─── Build holds / export ───────────────────────────────────────────────────────

def mask_to_hold(mask: np.ndarray, bgr_board: np.ndarray, bw: int, bh: int):
    cnt = largest_contour(mask)
    if cnt is None:
        return None
    area = int(cv2.countNonZero(mask))
    x, y, w, h = cv2.boundingRect(cnt)
    M = cv2.moments(cnt)
    if M["m00"] == 0:
        return None
    cx = M["m10"] / M["m00"]
    cy = M["m01"] / M["m00"]
    polygon = d2.contour_to_polygon(cnt, bw, bh)
    if len(polygon) < 3:
        return None
    color = d2.classify_colour(bgr_board, mask)
    if area > 5000:
        size = "large"
    elif area > 2000:
        size = "medium"
    else:
        size = "small"
    r_pct = max(round(max(w, h) / 2 / max(bw, bh) * 100, 1), 1.5)
    confidence = "high" if area >= 1500 else "medium"
    return {
        "color": color, "size": size,
        "cx": round(cx / bw * 100, 1), "cy": round(cy / bh * 100, 1),
        "w_pct": round(w / bw * 100, 1), "h_pct": round(h / bh * 100, 1),
        "r": r_pct, "area": area,
        "polygon": polygon,
        "confidence": confidence, "verified": confidence == "high",
        "notes": "",
        "_cx_px": cx, "_cy_px": cy,
    }


def _poly_mask(hold: dict, bw: int, bh: int) -> np.ndarray:
    pts = np.array([[int(round(p[0] / 100 * bw)), int(round(p[1] / 100 * bh))]
                    for p in hold["polygon"]], np.int32)
    m = np.zeros((bh, bw), np.uint8)
    if len(pts) >= 3:
        cv2.fillPoly(m, [pts], 255)
    return m


def final_dedup(holds: list, bw: int, bh: int) -> list:
    """Backstop dedup. Drop a hold ONLY if it is a TRUE duplicate of a larger kept
    hold: SAME colour label AND heavy polygon overlap (IoU>0.5 or ≥80% contained).
    Proximity + area alone is NEVER enough — on a dense wall distinct holds routinely
    sit ~20px apart and are often a different colour, so the old centroid-only rule
    silently deleted real holds. Recall-first: when unsure, keep."""
    holds = sorted(holds, key=lambda h: -h["area"])
    masks = [_poly_mask(h, bw, bh) for h in holds]
    kept, kept_masks = [], []
    for hh, hm in zip(holds, masks):
        ha = int(cv2.countNonZero(hm))
        dup = False
        for k, km in zip(kept, kept_masks):
            if hh["color"] != k["color"]:
                continue  # different colour → not a duplicate
            inter = int(cv2.countNonZero(cv2.bitwise_and(hm, km)))
            if inter == 0:
                continue
            ka = int(cv2.countNonZero(km))
            union = ha + ka - inter
            iou = inter / union if union else 0.0
            contain = inter / ha if ha else 0.0
            if iou > 0.5 or contain > 0.8:
                dup = True
                break
        if not dup:
            kept.append(hh)
            kept_masks.append(hm)
    return kept


# ─── Orchestration ──────────────────────────────────────────────────────────────

def refine(bundle: dict, depth_full: np.ndarray):
    crop = bundle["crop"]
    bl, bt, bw, bh = crop["bl"], crop["bt"], crop["bw"], crop["bh"]
    bgr_board = bundle["bgr_board"]
    lab = bundle["lab_board"]
    ply_mean, ply_std = bundle["ply_mean"], bundle["ply_std"]
    board_area = bw * bh

    depth_board = depth_full[bt:bt + bh, bl:bl + bw]
    if depth_board.shape != (bh, bw):
        depth_board = cv2.resize(depth_full, (bw, bh))[0:bh, 0:bw]

    raw_masks = [c["mask_board"].copy() for c in bundle["candidates"]]
    counts = {"input": len(raw_masks)}

    # Stage 1+2: cleanup + shape regularization
    masks = [regularize_mask(m) for m in raw_masks]

    # Stage 3: colour-aware dedup / merge (F4)
    before_merge = len(masks)
    masks = merge_duplicates(masks, lab, depth_board, ply_mean, ply_std)
    counts["merged_away"] = before_merge - len(masks)

    # Stage 6: split arbiter (F2) — done after merge so merged blobs can be re-split if 2 holds
    split_out = []
    n_split = 0
    for m in masks:
        parts = try_split(m, lab, depth_board, board_area)
        if len(parts) > 1:
            n_split += 1
        split_out.extend(parts)
    masks = split_out
    counts["split_into"] = n_split

    # Stage 4: depth flatness-gate (DROP only if flat AND colour-weak AND small)
    gated = []
    n_dropped = 0
    for m in masks:
        area = cv2.countNonZero(m)
        r = local_relief(m, depth_board)
        chroma = chroma_distance(m, lab, ply_mean, ply_std)
        small = area < board_area * GATE_AREA_MAX_FRAC
        flat = (r is not None and abs(r) < GATE_RELIEF_MAX)
        weak = chroma < GATE_CHROMA_MAX
        if small and flat and weak:
            n_dropped += 1
            continue
        gated.append(m)
    masks = gated
    counts["gate_dropped"] = n_dropped

    # Stage 5: foot-chip recovery (F1)
    chips = recover_foot_chips(masks, bgr_board, lab, depth_board,
                               ply_mean, ply_std, board_area)
    counts["foot_chips_added"] = len(chips)
    masks = masks + chips

    # Build holds + final conservative dedup
    holds = []
    for m in masks:
        h = mask_to_hold(m, bgr_board, bw, bh)
        if h is not None:
            holds.append(h)
    holds = final_dedup(holds, bw, bh)

    # sort top-to-bottom, left-to-right; assign IDs
    holds.sort(key=lambda h: (h["_cy_px"], h["_cx_px"]))
    for i, h in enumerate(holds):
        h["id"] = f"hold_{i + 1}"
        h.pop("_cx_px", None)
        h.pop("_cy_px", None)
    # reorder keys to match detect_holds_v2 exactly
    ordered = []
    for h in holds:
        ordered.append({
            "id": h["id"], "color": h["color"], "size": h["size"],
            "cx": h["cx"], "cy": h["cy"], "w_pct": h["w_pct"], "h_pct": h["h_pct"],
            "r": h["r"], "area": h["area"], "polygon": h["polygon"],
            "confidence": h["confidence"], "verified": h["verified"],
            "notes": h["notes"],
        })
    counts["output"] = len(ordered)
    return ordered, counts


# ─── Overlay ────────────────────────────────────────────────────────────────────

def save_overlay(image_path: str, holds: list, overlay_path: str, board_region: dict):
    data = {"holds": holds}
    d2.save_debug_overlay(image_path, data, overlay_path, board_region)


# ─── Entry ──────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description="Refine detect_holds_v2 candidate masks.")
    ap.add_argument("--image", default="board-assets/yonder/Yonder_Set_01_V1.jpg")
    ap.add_argument("--depth", default="/tmp/_depth_d.npy")
    ap.add_argument("--masks-cache", default="/tmp/_cand_masks.pkl",
                    help="Pickled candidate masks from _cache_masks.py (fast iteration).")
    ap.add_argument("--board-region", default="1,0.5,98,97", dest="board_region")
    ap.add_argument("--output", default="/tmp/holds_refined.json")
    ap.add_argument("--overlay", default="board-assets/yonder/_refine_overlay.jpg")
    ap.add_argument("--no-cache", action="store_true",
                    help="Re-run FastSAM via get_candidate_masks instead of the pickle.")
    args = ap.parse_args()

    root = Path(__file__).resolve().parents[1]

    def resolve(p):
        pp = Path(p)
        if pp.is_absolute():
            return pp
        return (root / p)

    image_path = resolve(args.image)
    parts = [float(x) for x in args.board_region.split(",")]
    board_region = {"left": parts[0], "top": parts[1], "width": parts[2], "height": parts[3]}

    depth_full = np.load(args.depth)

    if args.no_cache or not Path(args.masks_cache).exists():
        print("Running FastSAM front-half (get_candidate_masks)...")
        bundle = d2.get_candidate_masks(str(image_path), board_region)
        # normalise candidate dicts
        bundle["candidates"] = [{"mask_board": c["mask_board"], "area": c["area"],
                                 "cx": c["cx"], "cy": c["cy"], "x": c["x"], "y": c["y"],
                                 "w": c["w"], "h": c["h"]} for c in bundle["candidates"]]
    else:
        print(f"Loading cached candidate masks: {args.masks_cache}")
        bundle = pickle.load(open(args.masks_cache, "rb"))

    holds, counts = refine(bundle, depth_full)

    print("\n=== Refine counts ===")
    for k, v in counts.items():
        print(f"  {k:18s} {v}")

    out = {
        "boardRegion": board_region,
        "imageFile": str(image_path.relative_to(root)) if str(image_path).startswith(str(root)) else str(image_path),
        "detectedAt": date.today().isoformat(),
        "holds": holds,
    }
    outp = resolve(args.output)
    os.makedirs(outp.parent, exist_ok=True)
    outp.write_text(json.dumps(out, indent=2))
    print(f"\nWrote {len(holds)} holds → {outp}")

    save_overlay(str(image_path), holds, str(resolve(args.overlay)), board_region)


if __name__ == "__main__":
    main()
