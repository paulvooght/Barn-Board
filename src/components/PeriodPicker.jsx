import { useState } from 'react';
import { makePeriod, listAvailablePeriods, previousPeriod, nextPeriod } from '../utils/sessionStats';

const PERIOD_TYPES = [
  { key: 'session', label: 'Last session' },
  { key: 'week',    label: 'Week' },
  { key: 'month',   label: 'Month' },
  { key: 'all',     label: 'All time' },
];

export default function PeriodPicker({ sessions, period, onChange }) {
  const [modalOpen, setModalOpen] = useState(false);

  // ── Tab press: switch to that type using the most recent anchor ──────────
  function handleTabPress(type) {
    const available = listAvailablePeriods(sessions || [], type);
    if (type === 'all') {
      onChange(makePeriod('all', null, sessions));
      return;
    }
    if (available.length > 0) {
      onChange(available[0]); // most recent
    } else {
      // No sessions yet — produce an empty period for the type
      onChange(makePeriod(type, new Date(), sessions));
    }
  }

  // ── Nav arrows ───────────────────────────────────────────────────────────
  const prev = previousPeriod(period, sessions);
  const next = nextPeriod(period, sessions);

  // ── Modal list ───────────────────────────────────────────────────────────
  const modalPeriods = listAvailablePeriods(sessions || [], period.type);

  const containerStyle = {
    marginBottom: '12px',
  };

  const tabRowStyle = {
    display: 'flex',
    gap: '0',
    borderBottom: '1px solid var(--border)',
    marginBottom: '0',
  };

  const tabStyle = (active) => ({
    flex: 1,
    padding: '8px 4px',
    background: 'transparent',
    border: 'none',
    borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
    color: active ? 'var(--accent)' : 'var(--text-dim)',
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '12px',
    fontWeight: active ? 800 : 600,
    cursor: 'pointer',
    textAlign: 'center',
    transition: 'color 0.15s, border-color 0.15s',
    letterSpacing: '0.3px',
  });

  const navStripStyle = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 0 4px',
    gap: '8px',
  };

  const arrowBtnStyle = (enabled) => ({
    width: '32px',
    height: '32px',
    borderRadius: '50%',
    border: `1.5px solid ${enabled ? 'var(--border)' : 'transparent'}`,
    background: 'transparent',
    color: enabled ? 'var(--text-primary)' : 'var(--text-dim)',
    fontSize: '16px',
    cursor: enabled ? 'pointer' : 'default',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    opacity: enabled ? 1 : 0.3,
    transition: 'opacity 0.15s',
  });

  const labelStyle = {
    flex: 1,
    textAlign: 'center',
    fontSize: '13px',
    fontWeight: 700,
    color: 'var(--text-primary)',
    cursor: 'pointer',
    padding: '4px 8px',
    borderRadius: '6px',
    fontFamily: "'DM Sans', sans-serif",
    userSelect: 'none',
  };

  // ── Modal overlay ────────────────────────────────────────────────────────
  const overlayStyle = {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.5)',
    zIndex: 1000,
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'center',
  };

  const sheetStyle = {
    background: '#FFAB94',
    borderRadius: '20px 20px 0 0',
    width: '100%',
    maxWidth: '480px',
    maxHeight: '70vh',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  };

  const sheetHeaderStyle = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '16px 16px 8px',
    borderBottom: '1px solid rgba(26,10,0,0.1)',
    flexShrink: 0,
  };

  const sheetListStyle = {
    overflowY: 'auto',
    padding: '8px 0 24px',
  };

  const sheetItemStyle = (active) => ({
    padding: '12px 16px',
    fontSize: '14px',
    fontWeight: active ? 800 : 600,
    color: active ? 'var(--accent)' : 'var(--text-primary)',
    cursor: 'pointer',
    background: active ? 'rgba(0,71,255,0.08)' : 'transparent',
    fontFamily: "'DM Sans', sans-serif",
    borderLeft: active ? '3px solid var(--accent)' : '3px solid transparent',
    transition: 'background 0.1s',
  });

  function isCurrentPeriod(p) {
    if (period.type === 'session') return p.sessionId === period.sessionId;
    if (period.type === 'all') return true;
    return new Date(p.start).getTime() === new Date(period.start).getTime();
  }

  return (
    <div style={containerStyle}>
      {/* Period type tabs */}
      <div style={tabRowStyle}>
        {PERIOD_TYPES.map(({ key, label }) => (
          <button
            key={key}
            style={tabStyle(period.type === key)}
            onClick={() => handleTabPress(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Nav strip — hidden for 'all' */}
      {period.type !== 'all' && (
        <div style={navStripStyle}>
          <button
            style={arrowBtnStyle(!!prev)}
            onClick={() => prev && onChange(prev)}
            disabled={!prev}
            aria-label="Previous period"
          >
            ‹
          </button>

          <span
            style={labelStyle}
            onClick={() => setModalOpen(true)}
            role="button"
            tabIndex={0}
            onKeyDown={e => e.key === 'Enter' && setModalOpen(true)}
          >
            {period.label}
          </span>

          <button
            style={arrowBtnStyle(!!next)}
            onClick={() => next && onChange(next)}
            disabled={!next}
            aria-label="Next period"
          >
            ›
          </button>
        </div>
      )}

      {/* Modal picker */}
      {modalOpen && (
        <div style={overlayStyle} onClick={() => setModalOpen(false)}>
          <div style={sheetStyle} onClick={e => e.stopPropagation()}>
            <div style={sheetHeaderStyle}>
              <span style={{
                fontFamily: 'var(--font-heading)',
                fontSize: '12px',
                fontWeight: 800,
                letterSpacing: '1px',
                textTransform: 'uppercase',
                color: 'var(--text-primary)',
              }}>
                Select Period
              </span>
              <button
                onClick={() => setModalOpen(false)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: '20px',
                  color: 'var(--text-primary)',
                  padding: '0 4px',
                  lineHeight: 1,
                }}
              >
                ×
              </button>
            </div>
            <div style={sheetListStyle}>
              {modalPeriods.length === 0 ? (
                <div style={{ padding: '16px', fontSize: '13px', color: 'var(--text-dim)' }}>
                  No periods available yet.
                </div>
              ) : (
                modalPeriods.map((p, i) => (
                  <div
                    key={p.sessionId || new Date(p.start).toISOString() || i}
                    style={sheetItemStyle(isCurrentPeriod(p))}
                    onClick={() => { onChange(p); setModalOpen(false); }}
                  >
                    {p.label}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
