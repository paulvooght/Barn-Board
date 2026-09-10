#!/usr/bin/env python3
"""
board_update.py — the ONE command for a board-image TWEAK.

Owner's ask (verbatim): "I'd like to be able to drop an image in the folder,
and say something like 'I've dropped in a new pic for a board update / tweak'
and it know exactly what to do automatically, without a conversation, and
have our best outline outcomes and route / hold ID retention we have ever
had." This script IS that command. It shells out to the pieces built on
2026-09-09 (CLAUDE.md "Safe Workflow: Board Image Update — TWEAK") in the
right order, with every gate those scripts already enforce, plus a few more
of its own. It never reimplements their logic — only coordinates it.

THIS IS TWEAK ONLY. A TWEAK is "a few holds added/moved/removed, the set is
recognisably the same" (CLAUDE.md, "TWEAK vs RESET"). If the photo looks like
the wall was stripped and re-set, this script refuses and points at
docs/RESET_PROCESS_SPEC.md — that path is designed but NOT built, and running
this tool on a real reset would leave routes pointing at holds that no longer
exist. Never auto-decide a reset; an admin must.

────────────────────────────────────────────────────────────────────────────
USAGE
    python3 scripts/board_update.py --board the-barn --image board-assets/the-barn/Barn_Set_01_V9_raw.jpg
    python3 scripts/board_update.py --board the-barn                # auto-detect the new photo
    python3 scripts/board_update.py --board the-barn --dry-run      # read-only, writes NOTHING live

Auto-detect (no --image): the newest *.jpg directly in board-assets/<slug>/
that is NOT the currently-published image, NOT a -800w/-1200w/-2000w
responsive variant, and NOT underscore-prefixed (a working file). If more
than one file qualifies, every candidate is listed and the run stops —
this script never guesses which photo is the real one.

────────────────────────────────────────────────────────────────────────────
WHAT IT DOES, IN ORDER (mapped onto the pieces built 2026-09-09)
  0. Preflight (no writes): resolve the board, resolve the new image path,
     resolve the currently-published reference image, and check their pixel
     dimensions MATCH. A size mismatch means a re-crop happened, not a
     camera nudge — this tool is not the right one for that (the wizard /
     a fresh boardRegion is), so it aborts here, before anything is touched.
  1. Backup — scripts/backup_tables.mjs. Non-negotiable; abort everything
     if it fails.
  2. Measure the camera move — scripts/align_board_image.py. Its warped
     output is a measuring instrument ONLY (CLAUDE.md "THE BOARD PHOTO IS
     THE TRUTH") — used internally as an input to step 3's diff, NEVER
     published, NEVER the thing that reaches Supabase.
  3. Diff old vs new (find new / changed / vanished holds) —
     scripts/diff_new_holds.py. Deliberately run BEFORE any live write (the
     task materials describe this later in the manual sequence, but its
     result is exactly the RESET-vs-TWEAK signal, so it is promoted ahead of
     every mutating step here — see "REORDERING" below).
  3b. RESET-signal gate — if a large share of the board reads as
      changed/vanished/new relative to the live hold count, abort and point
      at docs/RESET_PROCESS_SPEC.md. Nothing has been written yet.
  4. Reproject every hold outline into the new photo's frame —
     scripts/reproject_holds.py. IDs preserved by construction; the script
     itself refuses to write if the ID set changed or any hold moved past
     its own --max-shift gate.
  5. Apply the reprojected geometry — scripts/merge_board_holds.mjs
     --update (dry-run validated first, --commit only in live mode).
  6. Publish the RAW photo — scripts/publish_board_image.py. Has no
     dry-run mode of its own (always writes), so this script skips calling
     it entirely under --dry-run rather than faking one.
  7. Guided re-outline (SAM+GrabCut consensus) — scripts/guided_reoutline.py,
     best-effort (see "WHAT IS NOT FULLY AUTOMATIC" below).
  8. Gate the guided re-outline to IoU >= 0.85 (both methods agree) and
     apply only that subset via merge_board_holds.mjs --update. This gate is
     load-bearing: on 2026-09-09 the ungated pass proposed changing 203/204
     holds and roughly half would have been WORSE (SAM inflating outlines
     onto bare plywood). Gated, 70 passed.
  9. New-hold candidates from step 3, reprojected into the new photo's
     frame, written to a review file. NEVER auto-added — a false hold is
     clutter the owner must delete by hand; a missed one costs nothing.
  9b. scripts/score_outline_fit.py — an independent per-hold "does this
      outline actually sit on this photo" ranking, for the review list. Runs
      if present; skips with a clear warning if not (matches the
      instruction this was being built in parallel).
  10. Final summary + board-assets/<slug>/_update_report.md.

REORDERING, on purpose: the task material lists diff_new_holds.py as step 7,
after the merge/publish/re-outline steps. This script runs it as step 3,
before ANY live write, because its output is exactly the signal that decides
whether this is safe to proceed as a TWEAK at all ("TWEAK ONLY... stop and
point at RESET_PROCESS_SPEC.md" — CLAUDE.md). Gating that on a signal
computed only after mutations had already landed would defeat the point of
the gate. Nothing about diff_new_holds.py itself changed — it is still a
pure read-only comparison of the reference photo vs the aligned new one.

────────────────────────────────────────────────────────────────────────────
WHAT IS NOT FULLY AUTOMATIC (see also the report this script writes)
  - Step 7 (guided re-outline) needs a heavyweight ML venv (torch +
    ultralytics + a SAM checkpoint) that this repo keeps at the ephemeral
    /tmp/holds_venv — it will not survive a reboot and is not something an
    unattended cron-style run can guarantee exists. If it's missing, this
    script SKIPS step 7/8 with a clear warning and continues — the core,
    ID-preserving TWEAK (steps 1-6) has already completed safely by then,
    so a missing refinement pass degrades quality, not correctness.
  - Step 6 (publish) and step 5 (apply geometry) are two independent writes
    to two different Supabase subsystems (a table row, a storage bucket) —
    there is no distributed transaction across them. If step 5 succeeds and
    step 6 then fails, the holds will already reflect the new photo's
    geometry while the OLD photo is still live for a short window; the fix
    is just re-running `publish_board_image.py <name> --board <slug>` by
    hand. This script cannot make that pair atomic without rewriting those
    scripts, which the task asked it not to do.
  - score_outline_fit.py's interface was being built in parallel; if it's
    missing OR it fails, this script warns and continues rather than
    treating it as load-bearing (per the original spec for this step).

────────────────────────────────────────────────────────────────────────────
SAFETY
  - --dry-run runs every read-only measurement/analysis step for real (so
    the report is trustworthy) but NEVER calls merge_board_holds.mjs
    --commit and NEVER calls publish_board_image.py at all.
  - In live mode, every mutating call is dry-run-validated by the
    underlying script FIRST; --commit only follows a clean dry-run.
  - This script never deletes a hold, renames an ID, or writes to
    board_settings directly — every mutation goes through
    merge_board_holds.mjs, which enforces that on its own.
  - Never touches src/, src/data/holds.json, or a published image file in
    place. Never runs `git add -A` or `npm run build`.

Dependencies: everything already used elsewhere in this repo's scripts
(cv2, numpy, Pillow, requests) — no new ones. Node for the two .mjs tools.
"""
import argparse
import json
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts"))
# Reuse the EXACT percentage<->pixel transform this repo already uses
# everywhere else (CLAUDE.md "SVG Coordinate Conversion" — do not rewrite
# this maths). reproject_holds.py's own CLI can't be reused verbatim for
# brand-new hold candidates (it asserts the ID set is unchanged, which
# breaks on a batch of candidates that all carry id=None) — see
# reproject_new_candidates() below, which reuses these two functions and
# nothing else.
from reproject_holds import pct_to_px, px_to_pct  # noqa: E402

GEOMETRY_KEYS = ("cx", "cy", "polygon", "w_pct", "h_pct", "r", "area")
DEFAULT_BOARD_REGION = "1.0,0.5,98.0,97.0"
VENV_PYTHON = Path("/tmp/holds_venv/bin/python")

_t_run_start = time.time()
_step_no = 0


# ════════════════════════════════════ small utilities ═════════════════════════

def elapsed():
    return time.time() - _t_run_start


def log(msg):
    print(f"[{elapsed():7.1f}s] {msg}")


def step(title):
    global _step_no
    _step_no += 1
    print(f"\n{'─' * 78}\nSTEP {_step_no}: {title}\n{'─' * 78}")
    return time.time()


def step_done(t0, note=""):
    dt = time.time() - t0
    log(f"done in {dt:.1f}s" + (f"  — {note}" if note else ""))
    return dt


class Abort(SystemExit):
    pass


def abort(msg, hint=None):
    print(f"\n{'!' * 78}")
    print(f"ABORT: {msg}")
    if hint:
        print(f"\n{hint}")
    print(f"{'!' * 78}\n")
    raise Abort(1)


def run(cmd, description):
    """Run a subprocess, streaming its output live, and return the exit
    code. Every caller MUST check this — a pipeline that carries on after a
    failed step is worse than no pipeline (task spec)."""
    printable = " ".join(str(c) for c in cmd)
    print(f"\n$ {printable}")
    t0 = time.time()
    result = subprocess.run(cmd, cwd=str(REPO_ROOT))
    dt = time.time() - t0
    tag = "OK" if result.returncode == 0 else f"FAILED (exit {result.returncode})"
    log(f"[{description}] {tag}  ({dt:.1f}s)")
    return result.returncode, dt


def sanitize_label(s):
    return re.sub(r"[^A-Za-z0-9_.-]+", "-", s).strip("-") or "update"


def image_size(path):
    with Image.open(path) as im:
        return im.size  # (w, h)


# ════════════════════════════════════ read-only Supabase (GET only) ═══════════
# Same pattern as every other script here (publish_board_image.py,
# diff_new_holds.py, guided_reoutline.py, score_outline_fit.py): load
# .env.local by hand, hit PostgREST directly with the service-role key.

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
    import requests
    is_uuid = bool(re.match(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-", board_arg, re.I))
    field = "id" if is_uuid else "slug"
    url = f"{base_url}/rest/v1/boards?{field}=eq.{board_arg}&select=id,slug,name,specs"
    r = requests.get(url, headers={**headers, "Accept": "application/json"}, timeout=15)
    if r.status_code != 200:
        abort(f"boards lookup failed: {r.status_code} {r.text}")
    rows = r.json()
    if not rows:
        abort(f"no board with {field}='{board_arg}'")
    return rows[0]


def fetch_live_holds(base_url, headers, board_id):
    import requests
    key = f"holds_{board_id}"
    url = f"{base_url}/rest/v1/board_settings?key=eq.{key}&select=data"
    r = requests.get(url, headers={**headers, "Accept": "application/json"}, timeout=30)
    if r.status_code != 200:
        abort(f"fetching {key} failed: {r.status_code} {r.text}")
    rows = r.json()
    if not rows or not isinstance(rows[0].get("data"), list):
        abort(f"board_settings['{key}'] missing or not an array")
    return rows[0]["data"], key


def fetch_image_config(base_url, headers, board_id):
    import requests
    key = f"board_image_config_{board_id}"
    url = f"{base_url}/rest/v1/board_settings?key=eq.{key}&select=data"
    r = requests.get(url, headers={**headers, "Accept": "application/json"}, timeout=15)
    if r.status_code != 200:
        abort(f"fetching {key} failed: {r.status_code} {r.text}")
    rows = r.json()
    if not rows or not isinstance(rows[0].get("data"), dict):
        return None
    return rows[0]["data"]


def fetch_routes(base_url, headers, board_id):
    import requests
    url = f"{base_url}/rest/v1/routes?board_id=eq.{board_id}&select=id,data"
    r = requests.get(url, headers={**headers, "Accept": "application/json"}, timeout=30)
    if r.status_code != 200:
        abort(f"fetching routes failed: {r.status_code} {r.text}")
    return r.json()


# ════════════════════════════════════ geometry glue ═══════════════════════════

def apply_geometry_patch(existing_holds, updates):
    """Merge a merge_board_holds.mjs-shaped --update list (geometry keys
    only) onto a full holds array, exactly matching what
    merge_board_holds.mjs --update would produce, without needing a
    round-trip to Supabase to see it. Used so later steps (guided
    re-outline, score_outline_fit) can operate on 'the holds as this run
    computed them' even under --dry-run, when nothing was actually
    committed yet."""
    by_id = {u["id"]: u for u in updates}
    out = []
    for h in existing_holds:
        u = by_id.get(h.get("id"))
        if not u:
            out.append(h)
            continue
        patched = dict(h)
        for k in GEOMETRY_KEYS:
            if k in u:
                patched[k] = u[k]
        out.append(patched)
    return out


def reproject_new_candidates(candidates, homography_new_to_reference, board_region, new_w, new_h):
    """Carry diff_new_holds.py's NEW-blob candidates (coordinates in the
    OLD reference photo's frame, via GrabCut on the aligned image) into the
    NEW photo's own frame — the exact same inverse-homography operation
    reproject_holds.py performs on existing holds, reusing its pct_to_px /
    px_to_pct primitives. reproject_holds.py's own CLI cannot be reused
    as-is here: it asserts the before/after ID SET is identical, which
    breaks with a TypeError the moment more than one candidate carries
    id=None (Python can't sort a list of Nones), and its --max-shift gate
    means 'this existing hold moved implausibly far', which has no
    meaning for a hold that didn't exist a moment ago. The transform
    itself — the only real 'logic' — is unchanged."""
    H_ref_to_new = np.linalg.inv(np.array(homography_new_to_reference, dtype=np.float64))

    def carry(pts_pct):
        px = np.array(
            [pct_to_px(x, y, board_region, new_w, new_h) for x, y in pts_pct], dtype=np.float64
        )
        out = cv2.perspectiveTransform(px.reshape(-1, 1, 2), H_ref_to_new).reshape(-1, 2)
        return [px_to_pct(x, y, board_region, new_w, new_h) for x, y in out]

    out = []
    for c in candidates:
        poly = c.get("polygon")
        if not poly or len(poly) < 3:
            continue
        new_poly = carry(poly)
        (ncx, ncy), = carry([(c["cx"], c["cy"])])
        xs = [p[0] for p in new_poly]
        ys = [p[1] for p in new_poly]
        reprojected = dict(c)
        reprojected.update({
            "cx": round(ncx, 2), "cy": round(ncy, 2),
            "polygon": [[round(x, 2), round(y, 2)] for x, y in new_poly],
            "w_pct": round(max(xs) - min(xs), 2), "h_pct": round(max(ys) - min(ys), 2),
        })
        out.append(reprojected)
    return out


def find_candidate_images(assets_dir, published_stem):
    if not assets_dir.exists():
        return []
    variant_re = re.compile(r"-(800|1200|2000)w\.jpg$", re.I)
    out = []
    for p in sorted(assets_dir.glob("*.jpg")):
        if p.name.startswith("_"):
            continue
        if variant_re.search(p.name):
            continue
        if published_stem and p.stem == published_stem:
            continue
        out.append(p)
    out.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return out


# ════════════════════════════════════ main ════════════════════════════════════

def build_argparser():
    ap = argparse.ArgumentParser(
        description="One-command board-image TWEAK: measure, reproject, apply, publish, "
                     "guided re-outline, review — see the module docstring for the full chain.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--board", required=True, metavar="SLUG", help="Board slug, e.g. the-barn")
    ap.add_argument("--image", default=None, metavar="PATH",
                     help="The new photo. Omit to auto-detect the newest unprocessed "
                          "*.jpg in board-assets/<slug>/.")
    ap.add_argument("--dry-run", action="store_true",
                     help="Run every measurement/analysis step for real; never call "
                          "merge_board_holds.mjs --commit or publish_board_image.py.")
    ap.add_argument("--min-inliers", type=int, default=100,
                     help="Forwarded to align_board_image.py --min-inliers (default 100).")
    ap.add_argument("--max-residual", type=float, default=3.0,
                     help="Forwarded to align_board_image.py --max-residual (default 3.0 px).")
    ap.add_argument("--max-shift", type=float, default=6.0,
                     help="Forwarded to reproject_holds.py --max-shift, board %% (default 6.0).")
    ap.add_argument("--iou-gate", type=float, default=0.85,
                     help="Guided re-outline apply gate: only holds where GrabCut and SAM "
                          "agree with IoU >= this are applied (default 0.85).")
    ap.add_argument("--review-top", type=int, default=15,
                     help="How many worst-ranked holds go in each review contact sheet (default 15).")
    ap.add_argument("--reset-ratio-threshold", type=float, default=0.5,
                     help="RESET-signal gate: abort if (new+changed+vanished blobs) / "
                          "live-hold-count exceeds this fraction (default 0.5 = 50%%).")
    ap.add_argument("--diff-min-area", type=int, default=150,
                     help="Forwarded to diff_new_holds.py --min-area (default 150, tuned for "
                          "The Barn's V7->V8 pair; override per-board if it's noisy).")
    ap.add_argument("--board-region", default=None, metavar="L,T,W,H",
                     help="Override the board region instead of reading boards.specs.boardRegion.")
    return ap


def main():
    args = build_argparser().parse_args()

    print(f"\n{'=' * 78}")
    print(f"  board_update.py — TWEAK pipeline")
    print(f"  board: {args.board}    mode: {'DRY-RUN (read-only)' if args.dry_run else 'LIVE'}")
    print(f"{'=' * 78}")

    node_bin = shutil.which("node")
    if not node_bin:
        abort("`node` not found on PATH — needed for backup_tables.mjs / merge_board_holds.mjs.")

    env = load_env()
    base_url = env.get("VITE_SUPABASE_URL", "").rstrip("/")
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not base_url or not service_key:
        abort("VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from .env.local "
              "(needed even for the read-only preflight checks).")
    headers = {"apikey": service_key, "Authorization": f"Bearer {service_key}"}

    # ── Preflight (read-only): resolve board, image, reference, dimensions ──
    t0 = step("Preflight — resolve board, image, and reference (no writes)")
    board = resolve_board(base_url, headers, args.board)
    board_id, board_slug, board_name = board["id"], board["slug"], board.get("name")
    log(f"board: {board_name or board_slug}  slug={board_slug}  id={board_id}")

    live_holds_before, holds_key = fetch_live_holds(base_url, headers, board_id)
    log(f"live hold count (before): {len(live_holds_before)}  (key={holds_key})")

    routes = fetch_routes(base_url, headers, board_id)
    total_hold_refs = sum(len((r.get("data") or {}).get("holds", {})) for r in routes)
    log(f"routes on this board: {len(routes)}  (hold references: {total_hold_refs})")

    image_cfg = fetch_image_config(base_url, headers, board_id)
    published_name = image_cfg.get("imageName") if image_cfg else None
    if not published_name:
        abort(f"board_image_config_{board_id} has no imageName — cannot determine the "
              f"currently-published photo to measure the camera move against.")
    log(f"currently published image: {published_name}")

    if args.board_region:
        parts = [float(v) for v in args.board_region.split(",")]
        board_region = {"left": parts[0], "top": parts[1], "width": parts[2], "height": parts[3]}
    else:
        specs_region = (board.get("specs") or {}).get("boardRegion")
        if specs_region:
            board_region = specs_region
        else:
            log(f"boards.specs.boardRegion missing — falling back to the app-wide default "
                f"({DEFAULT_BOARD_REGION}); pass --board-region to override.")
            parts = [float(v) for v in DEFAULT_BOARD_REGION.split(",")]
            board_region = {"left": parts[0], "top": parts[1], "width": parts[2], "height": parts[3]}
    board_region_str = f"{board_region['left']},{board_region['top']},{board_region['width']},{board_region['height']}"
    log(f"board region: {board_region_str}")

    assets_dir = REPO_ROOT / "board-assets" / board_slug

    # Resolve the new image path — explicit or auto-detect.
    if args.image:
        new_image = Path(args.image)
        if not new_image.is_absolute():
            new_image = REPO_ROOT / new_image
        if not new_image.exists():
            abort(f"--image path does not exist: {new_image}",
                  hint="Nothing was touched — this failed before the backup step.")
    else:
        candidates = find_candidate_images(assets_dir, Path(published_name).stem)
        if not candidates:
            abort(f"No unprocessed *.jpg found in {assets_dir} — drop the new photo there, "
                  f"or pass --image explicitly.")
        if len(candidates) > 1:
            listing = "\n".join(f"  - {p.name}  (mtime {datetime.fromtimestamp(p.stat().st_mtime)})"
                                 for p in candidates)
            abort(f"Ambiguous — {len(candidates)} candidate photos in {assets_dir}, "
                  f"not sure which is the new one:\n{listing}",
                  hint="Re-run with --image <path> naming the one you mean.")
        new_image = candidates[0]
    log(f"new image: {new_image}")

    # Resolve the reference (currently-published) image on disk.
    reference_image = assets_dir / f"{published_name}.jpg"
    if not reference_image.exists():
        legacy = REPO_ROOT / "public" / f"{published_name}.jpg"
        if legacy.exists():
            reference_image = legacy
        else:
            abort(f"Cannot find a local copy of the currently-published image "
                  f"'{published_name}.jpg' in {assets_dir} or public/ — the alignment step "
                  f"needs the exact file the live holds are calibrated to.")
    log(f"reference (published) image: {reference_image}")

    # ── Dimension gate: a size mismatch means a re-crop, not a tweak ──
    ref_w, ref_h = image_size(reference_image)
    new_w, new_h = image_size(new_image)
    log(f"reference size: {ref_w}x{ref_h}   new size: {new_w}x{new_h}")
    if (ref_w, ref_h) != (new_w, new_h):
        abort(
            f"New photo is {new_w}x{new_h} but the published photo is {ref_w}x{ref_h} — "
            f"different pixel dimensions mean a different crop/zoom, not a camera nudge.",
            hint="This tool only handles a TWEAK (same framing, camera moved a little). A "
                 "different frame size needs the board-image wizard (new boardRegion), not "
                 "this script. Nothing was touched — this failed before the backup step.",
        )
    step_done(t0, f"new image checks out against {published_name}")

    # ── Step 1: Backup (non-negotiable) ──
    t0 = step("Backup (non-negotiable — abort everything if this fails)")
    image_label = sanitize_label(new_image.stem)
    backup_label = f"pre-{board_slug}-{image_label}"
    rc, dt = run(["node", "--env-file=.env.local", "scripts/backup_tables.mjs", backup_label],
                 "backup_tables.mjs")
    if rc != 0:
        abort("Backup failed. Refusing to touch anything live without a fresh backup.")
    step_done(t0)

    work_prefix = assets_dir / f"_update_{image_label}"

    # ── Step 2: Measure the camera move (diagnostic warp only, never published) ──
    t0 = step("Measure the camera move (align_board_image.py — diagnostic only)")
    aligned_diag = f"{work_prefix}_aligned_diagnostic.jpg"
    cmd = [sys.executable, "scripts/align_board_image.py",
           "--reference", str(reference_image), "--new", str(new_image),
           "--output", aligned_diag,
           "--min-inliers", str(args.min_inliers), "--max-residual", str(args.max_residual)]
    rc, dt = run(cmd, "align_board_image.py")
    if rc != 0:
        abort("Alignment gate failed (too few inliers, or reprojection error too high). "
              "The camera move could not be measured reliably — nothing written live.")
    align_report = json.loads(Path(f"{aligned_diag}.align.json").read_text())
    disp = align_report["displacement"]["centre"]["magnitude"]
    log(f"inliers={align_report['match_report']['inliers']}  "
        f"mean_reproj_err={align_report['match_report']['mean_reprojection_error_px']:.3f}px  "
        f"centre displacement={disp:.2f}px")
    step_done(t0)

    # ── Step 3: Diff old vs new — also the RESET-signal check ──
    t0 = step("Diff old vs new photo (diff_new_holds.py) — also the RESET-signal check")
    live_holds_snapshot_path = f"{work_prefix}_live_holds_snapshot.json"
    Path(live_holds_snapshot_path).write_text(json.dumps(live_holds_before))
    diff_out = f"{work_prefix}_diff.json"
    diff_overlay = f"{work_prefix}_diff_overlay.jpg"
    cmd = [sys.executable, "scripts/diff_new_holds.py",
           "--reference", str(reference_image), "--aligned", aligned_diag,
           "--holds-file", live_holds_snapshot_path, "--board-region", board_region_str,
           "--min-area", str(args.diff_min_area),
           "--output", diff_out, "--overlay", diff_overlay]
    rc, dt = run(cmd, "diff_new_holds.py")
    if rc != 0:
        abort("diff_new_holds.py failed — cannot safely judge whether this is a TWEAK or a "
              "RESET without it. Nothing written live.")
    diff_data = json.loads(Path(diff_out).read_text())
    n_new = len(diff_data.get("candidates", []))
    n_changed = len(diff_data.get("changed", []))
    n_vanished = len(diff_data.get("vanished", []))
    n_interior = len(diff_data.get("interior", []))
    log(f"new candidates={n_new}  changed={n_changed}  vanished={n_vanished}  interior={n_interior}")
    step_done(t0)

    # ── Step 3b: RESET-signal gate — before any live write ──
    reset_ratio = (n_new + n_changed + n_vanished) / max(len(live_holds_before), 1)
    log(f"RESET-signal ratio (new+changed+vanished / live hold count): {reset_ratio:.3f}  "
        f"(abort threshold: {args.reset_ratio_threshold})")
    if reset_ratio > args.reset_ratio_threshold:
        abort(
            f"This looks like a RESET, not a TWEAK — {n_new + n_changed + n_vanished} of "
            f"{len(live_holds_before)} holds ({reset_ratio * 100:.1f}%) read as new/changed/"
            f"vanished between the published photo and the new one.",
            hint="Read docs/RESET_PROCESS_SPEC.md before proceeding — that process is designed "
                 "but NOT built, and this tool must not guess. An admin needs to decide this "
                 "explicitly. Nothing was written live.",
        )

    # ── Step 4: Reproject every hold outline into the new photo's frame ──
    t0 = step("Reproject hold outlines into the new photo's frame (reproject_holds.py)")
    reproject_out = f"{work_prefix}_reprojected.json"
    reproject_overlay = f"{work_prefix}_reprojected_overlay.jpg"
    cmd = [sys.executable, "scripts/reproject_holds.py",
           "--holds", live_holds_snapshot_path, "--align", f"{aligned_diag}.align.json",
           "--new-image", str(new_image), "--output", reproject_out,
           "--overlay", reproject_overlay, "--board-region", board_region_str,
           "--max-shift", str(args.max_shift)]
    rc, dt = run(cmd, "reproject_holds.py")
    if rc != 0:
        abort("Reprojection failed or its own sanity gate rejected the result (a hold moved "
              "further than --max-shift, or the ID set didn't come out identical). This can "
              "also indicate a RESET rather than a TWEAK — see docs/RESET_PROCESS_SPEC.md. "
              "Nothing written live.")
    reproject_data = json.loads(Path(reproject_out).read_text())
    n_reprojected = len(reproject_data["updates"])
    log(f"reprojected {n_reprojected} hold(s), {len(reproject_data.get('skipped_no_polygon', []))} skipped (no polygon)")
    step_done(t0)

    holds_after_reproject = apply_geometry_patch(live_holds_before, reproject_data["updates"])
    holds_after_reproject_path = f"{work_prefix}_holds_after_reproject.json"
    Path(holds_after_reproject_path).write_text(json.dumps(holds_after_reproject))

    def merge_update(update_file, label):
        """Always dry-run-validate first; --commit only in live mode, only
        after a clean dry run. Returns True if the (dry-run or committed)
        merge succeeded."""
        dry_cmd = ["node", "--env-file=.env.local", "scripts/merge_board_holds.mjs",
                   "--board", board_slug, "--update", str(update_file)]
        rc, _ = run(dry_cmd, f"{label} (dry-run validation)")
        if rc != 0:
            abort(f"{label}: dry-run validation failed. Nothing written.")
        if args.dry_run:
            log(f"[DRY-RUN] {label}: validated; --commit NOT sent.")
            return True
        rc, _ = run(dry_cmd + ["--commit"], f"{label} (COMMIT)")
        if rc != 0:
            abort(f"{label}: commit failed. See merge_board_holds.mjs output above for the "
                  f"exact restore command against the backup it just wrote.")
        return True

    # ── Step 5: Apply reprojected geometry ──
    t0 = step("Apply reprojected geometry (merge_board_holds.mjs --update)")
    if n_reprojected:
        merge_update(reproject_out, "Apply reprojected geometry")
    else:
        log("nothing to apply (no holds had a usable polygon to reproject)")
    step_done(t0)

    # ── Step 6: Publish the RAW photo ──
    t0 = step("Publish the RAW photo (publish_board_image.py)")
    if args.dry_run:
        log("[DRY-RUN] SKIPPED — publish_board_image.py has no dry-run mode of its own "
            "(it always uploads + writes board_settings), so this run does not call it at all.")
    else:
        publish_stem = new_image.stem
        target = assets_dir / f"{publish_stem}.jpg"
        if new_image.resolve() != target.resolve():
            assets_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(new_image, target)
            log(f"copied new image into {target} for publish_board_image.py's expected layout")
        cmd = [sys.executable, "scripts/publish_board_image.py", publish_stem, "--board", board_slug]
        rc, dt = run(cmd, "publish_board_image.py")
        if rc != 0:
            abort(f"Publish failed. IMPORTANT: step 5 already applied the reprojected hold "
                  f"geometry, so the app's holds now match the NEW photo's framing while the "
                  f"OLD photo may still be live. Re-run: "
                  f"`python3 scripts/publish_board_image.py {publish_stem} --board {board_slug}` "
                  f"by hand to finish.")
    step_done(t0)

    # ── Step 7/8: Guided re-outline, gated to IoU >= 0.85 ──
    t0 = step("Guided re-outline (SAM+GrabCut consensus) — best-effort")
    guided_ok = False
    gated_count = 0
    holds_final_local = holds_after_reproject
    if not VENV_PYTHON.exists():
        log(f"[SKIP] {VENV_PYTHON} not found — this is an ephemeral dev venv (torch + "
            f"ultralytics + a SAM checkpoint) that doesn't survive a reboot and can't be "
            f"assumed present for an unattended run. The core TWEAK (steps 1-6) already "
            f"completed safely; skipping this refinement pass.")
    else:
        guided_out = f"{work_prefix}_guided_updates.json"
        guided_review_dir = f"{work_prefix}_guided_review"
        cmd = [str(VENV_PYTHON), "scripts/guided_reoutline.py",
               "--holds-file", holds_after_reproject_path, "--image", str(new_image),
               "--output", guided_out, "--review-dir", guided_review_dir,
               "--top", str(args.review_top), "--board-region", board_region_str]
        rc, dt = run(cmd, "guided_reoutline.py")
        if rc != 0:
            log("[WARN] guided_reoutline.py failed — continuing without it (non-fatal; "
                "steps 1-6 already completed safely).")
        else:
            guided_ok = True
            guided_data = json.loads(Path(guided_out).read_text())
            review_data = json.loads((Path(guided_review_dir) / "review.json").read_text())
            iou_by_id = {row["id"]: (row["iou"] if row["iou"] is not None else 0.0)
                         for row in review_data["sorted_worst_first_by_iou"]}
            gated_updates = [u for u in guided_data["updates"]
                              if iou_by_id.get(u["id"], 0.0) >= args.iou_gate]
            gated_count = len(gated_updates)
            log(f"guided re-outline: {len(guided_data['updates'])} sanity-gate-passed "
                f"proposal(s) -> {gated_count} passed the IoU>={args.iou_gate} agreement gate")
            gated_out = f"{work_prefix}_guided_updates_gated.json"
            Path(gated_out).write_text(json.dumps({
                "note": f"guided re-outline, gated to IoU>={args.iou_gate} (methods agree)",
                "generatedAt": datetime.now(timezone.utc).isoformat(),
                "updates": gated_updates,
            }, indent=2))
            if gated_count:
                merge_update(gated_out, "Apply gated guided re-outline updates")
                holds_final_local = apply_geometry_patch(holds_after_reproject, gated_updates)
            else:
                log("no holds passed the IoU agreement gate — nothing to apply")
    step_done(t0)

    holds_final_local_path = f"{work_prefix}_holds_final.json"
    Path(holds_final_local_path).write_text(json.dumps(holds_final_local))

    # ── Step 9: New-hold candidates — reprojected, NEVER auto-added ──
    t0 = step("New-hold candidates — reprojected for review, never auto-added")
    candidates_review_path = None
    if n_new:
        reprojected_candidates = reproject_new_candidates(
            diff_data["candidates"], align_report["homography_new_to_reference"],
            board_region, new_w, new_h,
        )
        candidates_review_path = f"{work_prefix}_new_hold_candidates_for_review.json"
        Path(candidates_review_path).write_text(json.dumps({
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "note": "Possible NEW holds found by diff_new_holds.py, reprojected into the new "
                    "photo's frame. NOT added to the live board — review each one, then add "
                    "the real ones by hand in Hold Manager (or via merge_board_holds.mjs --add "
                    "after manually vetting). A false positive here is clutter you delete; a "
                    "missed one costs nothing.",
            "board": board_slug, "image": str(new_image),
            "candidates": reprojected_candidates,
        }, indent=2))
        log(f"{len(reprojected_candidates)} possible new hold(s) -> {candidates_review_path}")
    else:
        log("no new-hold candidates found")
    step_done(t0)

    # ── Step 9b: score_outline_fit.py — independent review ranking, best-effort ──
    t0 = step("Score outline fit (score_outline_fit.py) — best-effort review ranking")
    score_ok = False
    score_out = f"{work_prefix}_outline_fit.json"
    score_overlay = f"{work_prefix}_outline_fit_review.jpg"
    score_script = REPO_ROOT / "scripts" / "score_outline_fit.py"
    if not score_script.exists():
        log("[SKIP] scripts/score_outline_fit.py not found — skipping with a warning per spec "
            "(this step was being built in parallel with this one).")
    else:
        cmd = [sys.executable, str(score_script),
               "--holds-file", holds_final_local_path, "--image", str(new_image),
               "--output", score_out, "--overlay", score_overlay,
               "--top", str(args.review_top), "--board-region", board_region_str]
        rc, dt = run(cmd, "score_outline_fit.py")
        if rc != 0:
            log("[WARN] score_outline_fit.py failed — continuing without a scored review list.")
        else:
            score_ok = True
    step_done(t0)

    # ── Verification re-read (post-run) ──
    live_holds_after, _ = fetch_live_holds(base_url, headers, board_id)
    routes_after = fetch_routes(base_url, headers, board_id)
    dangling_after = sorted({
        hid for r in routes_after for hid in (r.get("data") or {}).get("holds", {})
        if hid not in {h["id"] for h in live_holds_after}
    } - {"custom_hold_9"})  # the one known pre-existing dangling ref

    # ── Final summary + report ──
    total_dt = elapsed()
    print(f"\n{'=' * 78}\n  SUMMARY\n{'=' * 78}")
    print(f"  board             : {board_name or board_slug} ({board_slug})")
    print(f"  mode              : {'DRY-RUN — nothing written live' if args.dry_run else 'LIVE'}")
    print(f"  new image         : {new_image.name}  ({new_w}x{new_h})")
    print(f"  reference image   : {reference_image.name}")
    print(f"  camera displacement (centre): {disp:.2f}px")
    print(f"  hold count        : {len(live_holds_before)} -> {len(live_holds_after)}")
    print(f"  holds reprojected : {n_reprojected}")
    print(f"  guided re-outline : {'ran, ' + str(gated_count) + ' applied after IoU gate' if guided_ok else 'skipped'}")
    print(f"  new-hold candidates for review: {n_new}")
    print(f"  changed / vanished: {n_changed} / {n_vanished}")
    print(f"  outline-fit scoring: {'ran' if score_ok else 'skipped'}")
    print(f"  dangling hold refs (new, excl. known custom_hold_9): {len(dangling_after)}")
    print(f"  total run time    : {total_dt:.1f}s")

    report_path = assets_dir / "_update_report.md"
    report_lines = [
        f"# Board update report — {board_slug}",
        "",
        f"Generated: {datetime.now(timezone.utc).isoformat()}",
        f"Mode: {'DRY-RUN (nothing written live)' if args.dry_run else 'LIVE'}",
        "",
        f"- New image: `{new_image}` ({new_w}x{new_h})",
        f"- Reference (published) image: `{reference_image}` ({ref_w}x{ref_h})",
        f"- Camera displacement (centre): {disp:.2f}px, "
        f"{align_report['match_report']['inliers']} RANSAC inliers",
        f"- Hold count: {len(live_holds_before)} -> {len(live_holds_after)}",
        f"- Holds reprojected (geometry only, IDs preserved): {n_reprojected}",
        f"- Guided re-outline: {'ran — ' + str(gated_count) + ' of ' + (str(len(guided_data['updates'])) if guided_ok else '0') + ' applied after IoU>=' + str(args.iou_gate) + ' gate' if guided_ok else 'SKIPPED (see warning above / VENV_PYTHON missing)'}",
        f"- New-hold candidates (NOT added — needs owner review): {n_new}"
        + (f" — see `{Path(candidates_review_path).name}`" if candidates_review_path else ""),
        f"- Changed regions: {n_changed}    Vanished holds: {n_vanished}    Interior (ambiguous): {n_interior}",
        f"- RESET-signal ratio: {reset_ratio:.3f} (threshold {args.reset_ratio_threshold})",
        f"- Outline-fit scoring: {'ran — see ' + Path(score_overlay).name if score_ok else 'skipped'}",
        f"- Dangling hold refs introduced by this run: {len(dangling_after)}"
        + (f" — {', '.join(dangling_after)}" if dangling_after else " (none)"),
        "",
        "## Review images",
        f"- Reprojection overlay: `{Path(reproject_overlay).name}`",
        f"- Diff overlay (new/changed/vanished): `{Path(diff_overlay).name}`",
    ]
    if guided_ok:
        report_lines.append(f"- Guided re-outline contact sheet: `_update_{image_label}_guided_review/review_sorted.png`")
    if score_ok:
        report_lines.append(f"- Outline-fit worst-N contact sheet: `{Path(score_overlay).name}`")
    if candidates_review_path:
        report_lines.append(f"- New-hold candidates to review by hand: `{Path(candidates_review_path).name}`")
    report_lines += [
        "",
        "## What needs the owner's eye",
        "- Every file above listed under \"Review images\" — none of this was auto-applied "
        "without a gate, but a gate passing isn't the same as \"definitely right\".",
        "- New-hold candidates, if any: add the real ones by hand in Hold Manager.",
    ]
    if not guided_ok:
        report_lines.append("- Guided re-outline did not run this time (see the run log) — "
                             "geometry only reflects the plain reprojection, not the SAM/GrabCut refinement.")
    report_path.write_text("\n".join(report_lines) + "\n")
    log(f"wrote {report_path}")

    if dangling_after:
        print(f"\n⚠ WARNING: this run appears to have introduced {len(dangling_after)} new "
              f"dangling hold reference(s): {', '.join(dangling_after)}. merge_board_holds.mjs "
              f"should have refused any write that caused this — investigate before trusting "
              f"this run's result.")

    print(f"\n{'DRY-RUN complete — nothing was written live.' if args.dry_run else 'LIVE run complete.'}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Abort as e:
        sys.exit(e.code)
    except KeyboardInterrupt:
        print("\nInterrupted.")
        sys.exit(130)
