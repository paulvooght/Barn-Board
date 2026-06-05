// migrate_holds_to_board.mjs — Multi-wall 2b-ii: move The Barn's holds + image
// config + boardRegion from the GLOBAL singletons into per-board keys.
//
// This is the executable twin of supabase/migrations/005_holds_per_board.sql.
// It reads LIVE data, PROVES the migration is a safe verbatim copy (hold IDs
// preserved), reports route-reference coverage, and — only with --commit —
// performs the writes. Dry-run by default (no DB writes).
//
// Usage:
//   node --env-file=.env.local scripts/migrate_holds_to_board.mjs            # dry-run (verify only)
//   node --env-file=.env.local scripts/migrate_holds_to_board.mjs --commit   # apply the writes
//
// What it writes (additive, non-destructive — old keys left as a revert path):
//   board_settings['holds_<barnId>']               = effective allHolds (== custom_holds)
//   board_settings['board_image_config_<barnId>']  = board_image_config (if present)
//   boards.specs.boardRegion                        = holds.json.boardRegion
//
// Reads VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local (service
// role: bypasses RLS, same as the other local scripts).

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const COMMIT = process.argv.includes('--commit');
const url = process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (run with --env-file=.env.local)');
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const holdsJson = JSON.parse(readFileSync(join(here, '..', 'src', 'data', 'holds.json'), 'utf8'));
const supabase = createClient(url, key, { auth: { persistSession: false } });

const die = (msg) => { console.error(`\n✗ ABORT: ${msg}`); process.exit(1); };
const ok = (msg) => console.log(`  ✓ ${msg}`);

console.log(`\n=== migrate_holds_to_board  (${COMMIT ? 'COMMIT — will write' : 'DRY-RUN — no writes'}) ===\n`);

// ── 1. Load live data ────────────────────────────────────────────────────────
const { data: barn, error: bErr } = await supabase
  .from('boards').select('id, name, slug, specs').eq('slug', 'the-barn').maybeSingle();
if (bErr) die(`boards query failed: ${bErr.message}`);
if (!barn) die('The Barn (slug=the-barn) not found — run 004 first');
const barnId = barn.id;
console.log(`The Barn: ${barnId}  (specs: ${JSON.stringify(barn.specs)})`);

const { data: bsRows, error: sErr } = await supabase
  .from('board_settings').select('key, data').in('key', ['hold_overrides', 'custom_holds', 'board_image_config']);
if (sErr) die(`board_settings query failed: ${sErr.message}`);
const overrides = bsRows.find(r => r.key === 'hold_overrides')?.data || {};
const customs   = bsRows.find(r => r.key === 'custom_holds')?.data;
const imageCfg  = bsRows.find(r => r.key === 'board_image_config')?.data || null;
if (!Array.isArray(customs)) die('board_settings[custom_holds] missing or not an array');

const { data: routes, error: rErr } = await supabase.from('routes').select('id, data, board_id');
if (rErr) die(`routes query failed: ${rErr.message}`);

// ── 2. Compute effective allHolds EXACTLY as useCustomHolds does ──────────────
const base = holdsJson.holds.filter(h => !overrides[h.id]?.hidden).map(h => ({ ...h, ...(overrides[h.id] || {}) }));
const effective = [...base, ...customs];

console.log('\n── Precondition: per-board copy is a verbatim copy of effective holds ──');
console.log(`  base holds total:        ${holdsJson.holds.length}`);
console.log(`  base surviving (visible):${String(base.length).padStart(4)}`);
console.log(`  custom_holds:            ${customs.length}`);
console.log(`  effective allHolds:      ${effective.length}`);

// The 005 SQL copies custom_holds verbatim into holds_<barnId>. That equals the
// effective set ONLY if no base hold survives. If a base hold IS visible, refuse.
if (base.length !== 0) {
  die(`${base.length} base hold(s) are still visible — a verbatim custom_holds copy would LOSE them. `
    + `Use a literal-blob migration seeded from "effective" instead of 005's copy.`);
}
ok('all base holds hidden — holds_<barnId> = custom_holds is exact');

// Duplicate-ID guard
const ids = effective.map(h => h.id);
const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
if (dupes.length) die(`duplicate hold IDs in effective set: ${dupes.join(', ')}`);
ok(`no duplicate hold IDs (${ids.length} unique)`);

// ── 3. Route-reference coverage (the real safety check) ──────────────────────
const idSet = new Set(ids);
let totalRefs = 0, missing = 0; const offenders = [];
for (const r of routes) {
  const holds = r.data?.holds || {};
  const refs = Object.keys(holds);
  let m = 0;
  for (const hid of refs) { totalRefs++; if (!idSet.has(hid)) { missing++; m++; } }
  if (m) offenders.push(`"${r.data?.name || r.id}" (${m}/${refs.length})`);
}
console.log('\n── Route hold-reference coverage ──');
console.log(`  routes: ${routes.length}  |  hold refs: ${totalRefs}  |  resolving: ${totalRefs - missing}  |  missing: ${missing}`);
if (missing) console.log(`  ⚠ routes with missing holds (PRE-EXISTING, unchanged by this migration): ${offenders.join(', ')}`);
else ok('every route hold reference resolves to a live hold');
console.log('  (the migrated set == effective set, so this coverage is identical before & after)');

// ── 4. Planned writes ────────────────────────────────────────────────────────
const boardRegion = holdsJson.boardRegion;
console.log('\n── Planned writes ──');
console.log(`  board_settings['holds_${barnId}']              ← custom_holds (${customs.length} holds)`);
console.log(`  board_settings['board_image_config_${barnId}'] ← ${imageCfg ? `board_image_config (${imageCfg.imageName})` : 'SKIP (none live)'}`);
console.log(`  boards.specs.boardRegion                        ← ${JSON.stringify(boardRegion)}`);

if (!COMMIT) {
  console.log('\nDRY-RUN complete — nothing written. Re-run with --commit (or run supabase/migrations/005_holds_per_board.sql).');
  process.exit(0);
}

// ── 5. Commit (idempotent upserts) ───────────────────────────────────────────
console.log('\n── Committing ──');
const nowIso = new Date().toISOString();

let { error } = await supabase.from('board_settings')
  .upsert({ key: `holds_${barnId}`, data: customs, updated_at: nowIso }, { onConflict: 'key' });
if (error) die(`write holds_<barnId> failed: ${error.message}`);
ok(`holds_${barnId} written`);

if (imageCfg) {
  ({ error } = await supabase.from('board_settings')
    .upsert({ key: `board_image_config_${barnId}`, data: imageCfg, updated_at: nowIso }, { onConflict: 'key' }));
  if (error) die(`write board_image_config_<barnId> failed: ${error.message}`);
  ok(`board_image_config_${barnId} written`);
}

const newSpecs = { ...(barn.specs || {}), boardRegion };
({ error } = await supabase.from('boards')
  .update({ specs: newSpecs, updated_at: nowIso }).eq('id', barnId));
if (error) die(`update boards.specs failed: ${error.message}`);
ok('boards.specs.boardRegion written');

console.log('\n✓ Migration committed. Old global keys (custom_holds / hold_overrides / board_image_config) left intact as a revert path.');
process.exit(0);
