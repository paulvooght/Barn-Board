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

function formatMinutes(mins) {
  if (mins == null) return null;
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ClimberCard({ stats, delta, gradeSystem, displayName, period }) {
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

  const sectionLabelStyle = {
    fontSize: '9px',
    fontWeight: 800,
    color: 'var(--text-muted)',
    letterSpacing: '1px',
    textTransform: 'uppercase',
    marginBottom: '8px',
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
  const headerRow = displayName ? (
    <div style={{
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'flex-end',
      marginBottom: '14px',
    }}>
      <span style={{
        fontSize: '11px',
        fontWeight: 700,
        color: 'var(--text-dim)',
        textAlign: 'right',
      }}>
        {displayName}
      </span>
    </div>
  ) : null;

  // ── 2. Time & frequency block ────────────────────────────────────────────
  const isSessionPeriod = period?.type === 'session';

  let timeItems = [];
  if (isSessionPeriod) {
    const formatted = formatMinutes(stats.exactSessionLengthMin);
    if (formatted) {
      timeItems.push({ label: 'Session length', value: formatted });
    }
  } else {
    const avgFormatted = formatMinutes(stats.avgSessionLengthMin);
    if (avgFormatted) {
      timeItems.push({ label: 'Avg session', value: avgFormatted });
    }
    if (stats.avgSessionsPerWeek != null) {
      timeItems.push({ label: 'Sessions/wk', value: String(stats.avgSessionsPerWeek) });
    }
  }

  const timeBlock = timeItems.length > 0 ? (
    <div style={{
      display: 'flex',
      gap: '16px',
      marginBottom: '14px',
    }}>
      {timeItems.map(({ label, value }, i) => (
        <div key={label} style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
          {i > 0 && (
            <span style={{ fontSize: '11px', color: 'var(--text-dim)', marginRight: '-4px' }}>·</span>
          )}
          <div>
            <span style={labelStyle}>{label}</span>
            <span style={{
              fontSize: '14px',
              fontWeight: 800,
              fontFamily: 'var(--font-heading)',
              color: 'var(--text-primary)',
            }}>
              {value}
            </span>
          </div>
        </div>
      ))}
    </div>
  ) : null;

  // ── 3. Grade row (2-column) ──────────────────────────────────────────────
  const gradeRow = (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: '8px',
      marginBottom: '14px',
    }}>
      <div style={{ textAlign: 'center' }}>
        <span style={labelStyle}>Top Grade</span>
        <div style={valueStyle}>{stats.topGrade || '—'}</div>
        {delta && <GradeDeltaBadge value={delta.topGradeIndex} />}
      </div>
      <div style={{ textAlign: 'center' }}>
        <span style={labelStyle}>Avg Grade</span>
        <div style={valueStyle}>{stats.avgGrade || '—'}</div>
        {stats.avgGrade && stats.avgGradeSampleSize > 0 && (
          <div style={{ fontSize: '9px', color: 'var(--text-dim)', marginTop: '2px' }}>
            across {stats.avgGradeSampleSize} send{stats.avgGradeSampleSize !== 1 ? 's' : ''}
          </div>
        )}
      </div>
    </div>
  );

  // ── 4. Activity row (2-column) ───────────────────────────────────────────
  const activityRow = (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: '8px',
      marginBottom: '14px',
    }}>
      <div style={{ textAlign: 'center' }}>
        <span style={labelStyle}>Sends</span>
        <div style={valueStyle}>{stats.sendCount}</div>
        {delta && <DeltaBadge value={delta.sendCount} />}
      </div>
      <div style={{ textAlign: 'center' }}>
        <span style={labelStyle}>Created</span>
        <div style={valueStyle}>{stats.createdCount}</div>
      </div>
    </div>
  );

  // ── 5 & 6. Composition sections (warm-up guarded) ────────────────────────
  const enoughData = stats.nonWarmupSendCount >= 3;

  // ── Hardest send section (always shown when there's a top send) ─────────────
  const hardestSendSection = stats.topGradeRoute ? (
    <div style={{ marginBottom: '14px' }}>
      <div style={sectionLabelStyle}>Hardest Send</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
        <span style={{
          fontSize: '18px',
          fontWeight: 800,
          fontFamily: 'var(--font-heading)',
          color: 'var(--accent)',
        }}>
          {stats.topGradeRoute.grade}
        </span>
        {stats.topGradeRoute.name && (
          <>
            <span style={{ fontSize: '12px', color: 'var(--text-dim)' }}>—</span>
            <span style={{
              fontSize: '12px',
              fontWeight: 600,
              color: 'var(--text-primary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: '180px',
            }}>
              {stats.topGradeRoute.name}
            </span>
          </>
        )}
      </div>
    </div>
  ) : null;

  const topGradeSection = enoughData && stats.topGradePerHoldType.length > 0 ? (
    <div style={{ marginBottom: '14px' }}>
      <div style={sectionLabelStyle}>Top Grade Per Hold Type</div>
      {stats.topGradePerHoldType.map(({ holdType, grade }) => (
        <div key={holdType} style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          paddingBottom: '4px',
        }}>
          <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)' }}>
            {holdType}
          </span>
          <span style={{
            fontSize: '12px',
            fontWeight: 800,
            color: 'var(--accent)',
            fontFamily: 'var(--font-heading)',
          }}>
            {grade}
          </span>
        </div>
      ))}
    </div>
  ) : null;

  let compositionSection = null;
  if (!enoughData) {
    compositionSection = (
      <div style={{
        fontSize: '11px',
        color: 'var(--text-dim)',
        fontStyle: 'italic',
        marginBottom: '4px',
      }}>
        Not enough non-warm-up climbing this period to show composition.
      </div>
    );
  } else {
    const subBlocks = [];

    if (stats.holdTypeComposition.length > 0) {
      subBlocks.push({
        heading: 'Hold types',
        text: stats.holdTypeComposition
          .map(({ value, percent }) => `${value} ${percent}%`)
          .join(' · '),
      });
    }
    if (stats.styleComposition.length > 0) {
      subBlocks.push({
        heading: 'Styles',
        text: stats.styleComposition
          .map(({ value, percent }) => `${value} ${percent}%`)
          .join(' · '),
      });
    }
    if (stats.angleComposition.length > 0) {
      subBlocks.push({
        heading: 'Angles',
        text: stats.angleComposition
          .map(({ value, percent }) => `${value}° ${percent}%`)
          .join(' · '),
      });
    }

    if (subBlocks.length > 0) {
      compositionSection = (
        <div style={{ marginBottom: '4px' }}>
          <div style={sectionLabelStyle}>Composition</div>
          {subBlocks.map(({ heading, text }) => (
            <div key={heading} style={{ marginBottom: '8px' }}>
              <div style={{
                fontSize: '10px',
                fontWeight: 700,
                color: 'var(--text-primary)',
                marginBottom: '2px',
              }}>
                {heading}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-dim)', lineHeight: 1.5 }}>
                {text}
              </div>
            </div>
          ))}
        </div>
      );
    }
  }

  // ── Assemble ─────────────────────────────────────────────────────────────
  return (
    <div style={cardStyle}>
      {headerRow}
      {timeBlock}
      {gradeRow}
      {activityRow}
      {hardestSendSection}
      {topGradeSection}
      {compositionSection}
    </div>
  );
}
