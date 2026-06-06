#!/usr/bin/env python3
"""
hold_tagger.py — local laptop "tap a hold → get an outline" tool (Step 2).

Loads a board photo + the refined holds, and lets you fix the long tail by hand —
fast — using a promptable SAM: click a hold and it traces the outline for you, so
you never draw vertices. Every edit (add / delete / reshape) is LOGGED as labelled
training data — the fuel for the learning flywheel (Step 3): next time, detection
gets better because it learns from what you corrected here.

What it is FOR: closing the gap automatic detection can't (small foot chips, missed
/ merged / mis-outlined holds) with a few clicks, while harvesting ground truth.

Controls (GUI)
--------------
  LEFT click            add a positive point on the hold → SAM previews its outline
  RIGHT click           add a negative point (exclude an area) → SAM re-previews
  ENTER / SPACE         accept the previewed outline as a new hold
  c                     clear the current preview / points
  d                     toggle DELETE mode; in DELETE mode, LEFT-click inside a hold removes it
  u                     undo the last add/delete
  s                     save holds JSON + flush the edit log
  + / -                 (zoom is by window resize; image is fit-to-window)
  q / ESC               save and quit

Outputs
-------
  --out         curated holds JSON (same schema as detect_holds_v2 → merge_holds.py compatible)
  --editlog-dir edits.jsonl (one record per edit) + patches/ (image crop per add/delete)
                + session.json (before/after id sets) — the flywheel's training corpus.

Run
---
  /tmp/holds_venv/bin/python scripts/hold_tagger.py \
      --image board-assets/yonder/Yonder_Set_01_V1.jpg \
      --holds /tmp/holds_refined.json \
      --out   /tmp/holds_curated.json

  # Headless check of the SAM core (no display needed):
  /tmp/holds_venv/bin/python scripts/hold_tagger.py --image ... --holds ... --selftest

Notes
-----
* Promptable SAM via ultralytics (default mobile_sam.pt — fast CPU encoder). Override
  with --model sam2_t.pt for crisper masks (slower).
* GUI uses OpenCV highgui (needs the non-headless opencv that ultralytics installs).
  If a window won't open on macOS, run from the venv's framework python or tell me and
  I'll add a matplotlib fallback.
* IDs: existing holds keep their id; new holds get custom_<ms>. Run the result through
  scripts/merge_holds.py before seeding so route references stay stable (CLAUDE.md law).
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

try:
    import cv2
    import numpy as np
except ImportError as e:  # pragma: no cover
    print(f"Error: missing dependency — {e}")
    print("  Run in the venv: /tmp/holds_venv/bin/python scripts/hold_tagger.py ...")
    sys.exit(1)

sys.path.insert(0, str(Path(__file__).resolve().parent))
import detect_holds_v2 as d2  # noqa: E402  (reuse colour label + polygon helpers)

MAX_W, MAX_H = 1500, 950  # fit-to-window display cap


# ─── SAM core (headless-testable) ────────────────────────────────────────────────

def load_sam(model_name: str):
    from ultralytics import SAM
    print(f"Loading SAM ({model_name}) … first run downloads the weight.")
    return SAM(model_name)


def segment_at(model, image_bgr, pts_img, labels):
    """Run SAM with point prompt(s) on the full image. pts_img=[[x,y],...] in image
    pixels, labels=[1=foreground / 0=background]. Returns a full-res uint8 mask (255/0)
    for the prompted object, or None."""
    res = model(image_bgr, points=pts_img, labels=labels, verbose=False)
    if not res or res[0].masks is None or len(res[0].masks.data) == 0:
        return None
    data = res[0].masks.data.cpu().numpy()  # (N, h, w) at model res
    # With point prompts ultralytics returns the best single mask; take the largest.
    idx = int(np.argmax([(m > 0.5).sum() for m in data]))
    m = (data[idx] > 0.5).astype(np.uint8) * 255
    H, W = image_bgr.shape[:2]
    if m.shape != (H, W):
        m = cv2.resize(m, (W, H), interpolation=cv2.INTER_NEAREST)
    # keep just the connected component under the first positive point
    pos = [p for p, l in zip(pts_img, labels) if l == 1]
    if pos:
        n, lbl, stats, _ = cv2.connectedComponentsWithStats(m, 8)
        px, py = int(pos[0][0]), int(pos[0][1])
        if 0 <= py < H and 0 <= px < W and lbl[py, px] > 0:
            m = np.where(lbl == lbl[py, px], 255, 0).astype(np.uint8)
    return m


def mask_to_poly_pct(mask, bl, bt, bw, bh):
    """Full-image mask → polygon in board-area percentages (detect_holds_v2 format)."""
    cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cnts:
        return None
    cnt = max(cnts, key=cv2.contourArea)
    if cv2.contourArea(cnt) < 25:
        return None
    peri = cv2.arcLength(cnt, True)
    approx = cv2.approxPolyDP(cnt, 0.01 * peri, True)
    poly = [[round((p[0][0] - bl) / bw * 100, 2), round((p[0][1] - bt) / bh * 100, 2)]
            for p in approx]
    return poly if len(poly) >= 3 else None


def hold_from_mask(mask, image_bgr, bl, bt, bw, bh):
    """Build a holds-JSON record (custom_<ms> id) from a full-image mask."""
    poly = mask_to_poly_pct(mask, bl, bt, bw, bh)
    if poly is None:
        return None
    cnt = max(cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0],
              key=cv2.contourArea)
    x, y, w, h = cv2.boundingRect(cnt)
    M = cv2.moments(cnt)
    cx = M["m10"] / M["m00"]; cy = M["m01"] / M["m00"]
    board_mask = mask[bt:bt + bh, bl:bl + bw]
    color = d2.classify_colour(image_bgr[bt:bt + bh, bl:bl + bw], board_mask)
    area = int(cv2.countNonZero(mask))
    size = "large" if area > 5000 else "medium" if area > 2000 else "small"
    return {
        "id": f"custom_{int(time.time() * 1000)}",
        "color": color, "size": size,
        "cx": round((cx - bl) / bw * 100, 1), "cy": round((cy - bt) / bh * 100, 1),
        "w_pct": round(w / bw * 100, 1), "h_pct": round(h / bh * 100, 1),
        "r": max(round(max(w, h) / 2 / max(bw, bh) * 100, 1), 1.5),
        "area": area, "polygon": poly,
        "confidence": "high", "verified": True, "notes": "tagged",
    }


# ─── Edit log (the flywheel corpus) ──────────────────────────────────────────────

class EditLog:
    def __init__(self, d, image_file, before_ids):
        self.dir = Path(d); self.dir.mkdir(parents=True, exist_ok=True)
        (self.dir / "patches").mkdir(exist_ok=True)
        self.jsonl = open(self.dir / "edits.jsonl", "a")
        self.image_file = image_file
        self.before_ids = list(before_ids)

    def record(self, action, hold, image_bgr, bl, bt, bw, bh):
        rec = {"ts": time.time(), "action": action, "image": self.image_file,
               "hold_id": hold.get("id"), "color": hold.get("color"),
               "polygon_pct": hold.get("polygon"),
               "cx": hold.get("cx"), "cy": hold.get("cy")}
        # save an image patch (training data): the hold's bbox + margin, in board px
        try:
            xs = [p[0] / 100 * bw + bl for p in hold["polygon"]]
            ys = [p[1] / 100 * bh + bt for p in hold["polygon"]]
            m = 14
            x0 = max(0, int(min(xs)) - m); y0 = max(0, int(min(ys)) - m)
            x1 = min(image_bgr.shape[1], int(max(xs)) + m)
            y1 = min(image_bgr.shape[0], int(max(ys)) + m)
            if x1 > x0 and y1 > y0:
                patch = f"patches/{action}_{hold.get('id')}_{int(rec['ts']*1000)}.png"
                cv2.imwrite(str(self.dir / patch), image_bgr[y0:y1, x0:x1])
                rec["patch"] = patch
        except Exception:
            pass
        self.jsonl.write(json.dumps(rec) + "\n"); self.jsonl.flush()

    def finalize(self, after_ids):
        after = list(after_ids)
        session = {"ts": time.time(), "image": self.image_file,
                   "before_ids": self.before_ids, "after_ids": after,
                   "added": [i for i in after if i not in self.before_ids],
                   "deleted": [i for i in self.before_ids if i not in after]}
        json.dump(session, open(self.dir / "session.json", "w"), indent=2)
        self.jsonl.close()


# ─── IO helpers ──────────────────────────────────────────────────────────────────

def load_holds(path):
    if not path or not Path(path).exists():
        return []
    return json.load(open(path)).get("holds", [])


def save_holds(path, holds, board_region, image_file):
    out = {"boardRegion": board_region, "imageFile": image_file,
           "detectedAt": time.strftime("%Y-%m-%d"),
           "holds": [{k: v for k, v in h.items()} for h in holds]}
    json.dump(out, open(path, "w"), indent=2)
    print(f"Saved {len(holds)} holds → {path}")


def poly_to_img_pts(poly, bl, bt, bw, bh):
    return np.array([[int(p[0] / 100 * bw + bl), int(p[1] / 100 * bh + bt)] for p in poly],
                    np.int32)


def point_in_hold(px, py, hold, bl, bt, bw, bh):
    pts = poly_to_img_pts(hold["polygon"], bl, bt, bw, bh)
    return cv2.pointPolygonTest(pts, (float(px), float(py)), False) >= 0


# ─── GUI ─────────────────────────────────────────────────────────────────────────

def run_gui(args, image_bgr, holds, region, bl, bt, bw, bh, model, editlog):
    H, W = image_bgr.shape[:2]
    scale = min(1.0, MAX_W / W, MAX_H / H)
    disp_base = cv2.resize(image_bgr, (int(W * scale), int(H * scale)))

    state = {"pts": [], "labels": [], "cand": None, "mode": "add", "undo": []}

    def to_img(x, y):
        return int(x / scale), int(y / scale)

    def redraw():
        img = disp_base.copy()
        for h in holds:
            pts = (poly_to_img_pts(h["polygon"], bl, bt, bw, bh) * scale).astype(np.int32)
            cv2.polylines(img, [pts], True, (0, 220, 0), 2, cv2.LINE_AA)
        if state["cand"] is not None:
            cnts, _ = cv2.findContours(state["cand"], cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            for c in cnts:
                cv2.polylines(img, [(c * scale).astype(np.int32)], True, (0, 255, 255), 2, cv2.LINE_AA)
        for (p, l) in zip(state["pts"], state["labels"]):
            cv2.circle(img, (int(p[0] * scale), int(p[1] * scale)), 4,
                       (0, 255, 0) if l == 1 else (0, 0, 255), -1)
        bar = f"[{state['mode'].upper()}]  holds:{len(holds)}  " \
              f"click=point  ENTER=accept  d=delete  u=undo  s=save  q=quit"
        cv2.rectangle(img, (0, 0), (img.shape[1], 24), (30, 30, 30), -1)
        cv2.putText(img, bar, (8, 17), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
        cv2.imshow("hold_tagger", img)

    def on_mouse(event, x, y, flags, _):
        if event not in (cv2.EVENT_LBUTTONDOWN, cv2.EVENT_RBUTTONDOWN):
            return
        ix, iy = to_img(x, y)
        if state["mode"] == "delete" and event == cv2.EVENT_LBUTTONDOWN:
            for i, h in enumerate(holds):
                if point_in_hold(ix, iy, h, bl, bt, bw, bh):
                    removed = holds.pop(i)
                    state["undo"].append(("del", removed))
                    editlog.record("delete", removed, image_bgr, bl, bt, bw, bh)
                    break
            redraw(); return
        lab = 1 if event == cv2.EVENT_LBUTTONDOWN else 0
        state["pts"].append([ix, iy]); state["labels"].append(lab)
        m = segment_at(model, image_bgr, state["pts"], state["labels"])
        state["cand"] = m
        redraw()

    cv2.namedWindow("hold_tagger", cv2.WINDOW_AUTOSIZE)
    cv2.setMouseCallback("hold_tagger", on_mouse)
    redraw()
    print("GUI open. (If no window appeared, see the macOS note in the docstring.)")

    while True:
        k = cv2.waitKey(20) & 0xFF
        if k in (13, 32):  # ENTER / SPACE → accept
            if state["cand"] is not None:
                h = hold_from_mask(state["cand"], image_bgr, bl, bt, bw, bh)
                if h:
                    holds.append(h); state["undo"].append(("add", h))
                    editlog.record("add", h, image_bgr, bl, bt, bw, bh)
            state["pts"], state["labels"], state["cand"] = [], [], None
            redraw()
        elif k == ord("c"):
            state["pts"], state["labels"], state["cand"] = [], [], None; redraw()
        elif k == ord("d"):
            state["mode"] = "add" if state["mode"] == "delete" else "delete"
            state["pts"], state["labels"], state["cand"] = [], [], None; redraw()
        elif k == ord("u"):
            if state["undo"]:
                act, h = state["undo"].pop()
                if act == "add" and h in holds:
                    holds.remove(h)
                elif act == "del":
                    holds.append(h)
                redraw()
        elif k == ord("s"):
            save_holds(args.out, holds, region, args.image)
        elif k in (ord("q"), 27):  # q / ESC
            break
    save_holds(args.out, holds, region, args.image)
    editlog.finalize([h["id"] for h in holds])
    cv2.destroyAllWindows()


# ─── Entry ──────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description="Tap-to-segment hold tagger (local).")
    ap.add_argument("--image", required=True)
    ap.add_argument("--holds", default=None, help="existing holds JSON to load/edit")
    ap.add_argument("--board-region", default="1,0.5,98,97", dest="board_region")
    ap.add_argument("--out", default="/tmp/holds_curated.json")
    ap.add_argument("--editlog-dir", default="/tmp/hold_edits", dest="editlog_dir")
    ap.add_argument("--model", default="mobile_sam.pt")
    ap.add_argument("--selftest", action="store_true",
                    help="Headless: load image+SAM, segment at the first hold's centre, verify a mask.")
    args = ap.parse_args()

    root = Path(__file__).resolve().parents[1]
    img_path = Path(args.image)
    if not img_path.is_absolute():
        img_path = root / args.image
    image_bgr = cv2.imread(str(img_path))
    if image_bgr is None:
        print(f"Error: cannot load image {img_path}"); sys.exit(1)
    H, W = image_bgr.shape[:2]
    p = [float(x) for x in args.board_region.split(",")]
    region = {"left": p[0], "top": p[1], "width": p[2], "height": p[3]}
    bl = int(W * p[0] / 100); bt = int(H * p[1] / 100)
    bw = int(W * p[2] / 100); bh = int(H * p[3] / 100)

    holds = load_holds(args.holds if args.holds else None)
    if args.holds and not Path(args.holds).is_absolute() and not Path(args.holds).exists():
        holds = load_holds(str(root / args.holds))
    print(f"Loaded {len(holds)} existing holds.")

    model = load_sam(args.model)

    if args.selftest:
        # Pick a probe point: centre of the first existing hold, else board centre.
        if holds:
            probe = (int(holds[0]["cx"] / 100 * bw + bl), int(holds[0]["cy"] / 100 * bh + bt))
        else:
            probe = (bl + bw // 2, bt + bh // 2)
        print(f"Self-test: segmenting at {probe} …")
        m = segment_at(model, image_bgr, [[probe[0], probe[1]]], [1])
        if m is None:
            print("SELFTEST FAIL: no mask returned"); sys.exit(1)
        area = int(cv2.countNonZero(m))
        h = hold_from_mask(m, image_bgr, bl, bt, bw, bh)
        print(f"SELFTEST OK: mask area={area}px ({100*area/(W*H):.2f}% of image), "
              f"colour={h['color'] if h else '?'}, verts={len(h['polygon']) if h else 0}")
        # save a visual for inspection
        ov = image_bgr.copy()
        cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(ov, cnts, -1, (0, 255, 255), 3)
        cv2.circle(ov, probe, 8, (0, 0, 255), -1)
        out = root / "board-assets/yonder/_tagger_selftest.jpg"
        cv2.imwrite(str(out), ov)
        print(f"Self-test overlay → {out}")
        return

    editlog = EditLog(args.editlog_dir, args.image, [h["id"] for h in holds])
    run_gui(args, image_bgr, holds, region, bl, bt, bw, bh, model, editlog)


if __name__ == "__main__":
    main()
