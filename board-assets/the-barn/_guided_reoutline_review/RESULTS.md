# guided_reoutline.py — full-board run on The Barn (204 live holds)

**Bottom line: the pipeline runs correctly end-to-end, in ~20s for all 204
holds, and the worst-first ranking genuinely works** — the lowest-confidence
holds are real disagreements, not noise, and the sanity gate caught the one
outright SAM failure this run produced. On the volcanic rock specifically
(`custom_1785242211962`, the case the owner called out), the new outline
**beats today's live one** (it correctly extends into a craggy bottom-right
section today's live outline still cuts across) **and closely reproduces**
the original prototype's SAM result (areas within 1%, near-identical shape).

This is a dry-run artifact set only. **Nothing was written to Supabase.**
`scripts/merge_board_holds.mjs --update` (no `--commit`) was run against the
output and is clean — see "Dry-run proof" below.

- **Tool:** `scripts/guided_reoutline.py`
- **Input:** live `board_settings['holds_<barnId>']`, 204 holds (read-only GET)
- **Image:** `board-assets/the-barn/Barn_Set_01_V8.jpg` (read-only)
- **Output:** `_guided_reoutline_updates.json` (this directory's sibling)
- **Review:** `review.json` (all 204, full detail), `review_sorted.png` (worst 20)

## Headline counts

| Metric | Count | Notes |
|---|---|---|
| Holds processed | 204 | 0 errors/exceptions |
| Gate accepted | 203 | written to `_guided_reoutline_updates.json` |
| Gate rejected | 1 | `custom_1775426726780` — kept existing polygon (see below) |
| Moved materially | 98 | shift ≥0.5 board% **or** \|area_ratio−1\|≥0.15 (defined below) |
| Neighbour-resolution affected | 110 | ≥1 pixel stripped from a raw candidate by a nearer neighbour |
| Chosen: SAM | 191 | default rule |
| Chosen: GrabCut | 13 | thin/elongated prior (aspect ≥ 3:1) |

**"Moved materially" definition** (a reporting threshold, not a gate): centroid
shift ≥ 0.5 board% OR the new/existing area ratio differs from 1.0 by ≥ 15%.
Both thresholds are arbitrary-but-reasonable round numbers, not derived from
data. One caveat worth flagging: the 98 "material" holds have a **smaller
median size** (w%×h% = 5.18) than the 105 non-material ones (7.28), though the
*means* are almost identical (21.4 vs 21.5) because both groups contain a few
large holds. So there's a real, if modest, skew toward small holds crossing
the material threshold — consistent with the prototype's own warning that
percentage-based area ratios are noisier on small shapes. Read "98 moved
materially" as "98 holds whose outline changed enough to be worth a glance,"
not "98 holds are dramatically different."

## Timing — the encode-once story, measured, not extrapolated

Unlike the prototype (15 of 204 holds, extrapolated), this is the **actual**
full-board run:

| Stage | Cost |
|---|---|
| SAM model load | 0.334s, one-time |
| SAM image encode (shared by all 204 holds) | 1.825s, one-time |
| Phase A total (204× GrabCut + 204× SAM decode) | 15.51s |
| — per-hold GrabCut | mean 32.9ms, median 9.6ms, max 556ms |
| — per-hold SAM decode (cached encoding) | mean 31.2ms, median 30.6ms, max 45.8ms |
| Phase B (neighbour resolution, all 204) | 0.039s |
| Phase C (resolve + choose, all 204) | 0.016s |
| **Wall total (incl. model load, fetch, image I/O, review render)** | **20.2s** |

SAM's per-hold cost is tight and consistent (median 30.6ms, matching the
prototype's 30.2ms almost exactly) because it only ever does a cached decode.
GrabCut's median (9.6ms) is now *lower* than its prototype mean (37.9ms) —
most of today's 204 holds are already reasonably-fitted (tight priors decode
faster; GrabCut's cost scales with ROI size), and its mean is pulled up by a
handful of larger holds (max 556ms). Neighbour resolution and method-choice
are essentially free (55ms combined for all 204 holds) — the cost of this
pipeline is still 100% the segmentation step, exactly as the prototype found.
**If this pipeline were run per-hold with a naive `SAM.predict()` instead of
the shared encoding, the same 204 holds would cost an estimated 204 × ~1.15s
≈ 235s (the prototype's own measurement of that failure mode) — the encode-
once design is the difference between 20 seconds and four minutes.**

## The one gate rejection

`custom_1775426726780` — SAM's candidate ballooned to 3.2× the existing
polygon's area (cap is 3.0×), so the gate correctly rejected it and kept the
existing polygon. Looked at directly: the hold sits against a bright vertical
edge (a doorframe or wall trim next to the board), and SAM's box+point prompt
followed a much larger, unrelated patch of shaded/stained wood grain instead
of the small actual hold — a genuine SAM failure, not a borderline call. This
is exactly the scenario the sanity gate exists for, and it worked.

## Neighbour resolution: does it do anything real?

110/204 holds had at least one pixel removed from a raw candidate by a
nearer neighbour. Checked one concrete case directly
(`custom_1785865721479`, rank #5 in the worst-20): SAM's raw candidate
claimed 3364px², a nearby hold's claim won back part of the contested
region, and the final chosen mask came out at 2718px² (a real ~19% trim).
Rendered side-by-side, the trim is real but visually modest for this
particular hold — not every one of the 110 is a dramatic before/after. The
honest read: the mechanism is doing genuine, correctly-scoped work (it only
ever removes pixels another hold's mask also claims and wins), but on this
densely-packed board — many holds sit close together or touching — a
majority of holds having *some* boundary pixel contested is plausible and
not itself a sign of a problem.

## Method choice: 13 routed to GrabCut

The 13 holds with prior aspect ratio ≥ 3:1 (thin/elongated) were routed to
GrabCut per the prototype's finding that box+point SAM over-rounds thin
shapes. Several (`custom_hold_18` iou=0.967, `custom_hold_4` iou=0.968,
`custom_hold_23` iou=0.962) already had GrabCut and SAM agreeing closely, so
the rule made little practical difference there. A few show real
disagreement the rule is actually deciding between: `custom_1775426921460`
(aspect 3.21, iou=0.569), `custom_1778625039016` (aspect 4.55, iou=0.749),
`custom_1774607844596`/`custom_1774607850503` (aspect ~4.4-4.7, iou
0.77-0.79). `custom_hold_3` — one of the prototype's own 15 test holds,
where GrabCut partially merged into a touching neighbour and SAM stayed
clean — is in this GrabCut-routed set too (aspect 4.55). Its live prior is
already a well-fitted rail shape (not the original bad merge), and here
GrabCut and SAM agree closely (iou=0.870) with no visible defect in either —
the rail-shaped prior no longer sits near enough to that neighbour's true
boundary to reproduce the original merge failure, and the rule fires cleanly
either way.

## Honest read of the worst-20 review sheet

Opened `review_sorted.png` and looked at every panel, then went back and
rendered several at full resolution to check first impressions (the 4-col
grid's ~340px panels are legible for judging *agreement/disagreement* but
too small to safely judge *which one is right* on a hold under ~2% of the
board — I initially misread panel #6 as a huge SAM over-segmentation from
the thumbnail alone; a full-resolution re-render showed both candidates are
actually small and close together, just genuinely ambiguous against
low-contrast plywood. That's a real limitation of the review sheet worth
knowing before trusting a glance at the grid for tiny holds — zoom in (or
check Hold Manager directly) before acting on any panel under roughly 2% of
board width.)

**With that caveat, the ranking works.** The worst ~15 of the 20 are
dominated by one clear, recognisable, honest failure pattern: **small,
low-contrast bolt-on hardware chips**, often sitting right next to a T-nut
cover. GrabCut (seeded from the correct small prior) stays tight and
plausible on nearly all of these; SAM's box+point prompt is genuinely
unreliable at this scale — sometimes shifting to a nearby but wrong patch of
plywood (rank #11, `custom_1774607780969`, iou=0.332), sometimes ballooning
into unrelated background texture entirely (rank #1, gate-rejected). This
is a real, useful finding for the next sweep: **tiny bolt-on chips are the
one class of hold this pipeline is least trustworthy on**, and a human
reviewing the worst-20 should expect most of what they see there to be
exactly this — not a random grab-bag of unrelated problems. The bottom of
the full 204 (iou ≥ 0.95, 20 holds) are unambiguously easy, isolated,
well-separated holds — consistent with the prototype's own "easy control"
cases.

IoU distribution across all 204: min 0.0, 10th pct 0.43, median 0.77, 90th
pct 0.94, max 0.98. 34 holds under 0.5, 20 holds at/above 0.95.

## The volcanic rock — `custom_1785242211962`

This is the case the owner called out as badly outlined, and the task asked
specifically whether the new result beats both today's live outline and the
prototype's own SAM result. Checked directly, at high resolution, three ways:

**Areas (board %²):** existing (today's live) = 27.23 · this run's chosen
result = 29.98 · prototype's original SAM = 30.29 · prototype's original
GrabCut = 26.74.

This run's result and the prototype's SAM result are within **1%** of each
other in area, and a direct overlay shows them tracing an almost identical
silhouette — strong evidence the pipeline reproduces the prototype's finding
correctly even though it was seeded from a different prior (today's live
polygon, not the prototype's rough pre-correction one).

**Visually, today's live outline (already a GrabCut-based hand-applied fix
from earlier today) still undershoots**, cutting across roughly the bottom-
right third of the rock's true, visibly-craggy extent — the same failure
mode the original prototype called out, just less severe than the original
rough prior. This run's SAM-chosen result extends correctly into that
missed region. **Verdict: beats today's live outline, matches the
prototype's SAM result.** Because this hold's aspect ratio (1.65) is well
under the thin-gate threshold, SAM was the default choice here anyway —
consistent with both this run and the prototype agreeing it's the right
method for this hold.

Why the coarse metrics alone would have missed this: shift 0.039 board%,
area ratio 1.101 — both comfortably "not material" by this run's own
threshold. This is exactly the kind of case RESULTS.md's own prototype
warned about (numbers can be genuinely misleading for irregular shapes) —
the visual check is what actually answers the question.

## Dry-run proof (`merge_board_holds.mjs --update`, no `--commit`)

Run against `_guided_reoutline_updates.json`, board `the-barn`:

```
Board: The Barn (the-barn)  id=1c97fee6-285a-4774-a185-cb5f17e60acf
Existing holds: 204
Routes on this board: 38
Updates in file: 203
  ✓ all 203 update ID(s) exist in the current array
  ✓ all geometry patches pass shape validation

── Invariant checks ──
  ✓ invariant 1: every pre-existing ID is present after the merge
  ✓ invariant 2: pre-existing records unchanged except the declared geometry keys
  ✓ ID set identical before/after (update mode adds/removes nothing)
  ✓ invariant 4: final count 204 matches expectation

── Route reference check (invariant 3) ──
  routes checked: 38  |  hold refs: 425
  ⚠ pre-existing dangling ref(s), NOT caused by this run (known before): custom_hold_9
  ✓ invariant 3: no route reference was broken by this run

── Summary ──
  before:   204
  updated:  203
  after:    204
  routes checked: 38   dangling: custom_hold_9

DRY-RUN complete — nothing written. Re-run with --commit to apply.
```

Named holds spot-checked in the log (e.g. `custom_hold_1` "Finish Jug",
`custom_hold_4` "Flathold Sloper", `custom_1778625068454` "Woody crimp") show
their `name`/`holdTypes` preserved verbatim while only geometry updates —
confirms the metadata-preservation contract end to end, not just in the
invariant assertions.

## What this run does NOT tell you

- It does not know which of the 191 "SAM, high IoU, gate accepted" holds are
  actually *correct* — high agreement between two related methods sharing a
  seed prior is evidence of consensus, not ground truth. It is, however, the
  same signal the task specified, and it demonstrably separates real trouble
  (worst-20) from real non-trouble (bottom-20) on inspection.
- It doesn't fix the bolt-on-chip weakness — it surfaces it. A future pass
  could special-case very small priors (by absolute board-% area, not just
  aspect ratio) to prefer GrabCut there too, the same way thin holds are
  special-cased now. Not done here — out of scope for this task, and the
  gate + review sheet already catch the worst instances.

## Reproducing this

```bash
/tmp/holds_venv/bin/python scripts/guided_reoutline.py \
    --board the-barn \
    --image board-assets/the-barn/Barn_Set_01_V8.jpg \
    --output board-assets/the-barn/_guided_reoutline_updates.json \
    --review-dir board-assets/the-barn/_guided_reoutline_review \
    --top 20

# then, always dry-run before ever considering --commit:
node --env-file=.env.local scripts/merge_board_holds.mjs \
    --board the-barn --update board-assets/the-barn/_guided_reoutline_updates.json
```

No Supabase writes were made in the course of this task. `--commit` is a
separate, later, human decision.
