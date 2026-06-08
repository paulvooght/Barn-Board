import { useState } from 'react';
import { makePeriod } from '../utils/sessionStats';

const V_GRADES = ['VB','V0-','V0','V0+','V1','V2','V3','V4','V5','V6','V7','V8','V9','V10','V11','V12','V13','V14','V15'];
const FONT_GRADES = ['3','3+','4','4+','5','5+','6A','6A+','6B','6B+','6C','6C+','7A','7A+','7B','7B+','7C','7C+','8A','8A+','8B','8B+','8C'];

/**
 * SessionHistoryAccordion — collapsible list of past sessions (most recent first).
 * Tapping a row calls onSelectSession(sessionId).
 *
 * Props:
 *   sessions      — all sessions array
 *   routes        — all routes array
 *   gradeSystem   — 'V' | 'font'
 *   onSelectSession — (sessionId) => void
 *   selectedSessionId — currently selected session id (highlights the row)
 */
export default function SessionHistoryAccordion({
  sessions,
  routes,
  gradeSystem,
  onSelectSession,
  selectedSessionId,
  // When set (cross-board "All Boards" view), returns a wall name for a session's
  // boardId so each row shows which wall it happened on.
  boardNameFor,
}) {
  const [open, setOpen] = useState(false);

  const safeSessions = sessions || [];
  const safeRoutes   = routes   || [];
  const gradeList    = gradeSystem === 'font' ? FONT_GRADES : V_GRADES;

  const sorted = [...safeSessions].sort(
    (a, b) => new Date(b.startTime) - new Date(a.startTime)
  );
  const displayed = sorted.slice(0, 20);

  const cardStyle = {
    background: 'var(--bg-card)',
    borderRadius: '12px',
    border: '1px solid var(--border)',
    marginBottom: '12px',
    overflow: 'hidden',
  };

  const headerStyle = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 16px',
    cursor: 'pointer',
    userSelect: 'none',
    WebkitUserSelect: 'none',
  };

  const titleStyle = {
    fontSize: '11px',
    fontWeight: 700,
    color: 'var(--text-muted)',
    letterSpacing: '1px',
    textTransform: 'uppercase',
  };

  const chevronStyle = {
    fontSize: '12px',
    color: 'var(--text-muted)',
    transition: 'transform 0.15s',
    transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
  };

  return (
    <div style={cardStyle}>
      {/* Header */}
      <div style={headerStyle} onClick={() => setOpen(o => !o)}>
        <span style={titleStyle}>Session History</span>
        <span style={chevronStyle}>▾</span>
      </div>

      {open && (
        <div style={{ padding: '0 12px 12px' }}>
          {safeSessions.length === 0 ? (
            <p style={{
              fontSize: '12px', color: 'var(--text-dim)',
              fontStyle: 'italic', margin: '4px 0 0', textAlign: 'center',
            }}>
              No sessions yet.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {displayed.map(s => {
                const start    = new Date(s.startTime);
                const duration = s.endTime ? new Date(s.endTime) - start : 0;
                const h        = Math.floor(duration / 3600000);
                const m        = Math.floor((duration % 3600000) / 60000);
                const durationStr = duration === 0 ? '—' : h > 0 ? `${h}h ${m}m` : `${m}m`;
                const sentCount   = (s.routesSent || []).length;
                const anglesClimbed = s.anglesClimbed || [];

                // Hardest grade sent
                const sentRoutes = safeRoutes.filter(r => (s.routesSent || []).includes(r.id));
                const hardest = sentRoutes.length > 0
                  ? sentRoutes.reduce((best, r) =>
                      gradeList.indexOf(r.grade) > gradeList.indexOf(best.grade) ? r : best
                    )
                  : null;

                const isSelected = s.id === selectedSessionId;

                return (
                  <button
                    key={s.id}
                    onClick={() => onSelectSession && onSelectSession(s.id)}
                    style={{
                      width: '100%', textAlign: 'left',
                      display: 'flex', alignItems: 'center', gap: '10px',
                      padding: '10px 12px', borderRadius: '10px',
                      border: isSelected
                        ? '1.5px solid rgba(0,71,255,0.35)'
                        : '1px solid rgba(26,10,0,0.08)',
                      background: isSelected
                        ? 'rgba(0,71,255,0.05)'
                        : 'rgba(255,255,255,0.5)',
                      cursor: 'pointer',
                    }}
                  >
                    {/* Date */}
                    <div style={{ minWidth: '52px' }}>
                      <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>
                        {start.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                      </div>
                      <div style={{
                        fontSize: '9px', color: 'var(--text-dim)',
                        fontFamily: 'var(--font-heading)',
                      }}>
                        {start.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </div>

                    {/* Duration */}
                    <div style={{
                      fontSize: '14px', fontWeight: 800,
                      fontFamily: 'var(--font-heading)',
                      color: '#B85A48', minWidth: '44px',
                    }}>
                      {durationStr}
                    </div>

                    {/* Stats */}
                    <div style={{
                      flex: 1, display: 'flex', gap: '6px',
                      flexWrap: 'wrap', alignItems: 'center',
                    }}>
                      {sentCount > 0 && (
                        <span style={{
                          fontSize: '10px', fontWeight: 700, color: '#B85A48',
                          background: 'rgba(212,112,90,0.15)',
                          padding: '2px 7px', borderRadius: '6px',
                        }}>
                          {sentCount} sent
                        </span>
                      )}
                      {hardest && (
                        <span style={{
                          fontSize: '10px', fontWeight: 800,
                          fontFamily: 'var(--font-heading)',
                          color: 'var(--text-primary)',
                          background: 'var(--yellow)',
                          padding: '2px 7px', borderRadius: '6px',
                        }}>
                          {hardest.grade}
                        </span>
                      )}
                      {anglesClimbed.length > 0 && (
                        <span style={{
                          fontSize: '9px', fontWeight: 600,
                          color: 'var(--text-dim)',
                        }}>
                          {anglesClimbed.map(a => `${a}°`).join(', ')}
                        </span>
                      )}
                      {boardNameFor && (
                        <span style={{
                          fontSize: '9px', fontWeight: 800, letterSpacing: '0.3px',
                          color: 'var(--accent)', background: 'var(--accent-dim)',
                          padding: '2px 7px', borderRadius: '6px', marginLeft: 'auto',
                        }}>
                          {boardNameFor(s.boardId)}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}

              {safeSessions.length > 20 && (
                <div style={{
                  fontSize: '10px', color: 'var(--text-dim)',
                  textAlign: 'center', padding: '4px',
                }}>
                  Showing 20 of {safeSessions.length} sessions
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
