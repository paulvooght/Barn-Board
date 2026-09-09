#!/usr/bin/env python3
"""
compare_sam_grabcut.py — BOUNDED PROTOTYPE, not a shipping tool.

Question: does box/point-prompted SAM produce materially better hold outlines
than the GrabCut method currently used for The Barn's V8 re-outlining pass?

Read-only w.r.t. the live app: never touches Supabase, never writes into src/,
never modifies the published board photo. All output lives in this directory
(board-assets/_proto_reoutline/, gitignored except what the task explicitly
`git add -f`s).

Run with the isolated venv (see scripts/requirements-detect.txt convention):
    /tmp/holds_venv/bin/python board-assets/_proto_reoutline/compare_sam_grabcut.py

Method A — GrabCut baseline (reproduces the method already used for
board-assets/the-barn/_v8_reoutline_updates.json):
    padded ROI -> mask seeded with the PRIOR polygon as probable-fg, an eroded
    core as definite-fg, an ROI-border ring as definite-bg -> 5 GrabCut
    iterations -> largest contour -> approxPolyDP(eps=1.5px).

Method B — box+point prompted SAM (SAM2.1-base via ultralytics):
    the board photo is encoded ONCE (shared across every hold, since it's the
    same photo); each hold prompts the cached encoding with its prior
    polygon's bounding box + centroid point, multimask_output=True, and we
    pick among the 3 returned proposals two different ways (reported
    separately): highest predicted IoU, and best area-agreement with the
    prior. Same contour -> approxPolyDP(eps=1.5px) finishing step as GrabCut,
    so the two methods are compared apples-to-apples.

The PRIOR polygon for every hold (the GrabCut seed / SAM prompt) is that
hold's entry in `_holds_reprojected_v8.json` — the reprojected-but-not-yet-
corrected polygon carried over from the pre-V8 photo. For the 10 holds also
listed in `_v8_reoutline_updates.json`, that prior is deliberately the ROUGH,
pre-correction shape (often hand-drawn against bare plywood) — that rough
shape *is* the hard case, and both methods start from the same seed so the
comparison is fair.

No ground truth exists. This script produces the pixel evidence (15 three-
panel crops + one contact sheet + timings); a human (Claude, looking at the
images) makes the actual A/B call. See RESULTS.md for that judgement.
"""
import json
import sys
import time
import datetime
from pathlib import Path

import numpy as np
import cv2

REPO = Path(__file__).resolve().parents[2]
OUT_DIR = Path(__file__).resolve().parent
CROPS_DIR = OUT_DIR / "crops"
CROPS_DIR.mkdir(exist_ok=True)

sys.path.insert(0, str(REPO / "scripts"))
from reproject_holds import pct_to_px, px_to_pct  # noqa: E402  (reuse, don't rewrite the maths)

IMG_PATH = REPO / "board-assets/the-barn/Barn_Set_01_V8.jpg"
REPROJ_PATH = REPO / "board-assets/the-barn/_holds_reprojected_v8.json"
BOARD_REGION = {"left": 1.0, "top": 0.5, "width": 98.0, "height": 97.0}

SAM_MODEL_NAME = "/tmp/holds_venv/weights/sam2.1_b.pt"  # cached here so repeat runs never re-download
                                                          # into the repo working tree (see RESULTS.md)
SAM_DEVICE = "cpu"  # MPS was measured too -- see RESULTS.md timing section

# --- the 15-hold test set ---------------------------------------------------
# (id, hard-case category, one-phrase justification). The first 10 are the
# REQUIRED set (volcanic rock + the other 9 IDs in _v8_reoutline_updates.json).
TEST_SET = [
    ("custom_1785242211962", "large matte-dark",
     "REQUIRED / volcanic rock -- currently the worst GrabCut result; prior sprawls onto plywood"),
    ("custom_1785242222284", "wood/tan-on-plywood",
     "REQUIRED -- small tan hold, low colour separation from plywood"),
    ("custom_1785242302475", "wood/tan-on-plywood",
     "REQUIRED -- tan triangular hold, prior undershoots the pointed tip"),
    ("custom_1785242340139", "wood/tan-on-plywood + neighbour",
     "REQUIRED -- small tan hold wedged beside a glossy blue hold"),
    ("custom_1785242357370", "touching-neighbour risk",
     "REQUIRED -- hold abuts a large glossy blue hold"),
    ("custom_1785242401621", "thin/elongated wood-on-plywood",
     "REQUIRED -- thin tan rail; GrabCut's erosion step may wipe a thin seed"),
    ("custom_1785249076778", "prior sits badly",
     "REQUIRED -- purple hold, prior polygon undershoots the true edge"),
    ("custom_1785249097137", "prior sits badly",
     "REQUIRED -- purple hold, prior polygon undershoots the true edge"),
    ("custom_1785863185201", "wood/tan-on-plywood",
     "REQUIRED -- tan oval hold on plywood beside a cyan strip"),
    ("custom_1785863207342", "wood/tan-on-plywood + clutter",
     "REQUIRED -- tan hold near mounting-hardware clutter, possible prior under-coverage"),
    ("custom_hold_17", "glossy / specular",
     "large cyan volume with a strong specular highlight down its ridge"),
    ("custom_1774618428149", "large matte-dark + touching-neighbour",
     "second large matte-dark hold, tightly boxed by yellow/cyan neighbours"),
    ("custom_hold_3", "wood/tan-on-plywood + touching-neighbour",
     "large wood-tone rail hold overlapping similarly-toned tan neighbours"),
    ("custom_hold_55", "easy control",
     "isolated, high-contrast yellow hold, clean simple shape, already-tight prior"),
    ("custom_hold_18", "easy control",
     "isolated, high-contrast cyan hold, mild gloss, simple shape, already-tight prior"),
]


# --- geometry helpers --------------------------------------------------------
def poly_pct_to_px(poly_pct, w, h):
    return np.array([pct_to_px(x, y, BOARD_REGION, w, h) for x, y in poly_pct], dtype=np.float64)


def poly_px_to_pct(poly_px, w, h):
    return [[round(x, 2), round(y, 2)] for x, y in (px_to_pct(x, y, BOARD_REGION, w, h) for x, y in poly_px)]


def polygon_area_centroid(poly):
    """Standard area-weighted polygon centroid (shoelace). Works in whatever
    units `poly` is given in -- we use it both in px (for mask-selection) and
    in board-% (for the reported ratios), never mixing the two."""
    poly = np.asarray(poly, dtype=np.float64)
    x, y = poly[:, 0], poly[:, 1]
    x1, y1 = np.roll(x, -1), np.roll(y, -1)
    cross = x * y1 - x1 * y
    a = cross.sum() / 2.0
    if abs(a) < 1e-9:
        return 0.0, (float(x.mean()), float(y.mean()))
    cx = ((x + x1) * cross).sum() / (6 * a)
    cy = ((y + y1) * cross).sum() / (6 * a)
    return abs(a), (float(cx), float(cy))


# --- Method A: GrabCut baseline ---------------------------------------------
def run_grabcut(img, prior_poly_px, pad_frac=0.5, min_pad=20, erode_frac=0.25, border_px=8, iters=5):
    ih, iw = img.shape[:2]
    xs, ys = prior_poly_px[:, 0], prior_poly_px[:, 1]
    x0, y0, x1, y1 = xs.min(), ys.min(), xs.max(), ys.max()
    bw, bh = x1 - x0, y1 - y0
    pad = max(min_pad, pad_frac * max(bw, bh))
    rx0, ry0 = max(0, int(x0 - pad)), max(0, int(y0 - pad))
    rx1, ry1 = min(iw, int(x1 + pad)), min(ih, int(y1 + pad))
    roi = img[ry0:ry1, rx0:rx1].copy()
    rh, rw = roi.shape[:2]

    poly_local = (prior_poly_px - [rx0, ry0]).astype(np.int32)

    fg_fill = np.zeros((rh, rw), np.uint8)
    cv2.fillPoly(fg_fill, [poly_local], 1)

    mask = np.full((rh, rw), cv2.GC_PR_BGD, dtype=np.uint8)
    mask[fg_fill == 1] = cv2.GC_PR_FGD

    # eroded core = definite-foreground; shrink the kernel if erosion would
    # wipe out a thin hold entirely (guards the thin-rail hard case)
    k = max(1, int(round(erode_frac * min(bw, bh))))
    core = fg_fill
    for kk in range(k, 0, -1):
        eroded = cv2.erode(fg_fill, np.ones((kk * 2 + 1, kk * 2 + 1), np.uint8))
        if eroded.sum() > 0:
            core = eroded
            break
    mask[core == 1] = cv2.GC_FGD

    b = min(border_px, rh // 4, rw // 4, 1) if min(rh, rw) < border_px * 4 else border_px
    mask[:b, :] = cv2.GC_BGD
    mask[-b:, :] = cv2.GC_BGD
    mask[:, :b] = cv2.GC_BGD
    mask[:, -b:] = cv2.GC_BGD

    bgd_model = np.zeros((1, 65), np.float64)
    fgd_model = np.zeros((1, 65), np.float64)
    t0 = time.perf_counter()
    cv2.grabCut(roi, mask, None, bgd_model, fgd_model, iters, cv2.GC_INIT_WITH_MASK)
    dt = time.perf_counter() - t0

    fg = np.where((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)
    contours, _ = cv2.findContours(fg, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None, dt
    c = max(contours, key=cv2.contourArea)
    approx = cv2.approxPolyDP(c, 1.5, True).reshape(-1, 2).astype(np.float64)
    poly_full = approx + [rx0, ry0]
    return poly_full, dt


# --- Method B: box+point prompted SAM ---------------------------------------
def setup_sam():
    from ultralytics.models.sam.predict import SAM2Predictor

    overrides = dict(model=SAM_MODEL_NAME, task="segment", mode="predict",
                      imgsz=1024, conf=0.25, save=False, verbose=False, device=SAM_DEVICE)
    predictor = SAM2Predictor(overrides=overrides)
    t0 = time.perf_counter()
    predictor.setup_model(model=None)
    t_load = time.perf_counter() - t0
    return predictor, t_load


def sam_encode_image(predictor, img):
    """Encode the board photo ONCE. Every hold's prompt reuses this."""
    t0 = time.perf_counter()
    predictor.setup_source(img)
    im = None
    for predictor.batch in predictor.dataset:
        im = predictor.preprocess(predictor.batch[1])
        predictor.features = predictor.get_im_features(im)
        break
    t_encode = time.perf_counter() - t0
    return im, t_encode


def sam_prompt(predictor, im, orig_img, box_px, point_px):
    from ultralytics.utils import ops

    t0 = time.perf_counter()
    masks, scores = predictor.inference(im, bboxes=[box_px], points=[point_px], labels=[1], multimask_output=True)
    full = ops.scale_masks(masks[None].float(), orig_img.shape[:2], padding=False)[0]
    full = (full > predictor.model.mask_threshold).detach().cpu().numpy()
    dt = time.perf_counter() - t0

    proposals = []
    for i in range(full.shape[0]):
        m = (full[i] * 255).astype(np.uint8)
        contours, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            proposals.append(None)
            continue
        c = max(contours, key=cv2.contourArea)
        approx = cv2.approxPolyDP(c, 1.5, True).reshape(-1, 2).astype(np.float64)
        proposals.append(approx)
    return proposals, scores.detach().cpu().numpy().tolist(), dt


def pick_by_score(scores):
    return int(np.argmax(scores))


def pick_by_area_agreement(proposals, prior_area_px):
    best_idx, best_diff = None, None
    for i, p in enumerate(proposals):
        if p is None:
            continue
        a = cv2.contourArea(p.astype(np.float32))
        diff = abs(a / prior_area_px - 1.0) if prior_area_px > 0 else abs(a)
        if best_diff is None or diff < best_diff:
            best_diff, best_idx = diff, i
    return best_idx


# --- visualization -----------------------------------------------------------
COLOR_GC = (255, 0, 255)   # magenta (BGR) -- distinct from every hold colour in the test set
COLOR_SAM = (0, 255, 0)    # green   (BGR)


def _outline(panel, poly_px, origin, color):
    if poly_px is None:
        cv2.putText(panel, "NO CONTOUR", (10, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 1, cv2.LINE_AA)
        return panel
    pts = (poly_px - origin).astype(np.int32)
    cv2.polylines(panel, [pts], True, (0, 0, 0), 4, cv2.LINE_AA)  # dark halo for contrast on any hold colour
    cv2.polylines(panel, [pts], True, color, 2, cv2.LINE_AA)
    return panel


def make_triptych(img, hold_id, category, prior_poly_px, gc_poly_px, sam_poly_px, out_path):
    polys = [p for p in [prior_poly_px, gc_poly_px, sam_poly_px] if p is not None]
    allpts = np.concatenate(polys, axis=0)
    x0, y0 = allpts[:, 0].min(), allpts[:, 1].min()
    x1, y1 = allpts[:, 0].max(), allpts[:, 1].max()
    w, h = x1 - x0, y1 - y0
    pad = max(25, 0.35 * max(w, h))
    ih, iw = img.shape[:2]
    cx0, cy0 = max(0, int(x0 - pad)), max(0, int(y0 - pad))
    cx1, cy1 = min(iw, int(x1 + pad)), min(ih, int(y1 + pad))
    crop = img[cy0:cy1, cx0:cx1]
    origin = np.array([cx0, cy0])

    scale = max(1, min(4, int(320 / max(crop.shape[:2]))))
    resize = lambda im: cv2.resize(im, (im.shape[1] * scale, im.shape[0] * scale), interpolation=cv2.INTER_CUBIC)

    p_plain = resize(crop.copy())
    p_gc = resize(_outline(crop.copy(), gc_poly_px, origin, COLOR_GC))
    p_sam = resize(_outline(crop.copy(), sam_poly_px, origin, COLOR_SAM))

    gap = 6
    sep = np.full((p_plain.shape[0], gap, 3), 30, np.uint8)
    combo = np.concatenate([p_plain, sep, p_gc, sep, p_sam], axis=1)

    header_h = 26
    footer_h = 22
    labeled = cv2.copyMakeBorder(combo, header_h, footer_h, 0, 0, cv2.BORDER_CONSTANT, value=(20, 20, 20))
    panel_w = p_plain.shape[1] + gap
    for i, txt in enumerate(["photo (unannotated)", "GrabCut (magenta)", "SAM (green)"]):
        cv2.putText(labeled, txt, (i * panel_w + 6, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
    footer_txt = f"{hold_id}  |  {category}"
    cv2.putText(labeled, footer_txt, (6, labeled.shape[0] - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (200, 200, 200), 1, cv2.LINE_AA)
    cv2.imwrite(str(out_path), labeled, [cv2.IMWRITE_PNG_COMPRESSION, 3])
    return labeled


def build_contact_sheet(rows, out_path, target_w=1000):
    resized = []
    for im in rows:
        s = target_w / im.shape[1]
        resized.append(cv2.resize(im, (target_w, int(im.shape[0] * s)), interpolation=cv2.INTER_AREA))
    sep = np.full((3, target_w, 3), 80, np.uint8)
    parts = []
    for r in resized:
        parts.append(r)
        parts.append(sep)
    sheet = np.concatenate(parts[:-1], axis=0)
    cv2.imwrite(str(out_path), sheet, [cv2.IMWRITE_PNG_COMPRESSION, 3])


# --- main --------------------------------------------------------------------
def main():
    img = cv2.imread(str(IMG_PATH))
    if img is None:
        sys.exit(f"cannot read {IMG_PATH}")
    ih, iw = img.shape[:2]
    print(f"board photo: {IMG_PATH.name}  {iw}x{ih}")

    reproj = {u["id"]: u for u in json.loads(REPROJ_PATH.read_text())["updates"]}

    predictor, t_load = setup_sam()
    print(f"SAM model load ({SAM_MODEL_NAME}, device={SAM_DEVICE}): {t_load:.3f}s")
    im_tensor, t_encode = sam_encode_image(predictor, img)
    print(f"SAM one-time image encode (shared by all holds): {t_encode:.3f}s")

    results = []
    contact_rows = []
    gc_times, sam_times = [], []

    for hold_id, category, justification in TEST_SET:
        u = reproj.get(hold_id)
        if u is None:
            print(f"!! {hold_id} not found in reprojected set -- skipping")
            continue
        prior_poly_pct = u["polygon"]
        prior_poly_px = poly_pct_to_px(prior_poly_pct, iw, ih)
        prior_area_pct, prior_centroid_pct = polygon_area_centroid(prior_poly_pct)
        prior_area_px = cv2.contourArea(prior_poly_px.astype(np.float32))

        box_px = [float(prior_poly_px[:, 0].min()), float(prior_poly_px[:, 1].min()),
                  float(prior_poly_px[:, 0].max()), float(prior_poly_px[:, 1].max())]
        point_px = list(pct_to_px(u["cx"], u["cy"], BOARD_REGION, iw, ih))

        # --- Method A ---
        gc_poly_px, dt_gc = run_grabcut(img, prior_poly_px)
        gc_times.append(dt_gc)
        if gc_poly_px is not None:
            gc_poly_pct = poly_px_to_pct(gc_poly_px, iw, ih)
            gc_area_pct, gc_centroid_pct = polygon_area_centroid(gc_poly_pct)
            gc_shift = float(np.hypot(gc_centroid_pct[0] - prior_centroid_pct[0],
                                       gc_centroid_pct[1] - prior_centroid_pct[1]))
            gc_ratio = gc_area_pct / prior_area_pct if prior_area_pct > 0 else None
        else:
            gc_poly_pct, gc_area_pct, gc_shift, gc_ratio = None, None, None, None

        # --- Method B ---
        proposals, scores, dt_sam = sam_prompt(predictor, im_tensor, img, box_px, point_px)
        sam_times.append(dt_sam)
        idx_score = pick_by_score(scores)
        idx_area = pick_by_area_agreement(proposals, prior_area_px)
        sam_poly_px = proposals[idx_score]
        if sam_poly_px is not None:
            sam_poly_pct = poly_px_to_pct(sam_poly_px, iw, ih)
            sam_area_pct, sam_centroid_pct = polygon_area_centroid(sam_poly_pct)
            sam_shift = float(np.hypot(sam_centroid_pct[0] - prior_centroid_pct[0],
                                        sam_centroid_pct[1] - prior_centroid_pct[1]))
            sam_ratio = sam_area_pct / prior_area_pct if prior_area_pct > 0 else None
        else:
            sam_poly_pct, sam_area_pct, sam_shift, sam_ratio = None, None, None, None

        # cross-check: does the "best area agreement" rule pick a different mask?
        area_rule_agrees = (idx_area == idx_score)

        out_path = CROPS_DIR / f"{hold_id}_3panel.png"
        combo_img = make_triptych(img, hold_id, category, prior_poly_px, gc_poly_px, sam_poly_px, out_path)
        contact_rows.append(combo_img)
        print(f"{hold_id:24s} gc={dt_gc*1000:6.1f}ms sam_decode={dt_sam*1000:6.1f}ms "
              f"sam_scores={['%.2f' % s for s in scores]} chosen_by_score={idx_score} "
              f"chosen_by_area={idx_area} agree={area_rule_agrees} -> {out_path.name}")

        results.append({
            "id": hold_id, "category": category, "justification": justification,
            "prior_polygon_pct": prior_poly_pct, "prior_area_pct2": prior_area_pct,
            "grabcut": {"polygon_pct": gc_poly_pct, "area_pct2": gc_area_pct,
                        "area_ratio_vs_prior": gc_ratio, "centroid_shift_pct": gc_shift,
                        "time_s": dt_gc},
            "sam": {"polygon_pct": sam_poly_pct, "area_pct2": sam_area_pct,
                    "area_ratio_vs_prior": sam_ratio, "centroid_shift_pct": sam_shift,
                    "time_s": dt_sam, "scores_all_3": scores,
                    "chosen_index_by_score": idx_score, "chosen_index_by_area_agreement": idx_area,
                    "selection_rules_agree": area_rule_agrees},
            "crop_path": str(out_path.relative_to(REPO)),
        })

    build_contact_sheet(contact_rows, OUT_DIR / "contact_sheet.png")
    print(f"wrote {OUT_DIR / 'contact_sheet.png'}")

    timing = {
        "model_load_s": t_load,
        "one_time_image_encode_s": t_encode,
        "per_hold_grabcut_s": {"mean": float(np.mean(gc_times)), "median": float(np.median(gc_times)),
                                "min": float(np.min(gc_times)), "max": float(np.max(gc_times))},
        "per_hold_sam_decode_s_CACHED": {"mean": float(np.mean(sam_times)), "median": float(np.median(sam_times)),
                                          "min": float(np.min(sam_times)), "max": float(np.max(sam_times))},
        "n_holds_tested": len(results),
        "extrapolation_204_holds": {
            "grabcut_total_s": float(np.mean(gc_times)) * 204,
            "sam_total_s_with_shared_encode": t_load + t_encode + float(np.mean(sam_times)) * 204,
        },
    }
    print(json.dumps(timing, indent=2))

    dump = {"generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "sam_model": SAM_MODEL_NAME, "sam_device": SAM_DEVICE,
            "board_region": BOARD_REGION, "timing": timing, "results": results}
    (OUT_DIR / "results.json").write_text(json.dumps(dump, indent=2))
    print(f"wrote {OUT_DIR / 'results.json'}")


if __name__ == "__main__":
    main()
