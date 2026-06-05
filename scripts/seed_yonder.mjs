// seed_yonder.mjs — Multi-wall 2b-iii: stand up the Yonder wall's DB state.
//
// Executable twin of supabase/migrations/006_yonder_board.sql (the boards row +
// membership) PLUS the per-board data seed (holds + boardRegion) from the
// detection output. Dry-run by default; --commit performs the writes.
//
// Writes (all idempotent / additive — touches NOTHING that belongs to The Barn):
//   boards row slug='yonder'                          (public, owner=Paul)   [006]
//   board_members: Paul=admin, claude-test=member                            [006]
//   board_settings['holds_<yonderId>']   = board-assets/yonder/holds_detected.json holds
//   boards.specs.boardRegion             = holds_detected.json boardRegion
//
// The board IMAGE is published separately (it needs Pillow):
//   python3 scripts/publish_board_image.py Yonder_Set_01_V1 --board yonder
//
// Reads VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local.
//
// Usage:
//   node --env-file=.env.local scripts/seed_yonder.mjs            # dry-run
//   node --env-file=.env.local scripts/seed_yonder.mjs --commit   # apply

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

// Identity (from the pre-2b-iii backup: profiles + The Barn owner_id).
const PAUL_ID = '9390639e-cd23-432b-94dc-fab38185f062';        // Paul V (owner/admin)
const CLAUDE_TEST_ID = 'b97b6928-fdce-4da1-902f-962b57cbe3e5'; // dev autologin (member)
const SLUG = 'yonder';
const NAME = 'Yonder';

const here = dirname(fileURLToPath(import.meta.url));
const detected = JSON.parse(readFileSync(join(here, '..', 'board-assets', 'yonder', 'holds_detected.json'), 'utf8'));
const supabase = createClient(url, key, { auth: { persistSession: false } });

const die = (msg) => { console.error(`\n✗ ABORT: ${msg}`); process.exit(1); };
const ok = (msg) => console.log(`  ✓ ${msg}`);

console.log(`\n=== seed_yonder  (${COMMIT ? 'COMMIT — will write' : 'DRY-RUN — no writes'}) ===\n`);

// ── 1. Validate the detection payload ────────────────────────────────────────
const boardRegion = detected.boardRegion;
if (!boardRegion || typeof boardRegion.left !== 'number') die('holds_detected.json has no valid boardRegion');
const rawHolds = detected.holds;
if (!Array.isArray(rawHolds) || rawHolds.length === 0) die('holds_detected.json has no holds');

// Normalise each hold to the shape the app renders/edits. holdTypes defaults to
// [] (route creation auto-collects from this). IDs are preserved verbatim — they
// become cardinal the moment Yonder has routes.
const holds = rawHolds.map(h => ({ name: '', holdTypes: [], positivity: 0, material: '', ...h }));

const ids = holds.map(h => h.id);
const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
if (dupes.length) die(`duplicate hold IDs in detection: ${dupes.join(', ')}`);
ok(`${holds.length} holds, ${new Set(ids).size} unique IDs, no duplicates`);
const byColour = holds.reduce((m, h) => ((m[h.color] = (m[h.color] || 0) + 1), m), {});
console.log(`  colours: ${JSON.stringify(byColour)}`);
console.log(`  boardRegion: ${JSON.stringify(boardRegion)}`);

// ── 2. Does the wall already exist? ──────────────────────────────────────────
const { data: existing, error: exErr } = await supabase
  .from('boards').select('id, name, slug, visibility, owner_id, specs').eq('slug', SLUG).maybeSingle();
if (exErr) die(`boards lookup failed: ${exErr.message}`);
console.log(existing ? `\n  Yonder already exists: ${existing.id}` : '\n  Yonder does not exist yet — will be created.');

// ── 3. Plan ──────────────────────────────────────────────────────────────────
const yonderIdLabel = existing?.id || '<new uuid>';
console.log('\n── Planned writes ──');
console.log(`  boards: upsert slug='${SLUG}' name='${NAME}' visibility='public' owner=${PAUL_ID}`);
console.log(`  board_members: ${PAUL_ID} = admin, ${CLAUDE_TEST_ID} = member`);
console.log(`  board_settings['holds_${yonderIdLabel}'] ← ${holds.length} holds`);
console.log(`  boards.specs.boardRegion ← ${JSON.stringify(boardRegion)}`);

if (!COMMIT) {
  console.log('\nDRY-RUN complete — nothing written. Re-run with --commit to apply.');
  process.exit(0);
}

// ── 4. Commit ────────────────────────────────────────────────────────────────
console.log('\n── Committing ──');
const nowIso = new Date().toISOString();

// 4a. boards row (idempotent on slug)
let { error } = await supabase.from('boards').upsert(
  { name: NAME, slug: SLUG, visibility: 'public', join_code: null, owner_id: PAUL_ID, specs: {} },
  { onConflict: 'slug', ignoreDuplicates: true });
if (error) die(`boards upsert failed: ${error.message}`);

const { data: yonder, error: yErr } = await supabase
  .from('boards').select('id, name, slug, visibility, owner_id, specs').eq('slug', SLUG).single();
if (yErr) die(`could not read back Yonder: ${yErr.message}`);
const yonderId = yonder.id;
ok(`boards row: ${yonderId}`);

// 4b. membership (idempotent on board_id,user_id)
({ error } = await supabase.from('board_members').upsert(
  [{ board_id: yonderId, user_id: PAUL_ID, role: 'admin' },
   { board_id: yonderId, user_id: CLAUDE_TEST_ID, role: 'member' }],
  { onConflict: 'board_id,user_id', ignoreDuplicates: true }));
if (error) die(`board_members upsert failed: ${error.message}`);
ok('membership: Paul=admin, claude-test=member');

// 4c. holds blob
({ error } = await supabase.from('board_settings').upsert(
  { key: `holds_${yonderId}`, data: holds, updated_at: nowIso }, { onConflict: 'key' }));
if (error) die(`holds_<yonderId> write failed: ${error.message}`);
ok(`board_settings['holds_${yonderId}'] ← ${holds.length} holds`);

// 4d. boardRegion into specs (merge, don't clobber other specs)
const newSpecs = { ...(yonder.specs || {}), boardRegion };
({ error } = await supabase.from('boards').update({ specs: newSpecs, updated_at: nowIso }).eq('id', yonderId));
if (error) die(`boards.specs update failed: ${error.message}`);
ok('boards.specs.boardRegion written');

// ── 5. Verify read-back ──────────────────────────────────────────────────────
const { data: check } = await supabase.from('board_settings').select('data').eq('key', `holds_${yonderId}`).single();
const { data: members } = await supabase.from('board_members').select('user_id, role').eq('board_id', yonderId);
console.log('\n── Verification ──');
console.log(`  holds_${yonderId}: ${check?.data?.length} holds stored`);
console.log(`  members: ${JSON.stringify(members)}`);
console.log(`\n✓ Yonder seeded. Next: publish image →  python3 scripts/publish_board_image.py Yonder_Set_01_V1 --board yonder`);
process.exit(0);
