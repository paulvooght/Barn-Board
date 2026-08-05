import { useState } from 'react';
import AngleStateChip from './AngleStateChip';

// Ordering used to resolve conflicting/duplicate signals when deriving
// per-angle state from stored session data (flash beats sent beats tried).
// Mirrors SessionEditView's STATE_RANK.
const STATE_RANK = { empty: 0, tried: 1, sent: 2, flash: 3 };

/**
 * Lookup the grade for a given angle on a route.
 * Falls back to route.grade if not found in angleGrades.
 * (Copied from SessionEditView.jsx's gradeForAngle — small enough not to
 * warrant a shared import.)
 */
function gradeForAngle(route, angle) {
  if (route.angleGrades) {
    const ag = route.angleGrades.find(a => a.angle === angle);
    if (ag) return ag.grade;
  }
  return route.grade;
}

/**
 * SessionRoutesCard — collapsible card showing routes logged in a single session.
 * Only rendered when period.type === 'session' and the session exists.
 *
 * Display-only: shows each route's per-angle send state as read-only
 * AngleStateChips (grade + angle + tried/sent/flash colour). No editing here —
 * that lives in SessionEditView.
 *
 * Props:
 *   session     — the full session object
 *   routes      — all routes array
 *   onViewRoute — (routeId) => void
 */
export default function SessionRoutesCard({ session, routes, onViewRoute, boardName }) {
  const [open, setOpen] = useState(false);

  if (!session) return null;

  // Build the set of route IDs logged in this session (any signal counts).
  const attempted      = new Set(session.routesAttempted  || []);
  const sent           = new Set(session.routesSent        || []);
  const flashedIds     = new Set(session.flashedRouteIds   || []);
  const angleAttemptIds = new Set((session.angleAttempts || []).map(a => a.routeId));
  for (const s of (session.sends || [])) sent.add(s.routeId);

  const allIds = [...new Set([...attempted, ...sent, ...flashedIds, ...angleAttemptIds])];

  // Derive per-route, per-angle state: { [angle]: 'tried' | 'sent' | 'flash' }.
  // Same derivation SessionEditView uses to seed its editable state, but kept
  // read-only here — no cycling, just display.
  const getAngleStates = (id, route) => {
    const headlineAngle = route ? route.angle : undefined;
    const routeSends = (session.sends || []).filter(s => s.routeId === id);

    // Legacy back-compat: old sessions recorded flash at the route level
    // (flashedRouteIds) before flash was tracked per-angle on each send.
    const legacyFlash = flashedIds.has(id) && !routeSends.some(s => s.flash === true);

    const angleStates = {};
    routeSends.forEach(send => {
      // A route-level send (no angle recorded) maps onto the route's
      // headline angle so it still renders instead of being lost.
      const angle = send.angle != null ? send.angle : headlineAngle;
      if (angle == null) return;
      const state = (send.flash === true || legacyFlash) ? 'flash' : 'sent';
      const existing = angleStates[angle];
      if (!existing || STATE_RANK[state] > STATE_RANK[existing]) {
        angleStates[angle] = state;
      }
    });

    const attemptsEntry = (session.angleAttempts || []).find(a => a.routeId === id);
    if (attemptsEntry) {
      (attemptsEntry.angles || []).forEach(angle => {
        if (!angleStates[angle]) angleStates[angle] = 'tried';
      });
    }

    // A route with no angle signal at all (routesAttempted only) still gets
    // a visible chip — fall back to its headline angle as 'tried'.
    if (Object.keys(angleStates).length === 0 && headlineAngle != null) {
      angleStates[headlineAngle] = 'tried';
    }

    return angleStates;
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

  return (
    <div style={cardStyle}>
      {/* Header */}
      <div style={headerStyle} onClick={() => setOpen(o => !o)}>
        <span style={titleStyle}>
          Routes this session · {count}
          {boardName && (
            <span style={{
              fontSize: '9px', fontWeight: 800, letterSpacing: '0.3px',
              color: 'var(--accent)', background: 'var(--accent-dim)',
              padding: '2px 7px', borderRadius: '6px', marginLeft: '8px',
              textTransform: 'none',
            }}>
              {boardName}
            </span>
          )}
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
                const name = route?.name || 'Unknown route';
                const angleStates = getAngleStates(id, route);
                const chipAngles = Object.keys(angleStates).map(Number).sort((a, b) => a - b);

                return (
                  <button
                    key={id}
                    onClick={() => onViewRoute && onViewRoute(id)}
                    style={{
                      width: '100%', textAlign: 'left',
                      display: 'flex', flexDirection: 'column', gap: '6px',
                      padding: '8px 10px', borderRadius: '10px',
                      border: '1px solid rgba(26,10,0,0.08)',
                      background: 'rgba(255,255,255,0.5)',
                      cursor: 'pointer',
                    }}
                  >
                    {/* Name */}
                    <span style={{
                      fontSize: '13px', fontWeight: 600,
                      color: 'var(--text-primary)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {name}
                    </span>

                    {/* Per-angle state chips — read-only, carry grade + angle + state */}
                    {chipAngles.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                        {chipAngles.map(angle => (
                          <AngleStateChip
                            key={angle}
                            grade={route ? gradeForAngle(route, angle) : ''}
                            angle={angle}
                            state={angleStates[angle]}
                          />
                        ))}
                      </div>
                    )}
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
