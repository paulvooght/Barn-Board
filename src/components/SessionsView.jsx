import { useEffect, useMemo } from 'react';
import PeriodPicker from './PeriodPicker';
import ClimberCard from './ClimberCard';
import HoldHeatMap from './HoldHeatMap';
import UnfinishedBusinessCard from './UnfinishedBusinessCard';
import SessionRoutesCard from './SessionRoutesCard';
import SessionHistoryAccordion from './SessionHistoryAccordion';
import {
  makePeriod,
  computeStats,
  computeDelta,
  previousPeriod,
  computeHoldHeat,
} from '../utils/sessionStats';

export default function SessionsView({
  activeSession,
  onStartSession,
  onEndSession,
  setSessionAngle,
  logAngleClimbed,
  sessions,
  settings,
  displayName,
  userRouteData,
  routes,
  boardImageSrc,
  boardRegion,
  allHolds,
  profilesById,
  onViewRoute,
  onEditSession,
  // Lifted period state — App.jsx owns these so selection survives navigation
  period,
  onChangePeriod,
}) {
  const safeSessions = sessions || [];
  const safeRoutes = routes || [];
  const safeURD = userRouteData || {};
  const gradeSystem = settings?.gradeSystem || 'V';

  // ── Default period: most recent session, or all-time if none exist ────────
  const defaultPeriod = useMemo(() => {
    if (safeSessions.length === 0) return makePeriod('all', null, []);
    const sorted = [...safeSessions].sort(
      (a, b) => new Date(b.startTime) - new Date(a.startTime)
    );
    return makePeriod('session', sorted[0].id, safeSessions);
  }, []); // intentionally stable — only computed once

  // Initialise parent period on first render (when it is null)
  useEffect(() => {
    if (period === null && onChangePeriod) {
      onChangePeriod(defaultPeriod);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Use a safe local fallback so the rest of the component never sees null
  const safePeriod = period ?? defaultPeriod;
  const setPeriod = onChangePeriod ?? (() => {});

  // ── Stats computation (memoised) ──────────────────────────────────────────
  const stats = useMemo(
    () => computeStats(safeSessions, safeRoutes, safeURD, safePeriod, gradeSystem),
    [safeSessions, safeRoutes, safeURD, safePeriod, gradeSystem]
  );

  const prevPeriod = useMemo(
    () => previousPeriod(safePeriod, safeSessions),
    [safePeriod, safeSessions]
  );

  const previousStats = useMemo(() => {
    if (!prevPeriod) return null;
    return computeStats(safeSessions, safeRoutes, safeURD, prevPeriod, gradeSystem);
  }, [prevPeriod, safeSessions, safeRoutes, safeURD, gradeSystem]);

  const delta = useMemo(
    () => computeDelta(stats, previousStats),
    [stats, previousStats]
  );

  // ── Hold heat map data (memoised) ─────────────────────────────────────────
  const heat = useMemo(
    () => computeHoldHeat(safeSessions, safeRoutes, safeURD, safePeriod),
    [safeSessions, safeRoutes, safeURD, safePeriod]
  );

  // ── Styles ────────────────────────────────────────────────────────────────
  const containerStyle = {
    maxWidth: '480px',
    margin: '0 auto',
    padding: '20px 16px 40px',
    fontFamily: "'DM Sans', sans-serif",
  };

  const cardStyle = {
    background: 'var(--bg-card)',
    borderRadius: '12px',
    border: '1px solid var(--border)',
    padding: '16px',
    marginBottom: '12px',
  };

  return (
    <div style={containerStyle}>
      {/* Header */}
      <h2 style={{
        fontFamily: 'var(--font-heading)',
        fontWeight: 800,
        fontSize: '13px',
        color: 'var(--accent)',
        letterSpacing: '1px',
        textTransform: 'uppercase',
        margin: '0 0 16px',
      }}>
        Session Record
      </h2>

      {/* Primary CTA strip */}
      {!activeSession ? (
        <button
          onClick={onStartSession}
          style={{
            width: '100%',
            padding: '14px 24px',
            borderRadius: '24px',
            border: '2px solid rgba(125,211,232,0.5)',
            background: 'var(--bg-card)',
            color: '#3BA8C4',
            fontSize: '15px',
            fontWeight: 800,
            cursor: 'pointer',
            letterSpacing: '0.5px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            marginBottom: '16px',
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="5,3 19,12 5,21" />
          </svg>
          Start Session
        </button>
      ) : (
        <div style={{ marginBottom: '16px' }}>
          {/* Stop Session button */}
          <button
            onClick={onEndSession}
            style={{
              width: '100%',
              padding: '14px 24px',
              borderRadius: '24px',
              border: '2px solid rgba(255,82,82,0.4)',
              background: 'rgba(255,82,82,0.1)',
              color: '#FF5252',
              fontSize: '15px',
              fontWeight: 800,
              cursor: 'pointer',
              letterSpacing: '0.5px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
              marginBottom: '12px',
            }}
          >
            <span style={{ fontSize: '12px' }}>■</span> Stop Session
          </button>

          {/* Board angle slider */}
          <div style={cardStyle}>
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '8px',
            }}>
              <span style={{
                fontSize: '10px',
                fontWeight: 700,
                color: 'var(--text-muted)',
                letterSpacing: '1px',
                textTransform: 'uppercase',
              }}>
                Board Angle
              </span>
              <span style={{
                fontSize: '16px',
                fontWeight: 800,
                fontFamily: 'var(--font-heading)',
                color: '#7DD3E8',
              }}>
                {activeSession.boardAngle || 30}°
              </span>
            </div>
            <input
              type="range"
              min="18"
              max="55"
              value={activeSession.boardAngle || 30}
              onChange={(e) => setSessionAngle(parseInt(e.target.value))}
              style={{ width: '100%', accentColor: '#7DD3E8', cursor: 'pointer' }}
            />
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: '9px',
              color: 'var(--text-dim)',
              fontWeight: 600,
              marginTop: '2px',
            }}>
              <span>18° slab</span>
              <span>55° steep</span>
            </div>
            <button
              onClick={() => logAngleClimbed(activeSession.boardAngle || 30)}
              style={{
                marginTop: '8px',
                width: '100%',
                padding: '8px',
                borderRadius: '8px',
                border: '1.5px solid rgba(125,211,232,0.4)',
                background: (activeSession.anglesClimbed || []).includes(activeSession.boardAngle || 30)
                  ? 'rgba(125,211,232,0.15)'
                  : 'transparent',
                color: '#3BA8C4',
                fontSize: '11px',
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              {(activeSession.anglesClimbed || []).includes(activeSession.boardAngle || 30)
                ? `✓ ${activeSession.boardAngle || 30}° logged`
                : `Log ${activeSession.boardAngle || 30}° as climbed`}
            </button>
            {(activeSession.anglesClimbed || []).length > 0 && (
              <div style={{
                marginTop: '6px',
                fontSize: '10px',
                color: 'var(--text-muted)',
                fontWeight: 600,
                textAlign: 'center',
              }}>
                Angles this session: {(activeSession.anglesClimbed || []).map(a => `${a}°`).join(', ')}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Period Picker */}
      <PeriodPicker
        sessions={safeSessions}
        period={safePeriod}
        onChange={setPeriod}
      />

      {/* Climber Card */}
      {(() => {
        const selectedSession = safePeriod?.type === 'session'
          ? safeSessions.find(s => s.id === safePeriod.sessionId)
          : null;
        return (
          <ClimberCard
            stats={stats}
            previousStats={previousStats}
            delta={delta}
            gradeSystem={gradeSystem}
            displayName={displayName}
            period={safePeriod}
            onEditSession={
              selectedSession && onEditSession
                ? () => onEditSession(selectedSession)
                : null
            }
          />
        );
      })()}

      {/* Routes this session — only when a specific session is selected */}
      {safePeriod?.type === 'session' && (() => {
        const selectedSession = safeSessions.find(s => s.id === safePeriod.sessionId);
        return selectedSession ? (
          <SessionRoutesCard
            session={selectedSession}
            routes={safeRoutes}
            onViewRoute={onViewRoute}
          />
        ) : null;
      })()}

      {/* Hold Heat Map */}
      {boardImageSrc && boardRegion && allHolds && (
        <HoldHeatMap
          boardImageSrc={boardImageSrc}
          boardRegion={boardRegion}
          allHolds={allHolds}
          heat={heat}
          periodLabel={safePeriod.label}
        />
      )}

      {/* Unfinished Business — routes tried but not yet sent (all-time) */}
      <UnfinishedBusinessCard
        sessions={safeSessions}
        routes={safeRoutes}
        userRouteData={safeURD}
        profilesById={profilesById}
        onViewRoute={onViewRoute}
      />

      {/* Session History — collapsible accordion at bottom */}
      <SessionHistoryAccordion
        sessions={safeSessions}
        routes={safeRoutes}
        gradeSystem={gradeSystem}
        selectedSessionId={safePeriod?.type === 'session' ? safePeriod.sessionId : null}
        onSelectSession={(sessionId) => {
          const p = makePeriod('session', sessionId, safeSessions);
          setPeriod(p);
        }}
      />
    </div>
  );
}
