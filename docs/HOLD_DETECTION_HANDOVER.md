# Hold Detection Redesign — Handover (2026-06-06)

Self-contained handover for the hold-detection rebuild. Pairs with `CURRENT_STATE.md`
and the auto-memory note `project_hold_detection_redesign.md`. Everything below is
**committed + pushed to `main`** (Vercel auto-deploys); the working tree is clean.

---

## TL;DR

- Replaced the old **colour-based** hold detector with an **object-first SAM** pipeline.
  Yonder went from **108 → 201 holds live in the app** (best detected set, seeded to the DB).
- New scripts: `detect_holds_v2.py`, `refine_holds.py`, `build_candidates.py`,
  `upload_board_setting.py`, `hold_tagger.py` (+ `requirements-detect.txt`).
- In-app **"Tap a hold"** tool added to the Hold Manager (v1 = pick from a precomputed
  library). Owner wants to upgrade it to **tap-anything (live SAM)** — **DECISION PENDING**
  (built-in ONNX vs hosted; see below).
- **Flywheel** (learn-from-edits) = designed, not built.

## Where to resume (ordered next steps)
1. **Owner decision on tap-anything**: built-in in-browser ONNX SAM (recommended) vs hosted API. Then build it (replaces the current pick-from-list TAP tool).
2. **Flywheel edit-logging** (Phase C) — owner wants this done before returning to multi-wall 2b-iv.
3. (Optional) Seed **The Barn** with an improved set — but it HAS routes → must go via `merge_holds.py` (never overwrite).
4. Resume **multi-wall 2b-iv** (wall onboarding/join + admin), which is where the RESET-vs-TWEAK image-update flow belongs.

---

## Why (the problem we fixed)
The old `scripts/detect_holds.py` is **detect-by-colour** (9 fixed HSV bands). On a dense,
chalked, glossy spray wall it's structurally wrong: one hold spans shadow→highlight (too
wide for one band), and chalk/specular pixels fall outside *every* band and shatter holds.
Result on Yonder: only **108 of ~220** holds. Proof + diagnostics in the scratch evidence
(`board-assets/yonder/_diag_*.png`).

**Reframe:** detect the OBJECT (colour-agnostic), demote colour to a post-hoc label, and
absorb chalk/specular/shadow into the hold.

---

## The new pipeline (scripts + how to run, board-generic)

**Environment:** a Python venv with `ultralytics` (FastSAM/SAM/MobileSAM) + `transformers`
(Depth Anything V2) + cv2/numpy/Pillow. During this work it lived at `/tmp/holds_venv`
(scratch — may vanish on reboot). Recreate anywhere:
```
python3 -m venv .venv-detect
.venv-detect/bin/pip install -r scripts/requirements-detect.txt
```
Model weights (`*.pt`) auto-download on first run and are **gitignored**. NOTE: the depth
experiments used `transformers`; it's listed in `requirements-detect.txt`.

| Script | What it does |
|---|---|
| `detect_holds_v2.py` | **FastSAM object-first detector.** Colour-agnostic; colour = post-hoc label. Recall-tuned defaults (imgsz 1536, conf 0.10, min-area-frac 0.00018, nested-overlap 0.75; all CLI-overridable). `--image`, `--board-region "L,T,W,H"`, `--output`. Exposes `get_candidate_masks()` (used by refine/candidates). Board-generic. |
| `refine_holds.py` | **Post-detection refine.** Hole-fill, capped de-shard, colour-aware merge (+plywood-gap guard), depth flatness-gate, **appearance-first foot-chip recovery**, colour+depth-valley+concavity split. Uses cached depth (`/tmp/_depth_d.npy`). Same JSON schema as v2 (→ `merge_holds.py`-compatible). |
| `build_candidates.py` | **Generous per-board tap-candidate library** (permissive FastSAM ∪ appearance foot-chips). For the in-app Tap tool. Output JSON. |
| `upload_board_setting.py` | **Board-generic uploader** — upsert any local JSON into `board_settings[<key>]` via the service-role key in `.env.local`. Used for `hold_candidates_<id>` and for re-seeding `holds_<id>`. |
| `hold_tagger.py` | Standalone **local cv2 GUI** tap-to-segment tool (SAM point-prompt) with edit-logging. Superseded by the in-app tool for the owner (non-technical), kept as a dev tool. `--selftest` verifies the SAM core headlessly. |
| `merge_holds.py` *(existing)* | **ID-preserving merge.** MANDATORY for any wall that HAS routes. |
| `_depth_proto.py`, `_depth_large_proto.py` *(scratch, board-assets/yonder/)* | Depth Anything V2 (Small cached `/tmp/_depth_d.npy`; Large `/tmp/_depth_large.npy`). **Large is markedly better** — adopt it for production depth. |

### Per-wall recipe (NEW WALL or re-detect)
```
# 1. detect (use the wall's photo + its boards.specs.boardRegion)
.venv-detect/bin/python scripts/detect_holds_v2.py --image board-assets/<slug>/<photo>.jpg \
    --board-region "L,T,W,H" --output /tmp/<slug>_v2.json
# 2. (optional) refine — needs a cached depth map for that image first
# 3a. NO routes on the wall  → seed directly:  upload the holds ARRAY to holds_<boardId>
#     (see "how Yonder was seeded" below)
# 3b. HAS routes (e.g. The Barn) → merge_holds.py, then seed the merged result (preserve IDs)
# 4. build + upload the tap-candidate library:
.venv-detect/bin/python scripts/build_candidates.py --image ... --board-region "L,T,W,H" --output /tmp/<slug>_cand.json
python3 scripts/upload_board_setting.py --key hold_candidates_<boardId> --file /tmp/<slug>_cand.json
```

---

## Live data state (what's actually in production)

- **Yonder** (`board_id 275dfaa7-1df9-4fe7-8332-c2795eb9ebe7`, slug `yonder`):
  - `board_settings['holds_<id>']` = **201 holds** (refined 200 best-set + 1 unique owner tap-add). **0 routes** (verified) → the clean reseed was safe.
  - `board_settings['hold_candidates_<id>']` = **247** candidate outlines (for the current Tap tool).
  - `boards.specs.boardRegion` = `{left:1, top:0.5, width:98, height:97}`.
- **The Barn**: **UNCHANGED** — its 186 holds + real routes are untouched. Not re-detected (has routes → would require `merge_holds.py`). The Tap button appears for it but is **inert** (no Barn candidate library generated yet).
- `src/data/holds.json` (repo): The Barn's **55 base holds** — restored after an incident where a build-time test overwrote it with Yonder data (never committed; reverted). **Detection scripts must never write `holds.json`.**

### How Yonder was seeded (reference)
Refined holds were in `/tmp/holds_refined.json` (200). Fetched the live `holds_<id>`, kept
the owner's unique `custom_` tap-adds (deduped vs the refined set by centroid proximity),
renumbered the refined set `hold_1..N`, and upserted the merged 201-element **array** into
`board_settings['holds_<id>'].data` via service-role REST (PostgREST upsert, `Prefer:
resolution=merge-duplicates`). The app reads that array via `db.getBoardHolds` →
`useCustomHolds`.

---

## In-app feature: Hold Manager "Tap" tool (v1, shipped)
- **Files:** `src/components/BoardSetupView.jsx` (`TOOLS.TAP` + `IconTap` + `TOOL_LABELS`
  entry + `handleClick` TAP branch + cursor), `src/App.jsx` (loads
  `hold_candidates_<activeBoardId>` into `tapCandidates`, passes it down),
  `src/lib/db.js` (`getBoardCandidates`).
- **Behaviour:** tap → smallest containing precomputed candidate → `holdFromPolygon` → add
  as a normal hold, selected with vertex handles shown (reuses existing vertex editing).
  Board-generic (keys off active wall + its `boardRegion`). Purely **additive** (mints a
  `custom_` id; never touches existing holds/routes). No load-bearing pan/touch/coordinate
  code was changed (TAP falls through `handleMouseDown` to the default, reaching
  `handleClick` like Draw).
- **KNOWN LIMITATION (why it's being replaced):** it can only return shapes already in the
  candidate library — it can't trace a genuinely-missed hold (e.g. the white foot chips).
  And now that the full set is seeded, tapping an existing hold makes a **duplicate**. Owner
  has been told to leave the Tap button alone until the upgrade.

---

## NEXT BUILD: tap-anything (live SAM) — **DECISION PENDING**
Replace the pick-from-list TAP with **live segmentation**: look at the photo at the tapped
point and trace whatever's there (including never-detected holds). Two architectures:

- **(A) In-browser ONNX SAM — RECOMMENDED.** Encode each board image **server-side** once
  (Python) → store the embedding in Supabase storage (per board). Ship a small (~15 MB) SAM
  **decoder** ONNX + `onnxruntime-web` in the app; on tap, run the decoder on the cached
  embedding → mask → polygon → add editable hold. **Self-contained: no accounts, no cost,
  no secrets, works offline-ish.** Bigger build (ONNX wrangling + coordinate transforms),
  slightly heavier app. Best fit for the owner's "no friction, just works" preference.
- **(B) Hosted SAM via a Vercel serverless proxy.** A serverless function holds a Replicate
  (or HF) token (Vercel secret) and calls hosted SAM with the **public board-image URL** +
  the click point → mask. Easier app code, but needs a paid account/token, per-tap latency
  (~2–4 s) and tiny per-tap cost, ongoing.

Once tap-anything ships, the **candidate library + the pick-from-list TAP become obsolete**
(remove them).

---

## THEN: flywheel (learn-from-edits) — designed, not built
Log every Hold-Manager edit (add / delete / **reshape**) per board as labelled data:
*before* = detector/SAM outline, *after* = owner's corrected outline. Groundwork already in:
tap-added holds carry `_candidatePolygon` (the pre-edit outline). Accumulate across **all**
walls → (a) fine-tune a hold model (YOLOv8-seg or LoRA-SAM) and (b) build a **hold-instance
catalogue** — the owner reuses the same physical holds across resets, so detection can become
*recognition* ("seen this jug before"). The standalone `hold_tagger.py` already writes an
edit log (`edits.jsonl` + patches + `session.json`) as a reference schema.

---

## CRITICAL RULES / GOTCHAS (read before touching holds)
- **ID stability is law.** Routes reference holds by ID. NEVER overwrite a wall's holds if it
  has routes — use `merge_holds.py`. Detection scripts must NEVER write `src/data/holds.json`.
  Always `git add <file>` explicitly — **never `git add -A`** (that's what kept the holds.json
  incident from being committed).
- **RESET vs TWEAK (image updates) — owner-flagged, critical.** When a new image is uploaded:
  - *Tweak* (a hold moved / a few added/removed) = same set → **preserve IDs via merge**, routes
    survive (the app's existing missing-hold/ghost system handles removed holds). Mostly built.
  - *Reset* (most holds changed) = new set → **archive (don't delete) the prior routes** under a
    new **"set version"**, new routes build on the fresh holds. **New work** (set-versioning +
    archiving + the prompt) — belongs in wall-onboarding (2b-iv).
  - **Never auto-decide.** Explicit admin choice at upload, with a smart suggestion from the
    new-vs-old hold overlap %, and the destructive (reset) path gated by a confirm showing how
    many routes will be archived. Getting it backwards is catastrophic (lost routes / broken routes).
  - The Tap tool is purely additive → safely inside the "tweak" world.
- **Seed-to-live:** detection output sitting in `/tmp` does NOTHING until uploaded to
  `board_settings['holds_<id>']`. Don't leave results in scratch (this was the "hidden work" bug).
- **Admin gating:** the Hold Manager only opens for the wall's admin in admin mode. The dev
  autologin user `claude-test` is a **member** (not admin) of Yonder, so it CANNOT reach
  Yonder's Hold Manager in preview — the owner (Paul, admin) is the real tester, or use a
  temporary dev gate-bypass (precedent: the pan-leak fix).
- **Scratch is disposable:** `/tmp/*.npy`, `/tmp/*.json`, `/tmp/holds_venv`, and
  `board-assets/**/_*` are gitignored throwaways — regenerate via the scripts. `*.pt` weights
  gitignored.
- **GuidedCameraStep** is still Barn-hardcoded (region + photo dims) — capture aid only; fix
  at wall-onboarding.
- **Depth:** prefer **Depth Anything V2 Large** (sharper; resolves white/larger foot-chip
  protrusion the Small model missed; small black chips ≈ flush T-nuts even with Large).

---

## FUTURE (owner, parked): desktop ADMIN APP
The owner wants admin tasks — image upload, the tweak/reset decision, hold management, set
versions — in a **dedicated desktop app**, not via Claude Code/the repo (some phone admin kept
too). Everything built here (detection pipeline, candidate library, tap-to-segment, flywheel —
all reading/writing the shared Supabase) is the reusable **engine** that app will wrap. Keep
the pieces modular.

---

## Commits (this arc, newest first)
```
4322d96 feat(hold-manager): in-app 'Tap a hold' auto-outline tool (board-generic)
47f5c09 feat(candidates): board-generic board_settings uploader; seed Yonder tap-candidates
aa5dffe feat(candidates): per-board tap-candidate library generator (board-generic)
0892adf feat(tagger): Step 2 local tap-to-segment hold tagger + flywheel edit-logging
e953bac docs: log Step 1.5 refine pass + depth-cue proof + F1 status
22b2dad feat(refine): appearance-first foot-chip recovery
49cf81c feat(refine): Step 1.5 refine pass — de-shard, colour-aware merge, depth gate, split
3154055 feat(detect-v2): recall-tune defaults + CLI knobs (149->193 holds on Yonder)
9209a19 feat(detect-v2): FastSAM object-first hold detector (colour-agnostic)
e6c19f4 chore: gitignore model weights (FastSAM *.pt)
```
*(Plus the docs commits logging each step.)* The live Yonder reseed to 201 holds was a
**direct DB upsert** (service-role), not a code change — re-run via the per-wall recipe if
needed.

## Scratch evidence (gitignored, in `board-assets/yonder/`)
`_detect_v2_tuned_overlay.jpg` (193), `_refine_overlay.jpg` (200), `_candidates_overlay.jpg`
(247), `_depth_raw.jpg` / `_depth_protrusion.jpg`, `_depthL_lower_overlay.jpg` /
`_depthL_lower_heat.jpg`, `_proto_sam.jpg` / `_proto_bg.jpg`, `_diag_*.png`, `_tagger_selftest.jpg`.
