import TagPicker from './TagPicker';
import { HOLD_TYPES, TECHNIQUES, STYLES, BOARD_SPECS } from '../utils/constants';

export default function RouteForm({
  name, setName,
  grade, setGrade,
  angle, setAngle,
  holdTypes, setHoldTypes,
  techniques, setTechniques,
  styles, setStyles,
  grades,
  selectedCount,
  onSave,
  onCancel,
  isEditing,
}) {
  const toggleTag = (list, setter, tag) => {
    setter(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]);
  };

  const canSave = name.trim() && selectedCount > 0;

  return (
    <div style={{ padding: '0 12px', marginTop: '16px' }}>
      {/* Route Name */}
      <div style={{ marginBottom: '14px' }}>
        <label style={labelStyle}>Route Name</label>
        <input
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="e.g. Barn Burner"
          style={inputStyle}
        />
      </div>

      {/* Grade + Angle */}
      <div style={{ display: 'flex', gap: '12px', marginBottom: '14px' }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Grade</label>
          <select value={grade} onChange={e => setGrade(e.target.value)} style={inputStyle}>
            {grades.map(g => <option key={g} value={g}>{g}</option>)}
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Board Angle</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <input
              type="range"
              min={BOARD_SPECS.minAngle}
              max={BOARD_SPECS.maxAngle}
              value={angle}
              onChange={e => setAngle(Number(e.target.value))}
              style={{ flex: 1 }}
            />
            <span style={{
              color: 'var(--accent)',
              fontWeight: 700,
              fontSize: '14px',
              fontFamily: 'var(--font-heading)',
              minWidth: '36px',
              textAlign: 'right',
            }}>
              {angle}°
            </span>
          </div>
        </div>
      </div>

      {/* Metadata Tags */}
      <TagPicker label="Hold Types" options={HOLD_TYPES} selected={holdTypes}
        onToggle={t => toggleTag(holdTypes, setHoldTypes, t)} />
      <TagPicker label="Techniques" options={TECHNIQUES} selected={techniques}
        onToggle={t => toggleTag(techniques, setTechniques, t)} />
      <TagPicker label="Style" options={STYLES} selected={styles}
        onToggle={t => toggleTag(styles, setStyles, t)} />

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: '10px', marginTop: '18px', paddingBottom: '32px' }}>
        <button onClick={onCancel} style={cancelBtnStyle}>
          Cancel
        </button>
        <button
          onClick={onSave}
          disabled={!canSave}
          style={{
            ...saveBtnStyle,
            background: canSave ? 'var(--accent)' : '#333',
            color: canSave ? '#000' : '#666',
            cursor: canSave ? 'pointer' : 'not-allowed',
          }}
        >
          {isEditing ? `Update Route (${selectedCount} holds)` : `Save Route (${selectedCount} holds)`}
        </button>
      </div>
    </div>
  );
}

const labelStyle = {
  fontSize: '11px',
  color: 'var(--text-secondary)',
  marginBottom: '6px',
  display: 'block',
  fontWeight: 700,
  letterSpacing: '1px',
  textTransform: 'uppercase',
};

const inputStyle = {
  width: '100%',
  padding: '10px 12px',
  borderRadius: '8px',
  border: '1.5px solid rgba(0,0,0,0.15)',
  background: 'var(--bg-input)',
  color: 'var(--text-primary)',
  fontSize: '14px',
  boxSizing: 'border-box',
};

const cancelBtnStyle = {
  flex: 1,
  padding: '12px',
  borderRadius: '10px',
  border: '1px solid rgba(0,0,0,0.15)',
  background: 'rgba(0,0,0,0.06)',
  color: 'var(--text-secondary)',
  fontSize: '14px',
  fontWeight: 600,
  cursor: 'pointer',
};

const saveBtnStyle = {
  flex: 2,
  padding: '12px',
  borderRadius: '10px',
  border: 'none',
  fontSize: '14px',
  fontWeight: 700,
};
