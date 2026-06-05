#!/usr/bin/env python3
"""
Publish a board image to Supabase storage so code-based image updates
flow through the same board_image_config as in-app-wizard updates.

Run this as the final step after detect_holds.py + merge_holds.py:

    # Per-wall (multi-wall): reads board-assets/<slug>/, writes board_image_config_<id>
    python3 scripts/publish_board_image.py Yonder_Set_01_V1 --board yonder

    # Legacy global Barn flow (reads public/, writes board_image_config):
    python3 scripts/publish_board_image.py Barn_Set_01_V8

The script:
  1. Reads {src_dir}/{name}.jpg — board-assets/<slug>/ with --board, else public/.
  2. Generates the missing responsive variants (-800w, -1200w, -2000w) using
     Pillow and saves them back into {src_dir} so they get committed too.
  3. Uploads all four JPEGs to the board-images Supabase storage bucket.
  4. Upserts board_settings under board_image_config_<id> (per-board, with --board)
     or board_image_config (legacy global) — the shape App.jsx reads, so whichever
     update (wizard or code) ran last wins.

Requirements:
    pip install Pillow requests
    (numpy and opencv-python-headless are already required by detect_holds.py)

Environment (in .env.local at repo root):
    VITE_SUPABASE_URL       — Supabase project URL
    SUPABASE_SERVICE_ROLE_KEY — service-role key (bypasses RLS for storage +
                               table writes). Do NOT put this in Vercel env vars;
                               it is local-dev-only. The app uses the anon key.
"""

import argparse
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    print("Error: Pillow is not installed.")
    print("  pip install Pillow")
    sys.exit(1)

try:
    import requests
except ImportError:
    print("Error: requests is not installed.")
    print("  pip install requests")
    sys.exit(1)


# ─── Helpers ──────────────────────────────────────────────────────────────────

REPO_ROOT = Path(__file__).resolve().parent.parent
PUBLIC_DIR = REPO_ROOT / "public"
WIDTHS = [800, 1200, 2000]


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


def make_variant(source: Image.Image, target_width: int) -> Image.Image:
    """Resize image to target_width, preserving aspect ratio."""
    orig_w, orig_h = source.size
    ratio = target_width / orig_w
    target_h = round(orig_h * ratio)
    return source.resize((target_width, target_h), Image.LANCZOS)


def ensure_variants(name: str, src_dir: Path):
    """
    Check for the three responsive variants in src_dir.
    Generate any that are missing from the full-size JPEG.
    Returns a list of all four paths (full + variants) in upload order.
    """
    full_path = src_dir / f"{name}.jpg"
    if not full_path.exists():
        print(f"Error: {full_path} not found.")
        print(f"  Place the full-size JPEG at {src_dir}/{name}.jpg before running this script.")
        sys.exit(1)

    paths = [full_path]
    missing = []
    for w in WIDTHS:
        p = src_dir / f"{name}-{w}w.jpg"
        paths.append(p)
        if not p.exists():
            missing.append((w, p))

    if missing:
        print(f"Generating {len(missing)} missing variant(s) from {full_path.name} ...")
        source = Image.open(full_path)
        if source.mode != "RGB":
            source = source.convert("RGB")
        for w, p in missing:
            variant = make_variant(source, w)
            variant.save(p, "JPEG", quality=85, progressive=True, optimize=True)
            print(f"  Saved {p.name} ({variant.size[0]}×{variant.size[1]})")
    else:
        print("All responsive variants already present.")

    return paths


def check_bucket(base_url: str, bucket: str, headers: dict):
    """Ensure the bucket exists; create it as public if not."""
    url = f"{base_url}/storage/v1/bucket/{bucket}"
    r = requests.get(url, headers=headers, timeout=15)
    if r.status_code == 200:
        return  # already exists
    if r.status_code == 400 and "not found" in r.text.lower():
        # Create as public bucket
        r2 = requests.post(
            f"{base_url}/storage/v1/bucket",
            headers={**headers, "Content-Type": "application/json"},
            json={"id": bucket, "name": bucket, "public": True},
            timeout=15,
        )
        if r2.status_code in (200, 201):
            print(f"  Created bucket '{bucket}' (public).")
        else:
            print(f"Error: failed to create bucket '{bucket}': {r2.status_code} {r2.text}")
            sys.exit(1)
    else:
        print(f"Error checking bucket '{bucket}': {r.status_code} {r.text}")
        sys.exit(1)


def upload_file(base_url: str, bucket: str, file_path: Path, headers: dict) -> str:
    """
    Upload a single file to Supabase storage (upsert).
    Returns the public URL.
    """
    object_name = file_path.name
    url = f"{base_url}/storage/v1/object/{bucket}/{object_name}"

    with open(file_path, "rb") as fh:
        data = fh.read()

    upload_headers = {
        **headers,
        "Content-Type": "image/jpeg",
        "x-upsert": "true",
    }
    r = requests.post(url, headers=upload_headers, data=data, timeout=120)
    if r.status_code not in (200, 201):
        print(f"Error uploading {object_name}: {r.status_code} {r.text}")
        sys.exit(1)

    public_url = f"{base_url}/storage/v1/object/public/{bucket}/{object_name}"
    return public_url


def resolve_board(base_url: str, headers: dict, board_arg: str):
    """
    Resolve a --board argument (slug or uuid) to (id, slug, name) via PostgREST.
    Exits with an error if the board doesn't exist.
    """
    is_uuid = bool(re.match(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-", board_arg, re.I))
    field = "id" if is_uuid else "slug"
    url = f"{base_url}/rest/v1/boards?{field}=eq.{board_arg}&select=id,slug,name"
    r = requests.get(url, headers={**headers, "Accept": "application/json"}, timeout=15)
    if r.status_code != 200:
        print(f"Error resolving board '{board_arg}': {r.status_code} {r.text}")
        sys.exit(1)
    rows = r.json()
    if not rows:
        print(f"Error: no board with {field}='{board_arg}'. Create the boards row first.")
        sys.exit(1)
    row = rows[0]
    return row["id"], row["slug"], row.get("name")


def upsert_config(base_url: str, name: str, headers: dict, config_key: str):
    """
    Upsert the board image config row in board_settings under config_key
    (per-board: board_image_config_<id>; legacy global: board_image_config).
    The data shape must match what App.jsx reads.
    """
    now_ms = int(time.time() * 1000)
    config = {
        "imageName": name,
        "baseUrl": f"{base_url}/storage/v1/object/public/board-images",
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "cacheVersion": now_ms,
    }

    # PostgREST upsert via REST API
    url = f"{base_url}/rest/v1/board_settings"
    rest_headers = {
        **headers,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    payload = {"key": config_key, "data": config}
    r = requests.post(url, headers=rest_headers, json=payload, timeout=15)
    if r.status_code not in (200, 201, 204):
        print(f"Error upserting {config_key}: {r.status_code} {r.text}")
        sys.exit(1)

    return config


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description=(
            "Publish a board image to Supabase storage and write board_image_config. "
            "Run after detect_holds.py + merge_holds.py as the final step of a code-based "
            "board image update."
        )
    )
    parser.add_argument(
        "image_name",
        metavar="IMAGE_NAME",
        help="Base name of the image without extension, e.g. Yonder_Set_01_V1",
    )
    parser.add_argument(
        "--board",
        default=None,
        metavar="SLUG_OR_ID",
        help=(
            "Board slug (e.g. 'yonder') or uuid. Writes the per-board key "
            "board_image_config_<id> and reads the image from board-assets/<slug>/. "
            "Omit ONLY for the legacy global Barn flow (writes board_image_config)."
        ),
    )
    parser.add_argument(
        "--assets-dir",
        default=None,
        metavar="PATH",
        help="Override the source directory for the image + variants.",
    )
    args = parser.parse_args()
    name = args.image_name

    # ── 1. Load environment ──────────────────────────────────────────────
    env = load_env()
    supabase_url = env.get("VITE_SUPABASE_URL", "").rstrip("/")
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY", "")

    if not supabase_url:
        print("Error: VITE_SUPABASE_URL is not set in .env.local.")
        sys.exit(1)

    if not service_key:
        print("Error: SUPABASE_SERVICE_ROLE_KEY is not set in .env.local.")
        print()
        print("  Add this line to your .env.local at the repo root:")
        print("    SUPABASE_SERVICE_ROLE_KEY=eyJ...")
        print()
        print("  Find it in the Supabase dashboard: Project Settings → API → service_role key.")
        print("  IMPORTANT: Do NOT add this key to Vercel environment variables.")
        print("  It is for local developer use only. The app uses the anon key (VITE_SUPABASE_ANON_KEY).")
        sys.exit(1)

    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
    }

    bucket = "board-images"

    # ── 1b. Resolve target board → config key + source dir ───────────────
    if args.board:
        board_id, board_slug, board_name = resolve_board(supabase_url, headers, args.board)
        config_key = f"board_image_config_{board_id}"
        src_dir = Path(args.assets_dir) if args.assets_dir else (REPO_ROOT / "board-assets" / board_slug)
        print(f"Target board : {board_name or board_slug}  ({board_slug} / {board_id})")
        print(f"Config key   : {config_key}")
    else:
        config_key = "board_image_config"
        src_dir = Path(args.assets_dir) if args.assets_dir else PUBLIC_DIR
        print("⚠  No --board given — writing the LEGACY GLOBAL key 'board_image_config'")
        print("   (app fallback only). Pass --board <slug> for a per-wall publish.")
    print(f"Source dir   : {src_dir}")

    # ── 2. Ensure responsive variants exist in the source dir ────────────
    print(f"\n=== Board image publish: {name} ===\n")
    print("Step 1/3 — Checking responsive variants ...")
    paths = ensure_variants(name, src_dir)

    # ── 3. Check / create bucket ─────────────────────────────────────────
    print("\nStep 2/3 — Uploading to Supabase storage ...")
    check_bucket(supabase_url, bucket, headers)

    uploaded_urls = []
    for path in paths:
        url = upload_file(supabase_url, bucket, path, headers)
        uploaded_urls.append(url)
        size_kb = path.stat().st_size // 1024
        print(f"  Uploaded {path.name} ({size_kb} KB)")

    # ── 4. Upsert config ─────────────────────────────────────────────────
    print(f"\nStep 3/3 — Writing {config_key} to board_settings ...")
    config = upsert_config(supabase_url, name, headers, config_key)

    # ── 5. Success summary ───────────────────────────────────────────────
    print("\n=== Done ===")
    print(f"  Image name  : {config['imageName']}")
    print(f"  Base URL    : {config['baseUrl']}")
    print(f"  Updated at  : {config['updatedAt']}")
    print(f"  Cache ver   : {config['cacheVersion']}")
    print(f"\n  Files uploaded ({len(uploaded_urls)}):")
    for u in uploaded_urls:
        print(f"    {u}")
    print(f"  Config key  : {config_key}")
    print(
        f"\n  {config_key} written. The app will use the new image on next load "
        "(or tab switch on already-open devices)."
    )


if __name__ == "__main__":
    main()
