import { useState, useEffect, useRef, useCallback } from 'react';
import * as db from '../lib/db';
import {
  CONSENT_TEXT,
  prepareVideo,
  createVideoUpload,
  videoErrorCode,
  videoErrorMessage,
} from '../utils/routeVideos';

/**
 * Background queue for route-video uploads. Mount it ONCE, high up (App), so an
 * upload keeps going when the climber swipes to another route or leaves the route
 * page — the jobs belong to the app, not to a screen.
 *
 * Jobs run ONE AT A TIME, in the order they were added. Each job walks:
 *   waiting → shrinking → uploading → finishing → done
 * and stops at `failed` (with friendly `error` text) if a step fails. Retrying
 * resumes from the step that failed — finished steps are never repeated.
 *
 * What React sees (`jobs`) is plain data: { jobId, routeId, routeName, stage,
 * progress (0–1), error, shrunk }. The heavy things (the File, the shrunk Blob,
 * the database row, the tus upload) live in `workRef`, outside React state.
 *
 * All values read inside async code come from refs, never from state captured in
 * a closure — the pipeline runs for minutes and state would be long stale.
 *
 * Returns { jobs, startUpload, retryUpload, cancelUpload, dismissUpload, lastFinished }
 * where lastFinished is { routeId, at } for the most recent success (so a route
 * page can re-fetch its videos when its own upload lands).
 */

// A brand-new route can still be syncing to the server when the climber adds a
// video, and the server answers 'route_not_found' until it lands. Wait and try again.
const ROUTE_NOT_FOUND_RETRY_MS = [2000, 3000, 5000, 8000, 10000, 15000];
const DONE_LINGER_MS = 4000;
const ACTIVE_STAGES = ['waiting', 'shrinking', 'uploading', 'finishing'];

// Sleep that a cancel can cut short (otherwise a cancelled job would hold up the
// queue for the rest of its back-off).
function sleepUnlessCancelled(work, ms) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); work.wake = null; resolve(); };
    const timer = setTimeout(done, ms);
    work.wake = done;
  });
}

// Create the database row, retrying only while the route hasn't synced yet.
async function createRowWithRetry(work) {
  for (let attempt = 0; ; attempt++) {
    const { video, error } = await db.createRouteVideo({
      routeId: work.routeId,
      mimeType: work.prepared.mimeType,
      sizeBytes: work.prepared.blob.size,
      durationS: work.durationS,
      consentText: CONSENT_TEXT,
    });
    if (!error && video) return video;

    const retryable = videoErrorCode(error) === 'route_not_found' && attempt < ROUTE_NOT_FOUND_RETRY_MS.length;
    if (!retryable || work.cancelled) throw error || new Error('create_route_video returned no row');
    await sleepUnlessCancelled(work, ROUTE_NOT_FOUND_RETRY_MS[attempt]);
    if (work.cancelled) throw error;
  }
}

export default function useVideoUploads() {
  const [jobs, setJobs] = useState([]);
  const [lastFinished, setLastFinished] = useState(null);

  const jobsRef = useRef([]);              // source of truth for `jobs`; async code reads this
  const workRef = useRef(new Map());       // jobId → private, non-React data for that job
  const pumpingRef = useRef(false);        // true while the queue loop is running
  const mountedRef = useRef(false);
  const wakeLockRef = useRef(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // ─── job list helpers (all read refs, so they can safely be [] callbacks) ───

  const commit = useCallback((next) => {
    jobsRef.current = next;
    if (mountedRef.current) setJobs(next);
  }, []);

  const update = useCallback((jobId, patch) => {
    const list = jobsRef.current;
    const i = list.findIndex((j) => j.jobId === jobId);
    if (i < 0) return; // cancelled or dismissed while something was still in flight
    const merged = { ...list[i], ...patch };
    if ('progress' in patch) {
      merged.progress = Number.isFinite(patch.progress) ? Math.min(1, Math.max(0, patch.progress)) : 0;
      // Upload progress fires many times a second; only re-render on a visible step.
      if (Object.keys(patch).length === 1 && merged.progress < 1 && Math.abs(merged.progress - list[i].progress) < 0.01) return;
    }
    const next = list.slice();
    next[i] = merged;
    commit(next);
  }, [commit]);

  const removeJob = useCallback((jobId) => {
    const work = workRef.current.get(jobId);
    if (work) clearTimeout(work.doneTimer);
    workRef.current.delete(jobId);
    commit(jobsRef.current.filter((j) => j.jobId !== jobId));
  }, [commit]);

  const stageOf = useCallback((jobId) => jobsRef.current.find((j) => j.jobId === jobId)?.stage, []);

  // Delete the database row (and any file) for a job that is being abandoned.
  // Idempotent. Failure is only logged: the server's 24-hour clean-up list
  // (fetchOrphanRouteVideos) catches whatever is left behind.
  const discardRow = useCallback(async (work) => {
    if (!work.row || work.rowDiscarded) return;
    work.rowDiscarded = true;
    const { error } = await db.deleteRouteVideo(work.row);
    if (error) console.warn('[useVideoUploads] could not remove abandoned upload, admin clean-up will:', error);
  }, []);

  // ─── the pipeline for one job ───────────────────────────────────────────────

  const runJob = useCallback(async (jobId) => {
    const work = workRef.current.get(jobId);
    if (!work) return;
    // False once the job has been cancelled/removed: every await below re-checks it.
    const isLive = () => !work.cancelled && workRef.current.get(jobId) === work;

    const complete = () => {
      update(jobId, { stage: 'done', progress: 1, error: null });
      // Let go of the big things; only the row id matters from here.
      work.file = null;
      work.prepared = null;
      work.upload = null;
      if (mountedRef.current) setLastFinished({ routeId: work.routeId, at: Date.now() });
      work.doneTimer = setTimeout(() => removeJob(jobId), DONE_LINGER_MS);
    };

    try {
      // 1. Shrink (skipped when a previous run already produced the blob).
      if (!work.prepared) {
        update(jobId, { stage: 'shrinking', progress: 0, error: null });
        const prepared = await prepareVideo(work.file, {
          onProgress: (p) => { if (isLive() && stageOf(jobId) === 'shrinking') update(jobId, { progress: p }); },
          onCancelHandle: (cancel) => {
            work.cancelFn = cancel;
            if (work.cancelled) cancel(); // cancelled before the conversion existed
          },
        });
        work.cancelFn = null;
        if (!isLive()) return;
        work.prepared = prepared;
        update(jobId, { shrunk: prepared.shrunk });
      }

      // 2. Create the database row (the storage policy refuses a file with no row).
      if (!work.row) {
        update(jobId, { stage: 'uploading', progress: 0, error: null });
        const row = await createRowWithRetry(work);
        work.row = row;
        if (!isLive()) { await discardRow(work); return; } // cancelled while the request was in flight
      }

      // 2b. Retry only: the failure may have been a lost RESPONSE, with the whole
      // file already stored. finish succeeding proves that and we're done; a
      // 'file_missing' means it really hasn't all arrived, so resume below.
      if (work.recheck) {
        work.recheck = false;
        update(jobId, { stage: 'finishing', progress: 1, error: null });
        const { error } = await db.finishRouteVideo(work.row.id);
        if (!isLive()) return;
        if (!error) { complete(); return; }
        if (videoErrorCode(error) !== 'file_missing') throw error;
      }

      // 3. Upload. ONE tus object per job, so a retry resumes from the same URL.
      if (!work.uploaded) {
        update(jobId, { stage: 'uploading', error: null });
        if (!work.upload) {
          work.upload = await createVideoUpload({
            blob: work.prepared.blob,
            path: work.row.storage_path,
            mimeType: work.prepared.mimeType,
            onProgress: (p) => { if (isLive() && stageOf(jobId) === 'uploading') update(jobId, { progress: p }); },
          });
          if (!isLive()) return;
        }
        await work.upload.start();
        if (!isLive()) return;
        work.uploaded = true;
      }

      // 4. Tell the server the file is there, which makes the video 'ready'.
      update(jobId, { stage: 'finishing', progress: 1, error: null });
      const { error } = await db.finishRouteVideo(work.row.id);
      if (!isLive()) return;
      if (error) throw error;
      complete();
    } catch (err) {
      if (!isLive()) return; // a cancel makes the steps above throw; that's expected
      console.error('[useVideoUploads] upload failed:', err);
      update(jobId, { stage: 'failed', error: videoErrorMessage(err) });
    }
  }, [update, removeJob, discardRow, stageOf]);

  // The queue: run the first waiting job, then the next, until none are left.
  // A failed job doesn't block it (it just sits there until retried or dismissed).
  const pump = useCallback(async () => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    try {
      for (;;) {
        const next = jobsRef.current.find((j) => j.stage === 'waiting');
        if (!next) break;
        await runJob(next.jobId);
        // Belt and braces: runJob always moves a job off 'waiting'. If it ever
        // didn't, fail it rather than spin on it forever.
        if (stageOf(next.jobId) === 'waiting') {
          update(next.jobId, { stage: 'failed', error: videoErrorMessage(null) });
        }
      }
    } finally {
      pumpingRef.current = false;
    }
  }, [runJob, update, stageOf]);

  // ─── public actions ─────────────────────────────────────────────────────────

  const startUpload = useCallback(({ routeId, routeName, file, durationS }) => {
    if (!routeId || !file) return null;
    const jobId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    workRef.current.set(jobId, {
      routeId,
      file,
      durationS: Number.isFinite(durationS) ? durationS : null, // null = unknown
      prepared: null,     // { blob, mimeType, shrunk } once shrinking is done
      row: null,          // the route_videos row once created
      upload: null,       // the tus wrapper, kept so a retry resumes
      uploaded: false,    // true once the tus upload has fully succeeded
      recheck: false,     // set by retry: try finish before re-uploading
      cancelled: false,
      cancelFn: null,     // stops shrinking
      wake: null,         // cuts a route_not_found back-off short
      doneTimer: null,
      rowDiscarded: false,
    });
    commit([...jobsRef.current, { jobId, routeId, routeName: routeName || '', stage: 'waiting', progress: 0, error: null, shrunk: false }]);
    pump();
    return jobId;
  }, [commit, pump]);

  const retryUpload = useCallback((jobId) => {
    const work = workRef.current.get(jobId);
    if (!work || stageOf(jobId) !== 'failed') return;
    // If the row exists but the file never fully landed, the failure may just have
    // been a lost reply: let runJob check with the server before re-sending.
    work.recheck = !!work.row && !work.uploaded;
    update(jobId, { stage: 'waiting', error: null });
    pump();
  }, [update, pump, stageOf]);

  const cancelUpload = useCallback(async (jobId) => {
    const work = workRef.current.get(jobId);
    if (!work) return;
    // A finished upload is not cancellable: that would delete a good video.
    if (stageOf(jobId) === 'done') { removeJob(jobId); return; }

    work.cancelled = true;
    removeJob(jobId); // gone from the UI immediately
    if (work.wake) work.wake();
    try { if (work.cancelFn) await work.cancelFn(); } catch (err) { console.warn('[useVideoUploads] cancel shrink:', err); }
    try { if (work.upload) await work.upload.abort(); } catch (err) { console.warn('[useVideoUploads] cancel upload:', err); }
    await discardRow(work);
  }, [removeJob, discardRow, stageOf]);

  const dismissUpload = useCallback((jobId) => {
    const stage = stageOf(jobId);
    if (stage === 'done' || stage === 'failed') removeJob(jobId);
  }, [removeJob, stageOf]);

  // ─── keep the phone awake and warn before leaving, while anything is active ──

  const anyActive = jobs.some((j) => ACTIVE_STAGES.includes(j.stage));

  // Shrinking is CPU work in the page; a phone that falls asleep kills it. Not
  // every browser has the Wake Lock API and it can be refused (low battery), so
  // it's best-effort and silent. The lock is dropped whenever the tab is hidden,
  // so ask again when it comes back.
  useEffect(() => {
    if (!anyActive) return undefined;
    let stopped = false;

    const acquire = async () => {
      try {
        if (!navigator.wakeLock || document.visibilityState !== 'visible') return;
        if (wakeLockRef.current && !wakeLockRef.current.released) return;
        const lock = await navigator.wakeLock.request('screen');
        if (stopped) { lock.release().catch(() => {}); return; }
        wakeLockRef.current = lock;
      } catch { /* unsupported or refused: carry on without it */ }
    };
    const onVisibility = () => { if (document.visibilityState === 'visible') acquire(); };

    acquire();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisibility);
      const lock = wakeLockRef.current;
      wakeLockRef.current = null;
      if (lock) lock.release().catch(() => {});
    };
  }, [anyActive]);

  useEffect(() => {
    if (!anyActive) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; return ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [anyActive]);

  return { jobs, startUpload, retryUpload, cancelUpload, dismissUpload, lastFinished };
}
