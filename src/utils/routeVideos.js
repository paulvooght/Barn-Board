// Route-video plumbing: reading, shrinking and uploading a climber's video.
// Plain functions only — no React. See supabase/migrations/011_route_videos.sql
// for the server contract (rpc names, error codes, the private `route-videos`
// bucket). The queue that drives these lives in src/hooks/useVideoUploads.js.
//
// `mediabunny` (~700 KB) and `tus-js-client` are loaded with dynamic import()
// INSIDE the functions that need them, so Vite splits them into their own chunks
// and nobody pays for them until someone actually picks a video. Never add a
// static import of either here.

import { supabase } from '../lib/supabase';
import { BOARD_SPECS } from './constants';

/** A whole board angle inside the board's range, for the angle sliders' starting
 *  position. Anything that isn't a number (no session, no angle) gives 30. */
export function clampBoardAngle(angle) {
  const n = Number.isFinite(angle) ? Math.round(angle) : 30;
  return Math.min(BOARD_SPECS.maxAngle, Math.max(BOARD_SPECS.minAngle, n));
}

// The server compares this to the exact same string in create_route_video()
// (migration 011) and rejects anything else with 'consent_required'. Change both
// together, and show users exactly this wording next to the upload button.
export const CONSENT_TEXT = 'By uploading I consent to this video being made public to all users of this app';

export const MAX_VIDEO_SECONDS = 60;
// Matches the `route-videos` bucket's file_size_limit (50 MB), which is the Free
// plan's maximum per file. The server refuses anything bigger.
export const MAX_VIDEO_BYTES = 52428800;

// Shrink targets. ~2 Mbps H.264 at 720p keeps a 60 s clip around 15 MB, well
// under the cap, and plays fine on a phone screen.
const TARGET_BITRATE = 2_000_000;
const MAX_SHORT_SIDE = 720;
const MAX_FPS = 30;
const STALL_TIMEOUT_MS = 30000; // no progress for this long, while visible, counts as stuck

const VIDEO_MIME_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'];

// ─── Errors ──────────────────────────────────────────────────────────────────

/** An upload problem with a machine-readable `.code` (also used as the message). */
export class VideoError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'VideoError';
    this.code = code;
  }
}

const ERROR_MESSAGES = {
  storage_full: 'Video storage is full. Ask an admin to clear some space.',
  file_too_large: 'That video is too big, even after shrinking. Trim it in your Photos app and try again.',
  unsupported_type: "That file type isn't supported. Choose an MP4 or MOV video.",
  route_not_found: "This route hasn't finished saving. Try again in a moment.",
  consent_required: 'Consent is needed before uploading.',
  bad_angle: "That angle isn't one this board goes to. Pick another and try again.",
};
const GENERIC_ERROR_MESSAGE = 'Upload failed. Check your signal and try again.';

// Codes worth recognising even though they have no special wording: the upload
// pipeline branches on them (file_missing = "the file hasn't fully arrived yet").
// Order matters: text is matched by substring, so 'route_not_found' (above) has
// to be tried before the shorter 'not_found'.
const KNOWN_CODES = [...Object.keys(ERROR_MESSAGES), 'file_missing', 'file_still_exists', 'not_found', 'not_allowed', 'cancelled'];

/**
 * Pull a known error code out of a code string, a VideoError, or any Error —
 * supabase rpc errors carry the code in `.message` (e.g. 'route_not_found'), so
 * look inside the text too. Returns null when nothing matches.
 */
export function videoErrorCode(codeOrError) {
  if (!codeOrError) return null;
  if (typeof codeOrError === 'string') {
    return KNOWN_CODES.find((c) => codeOrError.includes(c)) || null;
  }
  if (typeof codeOrError.code === 'string' && KNOWN_CODES.includes(codeOrError.code)) return codeOrError.code;
  if (typeof codeOrError.message === 'string') {
    return KNOWN_CODES.find((c) => codeOrError.message.includes(c)) || null;
  }
  return null;
}

/** Friendly, plain-English text for a code or an Error. Unknown errors (network,
 *  Storage, tus) all get the generic "check your signal" line. */
export function videoErrorMessage(codeOrError) {
  return ERROR_MESSAGES[videoErrorCode(codeOrError)] || GENERIC_ERROR_MESSAGE;
}

// ─── File type ───────────────────────────────────────────────────────────────

/** 'video/mp4' | 'video/quicktime' | 'video/webm', or null if we can't tell.
 *  `file.type` is trusted when it's one of those; phones and some desktop
 *  browsers leave it empty, so fall back to the extension. */
export function videoMimeType(file) {
  if (file && VIDEO_MIME_TYPES.includes(file.type)) return file.type;
  const ext = ((file && file.name) || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext === 'mp4' || ext === 'm4v') return 'video/mp4';
  if (ext === 'mov') return 'video/quicktime';
  if (ext === 'webm') return 'video/webm';
  return null;
}

// ─── Reading duration / size ─────────────────────────────────────────────────

const METADATA_TIMEOUT_MS = 8000;

// Ask the browser's own decoder. Fast and free, but it can only read what the
// browser can play (desktop Chrome can't decode iPhone HEVC, for instance).
// Resolves null instead of rejecting so the caller can fall back.
function readInfoFromElement(file) {
  return new Promise((resolve) => {
    let url = null;
    let video = null;
    let timer = null;
    let settled = false;

    const finish = (info) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (video) {
        video.onloadedmetadata = null;
        video.onerror = null;
        video.removeAttribute('src');
        video.load(); // lets the browser drop the decoder it started
      }
      if (url) URL.revokeObjectURL(url);
      resolve(info);
    };

    try {
      url = URL.createObjectURL(file);
      video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;
      video.onloadedmetadata = () => finish({
        // Infinity/NaN happens for some webm recordings: treat as unknown.
        durationS: Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null,
        width: video.videoWidth || null,
        height: video.videoHeight || null,
      });
      video.onerror = () => finish(null);
      timer = setTimeout(() => finish(null), METADATA_TIMEOUT_MS);
      video.src = url;
    } catch {
      finish(null);
    }
  });
}

// Parse the container ourselves. Slower to load, but reads files the browser
// can't play. Resolves null when it can't make sense of the file.
async function readInfoFromMediabunny(file) {
  let input = null;
  try {
    const { Input, ALL_FORMATS, BlobSource } = await import('mediabunny');
    input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    const duration = await input.computeDuration();
    return {
      durationS: Number.isFinite(duration) && duration > 0 ? duration : null,
      width: track ? await track.getDisplayWidth() : null,
      height: track ? await track.getDisplayHeight() : null,
    };
  } catch (err) {
    console.warn('[routeVideos] mediabunny could not read the file:', err);
    return null;
  } finally {
    if (input) input.dispose();
  }
}

/**
 * { durationS, width, height } for a picked video. Never throws: a null
 * `durationS` means "unknown" (the caller decides whether to let it through).
 */
export async function readVideoInfo(file) {
  const fromElement = await readInfoFromElement(file);
  if (fromElement && fromElement.durationS !== null) return fromElement;

  const fromLibrary = await readInfoFromMediabunny(file);
  if (fromLibrary && fromLibrary.durationS !== null) return fromLibrary;

  return {
    durationS: null,
    width: fromElement?.width ?? fromLibrary?.width ?? null,
    height: fromElement?.height ?? fromLibrary?.height ?? null,
  };
}

// ─── Shrinking ───────────────────────────────────────────────────────────────

/**
 * Re-encode a video to something small enough to upload over a phone connection:
 * H.264, ~2 Mbps, at most 30 fps, shorter side at most 720 px, in an MP4 with the
 * metadata up front so playback can start before the whole file has downloaded.
 *
 * Resolves { blob, mimeType: 'video/mp4' }. Throws if the file can't be read or
 * has no video the browser can decode (e.g. HEVC on desktop Chrome); the caller
 * (prepareVideo) falls back to the original. If `cancel` was called it throws
 * VideoError('cancelled').
 *
 *  • onProgress(0..1)
 *  • onCancelHandle(fn) is called once the first conversion exists; fn() stops it.
 */
export async function shrinkVideo(file, { onProgress, onCancelHandle } = {}) {
  // Named imports (not the whole namespace) so the bundler can drop what we don't use.
  const {
    Input, ALL_FORMATS, BlobSource, Output, Mp4OutputFormat, BufferTarget, Conversion, Quality,
  } = await import('mediabunny');

  let cancelled = false;
  let current = null; // the Conversion in flight, so cancel reaches whichever attempt is running
  let handedOut = false;
  const cancel = async () => {
    cancelled = true;
    try { await current?.cancel(); } catch { /* already finished */ }
  };

  // Hardware encoding is much faster and kinder to the battery, but some
  // machines (Linux, a few Android phones) can't do it and reject the config.
  // So ask for it first and, if the encode fails, run once more letting the
  // browser pick. Anything that goes wrong BEFORE encoding starts (unreadable
  // file, no video track) is not retried: it would fail the same way.
  for (const hardwareAcceleration of ['prefer-hardware', 'no-preference']) {
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    try {
      const track = await input.getPrimaryVideoTrack();
      if (!track) throw new Error('no video track in this file');

      // width/height in the conversion options are DISPLAY dimensions — after the
      // clip's rotation flag is applied. An iPhone portrait clip is stored as
      // landscape + "rotate 90"; reading display size here means portrait stays
      // portrait, and the output has the rotation baked in (the library re-renders
      // frames whenever it resizes), so it plays upright everywhere. Set ONLY the
      // shorter side: the library derives the other from the aspect ratio and
      // rounds both up to even numbers, which H.264 requires.
      const displayWidth = await track.getDisplayWidth();
      const displayHeight = await track.getDisplayHeight();
      const video = {
        codec: 'avc',
        quality: new Quality({ bitrate: TARGET_BITRATE }),
        hardwareAcceleration,
      };
      if (Math.min(displayWidth, displayHeight) > MAX_SHORT_SIDE) { // never upscale
        if (displayWidth <= displayHeight) video.width = MAX_SHORT_SIDE;
        else video.height = MAX_SHORT_SIDE;
      }
      // Only cap the frame rate, never raise it (a fixed rate would duplicate frames
      // in a 24 fps clip). Sampling the first ~4 s of packets is plenty to tell.
      try {
        const { averagePacketRate } = await track.computePacketStats(120);
        if (averagePacketRate > MAX_FPS + 0.5) video.frameRate = MAX_FPS;
      } catch { /* unknown rate: leave it alone */ }

      const target = new BufferTarget();
      const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
      const conversion = await Conversion.init({
        input,
        output,
        tracks: 'primary', // one video + one audio; ignore extras (depth maps, data tracks)
        video,
        // Audio: no bitrate/quality here on purpose, so AAC is COPIED across with no
        // re-encode. Pinning the codec to AAC means anything else (opus, PCM) is
        // converted to something every phone plays, and if the browser has no AAC
        // encoder (older iPhones) the library drops the audio instead of failing.
        audio: { codec: 'aac' },
        // Start from empty tags instead of inheriting the input's: an iPhone .mov
        // carries the GPS location it was filmed at, and these videos get shared.
        tags: {},
        showWarnings: false,
      });

      if (!conversion.isValid || !conversion.utilizedTracks.some((t) => t.type === 'video')) {
        const why = conversion.discardedTracks.map((d) => `${d.track.type}: ${d.reason}`).join(', ');
        throw new Error(`video can't be converted here (${why || 'no usable tracks'})`);
      }
      const lostAudio = conversion.discardedTracks.find((d) => d.track.type === 'audio' && d.reason !== 'discarded_by_user');
      if (lostAudio) console.warn('[routeVideos] audio dropped while shrinking:', lostAudio.reason);

      current = conversion;
      if (!handedOut) {
        handedOut = true;
        if (onCancelHandle) onCancelHandle(cancel);
      }
      if (cancelled) throw new VideoError('cancelled'); // cancelled while it was being set up

      // Safety net: if encoding stops moving WITHOUT throwing, give up so the caller
      // can fall back to the original, instead of sitting on "Shrinking 12%" forever.
      // Only visible time counts: Safari pauses conversion while the page is hidden
      // and carries on when you come back, and that isn't a stall. It's a race rather
      // than relying on cancel(), because a stuck decoder may never let execute() end.
      let lastProgressAt = Date.now();
      const stalledError = new Error('shrinking stalled');
      let watchdog;
      const stall = new Promise((_, reject) => {
        watchdog = setInterval(() => {
          if (document.visibilityState !== 'visible') { lastProgressAt = Date.now(); return; }
          if (Date.now() - lastProgressAt > STALL_TIMEOUT_MS) {
            conversion.cancel().catch(() => {});
            reject(stalledError);
          }
        }, 2000);
      });

      conversion.onProgress = (p) => {
        lastProgressAt = Date.now();
        if (onProgress && Number.isFinite(p)) onProgress(Math.min(1, Math.max(0, p)));
      };

      try {
        const executing = conversion.execute();
        executing.catch(() => {}); // if the stall wins the race, this may still reject later
        await Promise.race([executing, stall]);
      } catch (err) {
        if (cancelled) throw new VideoError('cancelled');
        if (err === stalledError) throw err; // straight to the fallback: don't wait another 30 s
        if (hardwareAcceleration === 'prefer-hardware') {
          console.warn('[routeVideos] hardware encode failed, retrying without it:', err);
          continue; // `finally` below still disposes this attempt's input
        }
        throw err;
      } finally {
        clearInterval(watchdog);
      }

      if (cancelled) throw new VideoError('cancelled');
      if (!target.buffer) throw new Error('shrinking produced no data');
      return { blob: new Blob([target.buffer], { type: 'video/mp4' }), mimeType: 'video/mp4' };
    } finally {
      input.dispose();
    }
  }
  // Unreachable: the second pass either returns or throws.
  throw new Error('shrinking failed');
}

/**
 * Get a video ready to upload: shrink it, falling back to the original file when
 * shrinking isn't possible or doesn't help. Resolves { blob, mimeType, shrunk }.
 *
 * Throws VideoError 'cancelled' (if the caller cancelled), 'unsupported_type'
 * (not mp4/mov/webm and couldn't be converted) or 'file_too_large' (still over
 * the server's limit after everything above).
 */
export async function prepareVideo(file, { onProgress, onCancelHandle } = {}) {
  let blob = file;
  let mimeType = videoMimeType(file);
  let shrunk = false;

  try {
    const result = await shrinkVideo(file, { onProgress, onCancelHandle });
    // Re-encoding a clip that's already small (or already an efficient mp4) can
    // come out bigger. Then the original is the better upload, as long as it's
    // already the right container.
    if (!(result.blob.size >= file.size && mimeType === 'video/mp4')) {
      blob = result.blob;
      mimeType = result.mimeType;
      shrunk = true;
    }
  } catch (err) {
    if (err instanceof VideoError && err.code === 'cancelled') throw err;
    console.warn('[routeVideos] could not shrink, using the original file:', err);
  }

  if (!mimeType) throw new VideoError('unsupported_type');
  if (blob.size > MAX_VIDEO_BYTES) throw new VideoError('file_too_large');
  return { blob, mimeType, shrunk };
}

// ─── Upload ──────────────────────────────────────────────────────────────────

const UPLOAD_BUCKET = 'route-videos';

/**
 * A resumable (tus) upload of `blob` to `path` in the private bucket. The row
 * for `path` must already exist (create_route_video): the storage policy refuses
 * a path with no row. Returns { start(), abort() }.
 *
 *  • start() resolves when the file has fully arrived and rejects on error. After
 *    a failure it can be called again on the same object: tus resumes from the
 *    same upload URL instead of starting over. (So keep ONE wrapper per file.)
 *  • abort() stops it, deletes the half-uploaded data on the server, and rejects
 *    a pending start() with VideoError('cancelled').
 *  • onProgress(0..1)
 */
export async function createVideoUpload({ blob, path, mimeType, onProgress }) {
  const { Upload } = await import('tus-js-client');

  // The direct storage host is what supports big/resumable uploads reliably.
  const projectRef = new URL(import.meta.env.VITE_SUPABASE_URL).hostname.split('.')[0];

  let pending = null; // { resolve, reject } for the start() currently waiting

  const upload = new Upload(blob, {
    endpoint: `https://${projectRef}.storage.supabase.co/storage/v1/upload/resumable`,
    // Mobile signal drops are normal: back off up to a minute between tries.
    retryDelays: [0, 1000, 3000, 5000, 10000, 20000, 30000, 60000, 60000],
    // We resume by keeping this object alive, not from localStorage, so a stale
    // upload URL from an earlier session can never be picked up.
    storeFingerprintForResuming: false,
    chunkSize: 6 * 1024 * 1024, // Supabase requires exactly 6 MB chunks
    uploadSize: blob.size,
    headers: { apikey: import.meta.env.VITE_SUPABASE_ANON_KEY },
    // A big upload can outlast the access token (~1 h), so read the current
    // session before EVERY request; supabase-js refreshes it when needed.
    onBeforeRequest: async (req) => {
      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token;
      if (token) req.setHeader('authorization', `Bearer ${token}`);
    },
    metadata: { bucketName: UPLOAD_BUCKET, objectName: path, contentType: mimeType, cacheControl: '3600' },
    onProgress: (sent, total) => {
      if (onProgress && total > 0) onProgress(Math.min(1, sent / total));
    },
    onError: (err) => { if (pending) { const p = pending; pending = null; p.reject(err); } },
    onSuccess: () => { if (pending) { const p = pending; pending = null; p.resolve(); } },
  });

  return {
    start() {
      return new Promise((resolve, reject) => {
        pending = { resolve, reject };
        upload.start();
      });
    },
    async abort() {
      const waiting = pending;
      pending = null;
      // abort() stops the request straight away; the promise it returns is the
      // server-side delete of the half-finished upload.
      const terminated = upload.abort(true);
      // tus fires no callback on abort, so settle the waiting start() ourselves.
      if (waiting) waiting.reject(new VideoError('cancelled'));
      try {
        await terminated;
      } catch (err) {
        // Not fatal: an unfinished upload expires on its own after 24 h.
        console.warn('[routeVideos] could not discard the partial upload:', err);
      }
    },
  };
}
