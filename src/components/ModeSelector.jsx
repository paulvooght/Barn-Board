import { SELECTION_MODES, MODE_COLORS, MODE_LABELS } from '../utils/constants';

export default function ModeSelector({ mode, setMode }) {
  return (
    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
      {Object.entries(SELECTION_MODES).map(([key, val]) => (
        <button
          key={val}
          onClick={() => setMode(val)}
          style={{
            padding: '7px 14px',
            borderRadius: '20px',
            border: mode === val ? `2px solid ${MODE_COLORS[val]}` : '2px solid rgba(0,0,0,0.15)',
            background: mode === val ? `${MODE_COLORS[val]}22` : 'rgba(255,255,255,0.5)',
            color: mode === val ? MODE_COLORS[val] : 'var(--text-secondary)',
            fontSize: '12px',
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'all 0.15s',
            whiteSpace: 'nowrap',
          }}
        >
          {MODE_LABELS[val]}
        </button>
      ))}
    </div>
  );
}
