// merge_board_holds.mjs — the ONLY sanctioned tool for mutating a wall's LIVE
// per-board hold array (board_settings['holds_<boardId>']).
//
// Why this exists: routes reference holds by ID. The legacy scripts/merge_holds.py
// workflow documented in CLAUDE.md operated on src/data/holds.json's `hold_N`
// base holds — but every live per-board hold today is `custom_*` (see
// migration 005_holds_per_board.sql). This script is the ID-safe replacement:
// it only ever APPENDS new holds (--add) or re-fits geometry on existing IDs
// (--update). It has no delete mode, no ID-rename mode, and no bulk-replace mode.
//
// Two mutually exclusive operations:
//
//   --add <candidates.json>     Append brand-new holds (fresh custom_<ms> IDs).
//                                Input: {"candidates": [...]} or a bare array.
//                                Each candidate is a hold-shaped object with
//                                "id": null (or no id — it's assigned here).
//     --only 1,3,5                 Only accept these 1-based indices into
//                                   `candidates`. Out-of-range index = error.
//     --max-overlap 0.5             Skip (as a likely duplicate) any candidate
//                                   whose centroid lands inside an existing
//                                   hold's polygon, or whose own polygon area
//                                   overlaps an existing hold by more than this
//                                   fraction (default 0.5 = 50%).
//
//   --update <updates.json>     Re-fit geometry of holds that physically moved,
//                                keeping their IDs and all other metadata.
//                                Input: {"updates": [{"id": "custom_...",
//                                "cx":.., "cy":.., "polygon":[...], ...}]}.
//                                Every "id" MUST already exist. Only the
//                                geometry keys present on each update entry are
//                                replaced (cx, cy, polygon, w_pct, h_pct, r,
//                                area) — name/holdTypes/positivity/material/
//                                notes/color/confidence/verified etc. are left
//                                untouched.
//
// Shared flags:
//   --board <slug>       Which wall (default: the-barn)
//   --commit             Actually write. Without it, this is a dry-run that
//                         prints the full report and touches nothing.
//
// Safety, in order, every run (dry-run or --commit):
//   1. Every pre-existing hold ID is still present afterwards (never renamed,
//      re-prefixed, or removed — there is no delete mode at all).
//   2. --add: every pre-existing hold record is deep-equal unchanged.
//      --update: unchanged except the declared geometry keys of the named IDs.
//   3. Every hold ID referenced by this board's routes still resolves — any
//      pre-existing dangling ref (there's a known one, custom_hold_9) is
//      reported separately from anything newly broken by this run.
//   4. Final count matches the expected before/after arithmetic exactly.
//
// With --commit: backs up the CURRENT live array to
// backups/holds-<slug>-<timestamp>.json BEFORE writing, then re-fetches from
// Supabase after writing and re-verifies invariants 1-4 against what actually
// landed. Any post-write verification failure prints the exact restore command
// (scripts/upload_board_setting.py against the backup just written) and exits
// non-zero.
//
// Usage:
//   node --env-file=.env.local scripts/merge_board_holds.mjs --add candidates.json
//   node --env-file=.env.local scripts/merge_board_holds.mjs --add candidates.json --only 1,3,5 --commit
//   node --env-file=.env.local scripts/merge_board_holds.mjs --update updates.json --commit
//
// Reads VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local (service
// role: bypasses RLS, same as the other local scripts).

import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

// A known, pre-existing dangling route reference (a hold that no longer
// exists but is still referenced by an old route). Not caused by this script
// — called out explicitly so it's never mistaken for damage a run introduced.
const KNOWN_PREEXISTING_DANGLING = ['custom_hold_9'];

// Geometry-only keys. --update may only ever touch these on an existing hold
// record; everything else (name, holdTypes, positivity, material, notes,
// color, confidence, verified, ...) is preserved verbatim.
const GEOMETRY_KEYS = ['cx', 'cy', 'polygon', 'w_pct', 'h_pct', 'r', 'area'];

// ─────────────────────────── pure geometry helpers ───────────────────────────
// No dependencies, per CLAUDE.md's "no new deps for hold detection" spirit —
// implemented directly since this is exactly the kind of thing that would
// otherwise pull in a full geometry library for two functions.

export function polygonArea(poly) {
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2;
}

export function pointInPolygon([px, py], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const intersects = (yi > py) !== (yj > py) &&
      px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function polygonBBox(poly) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of poly) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, maxX, minY, maxY };
}

function bboxesOverlap(polyA, polyB) {
  const a = polygonBBox(polyA), b = polygonBBox(polyB);
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

// Approximate intersection area, as a fraction of polyA's own area, via grid
// sampling over the overlapping bounding box. Hold polygons are non-convex
// blobs, so exact polygon clipping (Sutherland-Hodgman) doesn't apply and a
// full Greiner-Hormann implementation is overkill for a duplicate-detection
// heuristic — grid sampling is simple, dependency-free, and accurate enough
// at this grid density (relative error well under 1% for shapes this size).
export function overlapRatio(polyA, polyB, gridN = 80) {
  const a = polygonBBox(polyA), b = polygonBBox(polyB);
  const minX = Math.max(a.minX, b.minX), maxX = Math.min(a.maxX, b.maxX);
  const minY = Math.max(a.minY, b.minY), maxY = Math.min(a.maxY, b.maxY);
  if (maxX <= minX || maxY <= minY) return 0;
  const areaA = polygonArea(polyA);
  if (areaA === 0) return 0;
  let hits = 0;
  const stepX = (maxX - minX) / gridN, stepY = (maxY - minY) / gridN;
  for (let i = 0; i < gridN; i++) {
    const px = minX + (i + 0.5) * stepX;
    for (let j = 0; j < gridN; j++) {
      const py = minY + (j + 0.5) * stepY;
      if (pointInPolygon([px, py], polyA) && pointInPolygon([px, py], polyB)) hits++;
    }
  }
  const intersectionArea = (hits / (gridN * gridN)) * (maxX - minX) * (maxY - minY);
  return intersectionArea / areaA;
}

// ────────────────────────────── deep-equal helper ──────────────────────────────

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function deepEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}

// ───────────────────────────────── validation ─────────────────────────────────

function validatePolygonField(polygon, label) {
  const errors = [];
  if (!Array.isArray(polygon) || polygon.length < 3) {
    errors.push(`${label} must be an array of >= 3 [x,y] pairs`);
    return errors;
  }
  polygon.forEach((pt, i) => {
    if (!Array.isArray(pt) || pt.length !== 2 || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) {
      errors.push(`${label}[${i}] must be a [x,y] pair of finite numbers`);
    }
  });
  return errors;
}

export function validateCandidateShape(c) {
  if (!c || typeof c !== 'object') return ['candidate is not an object'];
  const errors = [];
  if (typeof c.cx !== 'number' || !Number.isFinite(c.cx)) errors.push('cx must be a finite number');
  if (typeof c.cy !== 'number' || !Number.isFinite(c.cy)) errors.push('cy must be a finite number');
  errors.push(...validatePolygonField(c.polygon, 'polygon'));
  return errors;
}

export function validateGeometryPatch(u) {
  if (!u || typeof u !== 'object') return ['update is not an object'];
  const errors = [];
  const has = (k) => Object.prototype.hasOwnProperty.call(u, k);
  if (has('cx') && (typeof u.cx !== 'number' || !Number.isFinite(u.cx))) errors.push('cx must be a finite number');
  if (has('cy') && (typeof u.cy !== 'number' || !Number.isFinite(u.cy))) errors.push('cy must be a finite number');
  if (has('w_pct') && (typeof u.w_pct !== 'number' || !Number.isFinite(u.w_pct))) errors.push('w_pct must be a finite number');
  if (has('h_pct') && (typeof u.h_pct !== 'number' || !Number.isFinite(u.h_pct))) errors.push('h_pct must be a finite number');
  if (has('r') && (typeof u.r !== 'number' || !Number.isFinite(u.r))) errors.push('r must be a finite number');
  if (has('area') && (typeof u.area !== 'number' || !Number.isFinite(u.area))) errors.push('area must be a finite number');
  if (has('polygon')) errors.push(...validatePolygonField(u.polygon, 'polygon'));
  return errors;
}

// ─────────────────────────────── duplicate guard ───────────────────────────────

export function checkDuplicate(candidate, existingHolds, maxOverlap) {
  for (const h of existingHolds) {
    if (!Array.isArray(h.polygon) || h.polygon.length < 3) continue;
    if (pointInPolygon([candidate.cx, candidate.cy], h.polygon)) {
      return { duplicate: true, reason: `centroid (${candidate.cx}, ${candidate.cy}) falls inside existing hold ${h.id}` };
    }
  }
  for (const h of existingHolds) {
    if (!Array.isArray(h.polygon) || h.polygon.length < 3) continue;
    if (!bboxesOverlap(candidate.polygon, h.polygon)) continue;
    const ratio = overlapRatio(candidate.polygon, h.polygon);
    if (ratio > maxOverlap) {
      return {
        duplicate: true,
        reason: `polygon overlaps existing hold ${h.id} by ${(ratio * 100).toFixed(1)}% (> ${(maxOverlap * 100).toFixed(0)}% max)`,
      };
    }
  }
  return { duplicate: false };
}

// ─────────────────────────────── invariant guards ───────────────────────────────
// These throw (rather than exiting the process) so they can be exercised
// directly in a test script without pulling in the network/CLI plumbing below.

export function assertAllIdsPreserved(beforeIds, afterIds) {
  const afterSet = new Set(afterIds);
  const missing = beforeIds.filter((id) => !afterSet.has(id));
  if (missing.length) {
    throw new Error(`INVARIANT 1 VIOLATION: ${missing.length} pre-existing hold ID(s) missing after merge: ${missing.join(', ')}`);
  }
}

export function assertIdSetIdentical(beforeIds, afterIds) {
  const b = new Set(beforeIds), a = new Set(afterIds);
  const missing = [...b].filter((id) => !a.has(id));
  const added = [...a].filter((id) => !b.has(id));
  if (missing.length || added.length) {
    throw new Error(
      `INVARIANT VIOLATION: ID set changed (--update must not add or remove IDs). ` +
      `missing=[${missing.join(', ')}] added=[${added.join(', ')}]`
    );
  }
}

// beforeHolds: array of original hold objects.
// afterById: Map id -> new hold object.
// allowedGeometryChanges: Map id -> Set(keys) that MAY legitimately differ for
//   that id (used by --update). Omit / pass an empty map for --add, where NO
//   pre-existing record may change at all.
export function assertExistingRecordsUnchanged(beforeHolds, afterById, { allowedGeometryChanges = new Map() } = {}) {
  const problems = [];
  for (const before of beforeHolds) {
    const after = afterById.get(before.id);
    if (!after) continue; // reported by assertAllIdsPreserved instead
    const allowedKeys = allowedGeometryChanges.get(before.id) || new Set();
    const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of allKeys) {
      if (allowedKeys.has(key)) continue;
      if (!deepEqual(before[key], after[key])) {
        problems.push(`${before.id}.${key} changed unexpectedly: ${JSON.stringify(before[key])} -> ${JSON.stringify(after[key])}`);
      }
    }
  }
  if (problems.length) {
    throw new Error(`INVARIANT 2 VIOLATION: existing hold record(s) mutated outside allowed geometry keys:\n  ${problems.join('\n  ')}`);
  }
}

// Reports route hold-reference resolution against a new ID set, separating
// anything ALREADY dangling (knownPreexistingDangling) from anything this run
// newly broke. Since this script never removes an ID, newlyDangling should
// always be empty by construction — this check exists to catch bugs, not
// because it's expected to ever fire.
export function checkRouteReferences(afterIds, routes, knownPreexistingDangling = []) {
  const idSet = new Set(afterIds);
  const known = new Set(knownPreexistingDangling);
  const dangling = new Set();
  let totalRefs = 0;
  for (const r of routes) {
    const refs = Object.keys(r.data?.holds || {});
    for (const hid of refs) {
      totalRefs++;
      if (!idSet.has(hid)) dangling.add(hid);
    }
  }
  const newlyDangling = [...dangling].filter((id) => !known.has(id));
  const preexistingDangling = [...dangling].filter((id) => known.has(id));
  return { totalRefs, dangling: [...dangling], newlyDangling, preexistingDangling };
}

// ────────────────────────────────── CLI plumbing ──────────────────────────────────

const die = (msg) => { console.error(`\n✗ ABORT: ${msg}`); process.exit(1); };
const ok = (msg) => console.log(`  ✓ ${msg}`);

function readJson(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    die(`could not read ${path}: ${e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    die(`${path} is not valid JSON: ${e.message}`);
  }
}

function parseOnly(s) {
  return s.split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    const n = Number(x);
    if (!Number.isInteger(n)) die(`--only: '${x}' is not an integer`);
    return n;
  });
}

function parseArgs(argv) {
  const args = { commit: false, maxOverlap: 0.5, board: 'the-barn' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--add':
        if (args.mode) throw new Error('--add and --update are mutually exclusive — pass only one');
        args.mode = 'add'; args.file = argv[++i]; break;
      case '--update':
        if (args.mode) throw new Error('--add and --update are mutually exclusive — pass only one');
        args.mode = 'update'; args.file = argv[++i]; break;
      case '--only': args.only = argv[++i]; break;
      case '--board': args.board = argv[++i]; break;
      case '--max-overlap': args.maxOverlap = Number(argv[++i]); break;
      case '--commit': args.commit = true; break;
      case '--help': case '-h': args.help = true; break;
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (!Number.isFinite(args.maxOverlap) || args.maxOverlap < 0) {
    throw new Error(`--max-overlap must be a non-negative number`);
  }
  return args;
}

function printUsage() {
  console.log(`
Usage:
  node --env-file=.env.local scripts/merge_board_holds.mjs --add <candidates.json> [--only 1,3,5] [--max-overlap 0.5] [--board the-barn] [--commit]
  node --env-file=.env.local scripts/merge_board_holds.mjs --update <updates.json> [--board the-barn] [--commit]

--add and --update are mutually exclusive. Dry-run (report only, no writes) unless --commit is passed.
`);
}

// ────────────────────────────────── add / update ──────────────────────────────────

async function runAdd(args, existingHolds) {
  const raw = readJson(args.file);
  const candidates = Array.isArray(raw) ? raw : raw.candidates;
  if (!Array.isArray(candidates)) die(`${args.file}: expected an array or {"candidates": [...]}`);
  console.log(`Candidates in file: ${candidates.length}`);

  // 1. Structural validation of every candidate in the file.
  const validationErrors = [];
  candidates.forEach((c, i) => {
    const errs = validateCandidateShape(c);
    if (errs.length) validationErrors.push(`  candidate #${i + 1}: ${errs.join('; ')}`);
  });
  if (validationErrors.length) {
    die(`${validationErrors.length} invalid candidate(s) — fix the input file and re-run:\n${validationErrors.join('\n')}`);
  }
  ok(`all ${candidates.length} candidate(s) pass shape validation (numeric cx/cy, polygon with >= 3 points)`);

  // 2. --only filter (1-based indices into the ORIGINAL candidates array).
  let selected = candidates.map((c, i) => ({ c, idx: i + 1 }));
  if (args.only) {
    const wanted = parseOnly(args.only);
    const outOfRange = wanted.filter((n) => n < 1 || n > candidates.length);
    if (outOfRange.length) die(`--only index out of range (valid: 1-${candidates.length}): ${outOfRange.join(', ')}`);
    const wantedSet = new Set(wanted);
    selected = selected.filter((s) => wantedSet.has(s.idx));
    console.log(`--only ${args.only} → considering ${selected.length} of ${candidates.length} candidate(s)`);
  }

  // 3. Duplicate guard against EXISTING holds only (not against sibling
  //    candidates in the same batch — see report caveat at the end of main()).
  const accepted = [];
  const skipped = [];
  for (const { c, idx } of selected) {
    const verdict = checkDuplicate(c, existingHolds, args.maxOverlap);
    if (verdict.duplicate) skipped.push({ idx, c, reason: verdict.reason });
    else accepted.push({ idx, c });
  }

  // 4. Assign IDs: custom_<epochMillis>, +1ms per accepted candidate so a
  //    batch can never self-collide.
  const existingIds = new Set(existingHolds.map((h) => h.id));
  const base = Date.now();
  const newRecords = accepted.map(({ c }, i) => {
    const id = `custom_${base + i}`;
    if (existingIds.has(id)) die(`generated ID collision: ${id} already exists in the live array`);
    return { name: '', holdTypes: [], positivity: 0, material: '', ...c, id };
  });
  const newIds = newRecords.map((r) => r.id);
  if (new Set(newIds).size !== newIds.length) die('generated IDs collided with each other (unexpected)');

  const afterHolds = [...existingHolds, ...newRecords];

  console.log(`\n── Duplicate guard (max-overlap=${args.maxOverlap}) ──`);
  console.log(`  accepted: ${accepted.length}   skipped-as-duplicate: ${skipped.length}`);
  for (const s of skipped) {
    console.log(`    candidate #${s.idx} at (${s.c.cx}, ${s.c.cy}) — SKIPPED: ${s.reason}`);
  }
  if (newRecords.length) {
    console.log(`\n── New holds to add ──`);
    for (const r of newRecords) {
      console.log(`  ${r.id}  at (${r.cx}, ${r.cy})  color=${r.color ?? '?'}`);
    }
  }

  return { afterHolds, accepted: newRecords.length, skipped: skipped.length, allowedGeometryChanges: new Map(), mode: 'add' };
}

async function runUpdate(args, existingHolds, holdsKey) {
  const raw = readJson(args.file);
  const updates = Array.isArray(raw) ? raw : raw.updates;
  if (!Array.isArray(updates)) die(`${args.file}: expected {"updates": [...]} (or a bare array)`);
  console.log(`Updates in file: ${updates.length}`);

  const byId = new Map(existingHolds.map((h) => [h.id, h]));

  // Every id MUST already exist.
  const missing = updates.filter((u) => !u || typeof u.id !== 'string' || !byId.has(u.id));
  if (missing.length) {
    die(
      `${missing.length} update(s) reference an id that does not exist in ${holdsKey}:\n` +
      missing.map((u) => `  ${JSON.stringify(u?.id)}`).join('\n')
    );
  }
  ok(`all ${updates.length} update ID(s) exist in the current array`);

  // Structural validation of whatever geometry keys are present.
  const shapeErrors = [];
  updates.forEach((u, i) => {
    const errs = validateGeometryPatch(u);
    if (errs.length) shapeErrors.push(`  update #${i + 1} (${u.id}): ${errs.join('; ')}`);
  });
  if (shapeErrors.length) die(`${shapeErrors.length} invalid update(s):\n${shapeErrors.join('\n')}`);
  ok('all geometry patches pass shape validation');

  const updatesById = new Map(updates.map((u) => [u.id, u]));
  const allowedGeometryChanges = new Map();
  console.log(`\n── Applying geometry patches ──`);
  const afterHolds = existingHolds.map((h) => {
    const u = updatesById.get(h.id);
    if (!u) return h;
    const patch = {};
    const appliedKeys = new Set();
    for (const key of GEOMETRY_KEYS) {
      if (Object.prototype.hasOwnProperty.call(u, key)) {
        patch[key] = u[key];
        appliedKeys.add(key);
      }
    }
    const ignoredKeys = Object.keys(u).filter((k) => k !== 'id' && !appliedKeys.has(k));
    if (ignoredKeys.length) {
      console.log(`  ⚠ ${h.id}: ignoring non-geometry key(s) [${ignoredKeys.join(', ')}] — edit metadata via Hold Manager instead`);
    }
    allowedGeometryChanges.set(h.id, appliedKeys);
    console.log(`  ${h.id}: updating [${[...appliedKeys].join(', ')}]  (name="${h.name || ''}" holdTypes=${JSON.stringify(h.holdTypes || [])} preserved)`);
    return { ...h, ...patch };
  });

  return { afterHolds, accepted: updates.length, skipped: 0, allowedGeometryChanges, mode: 'update' };
}

// ────────────────────────────────────── main ──────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    printUsage();
    process.exit(argv.length === 0 ? 1 : 0);
  }

  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    printUsage();
    process.exit(1);
  }
  if (!args.mode) {
    console.error('✗ Must specify exactly one of --add <file> or --update <file>');
    printUsage();
    process.exit(1);
  }

  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (run with --env-file=.env.local)');
    process.exit(1);
  }
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  console.log(`\n=== merge_board_holds --${args.mode}  (${args.commit ? 'COMMIT — will write' : 'DRY-RUN — no writes'}) ===\n`);

  const { data: board, error: boardErr } = await supabase
    .from('boards').select('id, name, slug').eq('slug', args.board).maybeSingle();
  if (boardErr) return die(`boards lookup failed: ${boardErr.message}`);
  if (!board) return die(`no board with slug '${args.board}'`);
  console.log(`Board: ${board.name} (${board.slug})  id=${board.id}`);

  const holdsKey = `holds_${board.id}`;
  const { data: settingsRow, error: settingsErr } = await supabase
    .from('board_settings').select('data').eq('key', holdsKey).maybeSingle();
  if (settingsErr) return die(`board_settings lookup failed: ${settingsErr.message}`);
  if (!settingsRow || !Array.isArray(settingsRow.data)) return die(`board_settings['${holdsKey}'] missing or not an array`);
  const existingHolds = settingsRow.data;
  console.log(`Existing holds: ${existingHolds.length}`);

  const { data: routes, error: routesErr } = await supabase
    .from('routes').select('id, data').eq('board_id', board.id);
  if (routesErr) return die(`routes lookup failed: ${routesErr.message}`);
  console.log(`Routes on this board: ${routes.length}`);

  const result = args.mode === 'add'
    ? await runAdd(args, existingHolds)
    : await runUpdate(args, existingHolds, holdsKey);

  const beforeIds = existingHolds.map((h) => h.id);
  const afterIds = result.afterHolds.map((h) => h.id);

  console.log(`\n── Invariant checks ──`);
  try {
    assertAllIdsPreserved(beforeIds, afterIds);
    ok('invariant 1: every pre-existing ID is present after the merge');

    const afterById = new Map(result.afterHolds.map((h) => [h.id, h]));
    assertExistingRecordsUnchanged(existingHolds, afterById, { allowedGeometryChanges: result.allowedGeometryChanges });
    ok(result.mode === 'add'
      ? 'invariant 2: every pre-existing hold record is deeply unchanged'
      : 'invariant 2: pre-existing records unchanged except the declared geometry keys');

    if (result.mode === 'update') {
      assertIdSetIdentical(beforeIds, afterIds);
      ok('ID set identical before/after (update mode adds/removes nothing)');
    }

    const expectedCount = result.mode === 'add' ? beforeIds.length + result.accepted : beforeIds.length;
    if (result.afterHolds.length !== expectedCount) {
      throw new Error(`INVARIANT 4 VIOLATION: expected ${expectedCount} holds after merge, got ${result.afterHolds.length}`);
    }
    ok(`invariant 4: final count ${result.afterHolds.length} matches expectation`);
  } catch (e) {
    return die(e.message);
  }

  const routeCheck = checkRouteReferences(afterIds, routes, KNOWN_PREEXISTING_DANGLING);
  console.log(`\n── Route reference check (invariant 3) ──`);
  console.log(`  routes checked: ${routes.length}  |  hold refs: ${routeCheck.totalRefs}`);
  if (routeCheck.preexistingDangling.length) {
    console.log(`  ⚠ pre-existing dangling ref(s), NOT caused by this run (known before): ${routeCheck.preexistingDangling.join(', ')}`);
  }
  if (routeCheck.newlyDangling.length) {
    return die(`invariant 3 VIOLATED: this run introduced ${routeCheck.newlyDangling.length} newly-dangling hold ID(s): ${routeCheck.newlyDangling.join(', ')}`);
  }
  ok('invariant 3: no route reference was broken by this run');

  console.log(`\n── Summary ──`);
  console.log(`  before:   ${existingHolds.length}`);
  if (result.mode === 'add') {
    console.log(`  accepted: ${result.accepted}`);
    console.log(`  skipped:  ${result.skipped} (duplicate)`);
  } else {
    console.log(`  updated:  ${result.accepted}`);
  }
  console.log(`  after:    ${result.afterHolds.length}`);
  console.log(`  routes checked: ${routes.length}   dangling: ${routeCheck.dangling.length ? routeCheck.dangling.join(', ') : 'none'}`);

  if (!args.commit) {
    console.log('\nDRY-RUN complete — nothing written. Re-run with --commit to apply.');
    process.exit(0);
  }

  // ── Commit ──────────────────────────────────────────────────────────────────
  console.log('\n── Committing ──');
  mkdirSync(join(repoRoot, 'backups'), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupRelPath = `backups/holds-${board.slug}-${stamp}.json`;
  writeFileSync(join(repoRoot, backupRelPath), JSON.stringify(existingHolds, null, 2));
  ok(`backup written: ${backupRelPath}  (${existingHolds.length} holds — the pre-write state)`);
  const restoreCmd = `python3 scripts/upload_board_setting.py --key ${holdsKey} --file ${backupRelPath}`;

  const nowIso = new Date().toISOString();
  const { error: writeErr } = await supabase.from('board_settings')
    .upsert({ key: holdsKey, data: result.afterHolds, updated_at: nowIso }, { onConflict: 'key' });
  if (writeErr) {
    console.error(`\n✗ write failed: ${writeErr.message}`);
    console.error(`  (the live data was not changed — no restore needed, but the backup is at ${backupRelPath} if you want to double check)`);
    process.exit(1);
  }
  ok('write sent');

  // Re-fetch and re-verify against what actually landed.
  const { data: verifyRow, error: verifyErr } = await supabase
    .from('board_settings').select('data').eq('key', holdsKey).maybeSingle();
  if (verifyErr || !Array.isArray(verifyRow?.data)) {
    console.error(`\n✗ POST-WRITE VERIFICATION FAILED: could not re-read ${holdsKey}: ${verifyErr?.message || 'no data returned'}`);
    console.error(`  RESTORE: ${restoreCmd}`);
    process.exit(1);
  }
  const landed = verifyRow.data;
  const landedIds = landed.map((h) => h.id);
  try {
    assertAllIdsPreserved(beforeIds, landedIds);
    const landedById = new Map(landed.map((h) => [h.id, h]));
    assertExistingRecordsUnchanged(existingHolds, landedById, { allowedGeometryChanges: result.allowedGeometryChanges });
    if (result.mode === 'update') assertIdSetIdentical(beforeIds, landedIds);
    const expectedCount = result.mode === 'add' ? beforeIds.length + result.accepted : beforeIds.length;
    if (landed.length !== expectedCount) throw new Error(`post-write count ${landed.length} != expected ${expectedCount}`);
    if (!deepEqual(landed, result.afterHolds)) throw new Error('post-write data does not deep-equal what was sent');
  } catch (e) {
    console.error(`\n✗ POST-WRITE VERIFICATION FAILED: ${e.message}`);
    console.error(`  RESTORE: ${restoreCmd}`);
    process.exit(1);
  }

  const { data: routesAfter, error: routesAfterErr } = await supabase
    .from('routes').select('id, data').eq('board_id', board.id);
  if (routesAfterErr) {
    console.error(`\n✗ POST-WRITE route re-check failed to fetch routes: ${routesAfterErr.message}`);
    console.error(`  RESTORE: ${restoreCmd}`);
    process.exit(1);
  }
  const routeCheckAfter = checkRouteReferences(landedIds, routesAfter, KNOWN_PREEXISTING_DANGLING);
  if (routeCheckAfter.newlyDangling.length) {
    console.error(`\n✗ POST-WRITE VERIFICATION FAILED: newly-dangling route ref(s): ${routeCheckAfter.newlyDangling.join(', ')}`);
    console.error(`  RESTORE: ${restoreCmd}`);
    process.exit(1);
  }

  console.log(`\n✓ Committed and verified. holds_${board.id}: ${existingHolds.length} → ${landed.length}`);
  console.log(`  Backup: ${backupRelPath}`);
  process.exit(0);
}

// Compare plain filesystem paths (not raw URL strings) — the repo path
// contains spaces, and a hand-built `file://${path}` string doesn't
// URL-encode them the way import.meta.url does, so that comparison would
// silently never match and main() would never run.
const isMain = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
