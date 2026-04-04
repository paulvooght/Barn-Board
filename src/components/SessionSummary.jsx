import { useMemo } from 'react';
import { V_GRADE_INDEX, FONT_GRADE_INDEX } from '../utils/constants';

function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export default function SessionSummary({ session, routes, grades, allSessions, onClose }) {
  const gradeIndex = grades[0] === 'VB' ? V_GRADE_INDEX : FONT_GRADE_INDEX;
  const duration = new Date(session.endTime) - new Date(session.startTime);

  // Detailed sends — includes angle + grade from when the send was logged
  const sends = session.sends || [];

  // Routes sent & attempted during this session
  const sentRoutes = useMemo(() =>
    routes.filter(r => session.routesSent.includes(r.id)),
    [routes, session.routesSent]
  );

  const attemptedRoutes = useMemo(() =>
    routes.filter(r => session.routesAttempted.includes(r.id) && !session.routesSent.includes(r.id)),
    [routes, session.routesAttempted, session.routesSent]
  );

  const newRoutes = useMemo(() =>
    routes.filter(r => session.routesCreated?.includes(r.id)),
    [routes, session.routesCreated]
  );

  // Collect ALL grades sent this session (main sends + angle-grade sends)
  const allGradesSent = useMemo(() => {
    if (sends.length > 0) {
      // Use detailed send data — each entry has a grade
      return sends
        .map(s => s.grade)
        .filter(Boolean);
    }
    // Fallback for old sessions without sends array
    return sentRoutes.map(r => r.grade);
  }, [sends, sentRoutes]);

  // Hardest grade — use grade index for proper ordering
  const hardestGrade = useMemo(() => {
    if (allGradesSent.length === 0) return null;
    let hardestIdx = -1;
    let hardest = null;
    for (const g of allGradesSent) {
      const idx = gradeIndex[g] ?? -1;
      if (idx > hardestIdx) {
        hardestIdx = idx;
        hardest = g;
      }
    }
    return hardest;
  }, [allGradesSent, grades, gradeIndex]);

  // Combine angles from session log AND sent routes for completeness
  const sessionAngles = session.anglesClimbed || [];
  const sendAngles = sends.map(s => s.angle).filter(Boolean);
  const routeAngles = [...new Set(sentRoutes.map(r => r.angle))];
  const angles = [...new Set([...sessionAngles, ...sendAngles, ...routeAngles])].sort((a, b) => a - b);

  // Styles & hold types from ALL sent routes
  const styleSet = new Set(sentRoutes.flatMap(r => r.styles || []));
  const holdTypeSet = new Set(sentRoutes.flatMap(r => r.holdTypes || []));

  // Build display list of sends with angle+grade detail
  const sendDisplayList = useMemo(() => {
    if (sends.length > 0) {
      return sends.map(s => {
        const route = routes.find(r => r.id === s.routeId);
        return {
          name: route?.name || 'Unknown',
          grade: s.grade || route?.grade || '?',
          angle: s.angle || route?.angle || null,
          routeId: s.routeId,
        };
      });
    }
    // Fallback for old sessions
    return sentRoutes.map(r => ({
      name: r.name,
      grade: r.grade,
      angle: r.angle,
      routeId: r.id,
    }));
  }, [sends, sentRoutes, routes]);

  // Personal bests (compare against all previous sessions)
  const pbs = useMemo(() => {
    const results = [];
    const prevSessions = allSessions.filter(s => s.id !== session.id && s.endTime);

    // Most routes sent in a session
    const prevMaxSent = Math.max(0, ...prevSessions.map(s => s.routesSent.length));
    if (session.routesSent.length > prevMaxSent && session.routesSent.length > 0) {
      results.push(`Most routes sent in a session: ${session.routesSent.length}`);
    }

    // Hardest grade ever sent in a session
    if (hardestGrade) {
      const hardestIdx = gradeIndex[hardestGrade] ?? -1;
      let prevHardestIdx = -1;
      for (const ps of prevSessions) {
        const psSends = ps.sends || [];
        const psGrades = psSends.length > 0
          ? psSends.map(s => s.grade).filter(Boolean)
          : routes.filter(r => ps.routesSent.includes(r.id)).map(r => r.grade);
        for (const g of psGrades) {
          const idx = gradeIndex[g] ?? -1;
          if (idx > prevHardestIdx) prevHardestIdx = idx;
        }
      }
      if (hardestIdx > prevHardestIdx && prevSessions.length > 0) {
        results.push(`New hardest send: ${hardestGrade}`);
      }
    }

    // Longest session
    const prevMaxDuration = Math.max(0, ...prevSessions.map(s =>
      new Date(s.endTime) - new Date(s.startTime)
    ));
    if (duration > prevMaxDuration && prevSessions.length > 0) {
      results.push(`Longest session: ${formatDuration(duration)}`);
    }

    return results;
  }, [session, allSessions, duration, hardestGrade, grades, routes]);

  return (
    <div style={{
      padding: '20px 16px', maxWidth: '480px', margin: '0 auto',
    }}>
      {/* Title */}
      <div style={{ textAlign: 'center', marginBottom: '20px' }}>
        <div style={{
          fontSize: '11px', color: 'var(--text-muted)', fontWeight: 700,
          letterSpacing: '2px', textTransform: 'uppercase', marginBottom: '4px',
        }}>
          Session Complete
        </div>
        <div style={{
          fontSize: '32px', fontWeight: 800, fontFamily: 'var(--font-heading)',
          color: 'var(--text-primary)',
        }}>
          {formatDuration(duration)}
        </div>
      </div>

      {/* Angles climbed */}
      {angles.length > 0 && (
        <div style={{
          textAlign: 'center', marginBottom: '16px', fontSize: '13px',
          color: 'var(--text-muted)', fontWeight: 600,
        }}>
          {angles.length === 1
            ? <>Board at <span style={{ color: '#D4705A', fontWeight: 800, fontFamily: 'var(--font-heading)', fontSize: '15px' }}>{angles[0]}°</span></>
            : <>Angles: {angles.map((a, i) => (
                <span key={a}>
                  {i > 0 && ', '}
                  <span style={{ color: '#D4705A', fontWeight: 800, fontFamily: 'var(--font-heading)', fontSize: '15px' }}>{a}°</span>
                </span>
              ))}</>
          }
        </div>
      )}

      {/* Stats cards row — use unique route count for "Sent" to match PB calculation */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
        <StatCard label="Sent" value={sentRoutes.length} color="#D4705A" />
        <StatCard label="Created" value={newRoutes.length} color="var(--accent)" />
      </div>

      {/* Hardest grade */}
      {hardestGrade && (
        <div style={{
          padding: '12px 16px', borderRadius: '12px', marginBottom: '10px',
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 600 }}>
            Hardest Send
          </span>
          <span style={{
            background: 'var(--yellow)', color: 'var(--text-primary)',
            fontWeight: 800, fontFamily: 'var(--font-heading)',
            fontSize: '14px', padding: '3px 12px', borderRadius: '8px',
          }}>
            {hardestGrade}
          </span>
        </div>
      )}

      {/* Angles used — only show card if multiple angles */}
      {angles.length > 1 && (
        <div style={{
          padding: '12px 16px', borderRadius: '12px', marginBottom: '10px',
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 600 }}>
            Angles Climbed
          </span>
          <span style={{ fontSize: '13px', color: 'var(--text-primary)', fontWeight: 600 }}>
            {angles.map(a => `${a}°`).join(', ')}
          </span>
        </div>
      )}

      {/* Styles & hold types */}
      {(styleSet.size > 0 || holdTypeSet.size > 0) && (
        <div style={{
          padding: '12px 16px', borderRadius: '12px', marginBottom: '10px',
          background: 'var(--bg-card)', border: '1px solid var(--border)',
        }}>
          {styleSet.size > 0 && (
            <div style={{ marginBottom: holdTypeSet.size > 0 ? '8px' : 0 }}>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase', marginBottom: '4px' }}>
                Styles
              </div>
              <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                {[...styleSet].map(s => (
                  <span key={s} style={tagStyle}>{s}</span>
                ))}
              </div>
            </div>
          )}
          {holdTypeSet.size > 0 && (
            <div>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase', marginBottom: '4px' }}>
                Hold Types
              </div>
              <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                {[...holdTypeSet].map(ht => (
                  <span key={ht} style={tagStyle}>{ht}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Sends list with angle+grade detail */}
      {sendDisplayList.length > 0 && (
        <div style={{
          padding: '12px 16px', borderRadius: '12px', marginBottom: '10px',
          background: 'var(--bg-card)', border: '1px solid var(--border)',
        }}>
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase', marginBottom: '6px' }}>
            Sends
          </div>
          {sendDisplayList.map((s, i) => (
            <div key={`${s.routeId}-${i}`} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '4px 0', fontSize: '13px',
            }}>
              <span style={{ color: 'var(--text-primary)', fontWeight: 500, flex: 1, minWidth: 0 }}>
                {s.name}
                {s.angle && (
                  <span style={{ color: 'var(--text-dim)', fontSize: '11px', marginLeft: '6px' }}>
                    {s.angle}°
                  </span>
                )}
              </span>
              <span style={{
                background: 'var(--yellow)', color: 'var(--text-primary)',
                fontWeight: 700, fontFamily: 'var(--font-heading)',
                fontSize: '11px', padding: '2px 8px', borderRadius: '6px',
                flexShrink: 0, marginLeft: '8px',
              }}>
                {s.grade}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Personal bests */}
      {pbs.length > 0 && (
        <div style={{
          padding: '12px 16px', borderRadius: '12px', marginBottom: '16px',
          background: 'rgba(212,112,90,0.08)', border: '1.5px solid rgba(212,112,90,0.3)',
        }}>
          <div style={{ fontSize: '10px', color: '#D4705A', fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase', marginBottom: '6px' }}>
            Personal Best
          </div>
          {pbs.map((pb, i) => (
            <div key={i} style={{ fontSize: '13px', color: '#D4705A', fontWeight: 600, padding: '2px 0' }}>
              {pb}
            </div>
          ))}
        </div>
      )}

      {/* Empty session */}
      {sendDisplayList.length === 0 && attemptedRoutes.length === 0 && newRoutes.length === 0 && (
        <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-dim)', fontSize: '13px' }}>
          No routes logged this session. View and send routes to track your progress!
        </div>
      )}

      {/* Done button */}
      <button
        onClick={onClose}
        style={{
          width: '100%', padding: '14px', borderRadius: '12px', border: 'none',
          background: 'var(--accent)', color: '#fff',
          fontSize: '14px', fontWeight: 700, cursor: 'pointer',
          letterSpacing: '0.5px',
        }}
      >
        Done
      </button>
    </div>
  );
}

function StatCard({ label, value, color }) {
  return (
    <div style={{
      flex: 1, padding: '14px 8px', borderRadius: '12px', textAlign: 'center',
      background: 'var(--bg-card)', border: '1px solid var(--border)',
      boxShadow: '0 2px 6px rgba(26,10,0,0.06)',
    }}>
      <div style={{
        fontSize: '24px', fontWeight: 800, fontFamily: 'var(--font-heading)',
        color: color,
      }}>
        {value}
      </div>
      <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, letterSpacing: '0.5px', marginTop: '2px' }}>
        {label}
      </div>
    </div>
  );
}

const tagStyle = {
  padding: '3px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 600,
  background: 'rgba(26,10,0,0.05)', color: 'var(--text-secondary)',
};
