// 4-state click-through: empty → tried → sent → flash → empty.
// State colours:
//   tried — pink border + small pink dot
//   sent  — cyan filled with white tick
//   flash — yellow border + yellow star
const STATE_CONFIG = {
  empty: { label: '',      borderColor: 'rgba(26,10,0,0.2)', bg: 'transparent',           labelColor: 'transparent' },
  tried: { label: 'Tried', borderColor: '#FF1493',           bg: 'rgba(255,20,147,0.12)', labelColor: '#FF1493'      },
  sent:  { label: 'Sent',  borderColor: '#7DD3E8',           bg: '#7DD3E8',               labelColor: '#0e7490'      },
  flash: { label: 'Flash', borderColor: '#FFCB47',           bg: 'rgba(255,203,71,0.25)', labelColor: '#b45309'      },
};

const TITLES = {
  empty: 'Tap to mark as Tried',
  tried: 'Tried — tap for Sent',
  sent:  'Sent — tap for Flash',
  flash: 'Flash — tap to clear',
};

export default function SentCycleButton({
  state = 'empty',
  onClick,
  showLabel = true,
  labelPosition = 'left',  // 'left' | 'below'
  size = 24,
}) {
  const cfg = STATE_CONFIG[state] || STATE_CONFIG.empty;

  const dotPx = Math.round(size * 0.34);
  const starPx = Math.round(size * 0.55);

  const box = (
    <button
      onClick={onClick}
      title={TITLES[state]}
      aria-label={TITLES[state]}
      style={{
        width: `${size}px`, height: `${size}px`, borderRadius: '6px',
        border: `2px solid ${cfg.borderColor}`,
        background: cfg.bg,
        color: '#fff',
        fontSize: '13px', fontWeight: 900, lineHeight: 1, cursor: 'pointer',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        transition: 'all 0.15s', padding: 0, flexShrink: 0,
      }}
    >
      {state === 'tried' && (
        <span style={{
          width: `${dotPx}px`, height: `${dotPx}px`, borderRadius: '50%',
          background: '#FF1493', display: 'block',
        }} />
      )}
      {state === 'sent' && '✓'}
      {state === 'flash' && (
        <svg width={starPx} height={starPx} viewBox="0 0 24 24" fill="#FFCB47" stroke="none">
          <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
        </svg>
      )}
    </button>
  );

  if (!showLabel) return box;

  if (labelPosition === 'below') {
    return (
      <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: '2px', flexShrink: 0 }}>
        {box}
        <span style={{
          fontSize: '9px', fontWeight: 700, lineHeight: 1, letterSpacing: '0.3px',
          color: cfg.labelColor, fontFamily: 'var(--font-heading)', textTransform: 'uppercase',
          minHeight: '9px',
        }}>
          {cfg.label || ' '}
        </span>
      </span>
    );
  }

  // labelPosition === 'left'
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
      <span style={{
        fontSize: '11px', fontWeight: 700, lineHeight: 1,
        color: cfg.labelColor, fontFamily: 'var(--font-heading)',
        minWidth: '34px', textAlign: 'right',
      }}>
        {cfg.label || ' '}
      </span>
      {box}
    </span>
  );
}
