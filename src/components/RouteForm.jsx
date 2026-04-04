import { useEffect, useRef } from 'react';
import TagPicker from './TagPicker';
import { HOLD_TYPES, TECHNIQUES, STYLES, BOARD_SPECS, getYouTubeId, getYouTubeThumbnail } from '../utils/constants';

export default function RouteForm({
  name, setName,
  grade, setGrade,
  angle, setAngle,
  setter, setSetter,
  description, setDescription,
  youtubeUrl, setYoutubeUrl,
  holdTypes, setHoldTypes,
  autoHoldTypes,
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

  // Auto-merge hold types from hold metadata into route hold types
  const prevAutoRef = useRef([]);
  useEffect(() => {
    if (!autoHoldTypes || autoHoldTypes.length === 0) return;
    const prev = prevAutoRef.current;
    const newAuto = autoHoldTypes.filter(t => !prev.includes(t));
    if (newAuto.length > 0) {
      setHoldTypes(current => {
        const merged = new Set([...current, ...newAuto]);
        return [...merged];
      });
    }
    prevAutoRef.current = autoHoldTypes;
  }, [autoHoldTypes, setHoldTypes]);

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

      {/* Setter */}
      <div style={{ marginBottom: '14px' }}>
        <label style={labelStyle}>Setter</label>
        <input
          type="text"
          value={setter}
          onChange={e => setSetter(e.target.value)}
          placeholder="e.g. Paul"
          style={inputStyle}
        />
      </div>

      {/* Description */}
      <div style={{ marginBottom: '14px' }}>
        <label style={labelStyle}>Description</label>
        <input
          type="text"
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="e.g. Any feet, campus only"
          style={inputStyle}
        />
      </div>

      {/* YouTube Beta */}
      <div style={{ marginBottom: '14px' }}>
        <label style={labelStyle}>
          Beta Video
          <span style={{
            marginLeft: '6px', fontSize: '8px', fontWeight: 800,
            background: '#FF2D78', color: '#fff', padding: '1px 5px',
            borderRadius: '4px', letterSpacing: '0.5px', verticalAlign: 'middle',
          }}>BETA</span>
        </label>
        <input
          type="url"
          value={youtubeUrl}
          onChange={e => setYoutubeUrl(e.target.value)}
          placeholder="Paste YouTube link..."
          style={inputStyle}
        />
        {getYouTubeThumbnail(youtubeUrl) && (
          <div style={{ marginTop: '8px', borderRadius: '8px', overflow: 'hidden', position: 'relative' }}>
            <img
              src={getYouTubeThumbnail(youtubeUrl)}
              alt="Video thumbnail"
              style={{ width: '100%', display: 'block', borderRadius: '8px' }}
            />
            <div style={{
              position: 'absolute', top: '50%', left: '50%',
              transform: 'translate(-50%, -50%)',
              width: '36px', height: '36px', borderRadius: '50%',
              background: 'rgba(26,10,0,0.6)', display: 'flex',
              alignItems: 'center', justifyContent: 'center',
            }}>
              <span style={{ color: '#fff', fontSize: '14px', marginLeft: '2px' }}>▶</span>
            </div>
          </div>
        )}
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
        onToggle={t => toggleTag(holdTypes, setHoldTypes, t)}
        highlighted={autoHoldTypes} />
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
            background: canSave ? 'var(--accent)' : 'var(--text-muted)',
            color: canSave ? '#fff' : 'var(--text-dim)',
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
  border: '1.5px solid rgba(26,10,0,0.15)',
  background: 'var(--bg-input)',
  color: 'var(--text-primary)',
  fontSize: '14px',
  boxSizing: 'border-box',
};

const cancelBtnStyle = {
  flex: 1,
  padding: '12px',
  borderRadius: '10px',
  border: '1px solid rgba(26,10,0,0.15)',
  background: 'rgba(26,10,0,0.06)',
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
