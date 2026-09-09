#!/usr/bin/env python3
"""
LEGACY — operates on the src/data/holds.json BASE-HOLD model only
(`hold_N` IDs). This is NOT the tool for any wall's live per-board hold
array — those all live in Supabase board_settings['holds_<boardId>'] and,
for every wall that exists today, are entirely `custom_*` IDs. Running this
script against a live per-board export would have its `custom_` exclusion
filter (see `merge_holds()` below) throw away every existing hold and mint
fresh `hold_N` IDs in their place — silently destroying every route's hold
references. A guard against that is built in (see `merge_holds()`), but the
real fix is: don't use this script for that job.

For live per-board holds (adding newly-detected holds, or re-fitting the
geometry of holds that moved), use `scripts/merge_board_holds.mjs` instead —
it is ID-safe by construction (append-only / geometry-only-update, with
before/after invariant checks and a pre-write backup).

Kept as-is for its documented purpose: The Barn's legacy revert/reseed path,
merging a freshly detected holds file into an existing holds.json, preserving
hold IDs for spatially matched holds so that existing routes continue to
reference the correct physical holds.

Usage:
    python3 scripts/merge_holds.py <existing_file> <new_file> [options]

Arguments:
    existing_file       Current holds.json (updated in-place unless --dry-run)
    new_file            Freshly detected holds from detect_holds.py --output

Options:
    --threshold FLOAT       Max distance (board %) for a spatial match (default: 5.0)
    --update-positions      Update matched holds' cx/cy/polygon to new detection values
    --dry-run               Print report without modifying any files
    --allow-custom-loss     Escape hatch: proceed even though the custom_
                            exclusion filter is about to drop most/all of the
                            "existing" holds (see the guard in merge_holds()).
                            Only pass this if you are SURE `existing_file` is
                            genuinely the legacy hold_N base-hold model and
                            the custom_ holds it contains are meant to be
                            dropped from this merge.

Example workflow after a board image replacement:
    python3 scripts/detect_holds.py --output src/data/holds_new.json
    python3 scripts/merge_holds.py src/data/holds.json src/data/holds_new.json --dry-run
    python3 scripts/merge_holds.py src/data/holds.json src/data/holds_new.json
"""

import json
import math
import sys
import argparse
from pathlib import Path


def euclidean(a, b):
    return math.hypot(a['cx'] - b['cx'], a['cy'] - b['cy'])


def merge_holds(existing_data, new_data, threshold=5.0, update_positions=False,
                 allow_custom_loss=False):
    """
    Spatially match new detections to existing holds.

    Returns:
        merged_holds    — list of hold dicts with correct IDs
        report          — dict with match details for printing
    """
    all_existing = existing_data['holds']
    existing_holds = [h for h in all_existing if not h['id'].startswith('custom_')]

    # Guard against the landmine this script used to be: every live per-board
    # hold array (board_settings['holds_<boardId>']) is 100% `custom_*` IDs
    # today, so the exclusion filter above would silently drop the whole
    # thing and mint fresh hold_N IDs — scrambling every route's hold
    # references. If most/all of `existing_file`'s holds are being dropped
    # this way, that's a strong signal this isn't the legacy hold_N file this
    # script expects.
    dropped = len(all_existing) - len(existing_holds)
    if dropped > 0:
        print(f'\n⚠ WARNING: {dropped} of {len(all_existing)} hold(s) in the existing '
              f"file are `custom_*` and are being EXCLUDED from this merge "
              f"(their IDs will not be preserved).")
        if dropped >= len(all_existing) or dropped > len(all_existing) / 2:
            if not allow_custom_loss:
                print(
                    f"\n✗ ABORT: this would drop {dropped}/{len(all_existing)} holds — "
                    f"most or all of the existing file. That means `existing_file` is a "
                    f"live per-board hold export (all-custom_ IDs), not the legacy "
                    f"src/data/holds.json base-hold model this script operates on.\n\n"
                    f"  Use scripts/merge_board_holds.mjs instead — it is the ID-safe "
                    f"tool for live per-board holds (--add to append, --update to re-fit "
                    f"geometry), and ships with before/after invariant checks + a backup.\n\n"
                    f"  If you really do mean to discard these custom_ holds from this "
                    f"legacy merge, re-run with --allow-custom-loss."
                )
                sys.exit(1)
            print('  --allow-custom-loss passed: proceeding anyway.')

    new_detections = new_data['holds']

    # Find max numeric ID in existing holds
    max_existing_num = 0
    for h in existing_holds:
        parts = h['id'].split('_')
        if len(parts) == 2 and parts[1].isdigit():
            max_existing_num = max(max_existing_num, int(parts[1]))

    # --- Greedy nearest-neighbour matching ---
    # For each new detection, find nearest existing hold within threshold.
    # Resolve conflicts (two new detections → same existing hold) by
    # keeping the closer match.

    # candidate_matches: existing_id → (distance, new_detection)
    candidate_matches = {}

    for new_hold in new_detections:
        best_dist = threshold
        best_existing = None
        for ex_hold in existing_holds:
            d = euclidean(ex_hold, new_hold)
            if d < best_dist:
                best_dist = d
                best_existing = ex_hold

        if best_existing is not None:
            ex_id = best_existing['id']
            if ex_id not in candidate_matches or best_dist < candidate_matches[ex_id][0]:
                candidate_matches[ex_id] = (best_dist, new_hold)

    # Build reverse lookup: new_detection → matched existing_id
    matched_new_ids = {id(v[1]): k for k, v in candidate_matches.items()}

    # --- Assign IDs to unmatched new detections ---
    next_id = max_existing_num + 1
    unmatched_new = []
    for new_hold in new_detections:
        if id(new_hold) not in matched_new_ids:
            new_hold = dict(new_hold)  # copy so we can mutate
            new_hold['id'] = f'hold_{next_id}'
            next_id += 1
            unmatched_new.append(new_hold)

    # --- Build merged holds list ---
    # For each existing hold, find its matched new detection (if any)
    matched_existing_ids = set(candidate_matches.keys())
    orphaned = [h for h in existing_holds if h['id'] not in matched_existing_ids]

    merged = []

    for ex_hold in existing_holds:
        ex_id = ex_hold['id']
        if ex_id in candidate_matches:
            dist, new_hold = candidate_matches[ex_id]
            if update_positions:
                # Take new position/polygon but restore original ID
                updated = dict(new_hold)
                updated['id'] = ex_id
                merged.append(updated)
            else:
                # Keep existing hold data exactly, just confirm it stays
                merged.append(ex_hold)
        else:
            # No match — keep the existing hold unchanged (it may have been
            # removed from the board; the user can delete it manually)
            merged.append(ex_hold)

    # Append new holds that had no existing match
    merged.extend(unmatched_new)

    # Sort by numeric ID for clean output
    def sort_key(h):
        parts = h['id'].split('_')
        if len(parts) == 2 and parts[1].isdigit():
            return (0, int(parts[1]))
        return (1, h['id'])

    merged.sort(key=sort_key)

    report = {
        'existing_count': len(existing_holds),
        'new_count': len(new_detections),
        'matched': [(ex_id, dist, new_h) for ex_id, (dist, new_h) in sorted(
            candidate_matches.items(), key=lambda x: int(x[0].split('_')[1]) if x[0].split('_')[1].isdigit() else 0)],
        'new_holds': unmatched_new,
        'orphaned': orphaned,
        'total': len(merged),
    }

    return merged, report


def print_report(report):
    print('\n=== Hold Merge Report ===')
    print(f"Existing holds:            {report['existing_count']}")
    print(f"New detections:            {report['new_count']}")
    print(f"Matched (ID preserved):    {len(report['matched'])}")
    for ex_id, dist, new_h in report['matched']:
        print(f"  {ex_id} ← detection at ({new_h['cx']}, {new_h['cy']})  dist={dist:.1f}")
    print(f"New holds added:           {len(report['new_holds'])}")
    for h in report['new_holds']:
        print(f"  {h['id']} at ({h['cx']}, {h['cy']}) — NEW ({h.get('color', '?')} {h.get('confidence', '?')})")
    print(f"Orphaned (no new match):   {len(report['orphaned'])}")
    for h in report['orphaned']:
        print(f"  {h['id']} at ({h['cx']}, {h['cy']}) — kept as-is")
    print(f"Total holds after merge:   {report['total']}")


def main():
    parser = argparse.ArgumentParser(description='Merge freshly detected holds into existing holds.json')
    parser.add_argument('existing_file', help='Current holds.json')
    parser.add_argument('new_file', help='Freshly detected holds from detect_holds.py --output')
    parser.add_argument('--threshold', type=float, default=5.0,
                        help='Max distance (board %%) for a spatial match (default: 5.0)')
    parser.add_argument('--update-positions', action='store_true',
                        help='Update matched holds cx/cy/polygon to new detection values')
    parser.add_argument('--dry-run', action='store_true',
                        help='Print report without modifying files')
    parser.add_argument('--allow-custom-loss', action='store_true',
                        help='Escape hatch: proceed even if the custom_ exclusion filter '
                             'is about to drop most/all of the existing holds')
    args = parser.parse_args()

    existing_path = Path(args.existing_file)
    new_path = Path(args.new_file)

    if not existing_path.exists():
        print(f'Error: {existing_path} not found')
        sys.exit(1)
    if not new_path.exists():
        print(f'Error: {new_path} not found')
        sys.exit(1)

    existing_data = json.loads(existing_path.read_text())
    new_data = json.loads(new_path.read_text())

    if not existing_data.get('holds'):
        print('Error: existing file has no holds')
        sys.exit(1)
    if not new_data.get('holds'):
        print('Error: new file has no holds')
        sys.exit(1)

    merged_holds, report = merge_holds(
        existing_data, new_data,
        threshold=args.threshold,
        update_positions=args.update_positions,
        allow_custom_loss=args.allow_custom_loss,
    )

    print_report(report)

    if args.dry_run:
        print('\n(Dry run — no files modified)')
        return

    # Update existing_data with merged result
    existing_data['holds'] = merged_holds
    existing_data['boardRegion'] = new_data['boardRegion']
    existing_data['imageFile'] = new_data['imageFile']
    existing_data['detectedAt'] = new_data.get('detectedAt', existing_data.get('detectedAt'))

    existing_path.write_text(json.dumps(existing_data, indent=2))
    print(f'\nWrote {len(merged_holds)} holds to {existing_path}')


if __name__ == '__main__':
    main()
