#!/usr/bin/env python3
"""
encode_board_embedding.py — make + upload a wall's SAM "fingerprint" (embedding).

This is the server-side HEAVY half of the tap-anything tool: run the MobileSAM
image encoder ONCE over a wall's board photo to produce its image embedding, then
host it so the browser can run the small decoder against it on every tap.

Board-generic (multi-wall). Mirrors publish_board_image.py:
  * reads board-assets/<slug>/<image_name>.jpg  (the SAME full image the app serves)
  * uploads the embedding to the board-images bucket at  embeddings/<board_id>.bin
  * upserts board_settings['sam_embedding_<board_id>'] = { path, url, shape,
    dtype, orig_h, orig_w, model, cacheVersion } — the pointer the app reads.

Run (in the detection venv):
    /tmp/holds_venv/bin/python scripts/encode_board_embedding.py Yonder_Set_01_V1 --board yonder

Env (.env.local): VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (service-role,
local-dev only — never in Vercel).  Deps: torch, segment-anything, samexporter,
opencv-python, numpy, requests (all in scripts/requirements-detect.txt's venv).

NOTE: the embedding is computed in the FULL image's pixel space (orig_w x orig_h).
The app converts decoder masks (px) -> board-% via boards.specs.boardRegion, so the
displayed responsive variant's size is irrelevant — only orig_w/orig_h matter, and
they're stored in the pointer.
"""
import argparse
import re
import sys
import time
import warnings
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

try:
    import cv2
    import requests
    import torch
except ImportError as e:
    raise SystemExit(f"Missing dep ({e}); use the detection venv (requirements-detect.txt).")

warnings.filterwarnings("ignore")
from samexporter.mobile_encoder.setup_mobile_sam import setup_model
from segment_anything import SamPredictor

REPO_ROOT = Path(__file__).resolve().parents[1]
BUCKET = "board-images"


def load_env():
    env, p = {}, REPO_ROOT / ".env.local"
    if p.exists():
        for line in p.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def resolve_board(base, headers, board_arg):
    is_uuid = bool(re.match(r"^[0-9a-f]{8}-[0-9a-f]{4}-", board_arg, re.I))
    field = "id" if is_uuid else "slug"
    r = requests.get(f"{base}/rest/v1/boards?{field}=eq.{board_arg}&select=id,slug,name",
                     headers={**headers, "Accept": "application/json"}, timeout=15)
    if r.status_code != 200 or not r.json():
        raise SystemExit(f"Board '{board_arg}' not found ({r.status_code}).")
    row = r.json()[0]
    return row["id"], row["slug"], row.get("name")


def main():
    ap = argparse.ArgumentParser(description="Encode + upload a wall's SAM embedding.")
    ap.add_argument("image_name", help="Base name, e.g. Yonder_Set_01_V1 (no extension).")
    ap.add_argument("--board", required=True, help="Board slug or uuid (embeddings are per-wall).")
    ap.add_argument("--assets-dir", default=None, help="Override source dir (default board-assets/<slug>).")
    ap.add_argument("--checkpoint", default=str(REPO_ROOT / "mobile_sam.pt"))
    args = ap.parse_args()

    env = load_env()
    base = env.get("VITE_SUPABASE_URL", "").rstrip("/")
    key = env.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not base or not key:
        raise SystemExit("VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local.")
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}

    board_id, slug, name = resolve_board(base, headers, args.board)
    src_dir = Path(args.assets_dir) if args.assets_dir else (REPO_ROOT / "board-assets" / slug)
    img_path = src_dir / f"{args.image_name}.jpg"
    if not img_path.exists():
        raise SystemExit(f"Image not found: {img_path}")
    print(f"Board : {name or slug}  ({slug} / {board_id})")
    print(f"Image : {img_path}")

    # ── 1. encode (TinyViT, CPU) ─────────────────────────────────────────────
    img = cv2.cvtColor(cv2.imread(str(img_path)), cv2.COLOR_BGR2RGB)
    H, W = img.shape[:2]
    print(f"Building MobileSAM + encoding {W}x{H} (CPU, ~a few seconds) ...")
    sam = setup_model()
    sam.load_state_dict(torch.load(args.checkpoint, map_location="cpu"), strict=True)
    sam.cpu().eval()
    predictor = SamPredictor(sam)
    predictor.set_image(img)
    emb = predictor.get_image_embedding().cpu().numpy().astype(np.float32)  # (1,256,64,64)
    print(f"  embedding {emb.shape} dtype {emb.dtype} ({emb.nbytes/1e6:.1f} MB)")

    # ── 2. upload embedding to storage ───────────────────────────────────────
    object_name = f"embeddings/{board_id}.bin"
    up_url = f"{base}/storage/v1/object/{BUCKET}/{object_name}"
    print(f"Uploading -> {BUCKET}/{object_name} ...")
    r = requests.post(up_url, headers={**headers, "Content-Type": "application/octet-stream",
                                       "x-upsert": "true"}, data=emb.tobytes(), timeout=180)
    if r.status_code not in (200, 201):
        raise SystemExit(f"Upload failed: {r.status_code} {r.text}")
    public_url = f"{base}/storage/v1/object/public/{BUCKET}/{object_name}"

    # ── 3. upsert the pointer board_settings['sam_embedding_<id>'] ────────────
    pointer = {
        "model": "mobile_sam",
        "bucket": BUCKET,
        "path": object_name,
        "url": public_url,
        "shape": list(emb.shape),     # [1,256,64,64]
        "dtype": "float32",
        "orig_w": int(W),
        "orig_h": int(H),
        "imageName": args.image_name,
        "cacheVersion": int(time.time() * 1000),
        "updatedAt": datetime.now(timezone.utc).isoformat(),
    }
    cfg_key = f"sam_embedding_{board_id}"
    rr = requests.post(f"{base}/rest/v1/board_settings",
                       headers={**headers, "Content-Type": "application/json",
                                "Prefer": "resolution=merge-duplicates,return=minimal"},
                       json={"key": cfg_key, "data": pointer}, timeout=30)
    if rr.status_code not in (200, 201, 204):
        raise SystemExit(f"Pointer upsert failed: {rr.status_code} {rr.text}")

    print("\n=== Done ===")
    print(f"  Embedding URL : {public_url}")
    print(f"  Pointer key   : {cfg_key}")
    print(f"  orig size     : {W}x{H}")
    print("  The app's Tap tool will use it on next Hold-Manager open (or tab switch).")


if __name__ == "__main__":
    main()
