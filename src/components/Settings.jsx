import { BOARD_SPECS } from '../utils/constants';
import holdsData from '../data/holds.json';

/**
 * Props:
 *   settings, updateSettings — grade system etc.
 *   allHolds                 — merged hold array from useCustomHolds
 *   onSetupBoard()           — open the Hold Manager
 */
export default function Settings({ settings, updateSettings, allHolds, onSetupBoard }) {
  const totalHolds    = allHolds.length;
  const customCount   = allHolds.filter(h => h.custom).length;
  const verifiedCount = allHolds.filter(h => h.verified).length;

  return (
    <div style={{ padding: '16px 12px' }}>
      <h2 style={{ margin: '0 0 20px', fontSize: '18px', fontWeight: 700 }}>
        Settings
      </h2>

      {/* ── Grading System ── */}
      <div style={{ marginBottom: '24px' }}>
        <label style={labelStyle}>Grading System</label>
        <div style={{ display: 'flex', gap: '8px' }}>
          {[
            { val: 'V',    label: 'V-Grade', example: 'V0, V1, V2...' },
            { val: 'Font', label: 'Font',    example: '6A, 6B, 6C...' },
          ].map(({ val, label, example }) => (
            <button
              key={val}
              onClick={() => updateSettings('gradeSystem', val)}
              style={{
                flex: 1, padding: '12px', borderRadius: '10px', cursor: 'pointer',
                border:     settings.gradeSystem === val ? '2px solid var(--accent)' : '2px solid rgba(0,0,0,0.12)',
                background: settings.gradeSystem === val ? 'var(--accent-dim)'       : 'rgba(255,255,255,0.5)',
                color:      settings.gradeSystem === val ? 'var(--accent)'            : 'var(--text-secondary)',
                fontSize: '14px', fontWeight: 600, textAlign: 'center',
              }}
            >
              {label}
              <div style={{ fontSize: '10px', marginTop: '3px', color: 'var(--text-muted)', fontWeight: 400 }}>
                {example}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* ── Hold Manager ── */}
      <div style={{ marginBottom: '12px' }}>
        <button
          onClick={onSetupBoard}
          style={{
            width: '100%', padding: '12px', borderRadius: '10px', fontSize: '14px',
            fontWeight: 700, cursor: 'pointer', border: 'none',
            background: 'var(--accent)', color: '#fff',
            letterSpacing: '0.5px',
          }}
        >
          Hold Manager
        </button>
        <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: '6px', fontFamily: 'var(--font-heading)', textAlign: 'center' }}>
          {totalHolds} holds · Last detected: {holdsData.detectedAt}
        </div>
      </div>

      {/* ── Board Specs ── */}
      <div style={cardStyle}>
        <div style={sectionTitleStyle}>Board Specs</div>
        <div style={specGridStyle}>
          <SpecRow label="Width"       value={`${BOARD_SPECS.widthM}m`} />
          <SpecRow label="Height"      value={`${BOARD_SPECS.heightM}m`} />
          <SpecRow label="Angle range" value={`${BOARD_SPECS.minAngle}° – ${BOARD_SPECS.maxAngle}°`} />
          <SpecRow label="Holds (total)"    value={totalHolds} />
          <SpecRow label="Verified"         value={verifiedCount} />
          <SpecRow label="Custom"           value={customCount} />
        </div>
      </div>

      <div style={{ marginBottom: '32px' }} />
    </div>
  );
}

const COLOR_DOTS = {
  black: '#444', blue: '#0047FF', cyan: '#0047FF', purple: '#c084fc',
  green: '#22a870', orange: '#FF8C00', yellow: '#D4A000',
  pink: '#FF69B4', red: '#FF5252', white: '#888',
};

function HoldRow({ hold, onEdit, onDelete }) {
  const colorDot   = COLOR_DOTS[hold.color] ?? '#888';
  const displayName = hold.name || hold.id;
  const showId      = !!hold.name; // show ID as secondary only when a name is set

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '8px',
      padding: '6px 8px', borderRadius: '6px',
      background: 'rgba(255,255,255,0.6)', border: '1px solid rgba(0,0,0,0.1)',
    }}>
      <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: colorDot, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: '11px', fontWeight: hold.name ? 600 : 400,
          color: hold.verified ? 'var(--text-secondary)' : 'var(--yellow)',
          fontFamily: hold.name ? 'var(--font-body)' : 'var(--font-heading)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {displayName}{hold.custom ? ' ★' : ''}
        </div>
        <div style={{ fontSize: '10px', color: 'var(--text-dim)' }}>
          {showId ? `${hold.id} · ` : ''}{hold.color}
          {hold.holdTypes?.length > 0 ? ` · ${hold.holdTypes.slice(0,2).join(', ')}` : ''}
          {` · ${hold.cx}%, ${hold.cy}%`}
        </div>
      </div>
      <button onClick={onEdit}   style={rowBtnStyle('#0047FF')}>Edit</button>
      <button onClick={onDelete} style={rowBtnStyle('#FFAB94')}>✕</button>
    </div>
  );
}

function SpecRow({ label, value }) {
  return (
    <>
      <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ fontSize: '12px', color: 'var(--peach)', fontWeight: 600, textAlign: 'right', fontFamily: 'var(--font-heading)' }}>{value}</div>
    </>
  );
}

function rowBtnStyle(color) {
  return {
    padding: '3px 8px', borderRadius: '4px', fontSize: '10px', cursor: 'pointer',
    border: `1px solid ${color}55`, background: `${color}11`, color, flexShrink: 0,
  };
}

const sectionTitleStyle = {
  fontSize: '11px', fontWeight: 800, color: 'var(--accent)',
  letterSpacing: '1.5px', textTransform: 'uppercase', marginBottom: '10px',
  borderLeft: '3px solid var(--yellow)', paddingLeft: '8px',
};

const labelStyle = {
  fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '8px', display: 'block',
  fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase',
};

const cardStyle = {
  background: 'var(--bg-card)', borderRadius: '12px', padding: '16px', border: '1px solid var(--border)',
  boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
};

const specGridStyle = {
  display: 'grid', gridTemplateColumns: '1fr auto', gap: '6px 16px',
};
