/**
 * ClimberCard.jsx — Headline analytics card for the Sessions tab.
 * Shows climber type, top grade, send counts, strengths/weaknesses,
 * common patterns, per-angle grades, and session frequency.
 */

// ─── Helpers ─────────────────────────────────────────────────────────────────

function DeltaBadge({ value, unit = '', invertColor = false }) {
  if (value == null || value === 0) return null;
  const positive = value > 0;
  const color = (positive !== invertColor) ? '#22a870' : '#FF5252';
  const symbol = positive ? '+' : '−';
  const display = `${symbol}${Math.abs(value)}${unit}`;
  return (
    <span style={{
      fontSize: '10px',
      fontWeight: 700,
      color,
      marginLeft: '4px',
      whiteSpace: 'nowrap',
    }}>
      {display}
    </span>
  );
}

function GradeDeltaBadge({ value }) {
  if (value == null || value === 0) return null;
  const positive = value > 0;
  const color = positive ? '#22a870' : '#FF5252';
  const arrow = positive ? '↑' : '↓';
  const count = Math.abs(value);
  const label = count === 1 ? 'grade' : 'grades';
  return (
    <span style={{ fontSize: '10px', fontWeight: 700, color, marginLeft: '4px' }}>
      {arrow} {count} {label}
    </span>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ClimberCard({ stats, previousStats, delta, gradeSystem, displayName }) {
  if (!stats) return null;

  const cardStyle = {
    background: 'var(--bg-card)',
    borderRadius: '16px',
    border: '1px solid var(--border)',
    padding: '16px',
    marginBottom: '12px',
    fontFamily: "'DM Sans', sans-serif",
  };

  const labelStyle = {
    fontSize: '9px',
    fontWeight: 800,
    color: 'var(--text-dim)',
    letterSpacing: '1px',
    textTransform: 'uppercase',
    display: 'block',
    marginBottom: '2px',
  };

  const valueStyle = {
    fontSize: '22px',
    fontWeight: 800,
    fontFamily: 'var(--font-heading)',
    color: 'var(--text-primary)',
    lineHeight: 1.1,
  };

  // ── Empty state ──────────────────────────────────────────────────────────
  if (stats.sendCount === 0 && stats.sessionCount === 0) {
    return (
      <div style={{ ...cardStyle, border: '1px solid rgba(255,171,148,0.5)' }}>
        <div style={{
          fontSize: '11px',
          fontWeight: 700,
          color: 'var(--text-dim)',
          textAlign: 'center',
          padding: '8px 0',
          lineHeight: 1.6,
        }}>
          No data for this period yet —<br />
          try <em>Last session</em> or <em>All time</em>, or start climbing!
        </div>
      </div>
    );
  }

  // ── 1. Header row ────────────────────────────────────────────────────────
  const headerRow = (
    <div style={{
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      marginBottom: '14px',
      gap: '8px',
    }}>
      <span style={{
        fontFamily: 'var(--font-heading)',
        fontSize: '16px',
        fontWeight: 800,
        color: 'var(--accent)',
        textTransform: 'uppercase',
        letterSpacing: '1px',
        lineHeight: 1.2,
        flex: 1,
      }}>
        {stats.climberType || 'Versatile Climber'}
      </span>
      {displayName && (
        <span style={{
          fontSize: '11px',
          fontWeight: 700,
          color: 'var(--text-dim)',
          textAlign: 'right',
          flexShrink: 0,
          paddingTop: '2px',
        }}>
          {displayName}
        </span>
      )}
    </div>
  );

  // ── 2. Headline stats grid ───────────────────────────────────────────────
  const headlineGrid = (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '1fr 1fr 1fr',
      gap: '8px',
      marginBottom: '14px',
    }}>
      {/* Top Grade */}
      <div style={{ textAlign: 'center' }}>
        <span style={labelStyle}>Top Grade</span>
        <div style={valueStyle}>
          {stats.topGrade || '—'}
        </div>
        {delta && <GradeDeltaBadge value={delta.topGradeIndex} />}
      </div>

      {/* Sends */}
      <div style={{ textAlign: 'center' }}>
        <span style={labelStyle}>Sends</span>
        <div style={valueStyle}>
          {stats.sendCount}
        </div>
        {delta && <DeltaBadge value={delta.sendCount} />}
      </div>

      {/* Sessions */}
      <div style={{ textAlign: 'center' }}>
        <span style={labelStyle}>Sessions</span>
        <div style={valueStyle}>
          {stats.sessionCount}
        </div>
        {delta && <DeltaBadge value={delta.sessionCount} />}
      </div>
    </div>
  );

  // ── 3. Strengths & Weaknesses ─────────────────────────────────────────────
  const hasStrengths = stats.strengths && stats.strengths.length > 0;
  const hasWeaknesses = stats.weaknesses && stats.weaknesses.length > 0;
  const noData = !hasStrengths && !hasWeaknesses;

  const swCard = (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: '8px',
      marginBottom: '14px',
    }}>
      {/* Strengths */}
      <div style={{
        background: 'rgba(34,168,112,0.07)',
        borderRadius: '10px',
        padding: '10px',
        border: '1px solid rgba(34,168,112,0.2)',
      }}>
        <div style={{
          fontSize: '9px',
          fontWeight: 800,
          color: '#22a870',
          letterSpacing: '1px',
          textTransform: 'uppercase',
          marginBottom: '6px',
        }}>
          Strengths
        </div>
        {noData ? (
          <div style={{ fontSize: '10px', color: 'var(--text-dim)', lineHeight: 1.5 }}>
            Not enough data yet — keep climbing!
          </div>
        ) : hasStrengths ? (
          stats.strengths.map(({ holdType, avgGrade, count }) => (
            <div key={holdType} style={{
              fontSize: '11px',
              fontWeight: 700,
              color: 'var(--text-primary)',
              marginBottom: '3px',
              lineHeight: 1.4,
            }}>
              {holdType}
              {avgGrade && (
                <span style={{ color: 'var(--text-dim)', fontWeight: 600 }}>
                  {' · '}{avgGrade} avg
                </span>
              )}
            </div>
          ))
        ) : (
          <div style={{ fontSize: '10px', color: 'var(--text-dim)' }}>—</div>
        )}
      </div>

      {/* Weaknesses */}
      <div style={{
        background: 'rgba(255,82,82,0.06)',
        borderRadius: '10px',
        padding: '10px',
        border: '1px solid rgba(255,82,82,0.2)',
      }}>
        <div style={{
          fontSize: '9px',
          fontWeight: 800,
          color: '#FF5252',
          letterSpacing: '1px',
          textTransform: 'uppercase',
          marginBottom: '6px',
        }}>
          Weaknesses
        </div>
        {noData ? (
          <div style={{ fontSize: '10px', color: 'var(--text-dim)', lineHeight: 1.5 }}>
            Not enough data yet — keep climbing!
          </div>
        ) : hasWeaknesses ? (
          stats.weaknesses.map(({ holdType, avgGrade, count }) => (
            <div key={holdType} style={{
              fontSize: '11px',
              fontWeight: 700,
              color: 'var(--text-primary)',
              marginBottom: '3px',
              lineHeight: 1.4,
            }}>
              {holdType}
              {avgGrade && (
                <span style={{ color: 'var(--text-dim)', fontWeight: 600 }}>
                  {' · '}{avgGrade} avg
                </span>
              )}
            </div>
          ))
        ) : (
          <div style={{ fontSize: '10px', color: 'var(--text-dim)' }}>—</div>
        )}
      </div>
    </div>
  );

  // ── 4. Common patterns 2×2 grid ───────────────────────────────────────────
  const patterns = [
    { label: 'Top grade', value: stats.commonGrade },
    { label: 'Hold type', value: stats.commonHoldTypes },
    { label: 'Technique', value: stats.commonTechniques },
    { label: 'Angle', value: stats.commonAngles ? `${stats.commonAngles}°` : null },
  ].filter(p => p.value);

  const patternsGrid = patterns.length > 0 ? (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: '8px',
      marginBottom: '14px',
    }}>
      {patterns.map(({ label, value }) => (
        <div key={label} style={{
          background: 'rgba(26,10,0,0.04)',
          borderRadius: '8px',
          padding: '8px 10px',
        }}>
          <span style={{
            fontSize: '9px',
            fontWeight: 800,
            color: 'var(--text-dim)',
            letterSpacing: '1px',
            textTransform: 'uppercase',
            display: 'block',
            marginBottom: '2px',
          }}>
            {label}
          </span>
          <span style={{
            fontSize: '14px',
            fontWeight: 800,
            color: 'var(--text-primary)',
            fontFamily: 'var(--font-heading)',
          }}>
            {value}
          </span>
        </div>
      ))}
    </div>
  ) : null;

  // ── 5. Per-angle top grades ───────────────────────────────────────────────
  const angleEntries = Object.entries(stats.topGradeByAngle || {})
    .sort((a, b) => Number(a[0]) - Number(b[0]));

  const perAngleRow = angleEntries.length > 0 ? (
    <div style={{
      display: 'flex',
      flexWrap: 'wrap',
      gap: '6px',
      marginBottom: '14px',
    }}>
      {angleEntries.map(([angle, grade]) => (
        <div key={angle} style={{
          fontSize: '11px',
          fontWeight: 700,
          color: 'var(--text-primary)',
          background: 'rgba(26,10,0,0.05)',
          borderRadius: '6px',
          padding: '3px 8px',
          fontFamily: 'var(--font-heading)',
        }}>
          {angle}°{' '}
          <span style={{ color: 'var(--accent)' }}>{grade}</span>
        </div>
      ))}
    </div>
  ) : null;

  // ── 6. Footer row ─────────────────────────────────────────────────────────
  const showSessionsPerWeek = !stats.isAllTime && stats.avgSessionsPerWeek != null;
  const TARGET_SESSIONS_PER_WEEK = 2;
  const spwGood = showSessionsPerWeek && stats.avgSessionsPerWeek >= TARGET_SESSIONS_PER_WEEK * 0.85;

  const footerItems = [];
  if (stats.createdCount > 0) {
    footerItems.push(
      <span key="created" style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-dim)' }}>
        {stats.createdCount} route{stats.createdCount !== 1 ? 's' : ''} created
      </span>
    );
  }
  if (stats.avgSessionLengthMin != null) {
    footerItems.push(
      <span key="avglen" style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-dim)' }}>
        {stats.avgSessionLengthMin} min avg
      </span>
    );
  }
  if (showSessionsPerWeek) {
    footerItems.push(
      <span key="spw" style={{
        fontSize: '11px',
        fontWeight: 700,
        color: spwGood ? '#22a870' : 'var(--text-dim)',
      }}>
        {stats.avgSessionsPerWeek}/wk
        {!spwGood && (
          <span style={{ color: 'var(--text-dim)', fontWeight: 600 }}>
            {' '}(target {TARGET_SESSIONS_PER_WEEK}/wk)
          </span>
        )}
      </span>
    );
  }

  const footer = footerItems.length > 0 ? (
    <div style={{
      display: 'flex',
      flexWrap: 'wrap',
      gap: '12px',
      borderTop: '1px solid var(--border)',
      paddingTop: '10px',
    }}>
      {footerItems}
    </div>
  ) : null;

  // ── Assemble ─────────────────────────────────────────────────────────────
  return (
    <div style={cardStyle}>
      {headerRow}
      {headlineGrid}
      {swCard}
      {patternsGrid}
      {perAngleRow}
      {footer}
    </div>
  );
}
