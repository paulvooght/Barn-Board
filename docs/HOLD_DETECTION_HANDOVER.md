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
- **Tap-anything (live in-browser SAM) SHIPPED (2026-06-07)** — the Hold-Manager Tap tool
  traces whatever's under your finger live (incl. holds the detector missed). Approach A
  (in-browser ONNX MobileSAM: encoder server-side → embedding; ~16 MB decoder in-browser via
  `onnxruntime-web`, WASM not WebGPU → iPhone-safe). Replaced the pick-from-list tool and
  removed the candidate library. See "TAP-ANYTHING (SHIPPED)" below.
- **Flywheel** (learn-from-edits) = designed, not built — **this is next.**

## Where to resume (ordered next steps)
1. ✅ **Tap-anything (live SAM) — DONE (2026-06-07).** Approach A shipped (see "TAP-ANYTHING (SHIPPED)" below). Yonder encoded + live.
2. **Flywheel edit-logging** (Phase C) — **NEXT.** Tap-added holds already carry `_candidatePolygon` (the pre-edit SAM outline); log add/reshape (before/after polygons) per board → a table or `board_settings`.
3. (Optional) Enable Tap on **The Barn**: run `encode_board_embedding.py` on its photo (additive — embedding only, does NOT touch its holds/routes). For an improved hold *set* The Barn HAS routes → must go via `merge_holds.py` (never overwrite).
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
| `export_sam_decoder.py` | **One-time** export of the MobileSAM mask decoder → `public/models/mobile_sam_decoder.onnx` (the small model the browser runs for live Tap). |
| `encode_board_embedding.py` | **Per-wall** SAM embedding: runs the encoder over a wall's photo → uploads ~4 MB embedding to Supabase storage + writes the `sam_embedding_<id>` pointer. Powers live Tap. (Replaces `build_candidates.py`, removed.) |
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

## In-app feature: Hold Manager "Tap" tool (v1 — SUPERSEDED 2026-06-07 by live SAM; see "TAP-ANYTHING (SHIPPED)" below — kept for history)
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

## TAP-ANYTHING (live SAM) — **SHIPPED 2026-06-07 (approach A)**
The Hold-Manager Tap tool now segments LIVE at the tap point (no precomputed library).
**Split MobileSAM:** the heavy ENCODER runs server-side once per wall; the small (~16 MB)
DECODER runs in-browser via `onnxruntime-web` (WASM, **not** WebGPU → iPhone-Safari-safe).

- **Server-side:** `scripts/export_sam_decoder.py` (one-time → `public/models/mobile_sam_decoder.onnx`)
  + `scripts/encode_board_embedding.py <IMAGE_NAME> --board <slug>` (per wall → ~4 MB embedding at
  Supabase `board-images/embeddings/<id>.bin` + pointer `board_settings['sam_embedding_<id>']`).
  Both run in the detection venv (`requirements-detect.txt` + `samexporter segment-anything onnx onnxruntime timm`).
- **App:** `src/lib/samSegment.js` lazy-loads ort + decoder + the wall's embedding; a board-% tap →
  SAM → board-% polygon (flood the tapped component, Moore-trace, RDP-simplify; **area-guard rejects
  plywood/background taps → null**). ort wasm self-hosted at `public/ort/` with `wasmPaths='/ort/'`
  (ort requests the UNHASHED name but Vite emits a HASHED asset, so the default path 404s in prod —
  pinning it is required; same-origin → offline-capable). `BoardSetupView` TAP branch calls it
  (**additive**; keeps `_candidatePolygon`); `App.jsx` → `samEmbedding` prop; `db.getBoardEmbedding`.
- **Removed (obsolete):** `scripts/build_candidates.py`, `db.getBoardCandidates`, the pick-from-list
  TAP. Stale `board_settings['hold_candidates_<id>']` rows are harmless (nothing reads them).
- **Verified:** core pipeline + integrated Tap UI (Yonder **201→202** via a temp dev admin-bypass,
  reverted), ~140 ms warm tap, build green, zero console errors, prod wasm path confirmed. **The Barn
  has no embedding yet → its Tap is dimmed/inert** until `encode_board_embedding.py` is run on its photo.
- **Model choice & perf:** MobileSAM (TinyViT encoder); decoder fp32 16.5 MB (quantization hit an
  onnx 1.19 bug — fp32 shipped; revisit if download size matters). Embedding 4 MB fp32 (could be fp16).
  Cold load ~0.7–2.5 s (decoder+wasm+embedding, then cached), warm tap ~140 ms.
- **Dedupe (2026-06-07):** Tap never adds an overlapping copy of an existing hold — pre-check
  `findHoldAtPoint(tap)` + post-check `findHoldAtPoint(centroid(traced))`; if either hits an outlined
  hold, select it + show "Already outlined — no duplicate added" (new `tapMsg`). Tap stays additive
  (new `custom_` ids; never renames existing → can't scramble IDs/routes). `handleSetupCancel` only
  discards; only "Save & Exit" persists.
- **Priority (owner, 2026-06-07):** board setup is **laptop-first**; phone Hold-Manager is for tweaks
  at the board. Phone/iOS-Safari is a *welcome bonus* of the encode/decode split, **not a goal** — don't
  let phone robustness/testing block or complicate the laptop flow. (Memory: `feedback-laptop-first-setup`.)
- **Live-data note:** owner tried Tap on the deployed app and saved 9 non-duplicate missed-hold adds →
  Yonder is at **210 holds** (was 201); left untouched pending owner confirmation.

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
