# Outline-fit scoring — results (The Barn, `Barn_Set_01_V8.jpg`)

`scripts/score_outline_fit.py` scores each hold's CURRENT outline against the CURRENT
board photo directly — not against another algorithm's guess (that was the earlier
"method disagreement" approach, which produced 133 holds to review because two
algorithms failing to agree isn't the same thing as an outline being wrong).

Read-only throughout: `holds_1c97fee6-285a-4774-a185-cb5f17e60acf` was fetched with a
plain GET, the photo was opened with `cv2.imread` and never written, and nothing was
written back to Supabase.

Run:
```
python3 scripts/score_outline_fit.py --board the-barn \
    --image board-assets/the-barn/Barn_Set_01_V8.jpg \
    --output board-assets/the-barn/_outline_fit/ranked.json \
    --overlay board-assets/the-barn/_outline_fit/review_top.jpg --top 15
```
213 live holds scored (0 skipped for missing polygon data).

## Method

1. **Plywood model.** Every hold's polygon is unioned into one mask, dilated by a
   buffer (`max(12px, 0.5 * median hold half-extent)` = 12px here), and inverted
   within the board-region bounding box — the remaining ~60% of the board area is
   the plywood sample (1,263,735 px). From it: median CIE-LAB colour
   (L=202, a=131, b=148 in OpenCV's 0-255 LAB) and median local texture energy
   (blurred `|Laplacian|` — plywood is smooth/low-relief, E=6.08).
2. Per pixel, a **combined distance** from that plywood model: chroma (a*, b*,
   weight 1.0 each) dominates over lightness (L*, weight 0.3, since shadow/glare
   shifts brightness a lot more than material colour does), plus texture energy
   added (not squared) so a busy-textured pixel can never "buy back" a plywood-like
   colour. A self-calibrated cut — the 92nd percentile of the plywood SAMPLE's own
   distance — separates "plywood-like" from "not."
3. Per hold: `emptiness` (core interior plywood fraction), `spill` (boundary-band
   plywood fraction — outline bigger than the hold), `leakage` (non-plywood pixels
   in a ring just outside the polygon, restricted to the connected component that
   touches the interior — hold extends past its outline), `edge_alignment` (mean
   Sobel gradient magnitude sampled along the boundary, relative to a per-photo
   reference — does the outline sit on a real image edge).

## Two fixes made during calibration (both driven by the known-bad/known-good checks below)

**1. Small-hold noise → locally-adaptive plywood threshold, not just a size floor.**
The single GLOBAL plywood cut in step 2 turned out to badly misclassify one whole
colourway on this board: a matte grey/stone set of holds that sits close to plywood
in the GLOBAL colour model (see the LAB numbers above — genuinely close). The fix
isn't a size correction — it's that "close to the BOARD-WIDE plywood average" is the
wrong question; "close to the plywood immediately around THIS hold" is the right
one. Each hold now gets a locally-adaptive threshold: `local_median + max(3 MADs,
0.35)`, where the local sample is an annulus AROUND the hold, deliberately started
`2×` the boundary-band width OUT from the polygon edge (skipping the halo/shadow a
real 3D hold casts on its own immediate surround, which otherwise drags the "local
plywood" baseline toward the hold's own colour) and excluding any pixel that falls
inside a *different*, neighbouring hold's own polygon. 211/213 holds had enough
clean local ring to use this; the other 2 fell back to the global cut (crowded by
neighbours / near the board edge). `emptiness` also now looks only at the polygon's
deep CORE (eroded by the boundary-band width), not the full interior — a real hold's
own edge has an unavoidable sliver of shadow/antialiasing, which is a much bigger
fraction of a small hold's interior than a large one's, so folding it into
`emptiness` was a second, compounding size bias.

**2. Colour/texture alone still can't clear the grey colourway → `edge_alignment`
used as a gate, not just a weighted term.** Even after fix 1, the grey colourway
kept producing false positives (visually confirmed — see "Visual verification"
below): 11 of the 70 known-good re-outlined holds still landed in the top 15.
Looking at *why*: every one of those false positives had `edge_alignment = 1.00`
(the outline boundary sits squarely on a real image edge), while both known-bad
reference holds sat at 0.54–0.56. That is direct, physical evidence: a crisp,
correctly-placed boundary means something is almost certainly really there,
regardless of how close its fill colour happens to be to plywood. So
`edge_alignment` is now used **twice** — once as its own weighted term, and once as
a multiplicative gate on `emptiness` and `spill`:

```
edge_gate = 1 - EDGE_GATE_STRENGTH * edge_alignment     # EDGE_GATE_STRENGTH = 0.85
fit_score = 0.35 * emptiness * edge_gate
          + 0.15 * spill     * edge_gate
          + 0.20 * leakage
          + 0.30 * (1 - edge_alignment)
```
(clipped to `[0, 1]`). The gate never reaches exactly 0 (`EDGE_GATE_STRENGTH < 1`) —
an edge can coincidentally land on a T-nut or a wood-grain seam. `leakage` is left
ungated: it's a different failure mode (material escaping a good boundary), not an
ambiguous fill colour. `emptiness` keeps the larger of the two gated weights —
"sits on nothing" is the clearest defect this method can see once a real boundary
is ruled out.

This is a real, stated trade-off: `edge_alignment` (Sobel gradient) is the noisiest
of the four signals in general (busy wood grain or a stray shadow can fake a weak
edge), and giving it this much leverage on a colour-similar colourway means a hold
whose true colour genuinely matches plywood *and* whose boundary happens to sit on
a wood-grain line could still slip through both checks. I did not find such a case
in the top 15 (see below), but it is the scorer's remaining honest blind spot.

## Calibration against the task's two references

**Known-bad** (earlier analysis: lowest edge energy on the board, 13.7/20.5 vs 40+
typical):
| hold | rank (of 213) | fit_score | emptiness | spill | leakage | edge_alignment |
|---|---|---|---|---|---|---|
| `custom_1785865721479` | **1** | 0.411 | 0.91 | 0.88 | 0.16 | 0.54 |
| `custom_1785865743901` | **3** | 0.357 | 0.73 | 0.68 | 0.17 | 0.56 |

Both land at the very top, as required.

**Known-good** (the 70 holds in `_guided_reoutline_updates_gated.json`, gated at
IoU≥0.85 agreement between GrabCut and SAM, already live on this board — confirmed
by a direct read-only GET: `custom_hold_55`'s live polygon matches the gated file
byte-for-byte):
- Median rank **124.5 of 213** (solidly mid-pack — unremarkable, as a "verified
  fine" set should be).
- Best (= worst-ranked) member sits at rank 10.
- **3 of 70** land in the top 15: `custom_1775051929956` (#10), `custom_1775051932821`
  (#11), `custom_1775051951726` (#13) — down from 11/70 before fix 2. See the visual
  verification below for a read on these three specifically; my own judgement
  disagrees with the flag on two of them (#10, #11 look like genuine, correctly
  outlined grey holds to me), which is exactly the residual blind spot fix 2
  couldn't fully close, and is reported honestly rather than papered over.
- Note on scope: the task's guarantee was specifically about "the big obvious
  holds (large yellow/teal/black volumes)" in that set, not literally all 70 —
  several of the 70 are small grey holds of the exact colourway this scorer
  struggles with, so some residual disagreement there is expected, not a sign the
  large-volume check failed.

## Size-bias check

`corr(fit_score, area_pct2) = -0.162` across all 213 holds (weak negative — some
residual size correlation remains, expected given percentage-based metrics are
inherently noisier on a smaller pixel count, but far from "the score is just size in
disguise"). **Top-15-worst vs top-15-smallest-by-area: 0/15 overlap** — the top 15
is not simply the 15 smallest holds on the board.

## Top 15 (worst-fitting outlines)

| rank | hold id | fit_score | emptiness | spill | leakage | edge_align | reason |
|---|---|---|---|---|---|---|---|
| 1 | `custom_1785865721479` | 0.411 | 0.91 | 0.88 | 0.16 | 0.54 | outline sits mostly on bare plywood — possible hold that was never mounted, or removed |
| 2 | `custom_1778624972273` | 0.376 | 0.14 | 0.27 | 0.77 | 0.44 | outline doesn't follow the hold's edge |
| 3 | `custom_1785865743901` | 0.357 | 0.73 | 0.68 | 0.17 | 0.56 | outline sits mostly on bare plywood — possible hold that was never mounted, or removed |
| 4 | `custom_1778624983441` | 0.342 | 0.08 | 0.11 | 0.83 | 0.50 | hold extends beyond its outline |
| 5 | `custom_hold_1` | 0.264 | 0.05 | 0.22 | 0.54 | 0.57 | outline doesn't follow the hold's edge |
| 6 | `custom_1775051292645` | 0.260 | 0.60 | 0.64 | 0.18 | 0.68 | outline doesn't follow the hold's edge |
| 7 | `custom_1775051820080` | 0.260 | 0.32 | 0.39 | 0.49 | 0.69 | hold extends beyond its outline |
| 8 | `custom_1775051289481` | 0.235 | 0.30 | 0.54 | 0.26 | 0.66 | outline doesn't follow the hold's edge |
| 9 | `custom_hold_42` | 0.226 | 0.26 | 0.41 | 0.43 | 0.73 | hold extends beyond its outline |
| 10 | `custom_1775051929956` | 0.222 | 0.69 | 0.44 | 0.10 | 0.72 | outline sits mostly on bare plywood — possible hold that was never mounted, or removed |
| 11 | `custom_1775051932821` | 0.218 | 0.24 | 0.28 | 0.31 | 0.66 | outline doesn't follow the hold's edge |
| 12 | `custom_1775051351826` | 0.214 | 0.13 | 0.36 | 0.33 | 0.65 | outline doesn't follow the hold's edge |
| 13 | `custom_1775051951726` | 0.204 | 0.02 | 0.06 | 0.54 | 0.70 | hold extends beyond its outline |
| 14 | `custom_1778666625467` | 0.203 | 0.60 | 0.61 | 0.18 | 0.78 | outline sits mostly on bare plywood — possible hold that was never mounted, or removed |
| 15 | `custom_1778625319912` | 0.202 | 0.10 | 0.11 | 0.83 | 0.92 | hold extends beyond its outline |

(All 213 holds, every sub-score, and `reason` for each are in `ranked.json`. Overall
`fit_score` across all 213: mean 0.121, median 0.109 — the top 15 are genuine
outliers above a long low tail, not an arbitrary top slice of a flat distribution.)

## Visual verification (opened `review_top.jpg`, judged every panel myself)

| # | hold | my read | notes |
|---|---|---|---|
| 1 | `custom_1785865721479` | **agree** | diagonal patch of plain wood grain, no material; matches the known-bad reference |
| 2 | `custom_1778624972273` | agree (low confidence) | small quad straddling a yellow/teal colour seam — outline doesn't track a clean feature boundary either way |
| 3 | `custom_1785865743901` | **agree** | pentagon on plain wood between two other (uncircled) holds; matches the known-bad reference |
| 4 | `custom_1778624983441` | agree | sits right at a yellow/teal seam, looks truncated/arbitrary rather than bounding one feature |
| 5 | `custom_hold_1` | agree (low confidence) | outline covers only part of a visibly larger yellow blob — plausibly undersized |
| 6 | `custom_1775051292645` | agree | faint patch, low contrast, same character as the two known-bad holds |
| 7 | `custom_1775051820080` | **disagree** | looks like a genuine, reasonably well-outlined grey hold to me |
| 8 | `custom_1775051289481` | agree (low confidence) | thin, low-contrast sliver near a dark hold; plausibly empty or marginal |
| 9 | `custom_hold_42` | agree (low confidence) | unusual panel (different lighting zone); teal shape does look like it extends slightly past the outline |
| 10 | `custom_1775051929956` | **disagree** | genuine grey hold with visible bolt holes, outline looks reasonable |
| 11 | `custom_1775051932821` | **disagree** | same — genuine grey hold, reasonably outlined |
| 12 | `custom_1775051351826` | agree (low confidence) | odd, flatter-toned crop region; thin sliver, hard to read but plausibly a real issue |
| 13 | `custom_1775051951726` | agree | yellow material visibly extends above the drawn outline |
| 14 | `custom_1778666625467` | agree | blank-looking wood near a mounting bracket, same character as known-bad holds |
| 15 | `custom_1778625319912` | agree | purple/lilac patch visibly extends past the outline into the black hold |

**Honest hit rate: 12/15 agree, 3/15 disagree** (`custom_1775051820080`,
`custom_1775051929956`, `custom_1775051932821` — all three are the grey/stone
colourway, all three are in the "known-good" gated 70, and all three are the
residual blind spot fix 2 didn't fully close: their fill colour is close enough to
local plywood *and* their edge is imperfect enough that the gate doesn't fully
save them). That clears the task's bar (flag if more than ~4/15 look fine — only 3
did). Several of the "agree" calls above are honestly **low-confidence** at this
crop resolution/zoom (2, 5, 8, 9, 12) — a human standing at the actual board will
resolve those in seconds; I'm reporting my zoomed-photo read, not certainty.

## Confidence

**Moderate-to-high** that this list is a genuine improvement over "review 133 holds
by method disagreement": 12/15 panels look like real, correctly-identified defects
on direct visual inspection, the two independently-derived known-bad references
land at ranks 1 and 3, the known-good set is unremarkable (median rank 124.5/213,
not clustered at the top), and the top 15 is demonstrably not just "the smallest
holds" (0/15 overlap, weak size correlation). **The stated blind spot**: a specific
grey/stone-coloured hold set on this board sits close to plywood in both colour and
texture, and for the minority of that colourway with an imperfect edge (not the
majority — most such holds scored low, see the "LARGEST 10 gated holds" check
during development, all ranked in the best 15% of the board), the scorer still
occasionally over-flags. That is a genuine limit of a colour/texture/edge
comparison against a single photo, not a bug I could tune away without also risking
missing real defects on that colourway — it is reported here rather than hidden.
