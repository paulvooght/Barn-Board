// board_reset.mjs — the ONLY sanctioned way to RESET a wall (strip it and set
// it fresh). See docs/RESET_PROCESS_SPEC.md for the full design; this is its
// executable twin. Do NOT hand-roll a reset with merge_board_holds.mjs or
// upload_board_setting.py — it has no delete mode for a reason (see
// merge_board_holds.mjs's header) and a hand-rolled reset is exactly the
// "silently break every route" failure mode the spec exists to prevent.
//
// A RESET is fundamentally different from a TWEAK (align_board_image.py →
// reproject_holds.py → merge_board_holds.mjs --update/--add): a TWEAK keeps
// every hold ID, a RESET retires the whole set. Routes built on the outgoing
// set are never deleted — they're ARCHIVED (stamped with the set version they
// were built on) and keep rendering from a FROZEN snapshot of the outgoing
// hold array. Only the live `holds_<boardId>` key is replaced.
//
// Requires supabase/migrations/010_set_versions.sql to already be applied
// (routes.set_version column + the board_settings RLS coverage for
// `holds_<boardId>_v<n>` keys). --commit refuses to run without it; a dry-run
// still works and reports as if every route were on set 1 (matching what the
// migration's backfill will do), so you can preview a reset before the
// migration has landed.
//
// Order of operations (spec §3.5), each gated behind the ones before it:
//   1. Back up ALL tables (scripts/backup_tables.mjs). Abort everything if it fails.
//   2. Freeze: copy holds_<boardId> -> holds_<boardId>_v<currentVersion>.
//      Re-fetch and verify byte-identical before continuing — this is what
//      makes it safe to touch the live array in step 5.
//   3. Stamp: any route on this board with set_version IS NULL -> currentVersion
//      (idempotent — a no-op once 010 has backfilled everyone to 1).
//   4. Increment boards.specs.setVersion (merged into specs — boardRegion and
//      anything else already there survives).
//   5. Replace holds_<boardId> with the new set (fresh custom_<epochMillis>
//      IDs, incrementing per hold so a batch can't self-collide).
//   6. Re-fetch everything and verify all five post-conditions. Refuse to
//      report success unless they all hold — mirrors how merge_board_holds.mjs
//      re-verifies after every write.
//
// Hard rules: never DELETE a route. Never delete a hold any route (current or
// archived) references — the freeze (step 2) is what makes replacing the live
// array (step 5) safe, so step 5 never runs unless step 2's verification passed.
//
// The confirm block (cost: routes archived, old/new set version, hold counts)
// prints in BOTH dry-run and --commit mode. --commit additionally REQUIRES an
// explicit --yes-archive-<N>-routes flag matching the actual archive count —
// so a stale command line (routes changed since you last looked) can never
// fire against the wrong number. Get N from the dry-run's own printed
// suggestion, don't compute it by hand.
//
// Usage:
//   node --env-file=.env.local scripts/board_reset.mjs --board the-barn --new-holds new_holds.json
//   node --env-file=.env.local scripts/board_reset.mjs --board the-barn --new-holds new_holds.json --commit --yes-archive-38-routes
//
// --new-holds file: a hold-shaped candidate array (same shape as
// merge_board_holds.mjs --add), i.e. {"candidates":[...]} or a bare array of
// { cx, cy, polygon, w_pct, h_pct, r, color, confidence, holdTypes, ... }.
// Any "id" present is ignored — fresh IDs are always assigned here.
//
// Reads VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local
// (service role: bypasses RLS, same as the other local scripts).

import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { validateCandidateShape, deepEqual, checkRouteReferences } from './merge_board_holds.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

const die = (msg) => { console.error(`\n✗ ABORT: ${msg}`); process.exit(1); };
const ok = (msg) => console.log(`  ✓ ${msg}`);
const warn = (msg) => console.log(`  ⚠ ${msg}`);

// ─────────────────────────────── CLI plumbing ───────────────────────────────

function printUsage() {
  console.log(`
Usage:
  node --env-file=.env.local scripts/board_reset.mjs --board <slug> --new-holds <file.json>                                     # dry-run
  node --env-file=.env.local scripts/board_reset.mjs --board <slug> --new-holds <file.json> --commit --yes-archive-<N>-routes    # apply

Dry-run (default) reports the full plan and touches nothing. --commit requires
--yes-archive-<N>-routes matching the archive count shown in the confirm block
(get N from a dry-run first — don't guess it).
`);
}

function parseArgs(argv) {
  const args = { commit: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--board') args.board = argv[++i];
    else if (a === '--new-holds') args.newHoldsFile = argv[++i];
    else if (a === '--commit') args.commit = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (/^--yes-archive-\d+-routes$/.test(a)) { /* consumed by assertArchiveGuardMatches via raw argv */ }
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

// Exported (and kept pure — no network, no process.exit) so the guard can be
// exercised directly, the same way merge_board_holds.mjs's invariant asserts
// are: proving the reject-a-wrong-N behaviour doesn't require ever passing
// --commit for real.
export function parseYesArchiveFlag(argv) {
  for (const a of argv) {
    const m = a.match(/^--yes-archive-(\d+)-routes$/);
    if (m) return Number(m[1]);
  }
  return null;
}

export function assertArchiveGuardMatches(argv, actualCount) {
  const n = parseYesArchiveFlag(argv);
  if (n === null) {
    throw new Error(
      `--commit requires --yes-archive-${actualCount}-routes to confirm you saw the correct route count ` +
      `(this run would archive ${actualCount} route(s)).`
    );
  }
  if (n !== actualCount) {
    throw new Error(
      `--yes-archive-${n}-routes does not match the actual archive count of ${actualCount}. Refusing — ` +
      `the command line may be stale (routes may have changed since you last checked). Re-run without ` +
      `--commit to see the current count, then pass --yes-archive-${actualCount}-routes.`
    );
  }
}

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

function loadNewHolds(file) {
  const raw = readJson(file);
  const candidates = Array.isArray(raw) ? raw : raw.candidates;
  if (!Array.isArray(candidates)) die(`${file}: expected an array or {"candidates": [...]}`);
  const errors = [];
  candidates.forEach((c, i) => {
    const errs = validateCandidateShape(c);
    if (errs.length) errors.push(`  hold #${i + 1}: ${errs.join('; ')}`);
  });
  if (errors.length) die(`${errors.length} invalid hold(s) in ${file} — fix the input file and re-run:\n${errors.join('\n')}`);
  return candidates;
}

// Fresh custom_<epochMillis> IDs, +1ms per hold so a batch can never self-collide
// (same scheme as merge_board_holds.mjs --add). Any "id" on the input is dropped.
function assignFreshIds(candidates, baseMs) {
  return candidates.map((c, i) => {
    const { id: _drop, ...rest } = c;
    return { name: '', holdTypes: [], positivity: 0, material: '', ...rest, id: `custom_${baseMs + i}` };
  });
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
  if (!args.board) { console.error('✗ --board <slug> is required'); printUsage(); process.exit(1); }
  if (!args.newHoldsFile) { console.error('✗ --new-holds <file.json> is required'); printUsage(); process.exit(1); }

  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (run with --env-file=.env.local)');
    process.exit(1);
  }
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  console.log(`\n=== board_reset  (${args.commit ? 'COMMIT — will write' : 'DRY-RUN — no writes'}) ===\n`);

  // ── Load live state (read-only) ─────────────────────────────────────────────
  const { data: board, error: boardErr } = await supabase
    .from('boards').select('id, name, slug, specs').eq('slug', args.board).maybeSingle();
  if (boardErr) return die(`boards lookup failed: ${boardErr.message}`);
  if (!board) return die(`no board with slug '${args.board}'`);
  console.log(`Board: ${board.name} (${board.slug})  id=${board.id}`);

  const currentVersion = board.specs?.setVersion ?? 1;
  const newVersion = currentVersion + 1;

  const holdsKey = `holds_${board.id}`;
  const { data: holdsRow, error: holdsErr } = await supabase
    .from('board_settings').select('data').eq('key', holdsKey).maybeSingle();
  if (holdsErr) return die(`board_settings lookup failed: ${holdsErr.message}`);
  if (!holdsRow || !Array.isArray(holdsRow.data)) return die(`board_settings['${holdsKey}'] missing or not an array`);
  const existingHolds = holdsRow.data;
  console.log(`Live holds (${holdsKey}): ${existingHolds.length}`);

  // Tolerate 010 not being applied yet: fall back to "every route is
  // implicitly version 1" (== what the migration's backfill will produce)
  // so a dry-run preview works before the migration has landed. --commit
  // hard-requires the real column (see below).
  let routes, hasSetVersionColumn = true;
  {
    const { data, error } = await supabase.from('routes').select('id, data, set_version').eq('board_id', board.id);
    if (error && /set_version/i.test(error.message)) {
      hasSetVersionColumn = false;
      const fallback = await supabase.from('routes').select('id, data').eq('board_id', board.id);
      if (fallback.error) return die(`routes lookup failed: ${fallback.error.message}`);
      routes = fallback.data.map((r) => ({ ...r, set_version: null }));
    } else if (error) {
      return die(`routes lookup failed: ${error.message}`);
    } else {
      routes = data;
    }
  }
  console.log(`Routes on this board: ${routes.length}${hasSetVersionColumn ? '' : '  (set_version column not found yet — treating all as set 1)'}`);

  const archived = routes.filter((r) => r.set_version === currentVersion || r.set_version == null);
  const toStamp = routes.filter((r) => r.set_version == null);
  const archiveCount = archived.length;

  const newCandidates = loadNewHolds(args.newHoldsFile);
  console.log(`New holds file (${args.newHoldsFile}): ${newCandidates.length} candidate(s), all pass shape validation`);

  // Baseline: hold refs already dangling against the CURRENT live array,
  // before this run touches anything. Used post-write to separate "already
  // broken" from "this run broke it" — same idea as merge_board_holds.mjs's
  // KNOWN_PREEXISTING_DANGLING, computed empirically instead of hardcoded
  // since board_reset.mjs runs against any wall, not just The Barn.
  const preReplaceDangling = checkRouteReferences(existingHolds.map((h) => h.id), routes);
  if (preReplaceDangling.dangling.length) {
    warn(`${preReplaceDangling.dangling.length} hold ref(s) already dangling against the live set (pre-existing, not caused by this run): ${preReplaceDangling.dangling.join(', ')}`);
  }

  // ── Confirm block (spec §3.4) — always printed, dry-run or --commit ────────
  console.log(`
── Reset ${board.name} to a new set? ──────────────────────────────────────
This archives ${archiveCount} route${archiveCount === 1 ? '' : 's'} built on set ${currentVersion}. They stay browsable under
"Past sets" along with their sends, but they'll leave the main route list.
The current ${existingHolds.length} hold outline${existingHolds.length === 1 ? '' : 's'} will be frozen (${holdsKey}_v${currentVersion}) so those
routes still display correctly, then replaced with ${newCandidates.length} new hold${newCandidates.length === 1 ? '' : 's'}.
  set version:  ${currentVersion} -> ${newVersion}
  holds:        ${existingHolds.length} -> ${newCandidates.length}
  routes archived: ${archiveCount}${toStamp.length ? ` (of which ${toStamp.length} needed a set_version stamp)` : ''}
This cannot be undone from the app.
─────────────────────────────────────────────────────────────────────────
`);

  if (!args.commit) {
    console.log('DRY-RUN complete — nothing written. To apply, re-run with:');
    console.log(`  node --env-file=.env.local scripts/board_reset.mjs --board ${args.board} --new-holds ${args.newHoldsFile} --commit --yes-archive-${archiveCount}-routes\n`);
    process.exit(0);
  }

  // ── --commit from here on ───────────────────────────────────────────────────
  if (!hasSetVersionColumn) {
    return die('supabase/migrations/010_set_versions.sql has not been applied yet (routes.set_version column does not exist). ' +
      'Apply it in the Supabase SQL Editor first, then re-run with --commit.');
  }
  try {
    assertArchiveGuardMatches(argv, archiveCount);
  } catch (e) {
    return die(e.message);
  }
  ok(`--yes-archive-${archiveCount}-routes matches the actual count`);

  // Step 1: back up everything first. Abort if it fails — nothing below may run.
  console.log('\n── Step 1: backup_tables.mjs ──');
  const backupLabel = `pre-reset-${board.slug}`;
  const backupProc = spawnSync(process.execPath, ['--env-file=.env.local', join(repoRoot, 'scripts', 'backup_tables.mjs'), backupLabel], {
    cwd: repoRoot, stdio: 'inherit', env: process.env,
  });
  if (backupProc.status !== 0) return die('scripts/backup_tables.mjs failed — aborting before any write.');
  ok('full table backup complete');

  // Also write a small dedicated backup of just this wall's live holds, so a
  // failure below has an exact one-command restore target (same pattern as
  // merge_board_holds.mjs's --commit backup).
  mkdirSync(join(repoRoot, 'backups'), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupRelPath = `backups/holds-${board.slug}-reset-${stamp}.json`;
  writeFileSync(join(repoRoot, backupRelPath), JSON.stringify(existingHolds, null, 2));
  ok(`dedicated holds backup written: ${backupRelPath} (${existingHolds.length} holds — the pre-reset live state)`);
  const restoreCmd = `python3 scripts/upload_board_setting.py --key ${holdsKey} --file ${backupRelPath}`;
  const restoreNote = () => {
    console.error(`  RESTORE holds: ${restoreCmd}`);
    console.error(`  (the full table backup is also at backups/${backupLabel}-<timestamp>/ if routes/boards need restoring too)`);
  };

  const nowIso = () => new Date().toISOString();

  // Step 2: freeze the outgoing set, and verify byte-identical BEFORE touching
  // the live array. Nothing after this point may run unless this passes.
  console.log('\n── Step 2: freeze (copy live holds -> versioned snapshot) ──');
  const frozenKey = `${holdsKey}_v${currentVersion}`;
  {
    const { error: writeErr } = await supabase.from('board_settings')
      .upsert({ key: frozenKey, data: existingHolds, updated_at: nowIso() }, { onConflict: 'key' });
    if (writeErr) { console.error(`\n✗ freeze write failed: ${writeErr.message}`); restoreNote(); process.exit(1); }
    const { data: verify, error: verifyErr } = await supabase.from('board_settings').select('data').eq('key', frozenKey).maybeSingle();
    if (verifyErr || !Array.isArray(verify?.data)) {
      console.error(`\n✗ POST-WRITE VERIFICATION FAILED: could not re-read ${frozenKey}: ${verifyErr?.message || 'no data returned'}`);
      restoreNote(); process.exit(1);
    }
    if (!deepEqual(verify.data, existingHolds)) {
      console.error(`\n✗ POST-WRITE VERIFICATION FAILED: ${frozenKey} is not byte-identical to the pre-freeze live array.`);
      restoreNote(); process.exit(1);
    }
    ok(`${frozenKey} == pre-reset live array, byte-identical (${existingHolds.length} holds) — safe to proceed`);
  }

  // Step 3: stamp any set_version IS NULL route on this board to currentVersion.
  console.log('\n── Step 3: stamp ──');
  if (toStamp.length) {
    const { error: stampErr } = await supabase.from('routes')
      .update({ set_version: currentVersion }).in('id', toStamp.map((r) => r.id));
    if (stampErr) { console.error(`\n✗ stamp failed: ${stampErr.message}`); restoreNote(); process.exit(1); }
    ok(`stamped ${toStamp.length} route(s) with no prior set_version -> ${currentVersion}`);
  } else {
    ok('nothing to stamp (every route already carries a set_version)');
  }

  // Step 4: increment boards.specs.setVersion, merged so boardRegion (and
  // anything else already in specs) survives.
  console.log('\n── Step 4: increment set version ──');
  const newSpecs = { ...(board.specs || {}), setVersion: newVersion };
  {
    const { error: specsErr } = await supabase.from('boards').update({ specs: newSpecs, updated_at: nowIso() }).eq('id', board.id);
    if (specsErr) { console.error(`\n✗ specs update failed: ${specsErr.message}`); restoreNote(); process.exit(1); }
    ok(`boards.specs.setVersion: ${currentVersion} -> ${newVersion} (other specs keys preserved)`);
  }

  // Step 5: replace the live holds with the new set. Only reachable because
  // step 2's freeze was verified byte-identical above.
  console.log('\n── Step 5: replace live holds ──');
  const idBase = Date.now();
  const newRecords = assignFreshIds(newCandidates, idBase);
  {
    const { error: replaceErr } = await supabase.from('board_settings')
      .upsert({ key: holdsKey, data: newRecords, updated_at: nowIso() }, { onConflict: 'key' });
    if (replaceErr) {
      console.error(`\n✗ replace failed: ${replaceErr.message}`);
      console.error(`  boards.specs.setVersion is now ${newVersion} but ${holdsKey} was NOT replaced — the wall is in a partial state.`);
      restoreNote();
      console.error(`  To finish: retry this exact command (freeze + stamp + specs are already done and idempotent); ` +
        `to fully undo instead, restore holds from the backup above AND set boards.specs.setVersion back to ${currentVersion}.`);
      process.exit(1);
    }
    ok(`${holdsKey}: ${existingHolds.length} -> ${newRecords.length} holds (fresh IDs custom_${idBase}..custom_${idBase + newRecords.length - 1})`);
  }

  // Step 6: re-fetch EVERYTHING fresh and verify all five post-conditions.
  console.log('\n── Step 6: post-write verification (5 post-conditions) ──');
  const fail6 = (msg) => { console.error(`\n✗ POST-WRITE VERIFICATION FAILED: ${msg}`); restoreNote(); process.exit(1); };

  // 1. Frozen snapshot landed and is still byte-identical.
  {
    const { data, error } = await supabase.from('board_settings').select('data').eq('key', frozenKey).maybeSingle();
    if (error || !Array.isArray(data?.data)) return fail6(`could not re-read ${frozenKey}`);
    if (!deepEqual(data.data, existingHolds)) return fail6(`${frozenKey} no longer matches the pre-reset live array`);
    ok(`1. ${frozenKey} landed, byte-identical (${data.data.length} holds)`);
  }

  // 2. Archived routes' hold refs still resolve against the frozen array (no
  //    NEW dangling refs — the freeze is a verbatim copy, so this should be
  //    trivially true; checked anyway, per the spec's insistence on this
  //    exact invariant).
  {
    const { data: routesAfter, error } = await supabase.from('routes').select('id, data, set_version').eq('board_id', board.id);
    if (error) return fail6(`could not re-fetch routes: ${error.message}`);
    const archivedAfter = routesAfter.filter((r) => r.set_version === currentVersion);
    const frozenIds = existingHolds.map((h) => h.id);
    const refCheck = checkRouteReferences(frozenIds, archivedAfter, preReplaceDangling.dangling);
    if (refCheck.newlyDangling.length) return fail6(`this run newly broke ${refCheck.newlyDangling.length} hold ref(s) on archived routes: ${refCheck.newlyDangling.join(', ')}`);
    ok(`2. all ${archivedAfter.length} archived route(s)' hold refs resolve against ${frozenKey} (${refCheck.totalRefs} refs checked)`);
  }

  // 3. Every route this run knew about now carries a set_version (no NULLs left).
  {
    const { data: routesAfter, error } = await supabase.from('routes').select('id, set_version').eq('board_id', board.id).in('id', routes.map((r) => r.id));
    if (error) return fail6(`could not re-fetch routes for stamp check: ${error.message}`);
    const stillNull = routesAfter.filter((r) => r.set_version == null);
    if (stillNull.length) return fail6(`${stillNull.length} route(s) still have set_version IS NULL: ${stillNull.map((r) => r.id).join(', ')}`);
    const wrongVersion = routesAfter.filter((r) => r.set_version !== currentVersion);
    if (wrongVersion.length) return fail6(`${wrongVersion.length} route(s) have set_version != ${currentVersion}: ${wrongVersion.map((r) => `${r.id}=${r.set_version}`).join(', ')}`);
    ok(`3. all ${routesAfter.length} pre-reset route(s) stamped set_version=${currentVersion}`);
  }

  // 4. boards.specs.setVersion advanced, everything else in specs preserved.
  {
    const { data: boardAfter, error } = await supabase.from('boards').select('specs').eq('id', board.id).maybeSingle();
    if (error || !boardAfter) return fail6(`could not re-fetch board specs: ${error?.message || 'no row'}`);
    if ((boardAfter.specs?.setVersion ?? null) !== newVersion) return fail6(`boards.specs.setVersion is ${boardAfter.specs?.setVersion} not ${newVersion}`);
    const beforeOther = { ...(board.specs || {}) }; delete beforeOther.setVersion;
    const afterOther = { ...(boardAfter.specs || {}) }; delete afterOther.setVersion;
    if (!deepEqual(beforeOther, afterOther)) return fail6(`boards.specs keys other than setVersion changed unexpectedly: before=${JSON.stringify(beforeOther)} after=${JSON.stringify(afterOther)}`);
    ok(`4. boards.specs.setVersion=${newVersion}, other specs keys unchanged (${Object.keys(beforeOther).join(', ') || 'none'})`);
  }

  // 5. Live holds now match exactly what we sent.
  {
    const { data, error } = await supabase.from('board_settings').select('data').eq('key', holdsKey).maybeSingle();
    if (error || !Array.isArray(data?.data)) return fail6(`could not re-read ${holdsKey}`);
    if (data.data.length !== newRecords.length) return fail6(`${holdsKey} has ${data.data.length} holds, expected ${newRecords.length}`);
    if (!deepEqual(data.data, newRecords)) return fail6(`${holdsKey} does not deep-equal what was sent`);
    const ids = data.data.map((h) => h.id);
    if (new Set(ids).size !== ids.length) return fail6(`${holdsKey} has duplicate hold IDs`);
    ok(`5. ${holdsKey} == the new set sent, no duplicate IDs (${data.data.length} holds)`);
  }

  console.log(`\n✓ RESET committed and verified. ${board.name}: set ${currentVersion} -> ${newVersion}, ${archiveCount} route(s) archived, holds ${existingHolds.length} -> ${newRecords.length}.`);
  console.log(`  Backups: backups/${backupLabel}-<timestamp>/  and  ${backupRelPath}`);
  process.exit(0);
}

const isMain = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
