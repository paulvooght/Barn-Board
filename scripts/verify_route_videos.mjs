// verify_route_videos.mjs — exercise the route_videos table + storage policies as a
// real user (claude-test) via the anon client, with service-role only for throwaway
// setup/teardown. Covers non-member, other member, uploader and wall admin, plus the
// resumable (TUS) upload path the app uses. Nothing touches the real walls.
// Run: node --env-file=.env.local scripts/verify_route_videos.mjs
import { createClient } from '@supabase/supabase-js';
import { Upload } from 'tus-js-client';
import { randomUUID } from 'node:crypto';

const URL_ = process.env.VITE_SUPABASE_URL;
const ANON = process.env.VITE_SUPABASE_ANON_KEY;
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EMAIL = process.env.VITE_DEV_AUTOLOGIN_EMAIL;
const PASS = process.env.VITE_DEV_AUTOLOGIN_PASSWORD;

const BARN = '1c97fee6-285a-4774-a185-cb5f17e60acf';
const PAUL = '9390639e-cd23-432b-94dc-fab38185f062';
const BUCKET = 'route-videos';
const CONSENT = 'By uploading I consent to this video being made public to all users of this app';

const svc = createClient(URL_, SVC, { auth: { persistSession: false } });
const anon = createClient(URL_, ANON, { auth: { persistSession: false } });

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { console.log(`${cond ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`); cond ? pass++ : fail++; };
const mp4 = (n = 1024) => Buffer.alloc(n, 7);

const wallA = randomUUID(), wallB = randomUUID();
const routeA = 'zzvid_a_' + Date.now();
const routeGone = 'zzvid_gone_' + Date.now();
const paulPrivate = { id: randomUUID() }, paulPublic = { id: randomUUID() }, paulOnRouteGone = { id: randomUUID() };
for (const v of [paulPrivate, paulPublic, paulOnRouteGone]) v.path = `${wallA}/${v.id}.mp4`;

async function exists(path) {
  const [folder, file] = path.split('/');
  const { data } = await svc.storage.from(BUCKET).list(folder, { search: file, limit: 5 });
  return (data || []).some(o => o.name === file);
}

async function setup(uid) {
  await svc.from('boards').insert([
    { id: wallA, name: 'ZZ Video A', slug: 'zz-video-a-' + wallA.slice(0, 8), visibility: 'private', owner_id: PAUL },
    { id: wallB, name: 'ZZ Video B', slug: 'zz-video-b-' + wallB.slice(0, 8), visibility: 'private', owner_id: PAUL },
  ]);
  await svc.from('routes').insert([
    { id: routeA, user_id: PAUL, board_id: wallA, data: { name: 'video test route' } },
    { id: routeGone, user_id: PAUL, board_id: wallA, data: { name: 'route that gets deleted' } },
  ]);
  const row = (v, route, extra = {}) => ({
    id: v.id, route_id: route, board_id: wallA, user_id: PAUL, storage_path: v.path, status: 'ready',
    is_public: false, consent_text: CONSENT, mime_type: 'video/mp4', size_bytes: 1024, ...extra,
  });
  const ins = await svc.from('route_videos').insert([
    row(paulPrivate, routeA),
    row(paulPublic, routeA, { is_public: true }),
    row(paulOnRouteGone, routeGone),
  ]);
  if (ins.error) throw new Error('setup insert failed: ' + ins.error.message);
  for (const v of [paulPrivate, paulPublic, paulOnRouteGone]) {
    const up = await svc.storage.from(BUCKET).upload(v.path, mp4(), { contentType: 'video/mp4' });
    if (up.error) throw new Error('setup upload failed: ' + up.error.message);
  }
  await svc.from('board_members').delete().in('board_id', [wallA, wallB]).eq('user_id', uid);
}

async function teardown() {
  for (const wall of [wallA, wallB]) {
    const { data } = await svc.storage.from(BUCKET).list(wall, { limit: 1000 });
    if (data?.length) await svc.storage.from(BUCKET).remove(data.map(o => `${wall}/${o.name}`));
  }
  await svc.from('route_videos').delete().in('board_id', [wallA, wallB]);
  await svc.from('board_members').delete().in('board_id', [wallA, wallB]);
  await svc.from('routes').delete().in('board_id', [wallA, wallB]);
  await svc.from('boards').delete().in('id', [wallA, wallB]);
}

// The same resumable upload the app does: direct storage host, 6 MB chunks.
function tusUpload(token, path, bytes, contentType = 'video/mp4') {
  const ref = new URL(URL_).hostname.split('.')[0];
  return new Promise((resolve) => {
    const u = new Upload(bytes, {
      endpoint: `https://${ref}.storage.supabase.co/storage/v1/upload/resumable`,
      retryDelays: [],
      chunkSize: 6 * 1024 * 1024,
      uploadSize: bytes.length,
      headers: { authorization: `Bearer ${token}`, apikey: ANON },
      metadata: { bucketName: BUCKET, objectName: path, contentType, cacheControl: '3600' },
      onError: (e) => resolve({ error: e }),
      onSuccess: () => resolve({ error: null }),
    });
    u.start();
  });
}

const rpcErr = (r) => r.error?.message || '';

const run = async () => {
  const { data: auth, error: authErr } = await anon.auth.signInWithPassword({ email: EMAIL, password: PASS });
  if (authErr) { console.error('sign-in failed:', authErr.message); process.exit(1); }
  const uid = auth.user.id;
  const token = auth.session.access_token;
  console.log('signed in as claude-test:', uid, '\n');

  await setup(uid);
  let r;

  try {
    // ── Bucket config ────────────────────────────────────────────────────────
    console.log('— Bucket —');
    const { data: bucket } = await svc.storage.getBucket(BUCKET);
    ok('Z1 bucket is private', bucket?.public === false);
    ok('Z2 bucket caps files at 50 MB', bucket?.file_size_limit === 52428800, `limit=${bucket?.file_size_limit}`);

    // ── Phase A: NON-member of wall A ────────────────────────────────────────
    console.log('\n— Phase A: non-member —');
    r = await anon.from('route_videos').select('id').eq('board_id', wallA);
    ok('A1 reads no video rows, not even the public one', !r.error && r.data.length === 0, `rows=${r.data?.length}`);
    r = await anon.storage.from(BUCKET).createSignedUrl(paulPrivate.path, 60);
    ok('A2 cannot get a link to a private video', !!r.error, r.error ? 'blocked' : 'LEAK');
    r = await anon.storage.from(BUCKET).createSignedUrl(paulPublic.path, 60);
    ok('A3 cannot get a link to a public video on a wall they are not on', !!r.error, r.error ? 'blocked' : 'LEAK');
    r = await anon.rpc('create_route_video', { p_route_id: routeA, p_mime_type: 'video/mp4', p_size_bytes: 1024, p_duration_s: 5, p_consent_text: CONSENT });
    ok('A4 cannot start an upload on the wall', rpcErr(r).includes('route_not_found'), rpcErr(r) || 'ALLOWED');
    r = await anon.storage.from(BUCKET).upload(`${wallA}/${randomUUID()}.mp4`, mp4(), { contentType: 'video/mp4' });
    ok('A5 cannot put a file straight in the bucket', !!r.error, r.error ? 'blocked' : 'LEAK');
    r = await tusUpload(token, `${wallA}/${randomUUID()}.mp4`, mp4());
    ok('A6 cannot put a file in by resumable upload either', !!r.error, r.error ? 'blocked' : 'LEAK');
    r = await anon.storage.from(BUCKET).list(wallA);
    ok('A7 cannot list the wall\'s files', !r.error && r.data.length === 0, `files=${r.data?.length}`);
    r = await anon.rpc('set_route_video_angle', { p_video: paulPublic.id, p_angle: 30 });
    ok('A8 cannot change a video\'s angle', rpcErr(r).includes('not_allowed'), rpcErr(r) || 'ALLOWED');

    // ── Phase B: other MEMBER of wall A (and admin of a DIFFERENT wall) ──────
    console.log('\n— Phase B: other member —');
    await svc.from('board_members').insert([
      { board_id: wallA, user_id: uid, role: 'member' },
      { board_id: wallB, user_id: uid, role: 'admin' },
    ]);
    r = await anon.from('route_videos').select('id').eq('route_id', routeA);
    const seen = new Set((r.data || []).map(v => v.id));
    ok('B1 sees the public video', seen.has(paulPublic.id));
    ok('B2 does NOT see another climber\'s private video', !seen.has(paulPrivate.id));

    r = await anon.storage.from(BUCKET).createSignedUrl(paulPublic.path, 60);
    const pubFetch = r.data?.signedUrl ? await fetch(r.data.signedUrl) : null;
    ok('B3 can play the public video', pubFetch?.status === 200, `status=${pubFetch?.status}`);
    r = await anon.storage.from(BUCKET).createSignedUrl(paulPrivate.path, 60);
    ok('B4 cannot get a link to the private video (even as admin of another wall)', !!r.error, r.error ? 'blocked' : 'LEAK');

    const noAuth = await fetch(`${URL_}/storage/v1/object/public/${BUCKET}/${paulPrivate.path}`);
    ok('B5 the plain public URL does not serve it', noAuth.status !== 200, `status=${noAuth.status}`);
    const withJwt = await fetch(`${URL_}/storage/v1/object/authenticated/${BUCKET}/${paulPrivate.path}`, { headers: { authorization: `Bearer ${token}` } });
    ok('B6 the signed-in URL does not serve it', withJwt.status !== 200, `status=${withJwt.status}`);

    r = await anon.from('route_videos').insert({ route_id: routeA, board_id: wallA, user_id: uid, storage_path: `${wallA}/x.mp4`, consent_text: CONSENT, mime_type: 'video/mp4', is_public: true }).select();
    ok('B7 cannot write the table directly', !!r.error, r.error ? 'blocked' : 'LEAK');
    r = await anon.from('route_videos').update({ is_public: true }).eq('id', paulPrivate.id).select();
    ok('B8 cannot update the table directly', !!r.error || r.data.length === 0, r.error ? 'blocked' : `rows=${r.data.length}`);
    r = await anon.from('route_videos').delete().eq('id', paulPublic.id).select();
    ok('B9 cannot delete from the table directly', !!r.error || r.data.length === 0, r.error ? 'blocked' : `rows=${r.data.length}`);

    r = await anon.rpc('set_route_video_public', { p_video: paulPrivate.id, p_public: true });
    ok('B10 cannot make someone\'s video public', rpcErr(r).includes('not_allowed'), rpcErr(r) || 'ALLOWED');
    r = await anon.rpc('set_route_video_public', { p_video: paulPublic.id, p_public: false });
    ok('B11 cannot make someone\'s video private', rpcErr(r).includes('not_allowed'), rpcErr(r) || 'ALLOWED');

    await anon.storage.from(BUCKET).remove([paulPublic.path]);
    ok('B12 cannot delete someone\'s file', await exists(paulPublic.path));
    r = await anon.rpc('delete_route_video_row', { p_video: paulPublic.id });
    ok('B13 cannot delete someone\'s video row', rpcErr(r).includes('not_allowed'), rpcErr(r) || 'ALLOWED');
    r = await anon.storage.from(BUCKET).upload(paulPrivate.path, mp4(), { contentType: 'video/mp4', upsert: true });
    ok('B14 cannot overwrite someone\'s file', !!r.error, r.error ? 'blocked' : 'LEAK');
    r = await anon.storage.from(BUCKET).upload(`${wallA}/${randomUUID()}.mp4`, mp4(), { contentType: 'video/mp4' });
    ok('B15 cannot upload to a path with no video row', !!r.error, r.error ? 'blocked' : 'LEAK');
    r = await anon.rpc('list_orphan_route_videos', { p_board: wallA });
    ok('B16 cannot read the admin clean-up list', rpcErr(r).includes('not_allowed'), rpcErr(r) || 'ALLOWED');

    // Limits and consent on starting an upload
    const start = (over = {}) => anon.rpc('create_route_video', { p_route_id: routeA, p_mime_type: 'video/mp4', p_size_bytes: 7 * 1024 * 1024, p_duration_s: 30, p_consent_text: CONSENT, ...over });
    r = await start({ p_consent_text: 'something else' });
    ok('B17 wrong consent wording is refused', rpcErr(r).includes('consent_required'), rpcErr(r) || 'ALLOWED');
    r = await start({ p_consent_text: null });
    ok('B18 missing consent is refused', rpcErr(r).includes('consent_required'), rpcErr(r) || 'ALLOWED');
    r = await start({ p_size_bytes: 52428801 });
    ok('B19 a file over 50 MB is refused', rpcErr(r).includes('file_too_large'), rpcErr(r) || 'ALLOWED');
    r = await start({ p_mime_type: 'application/pdf' });
    ok('B20 a non-video type is refused', rpcErr(r).includes('unsupported_type'), rpcErr(r) || 'ALLOWED');
    r = await start({ p_angle: 91 });
    ok('B21 an impossible angle is refused', rpcErr(r).includes('bad_angle'), rpcErr(r) || 'ALLOWED');
    r = await anon.rpc('set_route_video_angle', { p_video: paulPrivate.id, p_angle: 30 });
    ok('B22 cannot change the angle on someone\'s video', rpcErr(r).includes('not_allowed'), rpcErr(r) || 'ALLOWED');
    r = await anon.rpc('set_route_video_angle', { p_video: paulPublic.id, p_angle: 30 });
    ok('B23 cannot change the angle on someone\'s public video either', rpcErr(r).includes('not_allowed'), rpcErr(r) || 'ALLOWED');
    // The same query the route-card icons use: a private video must not show up,
    // or a climber's card would give away that someone else uploaded one.
    r = await anon.from('route_videos').select('route_id, is_public, user_id').eq('board_id', wallA).eq('status', 'ready');
    ok('B24 the wall-wide video list leaves out other climbers\' private videos', !r.error && r.data.length === 1 && r.data[0].is_public === true, rpcErr(r) || `rows=${r.data?.length}`);

    // ── Phase C: UPLOADER ────────────────────────────────────────────────────
    console.log('\n— Phase C: uploader —');
    r = await start();
    const mine = r.data;
    ok('C1 a member can start an upload', !r.error && !!mine?.id, rpcErr(r) || 'started');
    ok('C2 it starts private and unfinished', mine?.is_public === false && mine?.status === 'uploading');
    ok('C3 the wall comes from the route', mine?.board_id === wallA && mine?.user_id === uid);
    ok('C3b a call from the previous app version still works, with no angle', mine?.angle === null, `angle=${mine?.angle}`);
    r = await anon.rpc('finish_route_video', { p_video: mine.id });
    ok('C4 cannot finish before the file exists', rpcErr(r).includes('file_missing'), rpcErr(r) || 'ALLOWED');
    r = await anon.rpc('finish_route_video', { p_video: paulPrivate.id });
    ok('C5 cannot finish someone else\'s video', rpcErr(r).includes('not_found'), rpcErr(r) || 'ALLOWED');

    const bytes = mp4(7 * 1024 * 1024); // two 6 MB chunks, so the resume path really runs
    r = await tusUpload(token, mine.storage_path, bytes);
    ok('C6 resumable upload works under the policies', !r.error, r.error ? String(r.error.message).slice(0, 160) : 'uploaded');
    r = await anon.rpc('finish_route_video', { p_video: mine.id });
    ok('C7 finish marks it ready with the real file size', !r.error && r.data?.status === 'ready' && Number(r.data?.size_bytes) === bytes.length, rpcErr(r) || `size=${r.data?.size_bytes}`);
    r = await anon.rpc('finish_route_video', { p_video: mine.id });
    ok('C8 finishing twice is harmless', !r.error, rpcErr(r) || 'ok');

    r = await anon.from('route_videos').select('id').eq('id', mine.id);
    ok('C9 uploader sees their own private video', r.data?.length === 1);
    r = await anon.storage.from(BUCKET).createSignedUrl(mine.storage_path, 60);
    const ownFetch = r.data?.signedUrl ? await fetch(r.data.signedUrl, { headers: { range: 'bytes=0-99' } }) : null;
    ok('C10 uploader can play it, with the range requests phones need', ownFetch?.status === 206, `status=${ownFetch?.status}`);
    r = await anon.rpc('set_route_video_public', { p_video: mine.id, p_public: true });
    ok('C11 uploader cannot publish their own video', rpcErr(r).includes('not_allowed'), rpcErr(r) || 'ALLOWED');
    r = await anon.storage.from(BUCKET).upload(mine.storage_path, mp4(), { contentType: 'video/mp4', upsert: true });
    ok('C12 a finished file cannot be overwritten', !!r.error, r.error ? 'blocked' : 'LEAK');

    r = await anon.rpc('delete_route_video_row', { p_video: mine.id });
    ok('C13 row delete is refused while the file still exists', rpcErr(r).includes('file_still_exists'), rpcErr(r) || 'ALLOWED');
    r = await anon.storage.from(BUCKET).remove([mine.storage_path]);
    ok('C14 uploader can delete their own file', !r.error && !(await exists(mine.storage_path)), r.error?.message || 'removed');
    r = await anon.rpc('delete_route_video_row', { p_video: mine.id });
    ok('C15 uploader can then delete the row', !r.error, rpcErr(r) || 'deleted');

    // Bucket-level limits, on a row that would otherwise be allowed
    r = await start({ p_size_bytes: 1024 });
    const typeTest = r.data;
    r = await anon.storage.from(BUCKET).upload(typeTest.storage_path, Buffer.from('not a video'), { contentType: 'text/plain' });
    ok('C16 the bucket refuses a non-video file', !!r.error, r.error ? 'blocked' : 'LEAK');
    r = await tusUpload(token, typeTest.storage_path, mp4(52428801));
    ok('C17 the bucket refuses a file over 50 MB', !!r.error, r.error ? 'blocked' : 'LEAK');
    r = await anon.rpc('delete_route_video_row', { p_video: typeTest.id });
    ok('C18 a cancelled upload can be cleared', !r.error, rpcErr(r) || 'cleared');

    // Angle, on the uploader's own video
    r = await start({ p_size_bytes: 1024, p_angle: 35 });
    const angled = r.data;
    ok('C19 the angle is saved with the upload', !r.error && angled?.angle === 35, rpcErr(r) || `angle=${angled?.angle}`);
    r = await anon.rpc('set_route_video_angle', { p_video: angled.id, p_angle: 40 });
    ok('C20 uploader can correct their angle', !r.error && r.data?.angle === 40, rpcErr(r) || `angle=${r.data?.angle}`);
    ok('C21 changing the angle does not publish it', r.data?.is_public === false);
    r = await anon.rpc('set_route_video_angle', { p_video: angled.id, p_angle: null });
    ok('C22 the angle cannot be blanked', rpcErr(r).includes('bad_angle'), rpcErr(r) || 'ALLOWED');
    r = await anon.rpc('set_route_video_angle', { p_video: angled.id, p_angle: -1 });
    ok('C23 an impossible angle is refused', rpcErr(r).includes('bad_angle'), rpcErr(r) || 'ALLOWED');
    r = await anon.rpc('delete_route_video_row', { p_video: angled.id });
    ok('C24 the angle test row clears', !r.error, rpcErr(r) || 'cleared');

    // ── Phase D: wall ADMIN ──────────────────────────────────────────────────
    console.log('\n— Phase D: wall admin —');
    await svc.from('board_members').update({ role: 'admin' }).eq('board_id', wallA).eq('user_id', uid);
    r = await anon.from('route_videos').select('id').eq('route_id', routeA);
    const adminSeen = new Set((r.data || []).map(v => v.id));
    ok('D1 sees every climber\'s videos', adminSeen.has(paulPrivate.id) && adminSeen.has(paulPublic.id));
    r = await anon.storage.from(BUCKET).createSignedUrl(paulPrivate.path, 60);
    const adminFetch = r.data?.signedUrl ? await fetch(r.data.signedUrl) : null;
    ok('D2 can play a private video', adminFetch?.status === 200, `status=${adminFetch?.status}`);

    r = await anon.rpc('set_route_video_public', { p_video: paulPrivate.id, p_public: true });
    ok('D3 can make a video public', !r.error && r.data?.is_public === true && r.data?.published_by === uid, rpcErr(r) || 'public');

    // Demote to member for one check: the publish is what a normal member now sees.
    await svc.from('board_members').update({ role: 'member' }).eq('board_id', wallA).eq('user_id', uid);
    r = await anon.storage.from(BUCKET).createSignedUrl(paulPrivate.path, 60);
    ok('D4 once public, a normal member can play it', !r.error, r.error?.message || 'ok');
    await svc.from('board_members').update({ role: 'admin' }).eq('board_id', wallA).eq('user_id', uid);

    r = await anon.rpc('set_route_video_public', { p_video: paulPrivate.id, p_public: false });
    ok('D5 can undo it', !r.error && r.data?.is_public === false && r.data?.published_at === null, rpcErr(r) || 'private');
    await svc.from('board_members').update({ role: 'member' }).eq('board_id', wallA).eq('user_id', uid);
    r = await anon.storage.from(BUCKET).createSignedUrl(paulPrivate.path, 60);
    ok('D6 once undone, a normal member is blocked again', !!r.error, r.error ? 'blocked' : 'LEAK');
    await svc.from('board_members').update({ role: 'admin' }).eq('board_id', wallA).eq('user_id', uid);

    r = await anon.rpc('list_orphan_route_videos', { p_board: wallA });
    ok('D7 clean-up list ignores videos whose route still exists', !r.error && !r.data.some(v => v.id === paulPrivate.id || v.id === paulOnRouteGone.id), rpcErr(r) || `rows=${r.data?.length}`);
    await svc.from('routes').delete().eq('id', routeGone);
    r = await anon.rpc('list_orphan_route_videos', { p_board: wallA });
    ok('D8 clean-up list finds a video whose route was deleted', !r.error && r.data.some(v => v.id === paulOnRouteGone.id), rpcErr(r) || `rows=${r.data?.length}`);

    r = await anon.storage.from(BUCKET).remove([paulOnRouteGone.path]);
    ok('D9 admin can delete anyone\'s file', !r.error && !(await exists(paulOnRouteGone.path)), r.error?.message || 'removed');
    r = await anon.rpc('delete_route_video_row', { p_video: paulOnRouteGone.id });
    ok('D10 admin can delete anyone\'s row', !r.error, rpcErr(r) || 'deleted');

    r = await anon.rpc('route_videos_usage');
    const usage = r.data?.[0];
    ok('D11 storage gauge works', !r.error && Number(usage?.cap_bytes) === 838860800 && Number(usage?.used_bytes) >= 0, rpcErr(r) || `used=${usage?.used_bytes} count=${usage?.video_count}`);
    r = await anon.rpc('set_route_video_angle', { p_video: paulPrivate.id, p_angle: 30 });
    ok('D12 admin can set the angle on anyone\'s video', !r.error && r.data?.angle === 30, rpcErr(r) || `angle=${r.data?.angle}`);
    r = await anon.from('route_videos').select('id').eq('board_id', wallA).eq('status', 'ready');
    ok('D13 the wall-wide video list includes private videos for an admin', !r.error && r.data.some(v => v.id === paulPrivate.id), rpcErr(r) || `rows=${r.data?.length}`);

    // ── Phase E: real walls unaffected ───────────────────────────────────────
    console.log('\n— Phase E: real walls —');
    r = await anon.from('routes').select('id').eq('board_id', BARN).limit(1);
    ok('E1 real wall routes still read fine', !r.error && r.data.length === 1, r.error?.message || 'ok');
    const { data: imgs, error: imgErr } = await svc.storage.from('board-images').list('', { limit: 1 });
    ok('E2 board-images bucket untouched', !imgErr && imgs.length === 1, imgErr?.message || 'ok');
  } finally {
    await teardown();
    await anon.auth.signOut();
  }

  console.log(`\n${fail === 0 ? '🎉 ALL PASS' : '⚠️  FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
};

run().catch(async (e) => { console.error(e); await teardown().catch(() => {}); process.exit(1); });
