#!/usr/bin/env python3
"""
guided_reoutline.py — board-generic guided re-outline pass.

Re-derives every hold's polygon from the CURRENT board photo (the photo is the
truth — CLAUDE.md), keeping every ID, and hands back a review list sorted
worst-first so a human checks a handful of holds instead of all of them.

READ-ONLY w.r.t. everything that matters:
  - Fetches live holds via a plain GET (board_settings / boards tables). NEVER
    writes to Supabase. NEVER calls merge_board_holds.mjs --commit.
  - Opens --image with cv2.imread and never writes back to it.
  - Never touches src/, src/data/holds.json, or the published board image.
Its one file output is an --update file for scripts/merge_board_holds.mjs,
which is the only tool allowed to actually mutate live hold data — and even
that still requires a human to run it with --commit.

Builds on board-assets/_proto_reoutline/ (compare_sam_grabcut.py, RESULTS.md):
that bounded prototype found SAM beats GrabCut on visible GrabCut artifacts
(leaks into shadows/neighbours, truncated tips, merges with a touching hold)
but loses on thin/elongated holds (over-rounds them), and that encoding the
board photo ONCE and decoding per hold is ~30x faster than the naive
per-hold SAM.predict() (8s vs 235s @ 204 holds) — see RESULTS.md's timing
section. This script reuses that exact SAM plumbing (setup_sam /
sam_encode_image / sam_prompt) and reproject_holds.py's pct_to_px/px_to_pct,
rather than rediscovering either.

New in this script, beyond the prototype:
  1. NEIGHBOUR-AWARE RESOLUTION. The prototype segmented every hold in
     isolation, so two adjacent holds could claim the same pixels — the
     mechanism behind both dominant failure modes (GrabCut spikes leaking
     into a neighbour; SAM rounding over a touching hold's boundary). Here,
     after generating every hold's GrabCut + SAM candidate, a pixel claimed
     by more than one hold is awarded to whichever hold's PRIOR POLYGON'S
     OWN CENTROID (shoelace, not the stored cx/cy field — see below) is
     nearer, with near-ties (within TIE_EPS_PX) broken by SAM's own
     predicted-IoU confidence for that hold. Each hold's resolved mask is
     then reduced to its largest connected component so a resolution fight
     can't shatter a mask into fragments.
  2. A thin/elongated GATE (prior's min-area-rect aspect ratio >= 3:1) routes
     the hold to GrabCut instead of SAM, per the prototype's own finding
     that box+point SAM over-rounds thin shapes.
  3. CONFIDENCE = AGREEMENT: IoU between the (neighbour-resolved) GrabCut and
     SAM masks for a hold. High IoU -> both methods agree -> low priority for
     human review. Low IoU -> disagreement -> reviewed first.
  4. SANITY GATES against the hold's EXISTING (live) polygon: reject and
     keep the existing polygon if centroid shift, area ratio, or point count
     look physically implausible. A bad auto-outline is worse than the rough
     shape it would have replaced.

Two different "centroid" concepts are used on purpose, matching what the
existing tools in this repo already do:
  - "prior centroid" (neighbour-resolution tie-break) = the shoelace centroid
    of the PRIOR polygon (matches how compare_sam_grabcut.py computes shift
    for its own candidates) — geometrically the true centre of the shape
    being segmented, independent of wherever the stored cx/cy click landed.
  - the hold's stored cx/cy field (sanity-gate shift baseline) = the
    position the rest of the app actually reads today (matches how
    reproject_holds.py computes its own shift-vs-original metric).
  - the NEW polygon's cx/cy (written to --output) = the shoelace centroid of
    the newly chosen polygon — there is no rigid transform back to the old
    click point once the shape has been re-derived from scratch, so, like
    compare_sam_grabcut.py's own GC/SAM outputs, the new centroid IS the new
    shape's true centre.

Usage (The Barn, live holds):
    /tmp/holds_venv/bin/python scripts/guided_reoutline.py \\
        --board the-barn \\
        --image board-assets/the-barn/Barn_Set_01_V8.jpg \\
        --output board-assets/the-barn/_guided_reoutline_updates.json \\
        --review-dir board-assets/the-barn/_guided_reoutline_review \\
        --top 20

Offline (no Supabase read), from a local holds snapshot:
    /tmp/holds_venv/bin/python scripts/guided_reoutline.py \\
        --holds-file board-assets/the-barn/_holds_snapshot_2026-09-09.json \\
        --image board-assets/the-barn/Barn_Set_01_V8.jpg \\
        --output /tmp/updates.json --review-dir /tmp/review

Then, ALWAYS dry-run before ever considering --commit (a human decides that,
separately, later):
    node --env-file=.env.local scripts/merge_board_holds.mjs \\
        --board the-barn --update board-assets/the-barn/_guided_reoutline_updates.json

Requires the detection venv (ultralytics, opencv, torch, Pillow, requests —
see board-assets/_proto_reoutline/RESULTS.md's "Reproducing this"):
    /tmp/holds_venv/bin/python scripts/guided_reoutline.py ...
"""
import argparse
import datetime
import json
import re
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import requests  # only used for the --board (live GET) path; already in the detection venv

REPO_ROOT = Path(__file__).resolve().parent.parent

sys.path.insert(0, str(REPO_ROOT / "scripts"))
from reproject_holds import pct_to_px, px_to_pct  # noqa: E402  (reuse, don't rewrite the maths)

sys.path.insert(0, str(REPO_ROOT / "board-assets" / "_proto_reoutline"))
from compare_sam_grabcut import (  # noqa: E402  (reuse the proven SAM/GrabCut plumbing)
    setup_sam, sam_encode_image, sam_prompt, run_grabcut, polygon_area_centroid,
)

# ─────────────────────────────── tunables (not CLI-exposed; see RESULTS.md) ──
TIE_EPS_PX = 0.75          # neighbour-resolution: distances within this many px count as a tie
LOCAL_PAD_PX = 20          # padding around a hold's polygons when building its local claim canvas
MATERIAL_SHIFT_PCT = 0.5   # "moved materially" reporting threshold: centroid shift (board %)
MATERIAL_AREA_DEV = 0.15   # "moved materially" reporting threshold: |area_ratio - 1|
THIN_ASPECT_GATE = 3.0     # min-area-rect aspect ratio >= this -> route to GrabCut, not SAM
APPROX_EPS_PX = 1.5        # approxPolyDP epsilon — same finishing step as the prototype


# ════════════════════════════════ read-only Supabase loader ══════════════════
# Same GET-only pattern as scripts/publish_board_image.py's resolve_board() —
# this script never writes, so there's no upsert/backup machinery to mirror.

def load_env():
    env = {}
    p = REPO_ROOT / ".env.local"
    if not p.exists():
        return env
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def resolve_board(base_url, headers, board_arg):
    is_uuid = bool(re.match(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-", board_arg, re.I))
    field = "id" if is_uuid else "slug"
    url = f"{base_url}/rest/v1/boards?{field}=eq.{board_arg}&select=id,slug,name"
    r = requests.get(url, headers={**headers, "Accept": "application/json"}, timeout=15)
    if r.status_code != 200:
        sys.exit(f"Error resolving board '{board_arg}': {r.status_code} {r.text}")
    rows = r.json()
    if not rows:
        sys.exit(f"Error: no board with {field}='{board_arg}'.")
    row = rows[0]
    return row["id"], row["slug"], row.get("name")


def fetch_live_holds(base_url, headers, board_id):
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
    """Returns (holds, label) where label is a human string for logging/reports."""
    if args.holds_file:
        d = json.loads(Path(args.holds_file).read_text())
        holds = d["holds"] if isinstance(d, dict) and "holds" in d else d
        if not isinstance(holds, list):
            sys.exit(f"{args.holds_file}: expected a list of holds or {{'holds': [...]}}")
        return holds, f"--holds-file {args.holds_file}"

    env = load_env()
    base_url = env.get("VITE_SUPABASE_URL", "").rstrip("/")
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not base_url or not service_key:
        sys.exit("Missing VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local (read-only GET still needs these).")
    headers = {"apikey": service_key, "Authorization": f"Bearer {service_key}"}
    board_id, board_slug, board_name = resolve_board(base_url, headers, args.board)
    holds, holds_key = fetch_live_holds(base_url, headers, board_id)
    print(f"Board: {board_name or board_slug} ({board_slug})  id={board_id}")
    print(f"Fetched {holds_key}: {len(holds)} holds  (read-only GET)")
    return holds, f"--board {args.board} (live {holds_key})"


# ════════════════════════════════ geometry helpers ═══════════════════════════

def poly_pct_to_px(poly_pct, br, w, h):
    return np.array([pct_to_px(x, y, br, w, h) for x, y in poly_pct], dtype=np.float64)


def poly_px_to_pct(poly_px, br, w, h):
    return [[round(x, 2), round(y, 2)] for x, y in (px_to_pct(x, y, br, w, h) for x, y in poly_px)]


def min_area_rect_aspect(poly_px):
    """max(w,h)/min(w,h) of the polygon's minimum-area bounding rectangle."""
    rect = cv2.minAreaRect(poly_px.astype(np.float32))
    w, h = rect[1]
    lo, hi = min(w, h), max(w, h)
    if lo <= 1e-6:
        return float("inf")
    return hi / lo


def rasterize_local(poly_px, x0, y0, w, h):
    canvas = np.zeros((h, w), np.uint8)
    if poly_px is None or len(poly_px) < 3:
        return canvas.astype(bool)
    pts = np.round(poly_px - [x0, y0]).astype(np.int32)
    cv2.fillPoly(canvas, [pts], 1)
    return canvas.astype(bool)


def largest_component(mask_bool):
    """Keep only the largest connected component, so a resolution fight can't
    shatter one hold's mask into scattered fragments."""
    if not mask_bool.any():
        return mask_bool
    num, labels = cv2.connectedComponents(mask_bool.astype(np.uint8), connectivity=8)
    if num <= 2:  # background(0) + at most one foreground label
        return mask_bool
    counts = np.bincount(labels.ravel())
    counts[0] = 0
    return labels == int(counts.argmax())


def mask_to_polygon_px(mask_bool, offset):
    if not mask_bool.any():
        return None
    m = (mask_bool.astype(np.uint8)) * 255
    contours, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    c = max(contours, key=cv2.contourArea)
    approx = cv2.approxPolyDP(c, APPROX_EPS_PX, True).reshape(-1, 2).astype(np.float64)
    if len(approx) < 3:
        return None
    return approx + np.array(offset, dtype=np.float64)


def mask_iou(a, b):
    if a is None or b is None:
        return 0.0
    inter = np.logical_and(a, b).sum()
    union = np.logical_or(a, b).sum()
    return float(inter / union) if union > 0 else 0.0


def local_bbox(polys_px, iw, ih, pad=LOCAL_PAD_PX):
    pts = np.concatenate([p for p in polys_px if p is not None and len(p) > 0], axis=0)
    x0, y0 = pts[:, 0].min(), pts[:, 1].min()
    x1, y1 = pts[:, 0].max(), pts[:, 1].max()
    return (max(0, int(np.floor(x0 - pad))), max(0, int(np.floor(y0 - pad))),
            min(iw, int(np.ceil(x1 + pad))), min(ih, int(np.ceil(y1 + pad))))


# ════════════════════════════════ pipeline stages ═════════════════════════════

def pick_sam_polygon(proposals, scores):
    """Prefer the highest-scored proposal, but fall back to the next-best
    scored proposal that actually produced a contour (rare edge case where
    the top-scored mask has no external contour). The reported confidence is
    always the model's own top predicted-IoU score, regardless of which
    proposal's contour ends up usable, since it's used as a tie-break scalar
    for THIS HOLD in neighbour resolution, not as a shape descriptor."""
    order = np.argsort(scores)[::-1]
    confidence = float(scores[order[0]])
    for idx in order:
        if proposals[idx] is not None and len(proposals[idx]) >= 3:
            return proposals[idx], confidence
    return None, confidence


def phase_a_candidates(holds, img, predictor, im_tensor, br, iw, ih, limit=None):
    """Per hold: GrabCut + SAM candidates, rasterized to a local canvas."""
    records = []
    gc_times, sam_times = [], []
    n = len(holds) if limit is None else min(limit, len(holds))
    t_start = time.perf_counter()
    for i in range(n):
        hold = holds[i]
        rec = {"id": hold.get("id"), "hold": hold, "error": None}
        try:
            poly_pct = hold.get("polygon")
            if not poly_pct or len(poly_pct) < 3:
                rec["error"] = "hold has no usable prior polygon (<3 points) — skipped"
                records.append(rec)
                continue
            prior_poly_px = poly_pct_to_px(poly_pct, br, iw, ih)
            prior_area_px, (pcx_px, pcy_px) = polygon_area_centroid(prior_poly_px)
            box_px = [float(prior_poly_px[:, 0].min()), float(prior_poly_px[:, 1].min()),
                      float(prior_poly_px[:, 0].max()), float(prior_poly_px[:, 1].max())]
            point_px = list(pct_to_px(hold["cx"], hold["cy"], br, iw, ih))

            gc_poly_px, dt_gc = run_grabcut(img, prior_poly_px)
            gc_times.append(dt_gc)

            proposals, scores, dt_sam = sam_prompt(predictor, im_tensor, img, box_px, point_px)
            sam_times.append(dt_sam)
            sam_poly_px, sam_confidence = pick_sam_polygon(proposals, scores)

            x0, y0, x1, y1 = local_bbox([prior_poly_px, gc_poly_px, sam_poly_px], iw, ih)
            gc_local = rasterize_local(gc_poly_px, x0, y0, x1 - x0, y1 - y0)
            sam_local = rasterize_local(sam_poly_px, x0, y0, x1 - x0, y1 - y0)

            rec.update({
                "prior_poly_px": prior_poly_px, "prior_centroid_px": (pcx_px, pcy_px),
                "aspect": min_area_rect_aspect(prior_poly_px),
                "gc_poly_px": gc_poly_px, "sam_poly_px": sam_poly_px,
                "sam_confidence": sam_confidence, "dt_gc": dt_gc, "dt_sam": dt_sam,
                "bbox": (x0, y0, x1, y1), "gc_local": gc_local, "sam_local": sam_local,
            })
        except Exception as e:  # one bad hold must never sink a 200+ hold batch
            rec["error"] = f"exception during candidate generation: {e!r}"
        records.append(rec)
        if (i + 1) % 25 == 0 or (i + 1) == n:
            print(f"  ... {i + 1}/{n} holds processed ({time.perf_counter() - t_start:.1f}s elapsed)")
    return records, gc_times, sam_times


def phase_b_neighbour_resolution(records, iw, ih):
    """Global nearest-prior-centroid pixel ownership across every hold's
    claimed region (union of its GrabCut + SAM candidate). Ties (within
    TIE_EPS_PX) go to the higher SAM confidence. Returns the owner map plus
    a per-hold 'affected' flag."""
    owner = np.full((ih, iw), -1, dtype=np.int32)
    best_dist = np.full((ih, iw), np.inf, dtype=np.float32)
    owner_conf = np.full((ih, iw), -np.inf, dtype=np.float32)

    for i, rec in enumerate(records):
        if rec.get("error"):
            continue
        x0, y0, x1, y1 = rec["bbox"]
        claim_local = rec["gc_local"] | rec["sam_local"]
        if not claim_local.any():
            continue
        pcx, pcy = rec["prior_centroid_px"]
        ys, xs = np.mgrid[y0:y1, x0:x1]
        dist_local = np.hypot(xs - pcx, ys - pcy).astype(np.float32)
        conf_i = np.float32(rec["sam_confidence"] if rec["sam_confidence"] is not None else -1.0)

        region_owner = owner[y0:y1, x0:x1]
        region_best = best_dist[y0:y1, x0:x1]
        region_conf = owner_conf[y0:y1, x0:x1]

        cy_idx, cx_idx = np.where(claim_local)
        d = dist_local[cy_idx, cx_idx]
        cur_best = region_best[cy_idx, cx_idx]
        cur_conf = region_conf[cy_idx, cx_idx]

        better = d < (cur_best - TIE_EPS_PX)
        tie = np.abs(d - cur_best) <= TIE_EPS_PX
        tie_win = tie & (conf_i > cur_conf)
        take = better | tie_win

        ty, tx = cy_idx[take], cx_idx[take]
        region_owner[ty, tx] = i
        region_best[ty, tx] = d[take]
        region_conf[ty, tx] = conf_i

    return owner


def phase_c_resolve_and_choose(records, owner, iw, ih):
    """Per hold: clip candidates to what survived neighbour resolution, keep
    the largest connected component, compute IoU-agreement, then pick GrabCut
    or SAM per the thin/elongated aspect gate (with graceful fallback if the
    preferred method's mask didn't survive)."""
    n_affected = 0
    for i, rec in enumerate(records):
        if rec.get("error"):
            continue
        x0, y0, x1, y1 = rec["bbox"]
        owner_region = owner[y0:y1, x0:x1] == i

        gc_raw, sam_raw = rec["gc_local"], rec["sam_local"]
        gc_resolved = largest_component(gc_raw & owner_region)
        sam_resolved = largest_component(sam_raw & owner_region)

        if not np.array_equal(gc_resolved, gc_raw) or not np.array_equal(sam_resolved, sam_raw):
            n_affected += 1
            rec["neighbour_affected"] = True
        else:
            rec["neighbour_affected"] = False

        rec["iou"] = mask_iou(gc_resolved if gc_resolved.any() else None,
                               sam_resolved if sam_resolved.any() else None)

        gc_poly = mask_to_polygon_px(gc_resolved, (x0, y0))
        sam_poly = mask_to_polygon_px(sam_resolved, (x0, y0))
        rec["gc_resolved_poly_px"] = gc_poly
        rec["sam_resolved_poly_px"] = sam_poly

        prefer_gc = rec["aspect"] >= THIN_ASPECT_GATE
        if prefer_gc:
            if gc_poly is not None:
                rec["chosen_poly_px"], rec["chosen_method"] = gc_poly, "grabcut"
                rec["rule"] = f"thin/elongated prior (aspect={rec['aspect']:.2f} >= {THIN_ASPECT_GATE}) -> GrabCut"
            elif sam_poly is not None:
                rec["chosen_poly_px"], rec["chosen_method"] = sam_poly, "sam"
                rec["rule"] = f"thin/elongated prior wanted GrabCut but it produced no mask -> fell back to SAM"
            else:
                rec["chosen_poly_px"], rec["chosen_method"] = None, None
                rec["rule"] = "thin/elongated prior; NEITHER method produced a usable mask"
        else:
            if sam_poly is not None:
                rec["chosen_poly_px"], rec["chosen_method"] = sam_poly, "sam"
                rec["rule"] = f"default (aspect={rec['aspect']:.2f} < {THIN_ASPECT_GATE}) -> SAM"
            elif gc_poly is not None:
                rec["chosen_poly_px"], rec["chosen_method"] = gc_poly, "grabcut"
                rec["rule"] = "default wanted SAM but it produced no mask -> fell back to GrabCut"
            else:
                rec["chosen_poly_px"], rec["chosen_method"] = None, None
                rec["rule"] = "NEITHER method produced a usable mask"
    return n_affected


def phase_d_sanity_gate(records, br, iw, ih, max_shift, min_area_ratio, max_area_ratio):
    for rec in records:
        if rec.get("error"):
            rec["gate"] = {"accepted": False, "reason": rec["error"]}
            continue
        hold = rec["hold"]
        # polygon_area_centroid returns numpy scalars (area as np.float64) — cast to
        # native Python floats immediately, otherwise a later `numpy_float >= python_float`
        # comparison yields np.bool_, which json.dumps cannot serialize.
        existing_area_pct, _ = polygon_area_centroid(hold["polygon"])
        existing_area_pct = float(existing_area_pct)
        chosen_px = rec.get("chosen_poly_px")
        if chosen_px is None:
            rec["gate"] = {"accepted": False, "reason": rec.get("rule", "no candidate polygon")}
            continue

        new_poly_pct = poly_px_to_pct(chosen_px, br, iw, ih)
        new_area_pct, (new_cx, new_cy) = polygon_area_centroid(new_poly_pct)
        new_area_pct = float(new_area_pct)
        shift = float(np.hypot(new_cx - hold["cx"], new_cy - hold["cy"]))
        area_ratio = (new_area_pct / existing_area_pct) if existing_area_pct > 0 else None
        n_points = len(new_poly_pct)

        reasons = []
        if n_points < 5:
            reasons.append(f"only {n_points} points after simplification (< 5)")
        if shift > max_shift:
            reasons.append(f"centroid shift {shift:.2f} board% > --max-shift {max_shift}")
        if area_ratio is None or area_ratio < min_area_ratio or area_ratio > max_area_ratio:
            reasons.append(f"area ratio {area_ratio} outside [{min_area_ratio}, {max_area_ratio}]")

        xs = [p[0] for p in new_poly_pct]
        ys = [p[1] for p in new_poly_pct]
        rec["new_poly_pct"] = new_poly_pct
        rec["new_cx"], rec["new_cy"] = round(new_cx, 2), round(new_cy, 2)
        rec["new_w_pct"], rec["new_h_pct"] = round(max(xs) - min(xs), 2), round(max(ys) - min(ys), 2)
        rec["centroid_shift_pct"] = round(shift, 3)
        rec["area_ratio"] = round(float(area_ratio), 3) if area_ratio is not None else None
        rec["material"] = bool((shift >= MATERIAL_SHIFT_PCT) or (area_ratio is not None and abs(area_ratio - 1) >= MATERIAL_AREA_DEV))
        rec["gate"] = {"accepted": bool(len(reasons) == 0), "reason": "; ".join(reasons) if reasons else "pass"}


# ════════════════════════════════ review artifacts ═══════════════════════════

COLOR_GC = (255, 0, 255)     # magenta (BGR) — matches compare_sam_grabcut.py's convention
COLOR_SAM = (0, 255, 0)      # green — matches compare_sam_grabcut.py's convention
COLOR_EXISTING = (255, 255, 255)  # white, thin — today's live outline for reference


def render_review_panel(img, rank, rec, iw, ih, panel_px=340):
    hold_id = rec["id"]
    existing_px = rec.get("prior_poly_px")
    gc_px = rec.get("gc_resolved_poly_px")
    sam_px = rec.get("sam_resolved_poly_px")
    chosen_px = rec.get("chosen_poly_px")

    polys = [p for p in [existing_px, gc_px, sam_px, chosen_px] if p is not None]
    if not polys:
        crop = np.zeros((panel_px, panel_px, 3), np.uint8)
        cv2.putText(crop, "NO CANDIDATE", (6, panel_px // 2), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 1, cv2.LINE_AA)
        origin, scale = np.array([0, 0]), 1.0
    else:
        allpts = np.concatenate(polys, axis=0)
        x0, y0 = allpts[:, 0].min(), allpts[:, 1].min()
        x1, y1 = allpts[:, 0].max(), allpts[:, 1].max()
        pad = max(20, 0.3 * max(x1 - x0, y1 - y0))
        cx0, cy0 = max(0, int(x0 - pad)), max(0, int(y0 - pad))
        cx1, cy1 = min(iw, int(x1 + pad)), min(ih, int(y1 + pad))
        raw_crop = img[cy0:cy1, cx0:cx1].copy()
        origin = np.array([cx0, cy0])

        # letterbox the crop into a FIXED panel_px square (preserving aspect
        # ratio) so every hold's panel comes out the same size — required for
        # the grid contact sheet, since crops naturally vary in aspect ratio.
        rh, rw = raw_crop.shape[:2]
        scale = panel_px / max(rh, rw, 1)
        new_w, new_h = max(1, int(round(rw * scale))), max(1, int(round(rh * scale)))
        resized = cv2.resize(raw_crop, (new_w, new_h), interpolation=cv2.INTER_CUBIC)

        # rescale + draw polygons (full-image px) into the resized crop's own
        # coordinate space BEFORE pasting onto the fixed canvas, so strokes
        # only need the scale factor, not a paste offset.
        def stroke_scaled(poly, color, thickness):
            if poly is None:
                return
            pts = np.round((poly - origin) * scale).astype(np.int32)
            cv2.polylines(resized, [pts], True, color, thickness, cv2.LINE_AA)

        # Draw order matters: existing (background reference) first, then an
        # oversized BLACK glow under whichever polygon was chosen, then BOTH
        # raw candidates in their own colours on top. When the chosen shape
        # coincides with one candidate (the usual case), the glow peeks out
        # around that candidate's own-coloured line instead of the winner
        # visually erasing its own colour — so every panel still shows all
        # three signals (existing / GrabCut / SAM), plus which one won.
        stroke_scaled(existing_px, COLOR_EXISTING, 1)
        stroke_scaled(chosen_px, (0, 0, 0), 7)
        stroke_scaled(gc_px, COLOR_GC, 2)
        stroke_scaled(sam_px, COLOR_SAM, 2)

        crop = np.full((panel_px, panel_px, 3), 25, np.uint8)
        y_off, x_off = (panel_px - new_h) // 2, (panel_px - new_w) // 2
        crop[y_off:y_off + new_h, x_off:x_off + new_w] = resized

    header_h, footer_h = 20, 34
    panel = cv2.copyMakeBorder(crop, header_h, footer_h, 4, 4, cv2.BORDER_CONSTANT, value=(20, 20, 20))
    cv2.putText(panel, f"#{rank}  {hold_id}", (6, 15), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1, cv2.LINE_AA)
    iou_txt = f"IoU {rec['iou']:.2f}" if rec.get("iou") is not None else "IoU n/a"
    method = rec.get("chosen_method") or "none"
    gate = rec.get("gate", {})
    gate_txt = "ACCEPT" if gate.get("accepted") else "REJECT"
    cv2.putText(panel, f"{iou_txt}  method={method}", (6, panel.shape[0] - footer_h + 14),
                cv2.FONT_HERSHEY_SIMPLEX, 0.42, (200, 200, 200), 1, cv2.LINE_AA)
    gate_color = (120, 255, 120) if gate.get("accepted") else (120, 120, 255)
    cv2.putText(panel, f"gate: {gate_txt}", (6, panel.shape[0] - footer_h + 30),
                cv2.FONT_HERSHEY_SIMPLEX, 0.42, gate_color, 1, cv2.LINE_AA)
    return panel


def build_grid_contact_sheet(panels, out_path, cols=4):
    if not panels:
        return
    ph, pw = panels[0].shape[:2]
    rows = []
    for i in range(0, len(panels), cols):
        row_panels = panels[i:i + cols]
        while len(row_panels) < cols:
            row_panels.append(np.full((ph, pw, 3), 15, np.uint8))
        rows.append(np.concatenate(row_panels, axis=1))
    sheet = np.concatenate(rows, axis=0)
    cv2.imwrite(str(out_path), sheet, [cv2.IMWRITE_PNG_COMPRESSION, 3])


# ════════════════════════════════════ main ═══════════════════════════════════

def parse_board_region(s):
    parts = [float(v) for v in s.split(",")]
    if len(parts) != 4:
        sys.exit(f"--board-region must be 'left,top,width,height', got: {s}")
    left, top, width, height = parts
    return {"left": left, "top": top, "width": width, "height": height}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--board", help="Board slug or uuid — fetches live holds via read-only GET.")
    src.add_argument("--holds-file", help="Local holds JSON (array, or {'holds':[...]}) instead of a live fetch.")
    ap.add_argument("--image", required=True, help="Board photo to re-outline against. Read-only — never modified.")
    ap.add_argument("--board-region", default="1.0,0.5,98.0,97.0", help="left,top,width,height (board %% of the photo).")
    ap.add_argument("--output", required=True, help="Where to write the --update file for merge_board_holds.mjs.")
    ap.add_argument("--review-dir", required=True, help="Directory for review_sorted.png / review.json / RESULTS.md.")
    ap.add_argument("--top", type=int, default=20, help="How many lowest-confidence holds go in the review sheet.")
    ap.add_argument("--max-shift", type=float, default=3.0, help="Sanity gate: max centroid shift, board %%.")
    ap.add_argument("--min-area-ratio", type=float, default=0.3, help="Sanity gate: min new-area/existing-area.")
    ap.add_argument("--max-area-ratio", type=float, default=3.0, help="Sanity gate: max new-area/existing-area.")
    ap.add_argument("--limit", type=int, default=None, help="(debug) only process the first N holds.")
    args = ap.parse_args()

    br = parse_board_region(args.board_region)
    review_dir = Path(args.review_dir)
    review_dir.mkdir(parents=True, exist_ok=True)

    print(f"\n=== guided_reoutline — READ-ONLY (no Supabase writes, no photo/src writes) ===\n")
    t_wall_start = time.perf_counter()

    holds, source_label = load_holds(args)
    print(f"Holds loaded from {source_label}: {len(holds)}")

    img = cv2.imread(args.image)
    if img is None:
        sys.exit(f"cannot read --image {args.image}")
    ih, iw = img.shape[:2]
    print(f"Board photo: {args.image}  {iw}x{ih}  (read-only)")

    predictor, t_load = setup_sam()
    print(f"SAM model load: {t_load:.3f}s")
    im_tensor, t_encode = sam_encode_image(predictor, img)
    print(f"SAM one-time image encode (shared by every hold): {t_encode:.3f}s")

    print(f"\n── Phase A: per-hold GrabCut + SAM candidates ──")
    t0 = time.perf_counter()
    records, gc_times, sam_times = phase_a_candidates(holds, img, predictor, im_tensor, br, iw, ih, limit=args.limit)
    t_candidates = time.perf_counter() - t0
    print(f"Phase A done in {t_candidates:.2f}s  ({len(records)} holds)")

    print(f"\n── Phase B: neighbour-aware conflict resolution ──")
    t0 = time.perf_counter()
    owner = phase_b_neighbour_resolution(records, iw, ih)
    t_resolve = time.perf_counter() - t0
    print(f"Phase B done in {t_resolve:.2f}s")

    print(f"\n── Phase C: resolve masks, IoU-agreement, choose method ──")
    t0 = time.perf_counter()
    n_affected = phase_c_resolve_and_choose(records, owner, iw, ih)
    t_choose = time.perf_counter() - t0
    print(f"Phase C done in {t_choose:.2f}s  |  neighbour resolution affected {n_affected} hold(s)")

    print(f"\n── Phase D: sanity gates vs existing polygon ──")
    phase_d_sanity_gate(records, br, iw, ih, args.max_shift, args.min_area_ratio, args.max_area_ratio)

    n_errors = sum(1 for r in records if r.get("error"))
    n_accepted = sum(1 for r in records if r.get("gate", {}).get("accepted"))
    n_rejected = len(records) - n_accepted
    n_material = sum(1 for r in records if r.get("gate", {}).get("accepted") and r.get("material"))
    n_grabcut = sum(1 for r in records if r.get("chosen_method") == "grabcut")
    n_sam = sum(1 for r in records if r.get("chosen_method") == "sam")

    print(f"\n── Summary ──")
    print(f"  holds processed   : {len(records)}")
    print(f"  errors/skipped    : {n_errors}")
    print(f"  gate accepted     : {n_accepted}")
    print(f"  gate rejected     : {n_rejected}")
    print(f"  moved materially  : {n_material}  (shift>={MATERIAL_SHIFT_PCT}board% or |area_ratio-1|>={MATERIAL_AREA_DEV})")
    print(f"  neighbour-affected: {n_affected}")
    print(f"  chosen: grabcut={n_grabcut}  sam={n_sam}")

    # ── output: merge_board_holds.mjs --update file (geometry keys only) ──
    updates = []
    for r in records:
        if r.get("gate", {}).get("accepted"):
            updates.append({
                "id": r["id"], "cx": r["new_cx"], "cy": r["new_cy"],
                "polygon": r["new_poly_pct"], "w_pct": r["new_w_pct"], "h_pct": r["new_h_pct"],
            })
    out_payload = {
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "tool": "scripts/guided_reoutline.py",
        "source_holds": source_label, "image": args.image, "boardRegion": br,
        "gates": {"max_shift": args.max_shift, "min_area_ratio": args.min_area_ratio, "max_area_ratio": args.max_area_ratio},
        "counts": {"processed": len(records), "accepted": n_accepted, "rejected": n_rejected,
                   "material": n_material, "neighbour_affected": n_affected,
                   "chosen_grabcut": n_grabcut, "chosen_sam": n_sam},
        "updates": updates,
    }
    Path(args.output).write_text(json.dumps(out_payload, indent=2))
    print(f"\nwrote {args.output}  ({len(updates)} update(s))")

    # ── review.json: every hold, full detail ──
    review_rows = []
    for r in records:
        gate = r.get("gate", {})
        review_rows.append({
            "id": r["id"], "error": r.get("error"),
            "iou": round(r["iou"], 4) if r.get("iou") is not None else None,
            "chosen_method": r.get("chosen_method"), "rule": r.get("rule"),
            "aspect_ratio_prior": round(r["aspect"], 3) if "aspect" in r else None,
            "neighbour_affected": r.get("neighbour_affected", False),
            "centroid_shift_pct": r.get("centroid_shift_pct"), "area_ratio": r.get("area_ratio"),
            "material_change": r.get("material", False),
            "gate_accepted": gate.get("accepted", False), "gate_reason": gate.get("reason"),
        })
    review_rows_sorted_for_json = sorted(
        review_rows, key=lambda x: (x["iou"] if x["iou"] is not None else -1.0)
    )
    Path(review_dir / "review.json").write_text(json.dumps({
        "generatedAt": out_payload["generatedAt"], "n_holds": len(records),
        "sorted_worst_first_by_iou": review_rows_sorted_for_json,
    }, indent=2))
    print(f"wrote {review_dir / 'review.json'}")

    # ── review_sorted.png: worst-N contact sheet ──
    ranked = sorted(
        [r for r in records if not r.get("error")],
        key=lambda r: r["iou"] if r.get("iou") is not None else -1.0,
    )
    top_n = ranked[:max(0, args.top)]
    panels = [render_review_panel(img, i + 1, r, iw, ih) for i, r in enumerate(top_n)]
    build_grid_contact_sheet(panels, review_dir / "review_sorted.png", cols=4)
    print(f"wrote {review_dir / 'review_sorted.png'}  ({len(panels)} panels, worst-first)")

    # ── timing report ──
    t_wall = time.perf_counter() - t_wall_start
    timing = {
        "sam_model_load_s": t_load, "sam_image_encode_s": t_encode,
        "phase_a_total_s": t_candidates, "phase_b_neighbour_resolution_s": t_resolve,
        "phase_c_resolve_choose_s": t_choose, "wall_total_s": t_wall,
        "per_hold_grabcut_s": {"mean": float(np.mean(gc_times)) if gc_times else None,
                                "median": float(np.median(gc_times)) if gc_times else None,
                                "min": float(np.min(gc_times)) if gc_times else None,
                                "max": float(np.max(gc_times)) if gc_times else None},
        "per_hold_sam_decode_s": {"mean": float(np.mean(sam_times)) if sam_times else None,
                                   "median": float(np.median(sam_times)) if sam_times else None,
                                   "min": float(np.min(sam_times)) if sam_times else None,
                                   "max": float(np.max(sam_times)) if sam_times else None},
    }
    print(f"\n── Timing ──")
    print(json.dumps(timing, indent=2))
    (review_dir / "_timing.json").write_text(json.dumps(timing, indent=2))

    return {
        "records": records, "timing": timing, "counts": out_payload["counts"],
        "n_errors": n_errors,
    }


if __name__ == "__main__":
    main()
