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

/** All routes, newest first (shared — every user sees every route). */
export function fetchRoutes() {
  return supabase.from('routes').select('id, user_id, data').order('created_at', { ascending: false });
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

export function fetchSessions(userId) {
  return supabase.from('sessions').select('data').eq('user_id', userId).order('created_at', { ascending: false });
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
