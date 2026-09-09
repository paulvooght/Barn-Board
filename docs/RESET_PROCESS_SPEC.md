# RESET Process — Spec (NOT BUILT)

*Written 2026-09-09. Status: **designed, not implemented**. Nothing in this document exists in code yet.*

> **If you are about to strip The Barn and set it fresh, STOP and read this first.**
> The tooling today assumes every image update is a TWEAK. Doing a RESET without
> the work described here leaves 38 routes pointing at holds that are no longer on
> the wall, and there is no safe way to clean that up afterwards.

---

## 1. The two semantics

Every board-image update is one of two fundamentally different events. Getting them
backwards is catastrophic in both directions.

| | **TWEAK** (set update) | **RESET** (new set) |
|---|---|---|
| What happened physically | A few holds added / moved / removed. The set is recognisably the same. | The wall was stripped and re-set. Most holds are different. |
| What must happen to routes | **Survive.** Every route still climbs. | **Retire.** The routes describe holds that no longer exist. |
| Hold IDs | Preserved absolutely. Geometry may move. | Old IDs retired with their set; new holds get new IDs. |
| Status | ✅ **Built** — see CLAUDE.md "Safe Workflow: Board Image Update" | ❌ **Not built — this document** |

The TWEAK path is `align_board_image.py` (measure) → `reproject_holds.py` (move
outlines) → `merge_board_holds.mjs --update/--add` (apply, invariant-checked) →
`publish_board_image.py` (publish the raw photo).

---

## 2. What breaks today if you RESET anyway

`merge_board_holds.mjs` has **no delete mode, deliberately**. So a RESET attempted
with today's tools goes wrong one of two ways:

**(a) You leave the old hold records in place.** The new photo shows a different
wall, but 204 hold records still sit at their old coordinates. Every outline is
meaningless. All 38 routes still appear in the list, all still "climbable", all
nonsense. The missing-hold ghost system doesn't help — the holds aren't missing
from the *data*, they're missing from the *wall*.

**(b) Someone deletes the old holds to clean up.** Routes reference holds by ID.
Every route that used a deleted hold breaks silently — the hold vanishes from the
problem with no error, no warning, and no way to tell which routes were affected
after the fact. This is the exact failure CLAUDE.md's cardinal rule exists to
prevent.

Neither is recoverable without a backup restore. **There is no correct RESET today.**

---

## 3. Design

### 3.1 Core idea: set versions, and archive instead of delete

A wall gains a **set version**. Routes are stamped with the version they were built
on. A RESET increments the version, freezes the outgoing hold array, and *archives*
the prior version's routes — it never deletes anything.

Archived routes stay browsable as "past sets": history, personal records and photos
of problems you actually climbed. They just don't clutter the list of things you
can climb today.

### 3.2 Data model

```
boards.specs.setVersion          int, default 1        — the wall's current set
routes.data.setVersion           int                   — the set a route was built on
                                                         (backfill all existing routes to 1)
board_settings['holds_<boardId>_v<n>']                 — FROZEN snapshot of the hold
                                                         array as it was when set n retired
board_settings['holds_<boardId>']                      — unchanged: the CURRENT set
```

Freezing the outgoing hold array is what makes archived routes still *render*. An
archived route looks up its holds in its own set's snapshot, not in the live array.
Without this, "archive" degrades into "broken".

A `board_sets` table would be cleaner than `specs` + settings keys, but this shape
matches how the codebase already stores per-board state and needs no new RLS work.

### 3.3 The choice is always explicit

**Never auto-decide.** The system may *suggest*, but a human confirms.

At image upload, after the new photo is aligned, compute the overlap between newly
detected holds and the existing set (share of existing holds with a detection within
~2 board % of them). Then:

- **high overlap** → suggest TWEAK ("looks like the same set — 187 of 204 holds are still where they were")
- **low overlap** → suggest RESET ("looks like a new set — only 23 of 204 holds match")
- **in between** → suggest nothing, state the number, make the admin choose

Always show the raw number, never just the verdict. The admin knows what they did to
the wall; the number is there to catch mistakes, not to make the decision.

### 3.4 The RESET confirm must state the cost

The destructive path is gated behind a confirm that names the consequence:

> **Reset The Barn to a new set?**
> This archives **38 routes** built on set 1. They stay browsable under "Past sets"
> along with your sends, but they'll leave your main route list.
> The current 204 hold outlines are frozen so those routes still display correctly.
> **This cannot be undone from the app.**

Require typing the wall name, or an equivalent deliberate action. One tap must not
be able to retire a year of route-setting.

### 3.5 What a RESET does, in order

1. Back up (`scripts/backup_tables.mjs`) — non-negotiable, scripted, not a reminder.
2. Freeze: copy `holds_<boardId>` → `holds_<boardId>_v<current>`.
3. Stamp: any route with no `setVersion` gets the current version (idempotent backfill).
4. Increment `boards.specs.setVersion`.
5. Replace `holds_<boardId>` with the newly detected set (fresh `custom_<ts>` IDs).
6. Publish the new photo.

Steps 2–5 must be atomic in effect: if 5 fails after 4, the wall is left claiming a
set version whose holds were never written. Write a single verifier that re-fetches
and checks all five post-conditions, and refuse to report success without it —
mirroring how `merge_board_holds.mjs` re-verifies after every write.

### 3.6 UI

- **Settings → Update board image** — the TWEAK/RESET choice screen after upload.
- **Routes list** — a "Past sets" section, collapsed by default.
- **Route card** — a muted "Set 1" pill on archived routes.
- **Filters** — archived routes excluded from the default view, and from "unfinished business".

---

## 4. Rules that must not be broken

1. **Never auto-decide** TWEAK vs RESET.
2. **Never delete a hold record** that any route — current *or* archived — references.
3. **Archiving is reversible**; deletion is not. Prefer archiving in every ambiguous case.
4. A RESET **backs up first**, in code, not by asking the operator to remember.
5. Archived routes must still **render correctly** from their frozen hold snapshot.

---

## 5. Open questions

- **Per-user data on archived routes** — sends, ratings and grade suggestions should
  stay (they're real history). Confirm they don't distort current-set stats.
- **Sessions** reference routes by ID; session history must still resolve archived
  routes, or old sessions will render blank.
- **Climber card / heat map** — do archived sets count toward strengths and grade
  pyramids? Probably yes for all-time, no for current-period. Needs a decision.
- **Shared playlists** may contain archived routes. Show them greyed rather than
  silently dropping them.
- **Partial resets** — half the wall re-set. Currently forced into TWEAK, which is
  the safe default. Possibly fine forever; revisit only if it happens in practice.

---

## 6. Why this isn't built yet

It has never been needed: The Barn has only ever been tweaked, and Yonder was stood
up empty (zero routes), so a "reset" there was just a seed. The cost of building it
lands entirely on the first real re-set.

**Build it before that day, not on it.** The failure mode is silent, and the only
recovery is a backup restore.

---

*Related: CLAUDE.md → "THE BOARD PHOTO IS THE TRUTH" and "Safe Workflow: Board Image
Update"; `docs/HOLD_DETECTION_HANDOVER.md`; CURRENT_STATE.md 2026-09-09 entry.*
