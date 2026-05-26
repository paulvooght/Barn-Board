/**
 * UnfinishedBusinessCard.jsx — Routes the user has tried but not yet sent.
 *
 * Props:
 *   sessions       {Array}  — all sessions (used to compute unfinished list)
 *   routes         {Array}  — all routes
 *   userRouteData  {Object} — { [routeId]: { sent, flashed, attempted, ... } }
 *   profilesById   {Object} — { [userId]: { display_name } }
 *   onViewRoute    {Function(routeId)} — navigate to route view
 */

import { useMemo, useState } from 'react';
import { computeUnfinished } from '../utils/sessionStats';

// ─── Local card helpers ───────────────────────────────────────────────────────

function Card({ children }) {
  return (
    <div style={{
      background: 'var(--bg-card)',
      borderRadius: '12px',
      border: '1px solid var(--border)',
      padding: '16px',
      marginBottom: '12px',
    }}>
      {children}
    </div>
  );
}

function CardHeader({ label }) {
  return (
    <div style={{
      fontFamily: 'var(--font-heading)',
      fontWeight: 800,
      fontSize: '11px',
      color: 'var(--accent)',
      letterSpacing: '1px',
      textTransform: 'uppercase',
      marginBottom: '12px',
    }}>
      {label}
    </div>
  );
}

function MutedText({ children, style }) {
  return (
    <span style={{
      color: 'var(--text-muted)',
      fontSize: '12px',
      ...style,
    }}>
      {children}
    </span>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function UnfinishedBusinessCard({
  sessions,
  routes,
  userRouteData,
  profilesById,
  onViewRoute,
}) {
  const [showAll, setShowAll] = useState(false);

  const safeSessions = sessions || [];
  const safeRoutes = routes || [];
  const safeURD = userRouteData || {};

  // Compute over full history — not filtered to period
  const routeIds = useMemo(
    () => computeUnfinished(safeSessions, safeRoutes, safeURD),
    [safeSessions, safeRoutes, safeURD]
  );

  if (routeIds.length === 0) {
    return (
      <Card>
        <CardHeader label="Unfinished Business · 0" />
        <MutedText style={{ fontStyle: 'italic' }}>
          You've sent everything you've tried. Time to attempt something new! 😊
        </MutedText>
      </Card>
    );
  }

  const visible = showAll ? routeIds : routeIds.slice(0, 5);

  function getRoute(routeId) {
    return safeRoutes.find(r => r.id === routeId);
  }

  function getSetterName(route) {
    if (!route) return null;
    if (route.creatorId && profilesById?.[route.creatorId]?.display_name) {
      return profilesById[route.creatorId].display_name;
    }
    return route.setter || null;
  }

  return (
    <Card>
      <CardHeader label={`Unfinished Business · ${routeIds.length}`} />
      <MutedText style={{ display: 'block', marginBottom: '12px' }}>
        Routes you've tried but not yet sent.
      </MutedText>

      <div>
        {visible.map(routeId => {
          const route = getRoute(routeId);
          if (!route) return null;
          const setterName = getSetterName(route);
          return (
            <button
              key={routeId}
              onClick={() => onViewRoute && onViewRoute(routeId)}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '10px 0',
                background: 'transparent',
                border: 'none',
                borderTop: '1px solid var(--border)',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              {/* Route name */}
              <span style={{
                flex: 1,
                fontSize: '13px',
                fontWeight: 600,
                color: 'var(--text)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {route.name || 'Unnamed route'}
              </span>

              {/* Grade pill */}
              {route.grade && (
                <span style={{
                  padding: '2px 7px',
                  borderRadius: '6px',
                  background: 'var(--accent)',
                  color: '#fff',
                  fontSize: '11px',
                  fontWeight: 800,
                  fontFamily: 'var(--font-heading)',
                  flexShrink: 0,
                }}>
                  {route.grade}
                </span>
              )}

              {/* Setter */}
              {setterName && (
                <MutedText style={{ fontSize: '11px', flexShrink: 0 }}>
                  {setterName}
                </MutedText>
              )}

              {/* Chevron */}
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--text-muted)"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ flexShrink: 0 }}
              >
                <polyline points="9,18 15,12 9,6" />
              </svg>
            </button>
          );
        })}
      </div>

      {routeIds.length > 5 && (
        <button
          onClick={() => setShowAll(v => !v)}
          style={{
            marginTop: '8px',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--accent)',
            fontSize: '12px',
            fontWeight: 700,
            padding: '4px 0',
          }}
        >
          {showAll ? 'Show less' : `Show all ${routeIds.length}`}
        </button>
      )}
    </Card>
  );
}
