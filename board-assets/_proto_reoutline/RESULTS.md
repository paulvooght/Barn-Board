# SAM vs. GrabCut re-outlining — bounded prototype results

**Question:** does box/point-prompted SAM produce materially better hold outlines
than the GrabCut method currently used, on The Barn's V8 photo?

**Bottom line: yes, but only on specific failure modes — not universally.**
SAM clearly wins on the single worst known case (the volcanic rock) and on two
other recognisable GrabCut failure patterns (spurious spikes leaking into
shadows/neighbours, and merging with a touching same-toned neighbour). It
**loses** on thin/elongated holds (over-rounds them) and ties on everything
else, including every case that was expected to be hard for color-based
methods (glossy highlights, large uniform-dark blobs) but where color
separation from plywood turned out to be strong enough that both methods
did fine. **Confidence: moderate-to-high** that SAM should be the *default*
for a future re-outline pass, **not** a blind wholesale replacement — see
Recommendation.

This is a bounded prototype. Nothing here touched Supabase, `src/`, or the
published board image. All output lives in this directory
(`board-assets/_proto_reoutline/`, gitignored except for what was explicitly
`git add -f`'d).

- **Script:** `compare_sam_grabcut.py`
- **Raw data:** `results.json`
- **Evidence:** `crops/<hold_id>_3panel.png` (15 files) + `contact_sheet.png`
- **SAM model:** `sam2.1_b.pt` (SAM2.1-base, via `ultralytics`), CPU
- **Test photo:** `board-assets/the-barn/Barn_Set_01_V8.jpg` (read-only)

## Method (see the script for exact code)

Both methods start from the **same prior polygon** per hold — that hold's
entry in `_holds_reprojected_v8.json` (the reprojected-but-not-yet-corrected
shape). For the 10 required holds this prior is deliberately the *rough*
pre-correction shape (often hand-drawn against bare plywood before the V8
photo existed) — that roughness is the hard case itself, and starting both
methods from the same seed keeps the comparison apples-to-apples.

- **A — GrabCut:** padded ROI around the prior's bbox; mask seeded with the
  prior polygon as probable-fg, an eroded core as definite-fg (kernel shrinks
  automatically if erosion would wipe out a thin hold), an 8px ROI-border
  ring as definite-bg; 5 iterations; largest external contour;
  `approxPolyDP` epsilon 1.5px.
- **B — SAM:** the board photo is encoded **once** and shared across every
  hold (this matters a lot for timing — see below). Each hold prompts the
  cached encoding with its prior's bounding box + centroid point,
  `multimask_output=True` (3 proposals). Two selection rules were tried and
  both are recorded in `results.json`:
  - **highest predicted IoU** (SAM's own confidence head) — used as the
    primary rule, and what's drawn in every crop.
  - **best area-agreement with the prior** — reported for cross-check only.
  - They disagreed on 10/15 holds, but scores were usually tightly clustered
    (e.g. 0.90/0.90/0.92) when they disagreed, meaning the 3 proposals were
    near-duplicates of each other. Spot-checked the one case where the
    disagreement could have changed a verdict (`custom_1785249097137`,
    GrabCut-win, below) by rendering all 3 raw proposals directly: **all
    three were nearly identical**, so the selection rule was not
    responsible for that result. Did not re-verify the other 9 individually.
  Same contour → `approxPolyDP(eps=1.5)` finishing step as GrabCut, so the
  two methods produce polygons the same way.

Both outputs are converted to board-% using `scripts/reproject_holds.py`'s
own `pct_to_px`/`px_to_pct` (imported, not reimplemented).

## The 15-hold test set

| # | Hold ID | Hard-case category | Why picked |
|---|---------|--------------------|------------|
| 1 | `custom_1785242211962` | large matte-dark | REQUIRED — volcanic rock, currently the worst GrabCut result |
| 2 | `custom_1785242222284` | wood/tan-on-plywood | REQUIRED — small tan hold, low colour separation |
| 3 | `custom_1785242302475` | wood/tan-on-plywood | REQUIRED — tan triangular hold, prior undershoots the tip |
| 4 | `custom_1785242340139` | wood/tan-on-plywood + neighbour | REQUIRED — small tan hold beside a glossy blue hold |
| 5 | `custom_1785242357370` | touching-neighbour risk | REQUIRED — round hold abutting other holds |
| 6 | `custom_1785242401621` | thin/elongated + wood-on-plywood | REQUIRED — thin rail; erosion could wipe a thin GrabCut seed |
| 7 | `custom_1785249076778` | prior sits badly | REQUIRED — purple hold, prior undershoots the true edge |
| 8 | `custom_1785249097137` | prior sits badly | REQUIRED — purple/tan hold, prior undershoots the true edge |
| 9 | `custom_1785863185201` | wood/tan-on-plywood | REQUIRED — tan oval hold beside a cyan strip |
| 10 | `custom_1785863207342` | wood/tan-on-plywood + clutter | REQUIRED — tan hold near mounting-hardware clutter |
| 11 | `custom_hold_17` | glossy / specular | large cyan volume, strong specular highlight down its ridge |
| 12 | `custom_1774618428149` | large matte-dark + touching-neighbour | 2nd large matte-dark hold, boxed tight by yellow/cyan |
| 13 | `custom_hold_3` | wood/tan-on-plywood + touching-neighbour | large wood rail overlapping a similarly-toned neighbour |
| 14 | `custom_hold_55` | easy control | isolated, high-contrast yellow hold, already-tight prior |
| 15 | `custom_hold_18` | easy control | isolated, high-contrast cyan hold, mild gloss, already-tight prior |

(Note: several `color` tags in the live hold metadata are unreliable — 170/200
holds are tagged `black` regardless of true visual colour, and a few of the
holds above tagged "grey"/"purple" turned out on inspection to be tan/maroon.
The categories above are from looking at the actual pixels, not the tags.)

## Results table — the actual judgement

Verdicts are from looking at every `crops/*_3panel.png` at 2-3x zoom, not from
the numbers below.

| Hold ID | Category | GrabCut verdict | SAM verdict | Winner | Reason |
|---|---|---|---|---|---|
| `1785242211962` (volcanic rock) | large matte-dark | misses the craggy bottom edge, cuts across the texture | follows the bottom bumps and right edge much more closely | **SAM** | tracks the irregular rock silhouette noticeably better |
| `1785242222284` | wood/tan-on-plywood | spurious spike leaks up into the dark hold above | clean tight oval, no artifact | **SAM** | GrabCut produced a visible false spike; SAM stayed correct and simple |
| `1785242302475` | wood/tan-on-plywood | truncates the tapered right tip by roughly a third | captures the full tapered point | **SAM** | GrabCut cuts off real hold length |
| `1785242340139` | wood/tan-on-plywood + neighbour | spike/tail leaks toward the neighbouring blue hold's crack | clean hexagonal fit, no leak | **SAM** | GrabCut leaks along a shadow crack; SAM stays contained |
| `1785242357370` | touching-neighbour risk | accurate round fit | accurate round fit, near-identical | **Tie** | both cleanly isolate the hold from its neighbours |
| `1785242401621` | thin/elongated wood-on-plywood | tight, accurate fit to the thin sliver | rounder/bloated, overshoots the taper | **GrabCut** | box+point SAM over-rounds a very thin shape |
| `1785249076778` | prior sits badly | tight fit, follows a small concave "waist" in the shape | slightly smooths over that concave waist | **Tie** (slight GrabCut edge) | both recover well from the bad prior; GrabCut a touch more faithful to fine detail |
| `1785249097137` | prior sits badly | tight fit, respects the boundary with the black hold below | all 3 raw proposals oversized, encroaching onto the black neighbour (verified) | **GrabCut** | SAM's box+point prompt rounds the shape into its neighbour here |
| `1785863185201` | wood/tan-on-plywood | tight oval fit | tight oval fit, near-identical | **Tie** | near pixel-identical on this well-shaded oval |
| `1785863207342` | wood/tan-on-plywood + clutter | good fit, one small jagged notch | smoother equivalent fit | **Tie** (cosmetic SAM edge) | same extent; SAM's line is marginally cleaner, not materially better |
| `hold_17` | glossy / specular | tight fit straight through the highlight | tight fit straight through the highlight, near-identical | **Tie** | neither method is fooled by the specular streak — colour separation from plywood was strong enough regardless |
| `1774618428149` | large matte-dark + touching-neighbour | tight fit including the pinch notch | tight fit including the pinch notch, near-identical | **Tie** | both correctly separate this hold from tightly-packed neighbours |
| `hold_3` | wood/tan-on-plywood + touching-neighbour | bulges to absorb part of the overlapping round neighbour | stays on the rail shape only | **SAM** | GrabCut partially merges with the touching hold; SAM keeps a clean boundary |
| `hold_55` | easy control | tight, accurate | tight, accurate, near-identical | **Tie** | sanity check passes |
| `hold_18` | easy control | tight, accurate | tight, accurate, near-identical | **Tie** | sanity check passes |

**Tally: SAM wins 5, GrabCut wins 2, Tie 8.**

Every SAM win is a case where GrabCut produced a **visible artifact** (a
spike leaking into a shadow/crack, or missing/truncating real hold extent) —
not a subtle difference. Both GrabCut wins are also visible and real, not
selection-rule noise (checked directly for `1785249097137`).

## Where SAM did NOT help (the important part for planning manual sweep)

1. **Thin/elongated holds** (`1785242401621`) — box+point SAM tends to
   produce a fuller, rounder mask that overshoots a thin sliver's true taper.
   GrabCut, seeded with the actual (already-thin) prior polygon, tracks a
   thin shape tightly. **If a full sweep goes ahead, holds with a low
   width:height-derived aspect ratio (thin rails/crimps) should probably
   stay on GrabCut, or get manual review, rather than trusting SAM by
   default.**
2. **One case with a concave boundary against a touching neighbour**
   (`1785249097137`) — all three SAM proposals rounded off a concave notch
   and encroached slightly onto the neighbouring hold; GrabCut (seeded with
   the actual polygon shape, concavity included) respected the boundary.
   This cuts against the general "SAM handles touching neighbours better"
   pattern seen elsewhere (`hold_3`, `1785242340139`) — it is genuinely
   case-by-case, not a rule.
3. **Glossy holds were a non-issue for both methods** in this test —
   `hold_17`'s strong specular highlight and `hold_18`'s milder one didn't
   trip up GrabCut at all, because the hold's colour was still far enough
   from plywood that the highlight (which sits *inside* the true boundary,
   not on it) never got mistaken for background. The "glossy" hard case
   from the brief may matter more on a hold whose highlight extends closer
   to the true edge, but none of the glossy holds tested here showed it.

## Descriptive stats (area ratio & centroid shift vs. the prior) — read with caution

As the task anticipated, these numbers **do not reliably predict which
outline is visually correct**, because the prior polygon itself has unknown
bias. Two concrete examples from this test set:

- `1785242401621` (thin rail): GrabCut's area is only **0.58x** the prior,
  SAM's is **0.95x** — by the numbers alone SAM looks "closer to the
  original." Visually it's the opposite: GrabCut is the tight, correct fit;
  SAM is bloated. The prior itself was evidently oversized for this thin
  shape, so "closer to the prior" here means "closer to the prior's error."
- `hold_3`: GrabCut's area ratio is **0.96**, SAM's is **1.00** — both look
  unremarkable and similar by area. Visually, GrabCut partially merged with
  a touching neighbour (added a chunk on one side, lost some length
  elsewhere — the errors partly cancel in total area) while SAM did not.
  Area alone hides a real shape defect.

Full per-hold numbers are in `results.json`; spot values for context:

| Hold ID | GrabCut area÷prior | GrabCut centroid shift (board %) | SAM area÷prior | SAM centroid shift (board %) |
|---|---|---|---|---|
| `1785242211962` | 0.98 | 1.50 | 1.11 | 1.39 |
| `1785242401621` | 0.58 | 0.54 | 0.95 | 0.47 |
| `1785249097137` | 1.39 | 0.12 | 1.65 | 0.02 |
| `hold_3` | 0.96 | 0.45 | 1.00 | 0.26 |
| `hold_17` | 0.98 | 0.04 | 1.01 | 0.05 |

(all 15 rows are in `results.json`; omitted here for brevity since — per the
above — they're descriptive, not dispositive)

## Timing (for the go/no-go decision)

Measured on this machine (Apple M1 Max, 32GB), SAM2.1-base, CPU:

| Stage | Cost |
|---|---|
| SAM model load (weights cached locally) | **0.34s**, one-time |
| SAM image encode (the one board photo, shared by every hold) | **1.32s**, one-time |
| SAM per-hold prompt decode (**cached** encoding) | mean **30.5ms**, median 30.2ms, range 28-36ms |
| GrabCut per-hold (5 iterations) | mean **70.5ms**, median 37.9ms, range 6-254ms (scales with hold/ROI size) |

**Extrapolated cost across all 204 live holds:**
- GrabCut: 204 × 70.5ms ≈ **14.4s** total.
- SAM (encode-once, shared): 0.34s + 1.32s + 204 × 30.5ms ≈ **7.9s** total.

**SAM is actually the cheaper method at this scale — but only if the image is
encoded once and shared.** A naive implementation that calls the high-level
`SAM.predict()` per hold (which re-encodes the full image every single call
— confirmed empirically: ~1.1-1.2s per call, no caching) would cost
204 × ~1.15s ≈ **235s (~4 minutes)** instead of 8 seconds. This is a real
pitfall worth documenting for whoever builds the real pipeline: **use the
low-level `SAM2Predictor` directly, call `set_image`/`get_im_features` once,
and reuse cached features across all 204 prompts** (see
`setup_sam`/`sam_encode_image`/`sam_prompt` in the script for the exact
pattern — the ultralytics high-level API does not do this automatically).

**MPS (Apple GPU) was also measured** and is *not* worth it at this scale:
model load 0.61s, image encode 5.0s (slower — MPS kernel-compile overhead),
first decode call 4.0s (more compile overhead), then ~20ms/hold after
warm-up. Total for 204 holds ≈ 0.61+5.0+4.0+203×0.02 ≈ **13.7s — slower
than plain CPU's 7.9s**, because the one-time MPS compilation tax outweighs
its faster steady-state per-call cost at only ~204 calls. CPU is simpler and
sufficient; MPS would only start winning at much larger hold counts or
repeated runs within one process.

## Recommendation

**Adopt SAM as the default for a future guided re-outline pass, with two
guardrails, not a blind wholesale swap:**

1. **Route thin/elongated holds to GrabCut (or manual review) instead of
   SAM.** A simple aspect-ratio gate on the prior polygon's bbox (e.g.
   `min(w_pct,h_pct)/max(w_pct,h_pct)` below some threshold) would catch
   `1785242401621`-like cases before SAM gets a chance to bloat them.
2. **Always render a visual review pass (exactly this script's 3-panel
   crops) before committing anything** — 8/15 holds tied, and "tie" still
   means a human should glance at it, not that either output is
   guaranteed correct. This prototype's own numbers (area ratio, centroid
   shift) are not a substitute for that look, as shown above.

**Confidence: moderate-to-high.** The evidence is clean (every SAM win is a
visible, unambiguous GrabCut artifact — not a coin-flip), but it comes from
15 of 204 holds, deliberately skewed toward hard cases, so the true SAM-win
rate across the full board is probably lower than 5/15 (many of the
remaining ~189 holds are more like the "easy control"/tie cases here than
the artifact-prone ones). The genuine GrabCut win on thin holds is real and
should be respected, not smoothed over because SAM is the newer technique.

**Depth Anything V2** (explicitly out of scope for this prototype): no case
in this 15-hold test clearly cried out for a depth cue — SAM already
resolved the large matte-dark and touching-neighbour cases the depth idea
was originally aimed at. The one place it might still help is the concave
touching-neighbour miss on `1785249097137` (a depth seam between two
touching holds at slightly different heights could disambiguate the
boundary where colour can't) — but that's one hold out of 15, and both
non-depth methods already have a working answer for most touching-neighbour
cases. Not worth pursuing before a full-scale SAM sweep with the aspect-ratio
guardrail above.

## Reproducing this

```bash
# one-time setup (already done for this run)
python3 -m venv /tmp/holds_venv
/tmp/holds_venv/bin/pip install ultralytics

# run
/tmp/holds_venv/bin/python board-assets/_proto_reoutline/compare_sam_grabcut.py
```

Weights cache at `/tmp/holds_venv/weights/sam2.1_b.pt` (gitignored, not
committed, ~155MB) — the script points at this absolute path so repeat runs
never re-download into the repo working tree regardless of cwd.
