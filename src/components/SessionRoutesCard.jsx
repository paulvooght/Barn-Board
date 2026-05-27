import { useState } from 'react';

/**
 * SessionRoutesCard — collapsible card showing routes logged in a single session.
 * Only rendered when period.type === 'session' and the session exists.
 *
 * Props:
 *   session     — the full session object
 *   routes      — all routes array
 *   onViewRoute — (routeId) => void
 */
export default function SessionRoutesCard({ session, routes, onViewRoute }) {
  const [open, setOpen] = useState(false);

  if (!session) return null;

  // Build the set of route IDs logged in this session
  const attempted  = new Set(session.routesAttempted  || []);
  const sent       = new Set(session.routesSent        || []);
  const flashed    = new Set(session.flashedRouteIds   || []);
  // Also treat any route that appears in sends but not in routesSent as sent
  for (const s of (session.sends || [])) sent.add(s.routeId);

  const allIds = [...new Set([...attempted, ...sent, ...flashed])];

  // Status per route
  const getStatus = (id) => {
    if (flashed.has(id)) return 'flashed';
    if (sent.has(id))    return 'sent';
    return 'tried';
  };

  // Angles climbed per route
  const getAngles = (id) => {
    const status = getStatus(id);
    if (status === 'flashed' || status === 'sent') {
      const angles = (session.sends || [])
        .filter(s => s.routeId === id)
        .map(s => s.angle)
        .filter(Boolean);
      return [...new Set(angles)].sort((a, b) => a - b);
    }
    // tried — look in angleAttempts (optional field)
    const entry = (session.angleAttempts || []).find(a => a.routeId === id);
    return entry ? [...new Set(entry.angles || [])].sort((a, b) => a - b) : [];
  };

  const count = allIds.length;

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

  const statusPill = (status) => {
    const map = {
      flashed: { bg: '#FFCB47', color: '#1A0A00', label: '⚡ Flashed' },
      sent:    { bg: 'var(--peach,#FFAB94)', color: '#1A0A00', label: 'Sent' },
      tried:   { bg: 'rgba(26,10,0,0.07)',   color: 'var(--text-muted)', label: 'Tried' },
    };
    const s = map[status] || map.tried;
    return (
      <span style={{
        fontSize: '9px', fontWeight: 700,
        background: s.bg, color: s.color,
        padding: '2px 7px', borderRadius: '6px',
        flexShrink: 0,
      }}>
        {s.label}
      </span>
    );
  };

  return (
    <div style={cardStyle}>
      {/* Header */}
      <div style={headerStyle} onClick={() => setOpen(o => !o)}>
        <span style={titleStyle}>
          Routes this session · {count}
        </span>
        <span style={chevronStyle}>▾</span>
      </div>

      {open && (
        <div style={{ padding: '0 12px 12px' }}>
          {count === 0 ? (
            <p style={{
              fontSize: '12px', color: 'var(--text-dim)',
              fontStyle: 'italic', margin: '4px 0 0', textAlign: 'center',
            }}>
              No routes logged this session.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {allIds.map(id => {
                const route = routes.find(r => r.id === id);
                const status = getStatus(id);
                const angles = getAngles(id);
                const name = route?.name || 'Unknown route';
                const grade = route?.grade || '';

                return (
                  <button
                    key={id}
                    onClick={() => onViewRoute && onViewRoute(id)}
                    style={{
                      width: '100%', textAlign: 'left',
                      display: 'flex', alignItems: 'center', gap: '8px',
                      padding: '8px 10px', borderRadius: '10px',
                      border: '1px solid rgba(26,10,0,0.08)',
                      background: 'rgba(255,255,255,0.5)',
                      cursor: 'pointer',
                    }}
                  >
                    {/* Grade pill */}
                    {grade && (
                      <span style={{
                        flexShrink: 0,
                        background: 'var(--yellow)', color: 'var(--text-primary)',
                        padding: '3px 9px', borderRadius: '8px',
                        fontSize: '12px', fontWeight: 800,
                        fontFamily: 'var(--font-heading)',
                      }}>
                        {grade}
                      </span>
                    )}

                    {/* Name */}
                    <span style={{
                      flex: 1, minWidth: 0,
                      fontSize: '13px', fontWeight: 600,
                      color: 'var(--text-primary)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {name}
                    </span>

                    {/* Angle chips */}
                    {angles.length > 0 && (
                      <div style={{ display: 'flex', gap: '3px', flexShrink: 0 }}>
                        {angles.map(a => (
                          <span key={a} style={{
                            fontSize: '9px', fontWeight: 700,
                            color: 'var(--accent)',
                            background: 'rgba(0,71,255,0.08)',
                            padding: '1px 5px', borderRadius: '5px',
                            fontFamily: 'var(--font-heading)',
                          }}>
                            {a}°
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Status pill */}
                    {statusPill(status)}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
