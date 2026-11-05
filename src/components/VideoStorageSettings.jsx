import { useState, useEffect, useCallback, useRef } from 'react';
import * as db from '../lib/db';

const BYTES_PER_MB = 1024 * 1024;

// 12.0 → "12", 3.46 → "3.5": short numbers for a small gauge.
function mb(bytes) {
  const n = (Number(bytes) || 0) / BYTES_PER_MB;
  return n >= 10 ? String(Math.round(n)) : String(Number(n.toFixed(1)));
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * VideoStorageSettings — admin-only "Video storage" dropdown for Settings.
 * Shows how much of the video storage cap is used and offers a clean-up of
 * leftovers (videos whose route was deleted, and uploads that never finished).
 *
 * Nothing is fetched until the dropdown is opened. A failed fetch is shown as a
 * failure, never as "0 used" / "nothing to clean up", and the clean-up button only
 * exists when the leftover list was actually read.
 *
 * Props:
 *   boardId – the active wall
 */
export default function VideoStorageSettings({ boardId }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [usage, setUsage] = useState(null);           // { used_bytes, cap_bytes, video_count } | null
  const [usageFailed, setUsageFailed] = useState(false);
  const [orphans, setOrphans] = useState(null);       // array | null (null = not read)
  const [orphansFailed, setOrphansFailed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [cleaning, setCleaning] = useState(null);     // { done, total } while running
  const [result, setResult] = useState(null);         // { removed, failed } after a clean-up
  const reqRef = useRef(0);                           // newest fetch wins

  const loadAll = useCallback(async () => {
    const mine = ++reqRef.current;
    setLoading(true);
    const [u, o] = await Promise.all([
      db.fetchRouteVideosUsage(),
      boardId ? db.fetchOrphanRouteVideos(boardId) : Promise.resolve({ videos: null, error: new Error('no active wall') }),
    ]);
    if (mine !== reqRef.current) return;
    setUsage(u.usage);
    setUsageFailed(!!u.error || !u.usage);
    setOrphans(Array.isArray(o.videos) ? o.videos : null);
    setOrphansFailed(!Array.isArray(o.videos));
    setLoading(false);
  }, [boardId]);

  useEffect(() => {
    if (!open) return undefined;
    loadAll();
    return () => { reqRef.current++; };
  }, [open, loadAll]);

  const toggle = () => {
    if (!open) { setResult(null); setConfirming(false); }
    setOpen((o) => !o);
  };

  const runCleanup = async () => {
    if (!Array.isArray(orphans) || orphans.length === 0 || cleaning) return;
    const list = orphans.slice();
    setConfirming(false);
    setResult(null);
    let removed = 0;
    let failed = 0;
    for (let i = 0; i < list.length; i++) {
      setCleaning({ done: i, total: list.length });
      const { error } = await db.deleteRouteVideo(list[i]); // one at a time, on purpose
      if (error) failed++; else removed++;
    }
    setCleaning(null);
    setResult({ removed, failed });
    loadAll();
  };

  const used = usage ? Number(usage.used_bytes) || 0 : 0;
  const cap = usage ? Number(usage.cap_bytes) || 0 : 0;
  const fraction = cap > 0 ? Math.min(1, used / cap) : 0;
  const orphanCount = Array.isArray(orphans) ? orphans.length : 0;

  return (
    <div>
      <button type="button" onClick={toggle} aria-expanded={open} style={dropHeaderStyle(open)}>
        <span style={dropTitleStyle}>Video storage</span>
        <span style={{ fontSize: '12px', color: 'var(--text-dim)' }}>{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div style={dropBodyStyle}>
          {/* Usage gauge */}
          {usageFailed ? (
            <div style={{ ...quiet, display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              <span style={{ color: '#e74c3c' }}>Couldn't check video storage.</span>
              <button type="button" onClick={loadAll} disabled={loading} style={smallBtn}>Retry</button>
            </div>
          ) : !usage ? (
            <div style={quiet}>Loading…</div>
          ) : (
            <>
              <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
                {mb(used)} MB of {mb(cap)} MB used · {plural(Number(usage.video_count) || 0, 'video', 'videos')}
              </div>
              <div style={{ height: '8px', borderRadius: '4px', background: 'rgba(26,10,0,0.1)', marginTop: '8px', overflow: 'hidden' }}>
                <div style={{
                  height: '100%', width: `${fraction * 100}%`, borderRadius: '4px',
                  background: fraction >= 0.9 ? '#FF5252' : 'var(--accent)',
                }} />
              </div>
            </>
          )}

          {/* Leftovers */}
          <div style={{ marginTop: '16px', paddingTop: '14px', borderTop: '1px solid rgba(26,10,0,0.08)' }}>
            {cleaning ? (
              <div style={quiet}>Removing… {cleaning.done + 1} of {cleaning.total}</div>
            ) : loading || (orphans === null && !orphansFailed) ? (
              <div style={quiet}>Checking for leftovers…</div>
            ) : orphansFailed ? (
              <div style={{ ...quiet, display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                <span style={{ color: '#e74c3c' }}>Couldn't check for leftovers.</span>
                <button type="button" onClick={loadAll} disabled={loading} style={smallBtn}>Retry</button>
              </div>
            ) : orphans.length === 0 ? (
              <div style={quiet}>Nothing to clean up.</div>
            ) : (
              <>
                <div style={{ fontSize: '13px', color: 'var(--text-primary)', marginBottom: '10px' }}>
                  {plural(orphanCount, 'video', 'videos')} left over from deleted routes or unfinished uploads.
                </div>
                {confirming ? (
                  <div>
                    <div style={{ fontSize: '12px', fontWeight: 600, color: '#1A0A00', marginBottom: '8px' }}>
                      These are deleted permanently.
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button type="button" onClick={runCleanup} style={{ ...btn, border: 'none', background: '#FF5252', color: '#fff', flex: 1 }}>
                        Delete {orphanCount}
                      </button>
                      <button type="button" onClick={() => setConfirming(false)} style={{ ...btn, border: '1px solid rgba(26,10,0,0.15)', background: 'rgba(26,10,0,0.06)', color: 'var(--text-secondary)', flex: 1 }}>
                        Keep
                      </button>
                    </div>
                  </div>
                ) : (
                  <button type="button" onClick={() => setConfirming(true)} style={{ ...btn, border: 'none', background: 'var(--accent)', color: '#fff', width: '100%' }}>
                    Clean up {plural(orphanCount, 'video', 'videos')}
                  </button>
                )}
              </>
            )}

            {result && !cleaning && (
              <div style={{ fontSize: '12px', marginTop: '10px', color: result.failed > 0 ? '#e74c3c' : 'var(--text-secondary)' }}>
                {result.removed} removed, {result.failed} failed
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Dropdown chrome — same attached-box look as Settings.jsx / WallsSettings
// (header and body read as one box). Kept as local copies; Settings imports this file.
const dropHeaderStyle = (open) => ({
  width: '100%', padding: '14px 16px',
  borderRadius: open ? '12px 12px 0 0' : '12px',
  border: '1px solid var(--border)', borderBottom: open ? 'none' : '1px solid var(--border)',
  background: 'var(--bg-card)', boxShadow: '0 2px 8px rgba(26,10,0,0.06)',
  cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
});
const dropBodyStyle = {
  background: 'var(--bg-card)', padding: '16px',
  border: '1px solid var(--border)', borderTop: '1px solid rgba(26,10,0,0.08)',
  borderRadius: '0 0 12px 12px', boxShadow: '0 2px 8px rgba(26,10,0,0.06)',
};
const dropTitleStyle = {
  fontSize: '11px', fontWeight: 800, color: 'var(--accent)',
  letterSpacing: '1.5px', textTransform: 'uppercase', display: 'flex', alignItems: 'center',
};

const quiet = { fontSize: '12px', color: 'var(--text-dim)' };

const btn = {
  minHeight: '44px', padding: '0 14px', borderRadius: '10px', fontSize: '13px', fontWeight: 700, cursor: 'pointer',
};
const smallBtn = {
  minHeight: '44px', padding: '0 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
  cursor: 'pointer', border: '1.5px solid var(--accent)', background: 'var(--accent-dim)', color: 'var(--accent)',
};
