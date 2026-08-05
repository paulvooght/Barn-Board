// AngleStateChip — per-angle 4-state chip (empty → tried → sent → flash → empty).
// Shows the route's grade at this angle as the primary label, with the angle
// underneath. State is conveyed by colour + a small glyph (no state word), so
// several of these can sit side by side on a route row without becoming noisy.
//
// Palette matches SentCycleButton exactly — one shared visual vocabulary for
// the 4-state send cycle across the app.
const STATE_CONFIG = {
  empty: { borderColor: 'rgba(26,10,0,0.2)', bg: 'transparent',           textColor: 'var(--text-secondary)' },
  tried: { borderColor: '#FF1493',           bg: 'rgba(255,20,147,0.12)', textColor: '#FF1493'                },
  sent:  { borderColor: '#7DD3E8',           bg: '#7DD3E8',               textColor: '#0e7490'                },
  flash: { borderColor: '#FFCB47',           bg: 'rgba(255,203,71,0.25)', textColor: '#b45309'                },
};

const STATE_LABEL = { empty: 'Empty', tried: 'Tried', sent: 'Sent', flash: 'Flash' };
const NEXT_STATE  = { empty: 'tried', tried: 'sent', sent: 'flash', flash: 'empty' };

/**
 * Props:
 *   grade   — string, grade for this angle (falls back to '—' if empty)
 *   angle   — number, board angle in degrees
 *   state   — 'empty' | 'tried' | 'sent' | 'flash' (default 'empty')
 *   onClick — optional. When omitted, renders a read-only <span> instead of a <button>.
 */
export default function AngleStateChip({ grade, angle, state = 'empty', onClick }) {
  const cfg = STATE_CONFIG[state] || STATE_CONFIG.empty;
  const gradeLabel = grade || '—';
  const interactive = typeof onClick === 'function';

  const stateLabel = STATE_LABEL[state] || STATE_LABEL.empty;
  const nextState = NEXT_STATE[state] || 'tried';
  const title = interactive
    ? (nextState === 'empty'
        ? `${gradeLabel} at ${angle}° — ${stateLabel}, tap to clear`
        : `${gradeLabel} at ${angle}° — ${stateLabel}, tap for ${STATE_LABEL[nextState]}`)
    : `${gradeLabel} at ${angle}° — ${stateLabel}`;

  let glyph = null;
  if (state === 'tried') {
    glyph = (
      <span style={{
        width: '5px', height: '5px', borderRadius: '50%', background: '#FF1493',
        display: 'inline-block', marginLeft: '3px', verticalAlign: 'middle',
      }} />
    );
  } else if (state === 'sent') {
    glyph = (
      <span style={{ marginLeft: '3px', fontSize: '9px', fontWeight: 900, verticalAlign: 'middle', lineHeight: 1 }}>
        ✓
      </span>
    );
  } else if (state === 'flash') {
    glyph = (
      <svg width="9" height="9" viewBox="0 0 24 24" fill="#FFCB47" stroke="none"
        style={{ marginLeft: '3px', verticalAlign: 'middle' }}>
        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
      </svg>
    );
  }

  const content = (
    <>
      {/* <span>s, not <div>s — the read-only variant renders inside a <span>,
          and inside the route-row <button> in SessionRoutesCard. */}
      <span style={{
        fontSize: '13px', fontWeight: 800, fontFamily: 'var(--font-heading)',
        color: cfg.textColor, lineHeight: 1.15,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {gradeLabel}{glyph}
      </span>
      <span style={{
        display: 'block',
        fontSize: '9px', fontWeight: 700, lineHeight: 1.1, marginTop: '2px',
        color: state === 'empty' ? 'var(--text-muted)' : cfg.textColor,
        opacity: state === 'empty' ? 0.85 : 0.75,
      }}>
        {angle}°
      </span>
    </>
  );

  const sharedStyle = {
    display: 'inline-flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    borderRadius: '8px', border: `2px solid ${cfg.borderColor}`, background: cfg.bg,
    padding: interactive ? '6px 11px' : '5px 9px',
    minHeight: interactive ? '44px' : undefined,
    minWidth: '40px', boxSizing: 'border-box',
    transition: 'background 0.15s, border-color 0.15s, color 0.15s',
  };

  if (!interactive) {
    return (
      <span title={title} aria-label={title} style={sharedStyle}>
        {content}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{ ...sharedStyle, cursor: 'pointer', outline: 'none' }}
    >
      {content}
    </button>
  );
}
