import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import * as db from '../lib/db';
import { videoErrorCode, clampBoardAngle } from '../utils/routeVideos';
import AddVideoButton, { AngleSlider } from './AddVideoButton';

const ACTIVE_STAGES = ['waiting', 'shrinking', 'uploading', 'finishing'];

/**
 * RouteVideos — collapsible "Videos (n)" dropdown for one route.
 *
 * Loading, failed and empty are three DIFFERENT states here:
 *   videos === null && !loadFailed  → first load in progress
 *   videos === null &&  loadFailed  → first load failed (never shown as "no videos")
 *   videos !== null                 → we have a list (possibly empty); a later refetch
 *                                     failure keeps it and only adds a small Retry
 * Nothing in this file writes or deletes based on a list it could not load.
 *
 * Props:
 *   routeId, routeName
 *   currentUserId        – the signed-in user
 *   isVideoAdmin         – admin of this wall AND in admin mode (NOT the global comment-moderation flag)
 *   profilesById         – { [user_id]: { display_name } }
 *   jobs, lastFinished   – from useVideoUploads (this component only reads them)
 *   defaultAngle         – where the angle sliders start (the live session's angle, else the route's);
 *                          used for the Add-video pop-up and for "Add angle" on a video with none
 *   onAddVideo({ file, durationS, angle })
 *   embedded             – drop the outer padding when it sits inside the route form
 */
export default function RouteVideos({
  routeId,
  routeName,
  currentUserId,
  isVideoAdmin,
  profilesById,
  jobs,
  lastFinished,
  onAddVideo,
  defaultAngle,
  embedded = false,
}) {
  const [expanded, setExpanded] = useState(false);
  const [videos, setVideos] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [urls, setUrls] = useState({});           // storage_path → signed URL
  const [urlFailed, setUrlFailed] = useState({}); // storage_path → true when no URL came back
  const reqRef = useRef(0);                       // newest fetch wins; older replies are dropped
  const aliveRef = useRef(true);
  const inflightRef = useRef(new Set());          // paths whose URL is being fetched right now

  const load = useCallback(async () => {
    const mine = ++reqRef.current;
    let data = null;
    let error = null;
    try {
      ({ data, error } = await db.fetchRouteVideos(routeId));
    } catch (err) {
      error = err;
    }
    if (mine !== reqRef.current) return; // a newer fetch started, or we unmounted
    if (error || !Array.isArray(data)) {
      console.error('[RouteVideos] could not load videos:', error);
      setLoadFailed(true);
      return;
    }
    setVideos(data);
    setLoadFailed(false);
  }, [routeId]);

  // First load (and a clean slate if the same instance is pointed at another route).
  useEffect(() => {
    aliveRef.current = true;
    setVideos(null);
    setLoadFailed(false);
    setUrls({});
    setUrlFailed({});
    inflightRef.current = new Set();
    load();
    return () => { aliveRef.current = false; reqRef.current++; };
  }, [routeId, load]);

  // This route's own upload just landed: fetch again so it shows up. A finish that
  // happened before we mounted is already covered by the first load above.
  const handledFinishRef = useRef(lastFinished?.at ?? null);
  useEffect(() => {
    if (!lastFinished || lastFinished.routeId !== routeId) return;
    if (lastFinished.at === handledFinishRef.current) return;
    handledFinishRef.current = lastFinished.at;
    load();
  }, [lastFinished, routeId, load]);

  // The server already returns every video to wall admins, and only public + own
  // to everyone else. This filter only keeps Climber mode looking like what a
  // normal climber sees; it is NOT the security boundary.
  const visible = useMemo(() => {
    if (videos === null) return null;
    return isVideoAdmin ? videos : videos.filter((v) => v.is_public || v.user_id === currentUserId);
  }, [videos, isVideoAdmin, currentUserId]);

  // Signed links only while the dropdown is open, and only for paths we don't have.
  const fetchUrls = useCallback(async (paths) => {
    paths.forEach((p) => inflightRef.current.add(p));
    let got = {};
    try {
      ({ urls: got } = await db.getRouteVideoUrls(paths));
    } catch (err) {
      console.error('[RouteVideos] could not get video links:', err);
    }
    paths.forEach((p) => inflightRef.current.delete(p));
    if (!aliveRef.current) return;
    setUrls((prev) => ({ ...prev, ...got }));
    setUrlFailed((prev) => {
      const next = { ...prev };
      paths.forEach((p) => { if (got[p]) delete next[p]; else next[p] = true; });
      return next;
    });
  }, []);

  useEffect(() => {
    if (!expanded || !visible) return;
    const missing = visible
      .map((v) => v.storage_path)
      .filter((p) => !urls[p] && !urlFailed[p] && !inflightRef.current.has(p));
    if (missing.length > 0) fetchUrls(missing);
  }, [expanded, visible, urls, urlFailed, fetchUrls]);

  // One fresh link for one video (links expire after an hour). Resolves the URL or null.
  const refreshUrl = useCallback(async (path) => {
    let got = {};
    try {
      ({ urls: got } = await db.getRouteVideoUrls([path]));
    } catch (err) {
      console.error('[RouteVideos] could not refresh video link:', err);
    }
    if (!aliveRef.current) return null;
    if (got[path]) {
      setUrls((prev) => ({ ...prev, [path]: got[path] }));
      setUrlFailed((prev) => { const next = { ...prev }; delete next[path]; return next; });
      return got[path];
    }
    setUrlFailed((prev) => ({ ...prev, [path]: true }));
    return null;
  }, []);

  // All three writes wait for the server before touching the list (no optimistic update).
  const handleDelete = useCallback(async (video) => {
    const { error } = await db.deleteRouteVideo(video);
    if (!error) {
      setVideos((prev) => (prev ? prev.filter((v) => v.id !== video.id) : prev));
      return { error: null };
    }
    // Already gone (deleted elsewhere): just look again instead of reporting a failure.
    if (videoErrorCode(error) === 'not_found') { load(); return { error: null }; }
    return { error };
  }, [load]);

  const handleSetPublic = useCallback(async (video, makePublic) => {
    const { video: returned, error } = await db.setRouteVideoPublic(video.id, makePublic);
    if (error) return { error };
    const row = Array.isArray(returned) ? returned[0] : returned;
    if (row && row.id === video.id) {
      setVideos((prev) => (prev ? prev.map((v) => (v.id === row.id ? { ...v, ...row } : v)) : prev));
    } else {
      load(); // the reply wasn't the row we expected: don't guess, look again
    }
    return { error: null };
  }, [load]);

  const handleSetAngle = useCallback(async (video, angle) => {
    const { video: returned, error } = await db.setRouteVideoAngle(video.id, angle);
    if (error) return { error };
    const row = Array.isArray(returned) ? returned[0] : returned;
    if (row && row.id === video.id) {
      setVideos((prev) => (prev ? prev.map((v) => (v.id === row.id ? { ...v, ...row } : v)) : prev));
    } else {
      load(); // the reply wasn't the row we expected: don't guess, look again
    }
    return { error: null };
  }, [load]);

  const retryLoad = () => { setLoadFailed(false); load(); };

  const handleAdd = ({ file, durationS, angle }) => {
    setExpanded(true);
    onAddVideo({ file, durationS, angle });
  };

  const uploading = (jobs || []).some((j) => j.routeId === routeId && ACTIVE_STAGES.includes(j.stage));
  const countText = visible ? ` (${visible.length})` : '';

  return (
    <div data-no-swipe style={{ padding: embedded ? 0 : '8px 12px 8px' }}>
      <div style={{ display: 'flex', alignItems: 'stretch', gap: '8px' }}>
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
          style={{
            display: 'flex', alignItems: 'center', gap: '6px', flex: 1, minWidth: 0,
            minHeight: '44px', padding: '7px 12px', borderRadius: '8px',
            border: '1.5px solid rgba(26,10,0,0.6)', background: '#FFAB94',
            color: expanded ? '#0047FF' : 'rgba(26,10,0,0.6)',
            fontSize: '12px', fontWeight: 700, cursor: 'pointer', textAlign: 'left',
          }}
        >
          <span>{expanded ? '▾' : '▸'}</span>
          <span>Videos{countText}</span>
        </button>
        <AddVideoButton onConsented={handleAdd} defaultAngle={defaultAngle} />
      </div>

      {expanded && (
        <div style={{
          marginTop: '10px', padding: '10px', borderRadius: '10px',
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          boxShadow: '0 2px 8px rgba(26,10,0,0.06)',
        }}>
          {visible === null && !loadFailed && (
            <div style={quietStyle}>Loading videos…</div>
          )}
          {visible === null && loadFailed && (
            <div style={{ ...quietStyle, display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              <span>Couldn't load videos.</span>
              <button type="button" onClick={retryLoad} style={smallBtn}>Retry</button>
            </div>
          )}
          {visible !== null && loadFailed && (
            <div style={{ ...quietStyle, display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', paddingTop: 0 }}>
              <span>Couldn't refresh.</span>
              <button type="button" onClick={retryLoad} style={smallBtn}>Retry</button>
            </div>
          )}

          {uploading && <div style={quietStyle}>Your video is uploading…</div>}

          {visible !== null && visible.length === 0 && !uploading && (
            <div style={{ ...quietStyle, fontStyle: 'italic' }}>No videos yet. Add the first one.</div>
          )}

          {visible !== null && visible.map((v) => (
            <VideoItem
              key={v.id}
              video={v}
              url={urls[v.storage_path] || null}
              linkFailed={!!urlFailed[v.storage_path]}
              label={routeName ? `Video on ${routeName}` : 'Route video'}
              isMine={v.user_id === currentUserId}
              uploader={
                v.user_id === currentUserId
                  ? 'You'
                  : (profilesById && profilesById[v.user_id]?.display_name) || 'Climber'
              }
              isVideoAdmin={isVideoAdmin}
              defaultAngle={defaultAngle}
              onRefreshUrl={refreshUrl}
              onDelete={handleDelete}
              onSetPublic={handleSetPublic}
              onSetAngle={handleSetAngle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// One video: player, who/when/angle/visibility, and the delete / publish / angle controls.
function VideoItem({
  video, url, linkFailed, label, isMine, uploader, isVideoAdmin, defaultAngle,
  onRefreshUrl, onDelete, onSetPublic, onSetAngle,
}) {
  const [playFailed, setPlayFailed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(null); // null | 'delete' | 'visibility' | 'angle' | 'link'
  const [editingAngle, setEditingAngle] = useState(false);
  const [angleDraft, setAngleDraft] = useState(30); // the slider while editingAngle
  const [error, setError] = useState('');
  const triedRefreshRef = useRef(false); // links expire after an hour: one automatic fresh link per failure

  const canDelete = isMine || isVideoAdmin;

  const handleVideoError = async () => {
    if (playFailed || busy === 'link') return;
    if (triedRefreshRef.current) { setPlayFailed(true); return; }
    triedRefreshRef.current = true;
    setBusy('link');
    const fresh = await onRefreshUrl(video.storage_path);
    setBusy(null);
    if (!fresh) setPlayFailed(true); // otherwise the new src makes the player reload by itself
  };

  const retryPlay = async () => {
    setBusy('link');
    const fresh = await onRefreshUrl(video.storage_path);
    setBusy(null);
    triedRefreshRef.current = true; // if this link fails too, stop and say so
    if (fresh) setPlayFailed(false);
  };

  const doDelete = async () => {
    setBusy('delete');
    setError('');
    const { error: err } = await onDelete(video);
    setBusy(null);
    if (err) {
      setConfirming(false);
      setError(actionErrorText(err, "Couldn't delete this video. Check your signal and try again."));
    }
    // On success the parent drops this item, so there is nothing more to do here.
  };

  const doSetPublic = async () => {
    setBusy('visibility');
    setError('');
    const { error: err } = await onSetPublic(video, !video.is_public);
    setBusy(null);
    if (err) setError(actionErrorText(err, "Couldn't change who can see this video. Try again."));
  };

  const openAngleEditor = () => {
    setError('');
    setAngleDraft(Number.isFinite(video.angle) ? clampBoardAngle(video.angle) : clampBoardAngle(defaultAngle));
    setEditingAngle(true);
  };

  const doSaveAngle = async () => {
    setBusy('angle');
    setError('');
    const { error: err } = await onSetAngle(video, angleDraft);
    setBusy(null);
    if (err) setError(actionErrorText(err, "Couldn't save the angle. Check your signal and try again."));
    else setEditingAngle(false);
  };

  const badge = video.is_public
    ? { text: 'Public', bg: 'rgba(34,168,112,0.16)', color: '#14724b' }
    : { text: isMine ? 'Only you and admins' : 'Private', bg: 'rgba(255,171,0,0.22)', color: '#8a5a00' };

  return (
    <div style={{ marginBottom: '16px' }}>
      {linkFailed && !url ? (
        <div style={playerBox}>
          <span>Couldn't load this video.</span>
          <button type="button" onClick={retryPlay} disabled={busy === 'link'} style={retryBtnOnDark}>
            {busy === 'link' ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      ) : !url ? (
        <div style={playerBox}><span>Loading video…</span></div>
      ) : playFailed ? (
        <div style={playerBox}>
          <span>Couldn't play this video on this device.</span>
          <button type="button" onClick={retryPlay} disabled={busy === 'link'} style={retryBtnOnDark}>
            {busy === 'link' ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      ) : (
        <video
          key={video.id}
          src={`${url}#t=0.001`}
          controls
          playsInline
          preload="metadata"
          aria-label={label}
          onError={handleVideoError}
          onLoadedMetadata={() => { triedRefreshRef.current = false; }}
          style={{ width: '100%', maxHeight: '60vh', background: '#000', borderRadius: 8, display: 'block' }}
        />
      )}

      <div style={{
        display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
        marginTop: '6px', fontSize: '12px', color: 'var(--text-secondary)',
      }}>
        <span style={{ fontWeight: 700 }}>{uploader}</span>
        <span style={{ color: 'var(--text-muted)' }}>{shortDate(video.created_at)}</span>
        {video.angle != null && (
          <span style={{ fontFamily: 'var(--font-heading)', fontSize: '12px', fontWeight: 800, color: 'var(--accent)' }}>
            {video.angle}°
          </span>
        )}
        <span style={{
          padding: '2px 8px', borderRadius: '8px', fontSize: '10px', fontWeight: 700,
          background: badge.bg, color: badge.color,
        }}>{badge.text}</span>
      </div>

      {canDelete && editingAngle && (
        <div style={{ marginTop: '8px' }}>
          <AngleSlider value={angleDraft} onChange={setAngleDraft} />
          <div style={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
            <button
              type="button" onClick={doSaveAngle} disabled={busy === 'angle'}
              style={{ ...ctrlBtn, flex: 2, border: 'none', background: 'var(--accent)', color: '#fff' }}
            >
              {busy === 'angle' ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button" onClick={() => { setError(''); setEditingAngle(false); }} disabled={busy === 'angle'}
              style={{ ...ctrlBtn, flex: 1, border: '1px solid rgba(26,10,0,0.15)', background: 'rgba(26,10,0,0.06)', color: 'var(--text-secondary)' }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {canDelete && !editingAngle && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginTop: '8px' }}>
          {confirming ? (
            <>
              <span style={{ fontSize: '12px', fontWeight: 600, color: '#1A0A00' }}>
                Delete this video permanently?
              </span>
              <button
                type="button" onClick={doDelete} disabled={busy === 'delete'}
                style={{ ...ctrlBtn, border: 'none', background: '#FF5252', color: '#fff' }}
              >
                {busy === 'delete' ? 'Deleting…' : 'Delete'}
              </button>
              <button
                type="button" onClick={() => setConfirming(false)} disabled={busy === 'delete'}
                style={{ ...ctrlBtn, border: '1px solid rgba(26,10,0,0.15)', background: 'rgba(26,10,0,0.06)', color: 'var(--text-secondary)' }}
              >
                Keep
              </button>
            </>
          ) : (
            <>
              {isVideoAdmin && (
                <button
                  type="button" onClick={doSetPublic} disabled={busy !== null}
                  style={{ ...ctrlBtn, border: '1.5px solid var(--accent)', background: 'var(--accent-dim)', color: 'var(--accent)' }}
                >
                  {busy === 'visibility' ? 'Saving…' : video.is_public ? 'Make private' : 'Make public'}
                </button>
              )}
              {canDelete && (
                <button
                  type="button" onClick={openAngleEditor} disabled={busy !== null}
                  style={{ ...ctrlBtn, border: '1.5px solid var(--accent)', background: 'var(--accent-dim)', color: 'var(--accent)' }}
                >
                  {video.angle == null ? 'Add angle' : 'Change angle'}
                </button>
              )}
              {canDelete && (
                <button
                  type="button" onClick={() => { setError(''); setConfirming(true); }} disabled={busy !== null}
                  style={{ ...ctrlBtn, marginLeft: 'auto', border: '1px solid rgba(255,82,82,0.3)', background: 'rgba(255,82,82,0.06)', color: '#FF5252' }}
                >
                  Delete
                </button>
              )}
            </>
          )}
        </div>
      )}

      {error && <div style={{ fontSize: '11px', color: '#e74c3c', marginTop: '6px' }}>{error}</div>}
    </div>
  );
}

function actionErrorText(error, fallback) {
  return videoErrorCode(error) === 'not_allowed' ? "You aren't allowed to do that." : fallback;
}

function shortDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, {
    day: 'numeric', month: 'short',
    year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  });
}

const quietStyle = { fontSize: '12px', color: 'rgba(26,10,0,0.5)', padding: '8px 0' };

const smallBtn = {
  minHeight: '44px', padding: '0 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
  cursor: 'pointer', border: '1.5px solid var(--accent)', background: 'var(--accent-dim)', color: 'var(--accent)',
};

const ctrlBtn = {
  minHeight: '44px', padding: '0 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
};

// Same footprint as a 16:9 player, so the list doesn't jump when the link arrives.
const playerBox = {
  width: '100%', aspectRatio: '16 / 9', maxHeight: '60vh', borderRadius: '8px', background: '#000',
  color: 'rgba(255,255,255,0.8)', fontSize: '12px', display: 'flex', flexDirection: 'column',
  alignItems: 'center', justifyContent: 'center', gap: '10px', padding: '12px', textAlign: 'center',
  boxSizing: 'border-box',
};

const retryBtnOnDark = {
  minHeight: '44px', padding: '0 18px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
  cursor: 'pointer', border: '1px solid rgba(255,255,255,0.5)', background: 'transparent', color: '#fff',
};
