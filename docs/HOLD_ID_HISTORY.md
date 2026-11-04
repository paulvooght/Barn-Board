# Hold IDs, Tweaks and Resets: a History of the Barn Board App

*Written 2026-11-04 from the git history, CURRENT_STATE.md, the docs in `docs/`, and the
project memory. It is meant as a briefing for the next project: the Yonder climbing-centre
app, which brings this board concept to a wider centre whose boulders are on geometric walls.*

> **Naming note.** "Yonder" means two things here. In this repo it is the **second wall**
> (board slug `yonder`, a dense spray wall with 0 routes). In the new project it is the
> **whole climbing-centre app**. This doc says "Yonder wall" for the first and "the new app"
> for the second.

---

## 1. The one problem everything here is about

A route is a list of hold IDs mapped to roles (`{ holdId: "start" | "hand" | "foot" | ... }`).
A route does not store where its holds are. It points at hold records, and those records
hold the geometry. That gives three things that can drift apart:

```
 physical hold on the wall  ←→  hold record (ID + outline)  ←→  routes that reference the ID
        (reality)                  (board_settings)              (routes.data.holds)
```

All the work below comes down to two questions:

1. **When the wall or the photo changes, how do hold records follow reality without their IDs
   changing?** (This is the TWEAK.)
2. **When reality changes so much that the old records no longer describe the wall, how do
   you retire them without breaking the routes that used them?** (This is the RESET.)

If you get either one wrong, nothing errors. Routes just render holds in the wrong places, or
holds quietly drop out of a problem. That silence is why this area gets so much caution.

---

## 2. TWEAK vs RESET: the core distinction

| | **TWEAK** (set update) | **RESET** (new set) |
|---|---|---|
| What happened physically | A few holds were added, moved or removed. The set is clearly the same one. | The wall was stripped and set again. Most holds are different. |
| What must happen to routes | **They survive.** Every route still climbs. | **They retire.** They describe holds that are gone. |
| Hold IDs | Kept, always. Geometry may move. | The old IDs are frozen with their set. New holds get new IDs. |
| New photo's job | Shows the same holds from a slightly different camera spot, plus a few changes | Shows a different wall |
| Status in this app | ✅ Built, used in production (V8, V9) | ⚠️ Backend built 2026-09-10, **not live** (migration `010` not applied), no UI |

**What goes wrong if you mix them up, in either direction:**
- **Treat a reset as a tweak:** about 200 hold records stay at their old coordinates on a
  wall that no longer has those holds. All 38 routes still show as climbable, and all of
  them are nonsense.
- **Treat a tweak as a reset, or "tidy up" by deleting old holds:** every route that used a
  deleted hold silently loses it. There is no error and no record of which routes were hit.
  Only a backup restore fixes it.

**Rule set by the owner on 2026-06-06: never auto-decide.** The system may *suggest* tweak
or reset from a measured overlap number, but an admin always makes the choice, and the
destructive path needs a confirm that says what it will cost.

---

## 3. Timeline

### Phase 0: sequential IDs from a detector (March 2026)
- `scripts/detect_holds.py` detected holds **by colour** (fixed HSV bands for cyan, yellow,
  purple, black, plus a Canny edge pass). It wrote `src/data/holds.json` with IDs
  `hold_1, hold_2, ...` **assigned in order of sorted position**.
- There were three data layers: base `holds.json`, then `hold_overrides` (edits and hides of
  base holds), then `custom_holds` (holds made in Hold Manager, IDs `custom_<timestamp>`).
- **The flaw built in from the start:** the ID was a function of position. If one new hold
  was detected anywhere, every ID after it shifted by one.

### Phase 1: the ID-scramble incident and `merge_holds.py` (2026-04-01 to 04-19)
- **V3A (`3548e42`):** the board got a new photo and holds were re-detected (24 → 43). The IDs
  scrambled: `hold_5` became a different physical hold, so every route pointed at the wrong
  places. The commit message even suggested "use Hold Manager > Reset All to clear stale
  overrides". That was exactly the wrong reflex, because it would have wiped the IDs.
- **Fix (`0c6d960`, same day):** the old 24 holds were spatially matched against the 43 new
  detections (max distance 3.9%), so `hold_1..24` were restored and the new ones became
  `hold_25..43`. Two safeguards came out of it:
  - `scripts/merge_holds.py`: nearest-neighbour matching within a 5% threshold. A match
    keeps its old ID. An unmatched detection gets the next number. An unmatched old hold
    is **kept, flagged "possibly removed", and never deleted**.
  - `detect_holds.py` gained `--output` and a guard that refuses to overwrite a populated
    `holds.json` unless you pass `--force`.
- **V4 (`91e4e2d`):** 33 matched, 9 new, 10 orphans kept. **V5 (`32a22c2`):** 23 matched,
  3 new, **29 orphans kept**. The orphan count kept growing, which was a sign that
  re-detecting and then matching did not work well. A V6 test merge was reverted on 04-19.
- **Missing-hold ghost system (March–April):** each route stores `holdSnapshots`, its own
  copy of each hold's geometry at save time. If a referenced hold disappears, the route
  view draws a ghost outline from the snapshot instead of silently dropping it, and editing
  the route strips the missing refs on save. This is the safety net under everything else
  in this doc, and it is still the only mechanism that keeps a route readable after its
  holds are gone.

### Phase 2: phone image wizard, which warps the photo (2026-04-12 to 04-20)
- `BoardImageUpdateView`: upload → crop → align (4 pins plus a `matrix3d` perspective warp)
  → fine-tune → confirm. **Design choice: warp the new photo into the old photo's frame** so
  hold coordinates stay valid without being touched. A guided camera overlay
  (`GuidedCameraStep`) was added to help the admin reproduce the camera position.
- This avoided the ID problem by never moving the hold records at all. It was later
  **rejected on principle** (see Phase 5), although the in-app wizard still works this way.

### Phase 3: everything became `custom_*` (around April–May, found in September)
- Hold Manager's "Save & Exit" called `replaceAllHolds()`. That hid every base hold and
  re-saved the whole set as `custom_` holds. The Barn ended up with all 55 base holds hidden
  and **186 live `custom_*` holds**.
- **A hidden landmine:** `merge_holds.py`, which CLAUDE.md described as "the safe
  workflow", **ignores `custom_*` IDs**. Run as documented, it would have silently thrown
  away every live hold and broken all the routes. Nobody noticed until 2026-09-09 (Phase 5).
- **The lesson:** a safety tool tied to one ID scheme stops being safe when the ID scheme
  changes underneath it.

### Phase 4: per-wall hold arrays, plus the detection redesign (2026-06-05 to 06-08)
- **Multi-wall 2b-ii (`48ea2b6`):** each wall owns its full hold array at
  `board_settings['holds_<boardId>']`. The Barn's array was seeded as a **verbatim copy** of
  `custom_holds`, so the IDs were preserved byte for byte. The runtime base/override/custom
  merge went away, and so did the re-prefixing done by `replaceAllHolds`. The legacy keys
  remain as a revert path.
- **Detection redesign, built and tuned on the Yonder wall because it had 0 routes and so
  no IDs could break:**
  - Colour detection found only **108 of about 220** holds. One hold's pixels span a wide
    HSV range, and chalk and specular highlights fall outside every band.
  - **The reframe:** detect the *object* ("is this plywood or not?") and treat colour as a
    label added afterwards. `detect_holds_v2.py` uses FastSAM: 108 → 149 → 193.
  - Refine pass (`refine_holds.py`): fills holes, removes shards, merges by colour, splits
    touching holds, and uses a **monocular depth cue** (Depth Anything V2) to reject flat
    chalk, shadow and reflection. Result: 193 → 200.
  - **Honest ceiling:** about 85–90% automatic. Small black foot chips look the same as
    T-nut holes from one photo.
- **Tap tools, built and then removed:** first a precomputed candidate library with tap to
  pick, then live in-browser MobileSAM ("tap anything", encoder on the server, about 16 MB
  decoder in WASM). An A/B test on real holds showed it **did not earn its place**, and it
  was removed on 06-07. On a wall of repeated holds, **copy/paste won**. That pointed toward
  the **hold catalogue** idea (§7).
- **The Yonder wall was reseeded wholesale** (108 → 201 holds). That was only safe because
  it had 0 routes. It was effectively a reset of a wall with no routes, which is the one
  case where a reset is trivial.
- **On 06-06 the owner raised the TWEAK vs RESET rule**, the set-version idea, and
  "archive, never delete".

### Phase 5: "the photo is the truth, the holds move" (2026-09-09)
The Barn got photo V8. The camera had moved by 4–42 px.
- **First attempt (`87d22bd`): warp the photo into V7's frame** so the 200 records could stay
  byte-identical. It was safest for the data, and the measured sharpness cost was only 2.6%.
  **The owner looked at the deployed board and rejected it.** The photo is what climbers look
  at every session, and "safe for the database" is not the same as "right for the app".
- **The protocol that replaced it (`7258db5`):**
  1. `align_board_image.py` uses SIFT and RANSAC to **measure** the camera homography (427
     inliers). Its warped image is only a diagnostic.
  2. `reproject_holds.py` carries every polygon through the **inverse homography** into the
     new photo's frame. It is exact, global and keeps the IDs. 200/200 holds moved, with
     **zero non-geometry fields changed**.
  3. `merge_board_holds.mjs` is **the only sanctioned tool for changing a live hold array**.
     It has `--update` (geometry only) and `--add` (append with a duplicate guard). It has no
     delete, rename or bulk-replace mode. It runs as a dry-run by default. `--commit` backs up
     first, writes, then re-fetches and re-checks 4 invariants: every old ID is still present;
     records are otherwise unchanged; every route reference still resolves; the counts add up.
  4. `publish_board_image.py --board` publishes the **raw camera file** (md5 identical to
     the source).
  5. `diff_new_holds.py` diffs the old and new photo in a way that ignores lighting, to find
     NEW, CHANGED, INTERIOR and VANISHED regions. A plain pixel diff was useless because the
     white balance changed by region.
- **Why the homography beats re-detection plus matching:** the camera move is one global
  transform for a flat board, so it is exact. Re-detection guesses the outlines, then guesses
  the pairing, and throws away polygons that were tuned by hand. It is the same reason the
  orphans piled up in Phase 1.
- **Discovery, "records ahead of the camera":** 10 holds that looked new already had IDs.
  Their epoch-ms IDs dated them to after the previous photo. The owner had mounted them and
  outlined them over bare plywood in the old photo. They were re-outlined, not added. Only
  **4 were genuinely new**. Result: 200 → 204, 0 IDs lost, 38 routes and 425 references intact.
- The `merge_holds.py` landmine was closed: it now refuses to run when it would discard
  `custom_*` holds.
- `docs/RESET_PROCESS_SPEC.md` was written (spec only).

### Phase 6: automation and the RESET backend (2026-09-09 to 09-10)
- `guided_reoutline.py` re-outlines every hold from the current photo, keeps every ID,
  resolves neighbours against each other, and only applies a new outline where SAM and
  GrabCut agree (an IoU gate). It never writes; it emits an `--update` file.
- `score_outline_fit.py` scores each outline directly against a statistical model of
  plywood. It looks for "emptiness" (an outline sitting on bare wall) and "spill". This
  replaced the "two methods disagree" ranking, which flagged about 130 holds that were
  mostly fine.
- **`board_update.py` is the one-command TWEAK.** It runs backup → align → diff →
  **RESET-signal gate** → reproject → apply → publish → gated re-outline → new-hold
  candidates (for review, never auto-added) → scoring → report. The RESET gate runs
  **before any live write**. If (new + changed + vanished) / the live hold count is above
  `0.5`, it aborts and points at the reset spec.
- **RESET backend (`4007d84`), stage 1 of the spec:**
  - `supabase/migrations/010_set_versions.sql` adds a `routes.set_version` column
    (backfilled to 1), `boards.specs.setVersion`, and RLS coverage for the frozen
    `holds_<boardId>_v<n>` keys. Without that last part, writes would have silently failed
    the 008 RLS regex. **Not applied to prod.** Checked 2026-11-04: the column does not
    exist, and neither wall has `setVersion`.
  - `scripts/board_reset.mjs`:
    1. Back up.
    2. **Freeze** `holds_<id>` → `holds_<id>_v<n>`, then verify it is byte-identical.
    3. Stamp the routes.
    4. Increment the set version.
    5. Replace the live array with fresh IDs.
    6. Re-verify 5 post-conditions.

    `--commit` requires `--yes-archive-<N>-routes`, where N must match the live count, so an
    old command line can't fire against the wrong number of routes. A dry-run against The
    Barn correctly reported 38 routes to archive.
  - `db.js` gained `getFrozenHolds()` and an optional `setVersion` filter on `fetchRoutes()`.
  - **Not built:** the TWEAK/RESET choice screen, the "Past sets" list, archived-route
    rendering from frozen snapshots, and the stats, sessions and playlists decisions (§5).

### Phase 7: V9, the latest real tweak (2026-10-24)
- `board_update.py --iou-gate 1.01` effectively switched off auto re-outlining, because the
  owner wanted their hand-tuned shapes kept. The camera move was 4.93 px and the RESET
  signal was 0.042, so it was clearly a TWEAK. All 213 holds were reprojected (mean shift
  0.31% of the board, shape change below a pixel, zero metadata changes).
- **Failure worth noting:** V9's white balance was much cooler. The automatic diff found
  **1 of 14** real new holds, and FastSAM everything-mode also found 1. The new holds were
  found **by eye** from side-by-side tiles, then outlined with **point and box prompts in
  SAM 2.1**, and added with `--add`. Result: 213 → 227, 39 routes and 435 references intact.
- **Known gap:** route `annotations` (drawn lines, added 2026-10-21) are **not reprojected**,
  so they can drift a few px after a photo update.

---

## 4. Where things stand now

| Piece | Status |
|---|---|
| Hold storage | One JSON array per wall in `board_settings['holds_<boardId>']`. IDs are `custom_<epoch-ms>`, never re-derived. |
| TWEAK pipeline | ✅ Production (`board_update.py` → reproject → `merge_board_holds.mjs`) |
| Route self-description | ✅ `holdSnapshots` ghosts. One known dangling ref: `custom_hold_9`. |
| RESET backend | ⚠️ Code exists; migration `010` not applied; no UI |
| RESET UI and archive semantics | ❌ Not built |
| Detection | FastSAM + refine + depth, about 85–90%. A human closes the rest in Hold Manager. |
| Change detection between photos | ⚠️ Fragile when lighting or white balance changes (V9: 1 of 14) |
| Flywheel and hold catalogue | Designed, not built. `hold_tagger.py`'s `edits.jsonl` is the reference schema. |
| In-app image wizard | Still warps the *photo* (the Phase 2 approach). It conflicts with the "photo is truth" rule and is effectively superseded by the laptop protocol. |

**Doc drift to be aware of:** CLAUDE.md and the header of `board_update.py` still say "RESET
is NOT implemented". More precisely, it is *implemented but not deployed*.

---

## 5. Open questions the RESET spec never closed

These carry straight over to the new app, and they matter more there:
- **Per-user data on archived routes:** sends, ratings and grade suggestions should survive
  as history. Should they count toward current stats?
- **Sessions** reference routes by ID. Old sessions must still resolve archived routes.
- **Climber card and heat map:** do archived sets count? The likely answer is yes for all
  time and no for the current period.
- **Shared playlists** containing archived routes: show them greyed out rather than dropping
  them.
- **Partial resets** (half the wall re-set) are currently forced into TWEAK, the safe
  default. This was never tested in practice.

---

## 6. Lessons, distilled

1. **Never derive an ID from position or detection order.** `hold_N` caused the only real
   scramble. Use opaque IDs that are assigned once and never recomputed.
2. **Hold identity and hold geometry are separate things.** A camera move changes geometry,
   not identity. Tools should be able to update one without touching the other
   (`--update` vs `--add`).
3. **If the camera move is one global transform, measure it; don't re-detect.** Reprojection
   was exact. Re-detection plus nearest-neighbour matching piled up orphans (29 by V5) and
   threw away hand-tuned polygons.
4. **The photo is the product.** Never distort it to make the data easy. Move the data.
5. **Mutating tools should be append-only, dry-run first, and verify after writing.** Make
   the dangerous operations impossible in the tool (no delete mode) instead of relying on
   remembering not to use them.
6. **A safety tool is only as good as its assumptions.** `merge_holds.py` became a landmine
   once IDs went `custom_*`. Re-check guards whenever the data model changes.
7. **Routes should describe themselves.** `holdSnapshots` let a route outlive its holds.
   Frozen per-set snapshots extend that same idea to resets.
8. **Archive, never delete. Never auto-decide a reset. Put the cost on the confirm.**
9. **Data records can be ahead of the photo.** Holds get outlined before they're
   photographed. Timestamp IDs are what made this diagnosable, so keep a creation time on
   every hold.
10. **Automation tops out at about 85–90%.** The human pass is permanent, so design it to be
    fast (review lists sorted worst first, copy/paste for repeated holds) rather than
    chasing 100%.
11. **Change detection depends on consistent capture.** White balance alone sank the V9 diff.
12. **A reset of a wall with no routes is trivial,** which is why the Yonder wall's reseed
    was fine. The cost of resets only arrives once routes exist, so build the machinery
    before that day.

---

## 7. Considerations for the new app (geometric walls, a whole climbing centre)

The new app changes some of the assumptions underneath everything above. These are the ones
most worth rethinking.

### 7.1 RESET becomes the normal event, not the rare one
A private board is tweaked for months and almost never reset. A commercial centre strips and
re-sets a sector every few weeks on a rotation. **Design set versions in from day one, as a
first-class table**, instead of adding them later through `specs` and settings keys:

```
walls (sectors)  ─┬─ wall_sets (id, wall_id, version, set_date, strip_date, status: live|archived)
                  │       └─ placements (id, set_id, catalogue_hold_id?, geometry, retired_at)
                  └─ routes (id, set_id, ...)  → reference placement IDs
```

A route belongs to a set, and a set has a lifespan. "Archived" becomes the default state for
most routes over time, so stats, sessions and playlists need to handle archived routes from
the start (the §5 questions become core requirements).

### 7.2 One homography only works on a flat wall
Reprojection worked because The Barn is a **single plane**: one 3×3 homography maps the whole
board exactly. Geometric walls have many facets (volumes, arêtes, overhang prows, slab
panels) at different angles, and **each facet has its own homography**. One global transform
will be wrong across a fold. Options, roughly in order of effort:
- **Treat each planar facet as its own "board"** with its own photo region and coordinate
  frame. Hold geometry is a percentage within its facet, and you reproject facet by facet.
  This needs the least new work and fits the existing pipeline.
- **A piecewise transform** (a triangulated mesh warp driven by matched features). It handles
  folds approximately and needs no 3D model.
- **A 3D model of the wall** (photogrammetry or a LiDAR scan, which an iPhone Pro can do),
  with holds as 3D points or patches and any photo registered by camera pose. This is the
  most robust option and makes multi-angle views possible, but it is a much bigger build.

Even with facets, the core rule carries over: **measure the camera, move the holds, never
distort the photo.**

### 7.3 Gym boulders may not need per-hold IDs at all
Board routes are defined by *which* holds (hand-picked from a shared set). Commercial
boulders are usually defined by **hold colour plus start and top tags in one sector**. The
problem is itself a physical thing with a set date and a strip date. A hybrid model may fit
better:
- **Board-style walls** keep hold-level routes and everything in this doc.
- **Gym boulders** become route entities with a sector, colour, grade, setter, photo or
  photos, an optional highlighted region, and a lifespan. A reset is then simply "strip date
  reached, route archived", with no hold-ID risk at all.

This avoids paying the full cost of hold IDs where the route doesn't need it.

### 7.4 Separate the catalogue hold from its placement
The owner reuses the same physical holds across sets, and a centre definitely does (it keeps
a hold inventory). Splitting **catalogue hold** (the physical object: shape, colour, brand,
holdTypes) from **placement** (that object at a position in one set) cleanly separates:
- **TWEAK:** a placement is added, moved or removed within a live set. Its IDs are kept.
- **RESET:** a new set gets new placements, possibly of the same catalogue holds.

It also opens up the parked **catalogue and flywheel** idea: detection turns into
*recognition* ("that's the blue Kilter jug, ID 412"), and hold metadata is entered once per
object instead of once per placement.

### 7.5 Storage and concurrency
`board_settings['holds_<boardId>']` is one JSON blob per wall, written as a whole array. That
was fine for one admin and one wall. A centre with several setters working at once needs
**one row per placement** with soft-delete (`retired_at`), so two setters can't overwrite each
other's edits, and RLS can be scoped per set or sector. Use **UUIDs**, not `custom_<ms>`
(a batch insert had to work around timestamp collisions).

### 7.6 Make capture consistent, since it carries the change detection
The V9 diff failed on white balance, and V8 needed a measured homography because the camera
moved. For a centre, standardise capture: a **fixed mount or marked tripod spot per sector**,
locked exposure and white balance, and optionally a colour card in frame. Consistent capture
makes the diff reliable, the TWEAK/RESET suggestion trustworthy, and the reprojection small.

### 7.7 Carry the lessons over unchanged
- Opaque, permanent IDs, and a creation time on every record.
- Append-only, dry-run-first mutating tools that verify after writing.
- Routes that carry snapshots of their own geometry.
- Archive, never delete. A human chooses reset vs tweak. The confirm states the cost.
- Reproject *everything* that lives in photo coordinates (holds **and** annotations, which
  this app missed).
- Laptop-first for heavy setup; the phone for quick tweaks at the wall.

---

## 8. Key files, for reference

| File | Role |
|---|---|
| `docs/RESET_PROCESS_SPEC.md` | Full RESET design: set versions, freeze, archive, confirm UX |
| `docs/HOLD_DETECTION_HANDOVER.md` | Detection pipeline, the tap-tool post-mortem, flywheel and catalogue notes |
| `scripts/board_update.py` | One-command TWEAK, including the RESET-signal gate |
| `scripts/align_board_image.py` | Measures the camera homography (diagnostic image only) |
| `scripts/reproject_holds.py` | Carries outlines through the inverse homography, keeping IDs |
| `scripts/merge_board_holds.mjs` | The only sanctioned live hold mutator (`--add` / `--update`) |
| `scripts/diff_new_holds.py` | Old-vs-new photo change detection, independent of lighting |
| `scripts/guided_reoutline.py`, `score_outline_fit.py` | Re-outline from the photo; score how well each outline fits |
| `scripts/board_reset.mjs`, `supabase/migrations/010_set_versions.sql` | RESET backend (not deployed) |
| `scripts/detect_holds_v2.py`, `refine_holds.py` | Object-first detection (FastSAM, depth) |
| `scripts/merge_holds.py` | LEGACY: `hold_N` model only, refuses to run on `custom_*` data |
| `src/App.jsx` (`holdSnapshots`) | Route-embedded geometry and missing-hold ghosts |
