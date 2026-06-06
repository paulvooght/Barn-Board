#!/usr/bin/env python3
"""
upload_board_setting.py — upsert a JSON file into board_settings[<key>].

Board-generic helper for getting locally-generated per-board data (e.g. the
tap-candidate library) into Supabase, using the service-role key from .env.local
(same pattern as publish_board_image.py). The `data` column receives the file's
JSON verbatim.

Run
---
  python3 scripts/upload_board_setting.py \
      --key hold_candidates_275dfaa7-1df9-4fe7-8332-c2795eb9ebe7 \
      --file /tmp/yonder_candidates.json

Environment (.env.local at repo root): VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
"""
import argparse
import json
import sys
from pathlib import Path

try:
    import requests
except ImportError:
    print("Error: `requests` not installed (pip install requests)."); sys.exit(1)

REPO_ROOT = Path(__file__).resolve().parents[1]


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


def main():
    ap = argparse.ArgumentParser(description="Upsert a JSON file into board_settings[key].")
    ap.add_argument("--key", required=True, help="board_settings key, e.g. hold_candidates_<boardId>")
    ap.add_argument("--file", required=True, help="path to JSON file to store in the data column")
    args = ap.parse_args()

    env = load_env()
    base = env.get("VITE_SUPABASE_URL", "").rstrip("/")
    key = env.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not base:
        print("Error: VITE_SUPABASE_URL not set in .env.local"); sys.exit(1)
    if not key:
        print("Error: SUPABASE_SERVICE_ROLE_KEY not set in .env.local"); sys.exit(1)

    fp = Path(args.file)
    if not fp.is_absolute():
        fp = Path.cwd() / fp
    if not fp.exists():
        print(f"Error: file not found: {fp}"); sys.exit(1)
    data = json.loads(fp.read_text())

    url = f"{base}/rest/v1/board_settings"
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    payload = [{"key": args.key, "data": data}]
    r = requests.post(url, headers=headers, json=payload, timeout=30)
    if r.status_code not in (200, 201, 204):
        print(f"Error upserting {args.key}: {r.status_code} {r.text}"); sys.exit(1)
    size = len(json.dumps(data))
    print(f"OK — upserted board_settings['{args.key}'] ({size} bytes).")


if __name__ == "__main__":
    main()
