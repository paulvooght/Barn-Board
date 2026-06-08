// verify_2c_rls.mjs — exercise the 2c tenant-isolation RLS as a real user (claude-test)
// via the anon client, with service-role only for throwaway setup/teardown.
// Run: node --env-file=.env.local scripts/verify_2c_rls.mjs
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const URL = process.env.VITE_SUPABASE_URL;
const ANON = process.env.VITE_SUPABASE_ANON_KEY;
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EMAIL = process.env.VITE_DEV_AUTOLOGIN_EMAIL;
const PASS = process.env.VITE_DEV_AUTOLOGIN_PASSWORD;

const BARN = '1c97fee6-285a-4774-a185-cb5f17e60acf';
const YONDER = '275dfaa7-1df9-4fe7-8332-c2795eb9ebe7';
const PAUL = '9390639e-cd23-432b-94dc-fab38185f062';

const svc = createClient(URL, SVC, { auth: { persistSession: false } });
const anon = createClient(URL, ANON, { auth: { persistSession: false } });

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { console.log(`${cond ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`); cond ? pass++ : fail++; };

const zzPriv = randomUUID(), zzPub = randomUUID(), zzCoded = randomUUID();
const JOIN_CODE = 'ZZtest-' + zzCoded.slice(0, 6);
const routeOther = 'zztest_other_' + Date.now();   // owned by PAUL on zzPriv
let routeMine = null;                                // created by claude-test
const holdsKey = `holds_${zzPriv}`;

async function setup(uid) {
  await svc.from('boards').insert([
    { id: zzPriv, name: 'ZZ Priv', slug: 'zz-priv-' + zzPriv.slice(0, 8), visibility: 'private', owner_id: PAUL },
    { id: zzPub,  name: 'ZZ Pub',  slug: 'zz-pub-'  + zzPub.slice(0, 8),  visibility: 'public',  owner_id: PAUL },
    { id: zzCoded, name: 'ZZ Coded', slug: 'zz-coded-' + zzCoded.slice(0, 8), visibility: 'private', owner_id: PAUL, join_code: JOIN_CODE },
  ]);
  await svc.from('routes').insert({ id: routeOther, user_id: PAUL, board_id: zzPriv, data: { name: 'others route' } });
  await svc.from('board_settings').upsert({ key: holdsKey, data: { seed: true } }, { onConflict: 'key' });
  // ensure claude-test starts as a NON-member of both throwaway walls
  await svc.from('board_members').delete().in('board_id', [zzPriv, zzPub, zzCoded]).eq('user_id', uid);
}

async function teardown(uid) {
  await svc.from('board_members').delete().in('board_id', [zzPriv, zzPub, zzCoded]);
  await svc.from('routes').delete().in('board_id', [zzPriv, zzPub, zzCoded]);
  await svc.from('board_settings').delete().eq('key', holdsKey);
  await svc.from('boards').delete().in('id', [zzPriv, zzPub, zzCoded]);
}

const run = async () => {
  const { data: auth, error: authErr } = await anon.auth.signInWithPassword({ email: EMAIL, password: PASS });
  if (authErr) { console.error('sign-in failed:', authErr.message); process.exit(1); }
  const uid = auth.user.id;
  console.log('signed in as claude-test:', uid, '\n');

  await teardown(uid); // clean any prior run
  await setup(uid);

  try {
    // ── Phase A: NON-member of zzPriv ──────────────────────────────────────
    console.log('— Phase A: non-member —');
    let r = await anon.from('routes').select('id').eq('board_id', zzPriv);
    ok('A1 non-member reads 0 routes of private wall', !r.error && (r.data?.length ?? 0) === 0, `rows=${r.data?.length}`);

    r = await anon.from('boards').select('id,visibility');
    const ids = new Set((r.data || []).map(b => b.id));
    ok('A2 boards: private non-member wall hidden', !ids.has(zzPriv));
    ok('A2 boards: public wall visible', ids.has(zzPub));

    r = await anon.from('board_settings').upsert({ key: holdsKey, data: { hacked: true } }, { onConflict: 'key' });
    ok('A3 non-admin CANNOT write board_settings (holds)', !!r.error, r.error ? 'blocked' : 'WROTE — LEAK!');

    r = await anon.from('routes').insert({ id: 'zz_hack_' + Date.now(), user_id: uid, board_id: zzPriv, data: {} });
    ok('A4 non-member CANNOT create a route on the wall', !!r.error, r.error ? 'blocked' : 'INSERTED — LEAK!');

    r = await anon.from('board_members').insert({ board_id: zzPriv, user_id: uid, role: 'member' });
    ok('A5 CANNOT self-join a PRIVATE wall', !!r.error, r.error ? 'blocked' : 'JOINED — LEAK!');

    r = await anon.from('board_members').insert({ board_id: zzPub, user_id: uid, role: 'member' });
    ok('A6 CAN self-join a PUBLIC wall', !r.error, r.error?.message || 'joined');

    // ── Phase B: MEMBER of zzPriv ─────────────────────────────────────────
    console.log('\n— Phase B: member —');
    await svc.from('board_members').insert({ board_id: zzPriv, user_id: uid, role: 'member' });

    r = await anon.from('routes').select('id').eq('board_id', zzPriv);
    ok('B1 member reads the wall routes', !r.error && (r.data?.length ?? 0) >= 1, `rows=${r.data?.length}`);

    routeMine = 'zztest_mine_' + Date.now();
    r = await anon.from('routes').insert({ id: routeMine, user_id: uid, board_id: zzPriv, data: { name: 'mine' } }).select();
    ok('B2 member CAN create own route on the wall', !r.error && r.data?.length === 1, r.error?.message || 'created');

    r = await anon.from('routes').update({ data: { name: 'hijacked' } }).eq('id', routeOther).select();
    ok('B3 member CANNOT edit someone else\'s route', !r.error && (r.data?.length ?? 0) === 0, `rows=${r.data?.length}`);

    r = await anon.from('board_settings').upsert({ key: holdsKey, data: { x: 1 } }, { onConflict: 'key' });
    ok('B4 member (non-admin) CANNOT write board_settings', !!r.error, r.error ? 'blocked' : 'WROTE — LEAK!');

    // ── Phase C: ADMIN of zzPriv ──────────────────────────────────────────
    console.log('\n— Phase C: admin —');
    await svc.from('board_members').update({ role: 'admin' }).eq('board_id', zzPriv).eq('user_id', uid);

    r = await anon.from('board_settings').upsert({ key: holdsKey, data: { byAdmin: true } }, { onConflict: 'key' });
    ok('C1 board admin CAN write board_settings (holds)', !r.error, r.error?.message || 'wrote');

    r = await anon.from('routes').update({ data: { name: 'by admin' } }).eq('id', routeOther).select();
    ok('C2 board admin CAN edit any route on the wall', !r.error && r.data?.length === 1, r.error?.message || 'edited');

    r = await anon.from('routes').delete().eq('id', routeOther).select();
    ok('C3 board admin CAN delete any route on the wall', !r.error && r.data?.length === 1, r.error?.message || 'deleted');

    // ── Phase E: NO LOCKOUT on the real walls (claude-test is a member of both) ─
    console.log('\n— Phase E: no-lockout on real walls —');
    r = await anon.from('boards').select('id').in('id', [BARN, YONDER]);
    ok('E1 sees both real walls (Barn + Yonder)', !r.error && (r.data?.length ?? 0) === 2, `rows=${r.data?.length}`);
    r = await anon.from('routes').select('id').eq('board_id', YONDER);
    ok('E2 can read Yonder routes (member) without error', !r.error, r.error?.message || `rows=${r.data?.length}`);
    r = await anon.from('board_settings').select('key').eq('key', `holds_${YONDER}`);
    ok('E3 can READ board_settings (holds) of a member wall', !r.error && (r.data?.length ?? 0) === 1, r.error?.message || 'ok');

    // ── Phase D: DEFINER fns are the (now sole) private-join + leave path ──
    console.log('\n— Phase D: private join-by-code + leave (007 DEFINER fns) —');
    let d = await anon.rpc('join_board_by_code', { p_code: JOIN_CODE.toLowerCase() }); // case-insensitive
    ok('D1 join_board_by_code joins a PRIVATE wall', !d.error && d.data?.[0]?.id === zzCoded, d.error?.message || 'joined');
    d = await anon.from('board_members').select('role').eq('board_id', zzCoded).eq('user_id', uid);
    ok('D2 membership row created by the fn', !d.error && d.data?.length === 1, `rows=${d.data?.length}`);
    d = await anon.rpc('join_board_by_code', { p_code: 'totally-wrong-code' });
    ok('D3 wrong code is rejected', !!d.error, d.error ? 'rejected' : 'ACCEPTED — LEAK!');
    d = await anon.rpc('leave_board', { p_board: zzCoded });
    ok('D4 leave_board removes membership', !d.error, d.error?.message || 'left');
    d = await anon.from('board_members').select('role').eq('board_id', zzCoded).eq('user_id', uid);
    ok('D5 membership row gone after leave', !d.error && (d.data?.length ?? 0) === 0, `rows=${d.data?.length}`);
  } finally {
    await teardown(uid);
    await anon.auth.signOut();
  }

  console.log(`\n${fail === 0 ? '🎉 ALL PASS' : '⚠️  FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
};

run().catch(e => { console.error(e); process.exit(1); });
