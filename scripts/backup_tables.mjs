// backup_tables.mjs — dump all data tables to local JSON (a free restore point).
//
// Why: the Supabase project is on the Free plan (no scheduled backups / PITR),
// so this is our manual safety net before running migrations.
//
// Usage:  node --env-file=.env.local scripts/backup_tables.mjs
//   Reads VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local.
//   Writes backups/<label>-<timestamp>/<table>.json  (backups/ is gitignored).
//
// Read-only (SELECT *). Paginates so it captures tables with >1000 rows.

import { createClient } from '@supabase/supabase-js';
import { mkdirSync, writeFileSync } from 'fs';

const url = process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (run with --env-file=.env.local)');
  process.exit(1);
}

const label = process.argv[2] || 'backup';
const TABLES = ['routes', 'sessions', 'user_route_data', 'board_settings', 'profiles', 'route_comments', 'shared_playlists', 'boards', 'board_members'];

const supabase = createClient(url, key, { auth: { persistSession: false } });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dir = `backups/${label}-${stamp}`;
mkdirSync(dir, { recursive: true });

let grandTotal = 0;
let hadError = false;
for (const table of TABLES) {
  const rows = [];
  let from = 0;
  const page = 1000;
  while (true) {
    const { data, error } = await supabase.from(table).select('*').range(from, from + page - 1);
    if (error) { console.error(`  ${table}: ERROR — ${error.message}`); hadError = true; break; }
    rows.push(...data);
    if (data.length < page) break;
    from += page;
  }
  writeFileSync(`${dir}/${table}.json`, JSON.stringify(rows, null, 2));
  console.log(`  ${table.padEnd(18)} ${rows.length} rows`);
  grandTotal += rows.length;
}

console.log(`\n${hadError ? '⚠ completed WITH ERRORS' : '✓ backup complete'} → ${dir}  (${grandTotal} rows total)`);
process.exit(hadError ? 1 : 0);
