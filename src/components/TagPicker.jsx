export default function TagPicker({ label, options, selected, onToggle, highlighted }) {
  return (
    <div style={{ marginBottom: '14px' }}>
      <div style={{
        fontSize: '11px',
        color: 'var(--text-secondary)',
        marginBottom: '7px',
        fontWeight: 700,
        letterSpacing: '1px',
        textTransform: 'uppercase',
      }}>
        {label}
      </div>
      <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
        {options.map(opt => {
          const on = selected.includes(opt);
          const isAuto = on && highlighted?.includes(opt);
          return (
            <button
              key={opt}
              onClick={() => onToggle(opt)}
              style={{
                padding: '5px 11px',
                borderRadius: '14px',
                border: on ? '1.5px solid var(--accent)' : '1.5px solid rgba(26,10,0,0.15)',
                background: on ? 'var(--accent-dim)' : 'rgba(255,255,255,0.6)',
                color: on ? 'var(--accent)' : 'var(--text-secondary)',
                fontSize: '11px',
                fontWeight: isAuto ? 700 : 500,
                cursor: 'pointer',
                transition: 'all 0.12s',
                whiteSpace: 'nowrap',
              }}
            >
              {opt}{isAuto ? ' ✦' : ''}
            </button>
          );
        })}
      </div>
    </div>
  );
}
