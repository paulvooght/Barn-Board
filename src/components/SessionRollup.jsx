/**
 * SessionRollup.jsx — Supporting visualisations for the Sessions tab.
 * Renders four cards in sequence:
 *   1. Sparkline — "RECENT SENDS"
 *   2. Streaks & Badges
 *   3. Personal Records
 *   4. Unfinished Business
 */

import { useMemo, useState } from 'react';
import {
  computeSendsTimeline,
  computeStreaks,
  computePersonalRecords,
  computeUnfinished,
  computeAvgSessionsPerWeek,
} from '../utils/sessionStats';

// ─── Shared card shell ────────────────────────────────────────────────────────

function Card({ children, style }) {
  return (
    <div style={{
      background: 'var(--bg-card)',
      borderRadius: '12px',
      border: '1px solid var(--border)',
      padding: '16px',
      marginBottom: '12px',
      ...style,
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

// ─── 1. Sparkline ─────────────────────────────────────────────────────────────

function SparklineCard({ timeline }) {
  if (!timeline || timeline.length < 2) {
    return (
      <Card>
        <CardHeader label="Recent Sends" />
        <MutedText>Climb more sessions to see the trend.</MutedText>
      </Card>
    );
  }

  const W = 300;
  const H = 60;
  const PAD_X = 16;
  const PAD_Y_TOP = 16; // space for numbers above
  const PAD_Y_BOT = 4;
  const plotW = W - PAD_X * 2;
  const plotH = H - PAD_Y_TOP - PAD_Y_BOT;

  const counts = timeline.map(t => t.sendCount);
  const maxCount = Math.max(...counts, 1);

  const points = timeline.map((t, i) => {
    const x = PAD_X + (i / (timeline.length - 1)) * plotW;
    const y = PAD_Y_TOP + plotH - (t.sendCount / maxCount) * plotH;
    return { x, y, sendCount: t.sendCount, flashCount: t.flashCount };
  });

  const polylinePoints = points.map(p => `${p.x},${p.y}`).join(' ');

  // Area fill path (close path to bottom)
  const areaPath = [
    `M ${points[0].x} ${PAD_Y_TOP + plotH}`,
    ...points.map(p => `L ${p.x} ${p.y}`),
    `L ${points[points.length - 1].x} ${PAD_Y_TOP + plotH}`,
    'Z',
  ].join(' ');

  // Find index of highest point
  const maxIdx = counts.indexOf(maxCount);

  return (
    <Card>
      <CardHeader label="Recent Sends" />
      <MutedText style={{ display: 'block', marginBottom: '8px' }}>
        {timeline.length} sessions
      </MutedText>
      <svg
        width="100%"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ display: 'block', overflow: 'visible' }}
      >
        {/* Area fill */}
        <path
          d={areaPath}
          fill="#22d3ee"
          fillOpacity="0.15"
        />
        {/* Line */}
        <polyline
          points={polylinePoints}
          fill="none"
          stroke="#22d3ee"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {/* Send count labels above each point */}
        {points.map((p, i) => (
          <text
            key={i}
            x={p.x}
            y={p.y - 6}
            textAnchor="middle"
            fontSize="8"
            fontFamily="Space Mono, monospace"
            fill="#1A0A0066"
          >
            {p.sendCount}
          </text>
        ))}
        {/* Accent dot at highest point */}
        <circle
          cx={points[maxIdx].x}
          cy={points[maxIdx].y}
          r="4"
          fill="#0047FF"
        />
      </svg>
    </Card>
  );
}

// ─── 2. Streaks & Badges ──────────────────────────────────────────────────────

const BADGES = [
  { id: 'first_send',          emoji: '🪨', label: 'First Send',          test: (s) => s.totalSends >= 1 },
  { id: 'first_flash',         emoji: '⚡', label: 'First Flash',         test: (s) => s.totalFlashes >= 1 },
  { id: 'streak_starter',      emoji: '🔥', label: 'Streak Starter',      test: (s) => s.currentStreakWeeks >= 2 },
  { id: 'consistent_climber',  emoji: '📅', label: 'Consistent Climber',  test: (s) => s.currentStreakWeeks >= 4 },
  { id: 'century_club',        emoji: '💯', label: 'Century Club',        test: (s) => s.totalSends >= 100 },
  { id: 'flash_hunter',        emoji: '🎯', label: 'Flash Hunter',        test: (s) => s.totalFlashes >= 10 },
];

function BadgePill({ badge, earned }) {
  return (
    <div style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      padding: '4px 8px',
      borderRadius: '20px',
      border: earned ? '1.5px solid rgba(255,171,148,0.6)' : '1.5px solid var(--border)',
      background: earned ? 'rgba(255,171,148,0.15)' : 'transparent',
      opacity: earned ? 1 : 0.4,
      fontSize: '11px',
      fontWeight: 700,
      color: earned ? '#1A0A00' : 'var(--text-muted)',
      fontFamily: "'DM Sans', sans-serif",
      marginBottom: '4px',
    }}>
      <span>{badge.emoji}</span>
      <span>{badge.label}</span>
    </div>
  );
}

function ProgressBar({ value, max, color }) {
  const fill = Math.min(value / max, 1);
  return (
    <div style={{
      width: '100%',
      height: '6px',
      borderRadius: '3px',
      background: 'var(--border)',
      overflow: 'hidden',
      margin: '6px 0',
    }}>
      <div style={{
        width: `${fill * 100}%`,
        height: '100%',
        borderRadius: '3px',
        background: color,
        transition: 'width 0.4s ease',
      }} />
    </div>
  );
}

function StreaksCard({ streaks, avgPerWeek }) {
  const { currentStreakWeeks, longestStreakWeeks, totalSessions, totalSends, totalFlashes } = streaks;

  const streakLabel = currentStreakWeeks >= 2
    ? `${currentStreakWeeks} weeks 🔥`
    : `${currentStreakWeeks} week${currentStreakWeeks !== 1 ? 's' : ''}`;

  const streakColor = currentStreakWeeks >= 4 ? 'var(--accent)' : 'var(--text)';

  const avg = avgPerWeek != null ? avgPerWeek : 0;
  const barColor = avg >= 1.8 ? '#22a870' : avg >= 1.0 ? 'var(--accent)' : 'var(--text-muted)';
  const hitTarget = avg >= 1.8;

  const earnedSet = new Set(BADGES.filter(b => b.test(streaks)).map(b => b.id));

  return (
    <Card>
      <CardHeader label="Streaks & Badges" />

      {/* Big numbers grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: '12px',
        marginBottom: '16px',
      }}>
        <div>
          <div style={{
            fontSize: '22px',
            fontWeight: 800,
            fontFamily: 'var(--font-heading)',
            color: streakColor,
            lineHeight: 1,
          }}>
            {streakLabel}
          </div>
          <MutedText style={{ fontSize: '10px', letterSpacing: '0.5px', textTransform: 'uppercase' }}>
            Current streak
          </MutedText>
        </div>
        <div>
          <div style={{
            fontSize: '22px',
            fontWeight: 800,
            fontFamily: 'var(--font-heading)',
            color: 'var(--text-muted)',
            lineHeight: 1,
          }}>
            {longestStreakWeeks} wk{longestStreakWeeks !== 1 ? 's' : ''}
          </div>
          <MutedText style={{ fontSize: '10px', letterSpacing: '0.5px', textTransform: 'uppercase' }}>
            Longest streak
          </MutedText>
        </div>
        <div>
          <div style={{
            fontSize: '22px',
            fontWeight: 800,
            fontFamily: 'var(--font-heading)',
            lineHeight: 1,
          }}>
            {totalSessions}
          </div>
          <MutedText style={{ fontSize: '10px', letterSpacing: '0.5px', textTransform: 'uppercase' }}>
            Total sessions
          </MutedText>
        </div>
        <div>
          <div style={{
            fontSize: '22px',
            fontWeight: 800,
            fontFamily: 'var(--font-heading)',
            lineHeight: 1,
          }}>
            {totalSends}
          </div>
          <MutedText style={{ fontSize: '10px', display: 'block', letterSpacing: '0.5px', textTransform: 'uppercase' }}>
            Total sends
          </MutedText>
          <MutedText style={{ fontSize: '10px' }}>
            {totalFlashes} flash{totalFlashes !== 1 ? 'es' : ''}
          </MutedText>
        </div>
      </div>

      {/* Avg sessions per week progress bar */}
      {avgPerWeek != null && (
        <div style={{ marginBottom: '16px' }}>
          <ProgressBar value={avg} max={2.0} color={barColor} />
          <MutedText style={{ fontSize: '11px' }}>
            {avg.toFixed(1)} / 2.0 weekly target
            {hitTarget && <span style={{ color: '#22a870', marginLeft: '4px' }}>✓</span>}
          </MutedText>
        </div>
      )}

      {/* Badge pills */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
        {BADGES.map(badge => (
          <BadgePill key={badge.id} badge={badge} earned={earnedSet.has(badge.id)} />
        ))}
      </div>
    </Card>
  );
}

// ─── 3. Personal Records ──────────────────────────────────────────────────────

function PersonalRecordsCard({ records }) {
  const { topGrade, topGradeByAngle, hardestFlash, totalFlashes } = records;

  const sortedAngles = Object.keys(topGradeByAngle)
    .map(Number)
    .sort((a, b) => a - b);

  return (
    <Card>
      <CardHeader label="Personal Records" />

      {/* Top grade big display */}
      <div style={{ marginBottom: '16px' }}>
        <MutedText style={{
          fontSize: '10px',
          letterSpacing: '1px',
          textTransform: 'uppercase',
          display: 'block',
          marginBottom: '4px',
        }}>
          Hardest Send
        </MutedText>
        {topGrade ? (
          <div style={{
            fontSize: '36px',
            fontWeight: 800,
            fontFamily: 'var(--font-heading)',
            color: 'var(--accent)',
            lineHeight: 1,
          }}>
            {topGrade.grade}
          </div>
        ) : (
          <MutedText>No sends recorded yet.</MutedText>
        )}
      </div>

      {/* Per-angle PRs */}
      {sortedAngles.length > 0 && (
        <div style={{ marginBottom: '16px' }}>
          <MutedText style={{
            fontSize: '10px',
            letterSpacing: '1px',
            textTransform: 'uppercase',
            display: 'block',
            marginBottom: '6px',
          }}>
            Per-angle bests
          </MutedText>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {sortedAngles.map(angle => (
              <div key={angle} style={{
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                padding: '3px 8px',
                borderRadius: '8px',
                border: '1px solid var(--border)',
                background: 'transparent',
              }}>
                <span style={{
                  fontSize: '11px',
                  fontWeight: 600,
                  color: 'var(--text-muted)',
                }}>
                  {angle}°
                </span>
                <span style={{
                  fontSize: '11px',
                  fontWeight: 800,
                  fontFamily: 'var(--font-heading)',
                }}>
                  {topGradeByAngle[angle].grade}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Flash PR */}
      <div>
        {hardestFlash ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '14px' }}>⚡</span>
            <span style={{ fontSize: '13px', fontWeight: 700 }}>
              Flash PR:{' '}
              <span style={{ fontFamily: 'var(--font-heading)', color: 'var(--accent)' }}>
                {hardestFlash.grade}
              </span>
            </span>
            <MutedText style={{ marginLeft: 'auto' }}>
              {totalFlashes} flash{totalFlashes !== 1 ? 'es' : ''}
            </MutedText>
          </div>
        ) : (
          <MutedText style={{ fontStyle: 'italic' }}>No flash yet.</MutedText>
        )}
      </div>
    </Card>
  );
}

// ─── 4. Unfinished Business ───────────────────────────────────────────────────

function UnfinishedCard({ routeIds, routes, profilesById, onViewRoute }) {
  const [showAll, setShowAll] = useState(false);

  if (routeIds.length === 0) {
    return (
      <Card>
        <CardHeader label={`Unfinished Business · 0`} />
        <MutedText style={{ fontStyle: 'italic' }}>
          You've sent everything you've tried. Time to attempt something new! 😊
        </MutedText>
      </Card>
    );
  }

  const visible = showAll ? routeIds : routeIds.slice(0, 5);

  function getRoute(routeId) {
    return routes?.find(r => r.id === routeId);
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
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
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

// ─── Main component ───────────────────────────────────────────────────────────

export default function SessionRollup({
  sessions,
  routes,
  userRouteData,
  period,
  gradeSystem,
  profilesById,
  onViewRoute,
}) {
  const safeSessions = sessions || [];
  const safeRoutes = routes || [];
  const safeURD = userRouteData || {};
  const safeGradeSystem = gradeSystem || 'V';

  const timeline = useMemo(
    () => computeSendsTimeline(safeSessions, period, safeURD),
    [safeSessions, period, safeURD]
  );

  const streaks = useMemo(
    () => computeStreaks(safeSessions, safeURD),
    [safeSessions, safeURD]
  );

  const avgPerWeek = useMemo(
    () => computeAvgSessionsPerWeek(safeSessions),
    [safeSessions]
  );

  const records = useMemo(
    () => computePersonalRecords(safeSessions, safeRoutes, safeURD, safeGradeSystem),
    [safeSessions, safeRoutes, safeURD, safeGradeSystem]
  );

  const unfinishedIds = useMemo(
    () => computeUnfinished(safeSessions, safeRoutes, safeURD),
    [safeSessions, safeRoutes, safeURD]
  );

  // For 'session' period, hide sparkline (single point isn't a trend)
  const showSparkline = period?.type !== 'session';

  return (
    <>
      {showSparkline && (
        <SparklineCard timeline={timeline} />
      )}
      <StreaksCard streaks={streaks} avgPerWeek={avgPerWeek} />
      <PersonalRecordsCard records={records} />
      <UnfinishedCard
        routeIds={unfinishedIds}
        routes={safeRoutes}
        profilesById={profilesById}
        onViewRoute={onViewRoute}
      />
    </>
  );
}
