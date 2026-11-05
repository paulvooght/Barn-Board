import { createPortal } from 'react-dom';

const ACTIVE_STAGES = ['waiting', 'shrinking', 'uploading', 'finishing'];

/**
 * VideoUploadPill — the small floating status card for route-video uploads.
 *
 * Rendered once at the app root (the upload queue belongs to the app, not to a
 * route page), so it follows the climber around while a video shrinks and
 * uploads in the background. It is portalled to <body> and marked data-no-swipe
 * so a touch on it can't start the route carousel swipe.
 *
 * Shows ONE job — a failed one first (it needs the climber), then an active one,
 * then a finished one — with "+n more" when others are queued.
 *
 * Props:
 *   jobs                                   – from useVideoUploads
 *   onRetry(jobId), onCancel(jobId), onDismiss(jobId)
 */
export default function VideoUploadPill({ jobs, onRetry, onCancel, onDismiss }) {
  if (!jobs || jobs.length === 0) return null;

  const job =
    jobs.find((j) => j.stage === 'failed') ||
    jobs.find((j) => ACTIVE_STAGES.includes(j.stage)) ||
    jobs[0];
  const others = jobs.length - 1;
  const pct = Math.round((Number.isFinite(job.progress) ? job.progress : 0) * 100);
  const isActive = ACTIVE_STAGES.includes(job.stage);
  const isFailed = job.stage === 'failed';
  const isDone = job.stage === 'done';

  let text;
  if (job.stage === 'waiting') text = 'Video waiting…';
  else if (job.stage === 'shrinking') text = `Shrinking video ${pct}%`;
  else if (job.stage === 'uploading') text = `Uploading video ${pct}%`;
  else if (job.stage === 'finishing') text = 'Finishing…';
  else if (isDone) text = 'Video uploaded. Only you and admins can see it for now.';
  else text = job.error || 'Upload failed. Check your signal and try again.';

  return createPortal(
    <div
      data-no-swipe
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'fixed', left: '50%', transform: 'translateX(-50%)',
        bottom: 'calc(env(safe-area-inset-bottom) + 84px)',
        width: 'calc(100% - 24px)', maxWidth: '440px', boxSizing: 'border-box',
        zIndex: 900, padding: '10px 12px', borderRadius: '12px',
        background: '#fff', color: '#1A0A00',
        border: isFailed ? '1.5px solid rgba(231,76,60,0.5)' : '1px solid var(--border)',
        boxShadow: '0 4px 18px rgba(26,10,0,0.22)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            role="status"
            aria-live="polite"
            style={{ fontSize: '13px', fontWeight: 700, lineHeight: 1.3, color: isFailed ? '#c0392b' : '#1A0A00' }}
          >
            {text}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {job.routeName || 'Route'}
            {others > 0 && ` · +${others} more`}
          </div>
        </div>

        {isActive && (
          <button type="button" onClick={() => onCancel(job.jobId)} style={cancelBtn}>Cancel</button>
        )}
        {isFailed && (
          <>
            <button type="button" onClick={() => onRetry(job.jobId)} style={retryBtn}>Retry</button>
            <button type="button" onClick={() => onCancel(job.jobId)} style={cancelBtn}>Cancel</button>
          </>
        )}
        {isDone && (
          <button type="button" onClick={() => onDismiss(job.jobId)} aria-label="Dismiss" style={{ ...cancelBtn, padding: 0, width: '44px' }}>
            ✕
          </button>
        )}
      </div>

      {isActive && (
        <>
          <div style={{ height: '4px', borderRadius: '2px', background: 'rgba(26,10,0,0.1)', marginTop: '8px', overflow: 'hidden' }}>
            <div style={{
              height: '100%', width: `${pct}%`, background: 'var(--accent)',
              borderRadius: '2px', transition: 'width 0.2s ease-out',
            }} />
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
            Keep the app open until this finishes.
          </div>
        </>
      )}
    </div>,
    document.body
  );
}

const btnBase = {
  minHeight: '44px', padding: '0 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
  cursor: 'pointer', flexShrink: 0,
};
const cancelBtn = { ...btnBase, border: '1px solid rgba(26,10,0,0.15)', background: 'rgba(26,10,0,0.06)', color: 'var(--text-secondary)' };
const retryBtn = { ...btnBase, border: 'none', background: 'var(--accent)', color: '#fff' };
