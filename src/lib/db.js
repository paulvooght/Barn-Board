// ─────────────────────────────────────────────────────────────────────────────
// db.js — the single place that talks to Supabase tables.
//
// Why this exists:
//  • Removes duplicated query/payload boilerplate (esp. user_route_data upserts).
//  • Gives one home for column names + conflict keys, so a schema change is a
//    one-place edit.
//  • Sets up multi-wall: when routes/sessions/holds gain a `board_id`, the filter
//    is added HERE once, not at ~35 call sites.
//
// Conventions:
//  • Fetch helpers RETURN the Supabase query builder (a thenable) so callers can
//    still compose them in Promise.all and read { data, error } — identical to before.
//  • Mutation helpers await the call and return { data?, error } (or { error }),
//    logging errors with a [db] prefix so call sites can drop their own .then(...).
//  • This module owns table access only. Auth (signIn / updateUser / getSession)
//    stays with the components that own those flows.
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from './supabase';

const now = () => new Date().toISOString();

// ─── routes ──────────────────────────────────────────────────────────────────

/**
 * All routes, newest first. Pass a boardId to scope to one wall (multi-wall).
 * Pass setVersion to additionally scope to one hold-set version (RESET
 * process — see docs/RESET_PROCESS_SPEC.md and scripts/board_reset.mjs).
 * Omitted by default so every existing call site is unaffected; deliberately
 * NOT added to the select() list here — routes.set_version only exists once
 * migration 010_set_versions.sql has been applied, and code can deploy ahead
 * of that migration being run, so widening the select would risk breaking
 * every existing caller until the owner runs the SQL.
 */
export function fetchRoutes(boardId, setVersion) {
  let q = supabase.from('routes').select('id, user_id, data, board_id').order('created_at', { ascending: false });
  if (boardId) q = q.eq('board_id', boardId);
  if (setVersion !== undefined) q = q.eq('set_version', setVersion);
  return q;
}

/** Bulk insert (used only by the first-login localStorage migration). */
export function insertRoutes(rows) {
  return supabase.from('routes').insert(rows);
}

/** Upsert route rows: [{ id, user_id, data }]. Stamps updated_at, conflicts on id. */
export async function upsertRoutes(rows) {
  const { error } = await supabase.from('routes').upsert(
    rows.map(r => ({ ...r, updated_at: now() })),
    { onConflict: 'id' }
  );
  if (error) console.error('[db] upsertRoutes error:', error);
  return { error };
}

/** Delete one route. Returns the deleted rows so callers can detect RLS blocks. */
export function deleteRoute(routeId) {
  return supabase.from('routes').delete().eq('id', routeId).select();
}

// ─── user_route_data (per-user, per-route) ───────────────────────────────────

/** This user's per-route data (sent/flashed/attempted/rating/angles/grades). */
export function fetchUserRouteData(userId) {
  return supabase
    .from('user_route_data')
    .select('route_id, sent, flashed, rating, angle_sends, angle_flashes, angle_attempts, grade_suggestions, attempted')
    .eq('user_id', userId);
}

/** Every non-zero rating across all users (for community averages). */
export function fetchAllRatings() {
  return supabase.from('user_route_data').select('route_id, rating').gt('rating', 0);
}

/** Every non-empty grade suggestion across all users (for community consensus). */
export function fetchAllGradeSuggestions() {
  return supabase.from('user_route_data').select('user_id, route_id, grade_suggestions').not('grade_suggestions', 'eq', '{}');
}

/**
 * Upsert one user_route_data row. Pass the full field set you want persisted —
 * callers already derive the complete row from `current`, so behaviour matches
 * the previous inline upserts exactly. Adds user_id/route_id/updated_at + conflict key.
 *
 * fields: { sent, flashed, attempted, rating, angle_sends, angle_flashes, angle_attempts, grade_suggestions }
 */
export async function upsertUserRouteData(userId, routeId, fields) {
  const { error } = await supabase.from('user_route_data').upsert(
    { user_id: userId, route_id: routeId, ...fields, updated_at: now() },
    { onConflict: 'user_id,route_id' }
  );
  if (error) console.error('[db] upsertUserRouteData error:', error);
  return { error };
}

// ─── sessions (private per user) ─────────────────────────────────────────────

export function fetchSessions(userId, boardId) {
  let q = supabase.from('sessions').select('data, board_id').eq('user_id', userId).order('created_at', { ascending: false });
  if (boardId) q = q.eq('board_id', boardId);
  return q;
}

/** Bulk insert (first-login migration only). */
export function insertSessions(rows) {
  return supabase.from('sessions').insert(rows);
}

/** Upsert session rows: [{ id, user_id, data }]. Stamps updated_at, conflicts on id. */
export async function upsertSessions(rows) {
  const { error } = await supabase.from('sessions').upsert(
    rows.map(s => ({ ...s, updated_at: now() })),
    { onConflict: 'id' }
  );
  if (error) console.error('[db] upsertSessions error:', error);
  return { error };
}

// ─── boards & membership (multi-wall) ────────────────────────────────────────

/** All boards (for the wall switcher / public list). `specs` carries per-wall
 *  config like boardRegion (the board area inside the photo). */
export function fetchBoards() {
  return supabase.from('boards').select('id, name, slug, visibility, specs').order('created_at', { ascending: true });
}

/** One board by its slug (e.g. 'the-barn'). */
export function fetchBoardBySlug(slug) {
  return supabase.from('boards').select('id, name, slug, visibility').eq('slug', slug).maybeSingle();
}

/** Boards this user belongs to (board_id + role). */
export function fetchMyMemberships(userId) {
  return supabase.from('board_members').select('board_id, role').eq('user_id', userId);
}

/** Add the current user to a board (idempotent). */
export async function joinBoard(boardId, userId, role = 'member') {
  const { error } = await supabase.from('board_members').upsert(
    { board_id: boardId, user_id: userId, role },
    { onConflict: 'board_id,user_id', ignoreDuplicates: true }
  );
  if (error) console.error('[db] joinBoard error:', error);
  return { error };
}

// ─── membership management (multi-wall 2b-iv) — all via SECURITY DEFINER RPCs
//     (migration 007). Each RPC re-checks permissions server-side; the privilege
//     is scoped to these vetted operations and survives the 2c RLS lockdown. ──

/** Join a PRIVATE wall by its code (works for walls you can't see in the list). */
export async function joinBoardByCode(code) {
  const { data, error } = await supabase.rpc('join_board_by_code', { p_code: code });
  return { board: (data && data[0]) || null, error };
}

/** A wall's members with display names + roles (any member may view the roster). */
export async function fetchBoardMembers(boardId) {
  const { data, error } = await supabase.rpc('get_board_members', { p_board: boardId });
  return { members: data || [], error };
}

/** Promote/demote a member (admin only; server guards the last admin). */
export async function setMemberRole(boardId, userId, role) {
  const { error } = await supabase.rpc('set_member_role', { p_board: boardId, p_user: userId, p_role: role });
  return { error };
}

/** Leave a wall (server blocks the last admin from abandoning it). */
export async function leaveBoard(boardId) {
  const { error } = await supabase.rpc('leave_board', { p_board: boardId });
  return { error };
}

/** Set a wall public/private (admin only). */
export async function setBoardVisibility(boardId, visibility) {
  const { error } = await supabase.rpc('set_board_visibility', { p_board: boardId, p_vis: visibility });
  return { error };
}

/** Update a wall's `specs` jsonb (physical dimensions + boardRegion). Pass the
 *  FULL merged specs object so nothing already in there (e.g. boardRegion) is
 *  dropped. RLS: the board owner can write directly ("boards: owner manage", 004). */
export async function updateBoardSpecs(boardId, specs) {
  const { error } = await supabase.from('boards').update({ specs }).eq('id', boardId);
  return { error };
}

// ─── board_settings (shared keyed JSON: holds, image config, playlists_<id>) ──

/** Read one settings blob by key. Returns the query (maybeSingle). */
export function getBoardSetting(key) {
  return supabase.from('board_settings').select('data').eq('key', key).maybeSingle();
}

/** Read several settings blobs at once. Returns rows [{ key, data }]. */
export function getBoardSettingsIn(keys) {
  return supabase.from('board_settings').select('key, data').in('key', keys);
}

/** Write one settings blob by key. Stamps updated_at, conflicts on key. */
export async function setBoardSetting(key, data) {
  const { error } = await supabase.from('board_settings').upsert(
    { key, data, updated_at: now() },
    { onConflict: 'key' }
  );
  if (error) console.error('[db] setBoardSetting error:', error);
  return { error };
}

// ─── per-board holds + image config (multi-wall 2b-ii) ───────────────────────
// Each wall owns its full hold array + image config under a board-scoped key, so
// the key-naming convention lives in ONE place. The legacy GLOBAL keys
// (custom_holds / hold_overrides / board_image_config) are left untouched as a
// revert path — see 005_holds_per_board.sql.

/** This wall's full hold array (the per-board equivalent of allHolds). */
export const getBoardHolds = (boardId) => getBoardSetting(`holds_${boardId}`);

/** Persist this wall's full hold array (IDs preserved verbatim). */
export const setBoardHolds = (boardId, holds) => setBoardSetting(`holds_${boardId}`, holds);

/**
 * One archived set's frozen hold snapshot (`holds_<boardId>_v<n>`), written
 * by scripts/board_reset.mjs when a wall is RESET to a new set (see
 * docs/RESET_PROCESS_SPEC.md). An archived route (set_version < the wall's
 * current boards.specs.setVersion) should render from this snapshot rather
 * than the live `holds_<boardId>` array, which by then holds a different set.
 */
export const getFrozenHolds = (boardId, setVersion) => getBoardSetting(`holds_${boardId}_v${setVersion}`);

/** This wall's board-image config ({ imageName, baseUrl, ... }). */
export const getBoardImageConfig = (boardId) => getBoardSetting(`board_image_config_${boardId}`);

/** Persist this wall's board-image config. */
export const setBoardImageConfig = (boardId, cfg) => setBoardSetting(`board_image_config_${boardId}`, cfg);

// ─── shared_playlists (public, subscribable) ─────────────────────────────────

export async function fetchSharedPlaylists() {
  const { data } = await supabase.from('shared_playlists').select('*');
  return data || [];
}

export async function upsertSharedPlaylist(row) {
  const { error } = await supabase.from('shared_playlists').upsert(
    { ...row, updated_at: now() },
    { onConflict: 'id' }
  );
  if (error) console.error('[db] upsertSharedPlaylist error:', error);
  return { error };
}

export function deleteSharedPlaylist(id) {
  return supabase.from('shared_playlists').delete().eq('id', id);
}

// ─── profiles (display name + admin flag) ────────────────────────────────────

export function fetchProfiles() {
  return supabase.from('profiles').select('user_id, display_name, is_admin');
}

/** Upsert this user's profile fields (e.g. { display_name }). Conflicts on user_id. */
export async function upsertProfile(userId, fields) {
  const { error } = await supabase.from('profiles').upsert(
    { user_id: userId, ...fields },
    { onConflict: 'user_id' }
  );
  return { error };
}

// ─── route_comments ──────────────────────────────────────────────────────────
// These return the query builder (thenable) — callers do their own error
// handling + optimistic rollback, so they need the { data, error } result.

export function fetchComments(routeId) {
  return supabase.from('route_comments').select('*').eq('route_id', routeId).order('created_at', { ascending: true });
}

/** Insert a comment and return the created row. */
export function insertComment(routeId, userId, body) {
  return supabase.from('route_comments').insert({ route_id: routeId, user_id: userId, body }).select().single();
}

/** Patch a comment in place (e.g. { likes } / { flags }). No row returned. */
export function updateComment(commentId, fields) {
  return supabase.from('route_comments').update(fields).eq('id', commentId);
}

/** Patch a comment and return the updated row (e.g. body edit). */
export function updateCommentReturning(commentId, fields) {
  return supabase.from('route_comments').update(fields).eq('id', commentId).select().single();
}

export function deleteComment(commentId) {
  return supabase.from('route_comments').delete().eq('id', commentId);
}

// ─── route_videos (migration 011) ────────────────────────────────────────────
// The table is READ-ONLY to clients: every write goes through a SECURITY DEFINER
// rpc that re-checks permissions. The files live in the PRIVATE `route-videos`
// bucket and are only reachable through short-lived signed URLs. The resumable
// upload itself is in src/utils/routeVideos.js (it needs the session token).
//
// Error codes arrive as the rpc error's `.message` (e.g. 'route_not_found',
// 'storage_full', 'file_missing') — see videoErrorMessage() for the wording.
//
// Rule for callers: a FAILED fetch is an error, never "no videos". Nothing here
// decides to delete from a result it could not read.

const ROUTE_VIDEOS_BUCKET = 'route-videos';

/** Videos on one route that finished uploading and that this user may see
 *  (RLS: their own, a wall admin's view of all, or ones made public). Newest first. */
export function fetchRouteVideos(routeId) {
  return supabase
    .from('route_videos')
    .select('*')
    .eq('route_id', routeId)
    .eq('status', 'ready')
    .order('created_at', { ascending: false });
}

/** One light row per finished video this user may see on a wall (RLS decides which):
 *  feeds the camera icons and video filters on the route list. */
export function fetchRouteVideoSummary(boardId) {
  return supabase
    .from('route_videos')
    .select('route_id, is_public, user_id')
    .eq('board_id', boardId)
    .eq('status', 'ready');
}

/** Start an upload: creates the row (status 'uploading') after the server checks
 *  membership, consent wording, type, size and the storage cap. */
export async function createRouteVideo({ routeId, mimeType, sizeBytes, durationS, consentText, angle }) {
  const { data, error } = await supabase.rpc('create_route_video', {
    p_route_id: routeId,
    p_mime_type: mimeType,
    p_size_bytes: sizeBytes,
    p_duration_s: durationS,
    p_consent_text: consentText,
    p_angle: angle,
  });
  if (error) console.error('[db] createRouteVideo error:', error);
  return { video: error ? null : data, error };
}

/** Mark an upload ready once the file really exists. Safe to call twice, so a
 *  lost response can simply be retried. */
export async function finishRouteVideo(videoId) {
  const { data, error } = await supabase.rpc('finish_route_video', { p_video: videoId });
  if (error) console.error('[db] finishRouteVideo error:', error);
  return { video: error ? null : data, error };
}

/** Make a video public to the wall's members, or private again (wall admin only). */
export async function setRouteVideoPublic(videoId, isPublic) {
  const { data, error } = await supabase.rpc('set_route_video_public', { p_video: videoId, p_public: isPublic });
  if (error) console.error('[db] setRouteVideoPublic error:', error);
  return { video: error ? null : data, error };
}

/** Set or correct the board angle a video was climbed at (uploader or wall admin). */
export async function setRouteVideoAngle(videoId, angle) {
  const { data, error } = await supabase.rpc('set_route_video_angle', { p_video: videoId, p_angle: angle });
  if (error) console.error('[db] setRouteVideoAngle error:', error);
  return { video: error ? null : data, error };
}

/** Signed playback URLs (1 hour) for several storage paths at once. Returns
 *  { urls: { [path]: signedUrl }, error }. A path the user may not read comes back
 *  with its own error and is simply left out of `urls`. */
export async function getRouteVideoUrls(paths) {
  if (!paths || paths.length === 0) return { urls: {}, error: null };
  const { data, error } = await supabase.storage.from(ROUTE_VIDEOS_BUCKET).createSignedUrls(paths, 3600);
  if (error) {
    console.error('[db] getRouteVideoUrls error:', error);
    return { urls: {}, error };
  }
  const urls = {};
  for (const item of data || []) {
    if (!item.error && item.path && item.signedUrl) urls[item.path] = item.signedUrl;
  }
  return { urls, error: null };
}

/**
 * Delete one video: the FILE first (Storage API), then the row. Never SQL-delete
 * storage.objects — that would orphan the file in the bucket.
 *
 * remove() returns no error when RLS silently removed nothing; the row delete then
 * raises 'file_still_exists' and that error is returned, so the row is never
 * dropped while its file survives.
 */
export async function deleteRouteVideo(video) {
  const { error: removeError } = await supabase.storage.from(ROUTE_VIDEOS_BUCKET).remove([video.storage_path]);
  if (removeError) {
    console.error('[db] deleteRouteVideo file error:', removeError);
    return { error: removeError };
  }
  const { error } = await supabase.rpc('delete_route_video_row', { p_video: video.id });
  if (error) console.error('[db] deleteRouteVideo row error:', error);
  return { error };
}

/**
 * Clean up a route's videos right after its row has been CONFIRMED deleted
 * (routes have no FK to route_videos, so nothing cascades). Looks at ANY status,
 * so half-finished uploads go too.
 *
 * Deletes only what this user is allowed to: their own, or everything if they are
 * the wall's admin. RLS means a non-admin setter only sees their own and public
 * videos anyway; whatever can't be deleted is left for the admin clean-up
 * (fetchOrphanRouteVideos) on purpose. Rows are deleted one at a time and one
 * failure doesn't stop the rest; the first failure is returned.
 *
 * If the lookup itself fails, NOTHING is deleted and the error is returned.
 */
export async function deleteVideosForDeletedRoute(routeId, userId, isBoardAdmin) {
  const { data, error: fetchError } = await supabase.from('route_videos').select('*').eq('route_id', routeId);
  if (fetchError || !Array.isArray(data)) {
    const error = fetchError || new Error('route_videos lookup returned no rows array');
    console.error('[db] deleteVideosForDeletedRoute lookup error:', error);
    return { error };
  }
  let firstError = null;
  for (const video of data) {
    if (video.user_id !== userId && !isBoardAdmin) continue;
    const { error } = await deleteRouteVideo(video);
    if (error && !firstError) firstError = error;
  }
  return { error: firstError };
}

/** Admin clean-up list: videos whose route has gone, plus uploads dead for 24h+.
 *  Decided server-side. `videos` is null (NOT []) when the call failed, so a
 *  failure can't be mistaken for "nothing to clean". */
export async function fetchOrphanRouteVideos(boardId) {
  const { data, error } = await supabase.rpc('list_orphan_route_videos', { p_board: boardId });
  if (error) {
    console.error('[db] fetchOrphanRouteVideos error:', error);
    return { videos: null, error };
  }
  return { videos: data || [], error: null };
}

/** Storage gauge for wall admins: { used_bytes, cap_bytes, video_count }. `usage`
 *  is null when the call failed or returned nothing. */
export async function fetchRouteVideosUsage() {
  const { data, error } = await supabase.rpc('route_videos_usage');
  if (error) console.error('[db] fetchRouteVideosUsage error:', error);
  return { usage: error ? null : (data && data[0]) || null, error };
}

// ─── storage: board images ───────────────────────────────────────────────────

const BOARD_IMAGES_BUCKET = 'board-images';

/** Public base URL for the board-images bucket. */
export const BOARD_IMAGES_BASE_URL =
  `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/public/${BOARD_IMAGES_BUCKET}`;

/**
 * Upload the four responsive board-image variants (full + 2000/1200/800w).
 * Ensures the bucket exists, then uploads in parallel. Returns the array of
 * upload results so the caller can inspect per-file errors.
 */
export async function uploadBoardImage(imageName, imageBlobs) {
  await supabase.storage.createBucket(BOARD_IMAGES_BUCKET, { public: true }).catch(() => {});
  const opts = { contentType: 'image/jpeg', upsert: true };
  return Promise.all([
    supabase.storage.from(BOARD_IMAGES_BUCKET).upload(`${imageName}.jpg`, imageBlobs.full, opts),
    supabase.storage.from(BOARD_IMAGES_BUCKET).upload(`${imageName}-2000w.jpg`, imageBlobs.w2000, opts),
    supabase.storage.from(BOARD_IMAGES_BUCKET).upload(`${imageName}-1200w.jpg`, imageBlobs.w1200, opts),
    supabase.storage.from(BOARD_IMAGES_BUCKET).upload(`${imageName}-800w.jpg`, imageBlobs.w800, opts),
  ]);
}
