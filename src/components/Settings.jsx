import { BOARD_SPECS } from '../utils/constants';
import holdsData from '../data/holds.json';

/**
 * Props:
 *   settings, updateSettings — grade system etc.
 *   allHolds                 — merged hold array from useCustomHolds
 *   onAddHold()              — navigate to add-hold editor
 *   onEditHold(hold)         — navigate to edit-hold editor
 *   onDeleteHold(holdId)     — delete / hide a hold
 */
export default function Settings({ settings, updateSettings, allHolds, onAddHold, onEditHold, onDeleteHold, onSelectOnBoard }) {
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

      {/* ── Hold Management ── */}
      <div style={{ ...cardStyle, marginTop: '12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
          <div style={sectionTitleStyle}>Hold Management</div>
          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              onClick={onSelectOnBoard}
              style={{
                padding: '6px 12px', borderRadius: '20px', fontSize: '12px',
                fontWeight: 600, cursor: 'pointer',
                border: '1.5px solid rgba(0,71,255,0.35)',
                background: 'rgba(0,71,255,0.08)', color: 'var(--accent)',
              }}
            >
              Select on board
            </button>
            <button
              onClick={onAddHold}
              style={{
                padding: '6px 14px', borderRadius: '20px', fontSize: '12px',
                fontWeight: 700, cursor: 'pointer', border: 'none',
                background: 'var(--accent)', color: '#fff',
              }}
            >
              + Add Hold
            </button>
          </div>
        </div>

        <div style={{ fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: '10px' }}>
          Tap <strong style={{ color: 'var(--text-secondary)' }}>Edit</strong> to reposition or resize any hold boundary.
          Custom holds (★) can be deleted; auto-detected holds are hidden instead.
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', maxHeight: '38vh', overflowY: 'auto' }}>
          {allHolds.map(hold => (
            <HoldRow
              key={hold.id}
              hold={hold}
              onEdit={() => onEditHold(hold)}
              onDelete={() => onDeleteHold(hold.id)}
            />
          ))}
        </div>
      </div>

      {/* ── Hold Detection Info ── */}
      <div style={{ ...cardStyle, marginTop: '12px' }}>
        <div style={sectionTitleStyle}>Hold Detection</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.7 }}>
          Holds are auto-detected from the board photo using colour analysis.
          After resetting holds, take a new straight-on photo and re-run detection.
        </div>
        <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: '8px', fontFamily: 'var(--font-heading)' }}>
          Last detected: {holdsData.detectedAt}
        </div>
      </div>

      {/* ── About ── */}
      <div style={{ ...cardStyle, marginTop: '12px', marginBottom: '32px' }}>
        <div style={sectionTitleStyle}>About</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.7 }}>
          Phase 1 — Interactive board with hold detection, route creation, and local storage.
          Built for vibe coding with Claude.
        </div>
      </div>
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
