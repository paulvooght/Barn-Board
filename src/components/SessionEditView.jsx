import { useState, useMemo } from 'react';
import { V_GRADES, FONT_GRADES } from '../utils/constants';
import { getWeekStart } from '../utils/sessionStats';

// Board angles
const BOARD_ANGLES = [18, 20, 25, 30, 35, 40, 45, 50, 55];

/**
 * Ordinal suffix: 1st, 2nd, 3rd, 4th…
 */
function ordinal(n) {
  if (n <= 0) return `${n}`;
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

/**
 * Format a Date as "Mon 26 May" (no year).
 */
function formatDate(d) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]}`;
}

/**
 * Compute "Nth session this (ISO) week" for `session` within `allSessions`.
 * ISO week: Monday → Sunday. Returns 1-based ordinal.
 */
function sessionOrdinalInWeek(session, allSessions) {
  const sessionDate = new Date(session.startTime);
  const weekStart = getWeekStart(sessionDate);
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000 - 1);

  const sessionsInWeek = allSessions
    .filter(s => {
      const t = new Date(s.startTime).getTime();
      return t >= weekStart.getTime() && t <= weekEnd.getTime();
    })
    .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

  const idx = sessionsInWeek.findIndex(s => s.id === session.id);
  return idx >= 0 ? idx + 1 : 1;
}

/**
 * SessionEditView
 *
 * Props:
 *   session       — the session object being edited
 *   allSessions   — full sessions array (for week-ordinal computation)
 *   gradeSystem   — 'V' or 'Font'
 *   onSave(updatedSession) — called with the modified session
 *   onCancel()    — back without saving
 */
export default function SessionEditView({ session, allSessions = [], gradeSystem = 'V', onSave, onCancel }) {
  // ── Derive initial duration ──
  const initDurationMs = session.startTime && session.endTime
    ? Math.max(0, new Date(session.endTime) - new Date(session.startTime))
    : 0;
  const initHours = Math.floor(initDurationMs / 3600000);
  const initMins  = Math.floor((initDurationMs % 3600000) / 60000);

  // ── Local form state ──
  const [hours, setHours] = useState(initHours);
  const [mins,  setMins]  = useState(initMins);
  const [anglesClimbed, setAnglesClimbed] = useState(session.anglesClimbed || []);
  const [warmupGrade, setWarmupGrade] = useState(session.warmupGrade || '');

  // ── Header info ──
  const sessionDate = new Date(session.startTime);
  const dateLabel = formatDate(sessionDate);
  const weekOrdinal = useMemo(
    () => sessionOrdinalInWeek(session, allSessions),
    [session, allSessions]
  );

  // ── Grades for warmup dropdown ──
  const grades = gradeSystem === 'Font' ? FONT_GRADES : V_GRADES;

  // ── Dirty check ──
  const isDirty = useMemo(() => {
    const newDurationMs = (hours * 3600 + mins * 60) * 1000;
    const origDurationMs = Math.round(initDurationMs / 60000) * 60000; // original rounded to minute
    const newDurRounded = Math.round(newDurationMs / 60000) * 60000;
    if (newDurRounded !== origDurationMs) return true;

    const origAngles = [...(session.anglesClimbed || [])].sort((a, b) => a - b);
    const nextAngles = [...anglesClimbed].sort((a, b) => a - b);
    if (JSON.stringify(origAngles) !== JSON.stringify(nextAngles)) return true;

    if ((warmupGrade || '') !== (session.warmupGrade || '')) return true;

    return false;
  }, [hours, mins, anglesClimbed, warmupGrade, session, initDurationMs]);

  // ── Save handler ──
  const handleSave = () => {
    const newEndTime = session.startTime
      ? new Date(new Date(session.startTime).getTime() + (hours * 3600 + mins * 60) * 1000).toISOString()
      : session.endTime;

    const updated = {
      ...session,
      endTime: newEndTime,
      anglesClimbed,
      warmupGrade: warmupGrade || undefined,
    };
    // Clean up undefined fields so they don't pollute stored JSON
    if (!updated.warmupGrade) delete updated.warmupGrade;

    onSave(updated);
  };

  // ── Angle chip toggle ──
  const toggleAngle = (angle) => {
    setAnglesClimbed(prev =>
      prev.includes(angle) ? prev.filter(a => a !== angle) : [...prev, angle]
    );
  };

  return (
    <div style={{ padding: '16px 12px', maxWidth: '480px', margin: '0 auto' }}>

      {/* ── Back + title bar ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '20px' }}>
        <button
          onClick={onCancel}
          style={{
            padding: '6px 14px', borderRadius: '8px', fontSize: '13px', fontWeight: 700,
            border: '1.5px solid rgba(26,10,0,0.15)', background: 'transparent',
            color: 'var(--text-secondary)', cursor: 'pointer', flexShrink: 0,
          }}
        >
          ← Back
        </button>
        <div style={{ flex: 1 }}>
          <div style={{
            fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)',
            fontFamily: 'var(--font-heading)',
          }}>
            {dateLabel}
          </div>
          <div style={{
            fontSize: '11px', color: 'var(--text-dim)',
            letterSpacing: '0.5px', marginTop: '1px',
          }}>
            {ordinal(weekOrdinal)} session this week
          </div>
        </div>
      </div>

      {/* ── Session Duration card ── */}
      <div style={cardStyle}>
        <div style={sectionTitleStyle}>Session Length</div>
        <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '12px', lineHeight: 1.4 }}>
          Adjusting duration moves the end time (start time stays fixed).
        </div>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-end' }}>
          <label style={{ flex: 1 }}>
            <div style={fieldLabelStyle}>Hours</div>
            <input
              type="number"
              min={0}
              max={12}
              value={hours}
              onChange={e => setHours(Math.max(0, Math.min(12, Number(e.target.value) || 0)))}
              style={numInputStyle}
            />
          </label>
          <div style={{ paddingBottom: '10px', fontSize: '18px', color: 'var(--text-muted)', fontFamily: 'var(--font-heading)' }}>:</div>
          <label style={{ flex: 1 }}>
            <div style={fieldLabelStyle}>Minutes</div>
            <input
              type="number"
              min={0}
              max={59}
              value={mins}
              onChange={e => setMins(Math.max(0, Math.min(59, Number(e.target.value) || 0)))}
              style={numInputStyle}
            />
          </label>
        </div>
        {hours === 0 && mins === 0 && (
          <div style={{ fontSize: '11px', color: '#e55', marginTop: '6px' }}>
            Duration is 0 — save will record a zero-length session.
          </div>
        )}
      </div>

      {/* ── Angles Climbed card ── */}
      <div style={{ ...cardStyle, marginTop: '12px' }}>
        <div style={sectionTitleStyle}>Angles Climbed</div>
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '4px',
        }}>
          {BOARD_ANGLES.map(angle => {
            const active = anglesClimbed.includes(angle);
            return (
              <button
                key={angle}
                onClick={() => toggleAngle(angle)}
                style={{
                  padding: '6px 12px', borderRadius: '8px', fontSize: '13px', fontWeight: 700,
                  cursor: 'pointer', border: 'none',
                  background: active ? 'var(--accent)' : 'rgba(26,10,0,0.07)',
                  color: active ? '#fff' : 'var(--text-secondary)',
                  fontFamily: 'var(--font-heading)',
                  transition: 'background 0.15s, color 0.15s',
                }}
              >
                {angle}°
              </button>
            );
          })}
        </div>
        {anglesClimbed.length === 0 && (
          <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: '8px' }}>
            No angles selected.
          </div>
        )}
      </div>

      {/* ── Warmup grade card ── */}
      <div style={{ ...cardStyle, marginTop: '12px' }}>
        <div style={sectionTitleStyle}>Warmed Up To</div>
        <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '10px', lineHeight: 1.4 }}>
          Optional. Sets the warm-up ceiling for this session's stats — routes at or below this grade count as warm-up.
        </div>
        <select
          value={warmupGrade}
          onChange={e => setWarmupGrade(e.target.value)}
          style={selectStyle}
        >
          <option value="">— Not set (use auto) —</option>
          {grades.map(g => (
            <option key={g} value={g}>{g}</option>
          ))}
        </select>
      </div>

      {/* ── Routes (next task) ── */}

      {/* ── Action row ── */}
      <div style={{ display: 'flex', gap: '10px', marginTop: '24px', paddingBottom: '32px' }}>
        <button
          onClick={handleSave}
          disabled={!isDirty}
          style={{
            flex: 1, padding: '13px', borderRadius: '10px', fontSize: '15px',
            fontWeight: 700, cursor: isDirty ? 'pointer' : 'not-allowed', border: 'none',
            background: isDirty ? 'var(--accent)' : 'rgba(26,10,0,0.1)',
            color: isDirty ? '#fff' : 'var(--text-muted)',
            transition: 'background 0.2s, color 0.2s',
          }}
        >
          Save
        </button>
        <button
          onClick={onCancel}
          style={{
            padding: '13px 20px', borderRadius: '10px', fontSize: '14px',
            fontWeight: 600, cursor: 'pointer',
            border: '1.5px solid rgba(26,10,0,0.15)',
            background: 'transparent', color: 'var(--text-secondary)',
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Shared style objects ──

const cardStyle = {
  background: 'var(--bg-card)', borderRadius: '12px', padding: '16px',
  border: '1px solid var(--border)', boxShadow: '0 2px 8px rgba(26,10,0,0.06)',
};

const sectionTitleStyle = {
  fontSize: '11px', fontWeight: 800, color: 'var(--accent)',
  letterSpacing: '1.5px', textTransform: 'uppercase', marginBottom: '10px',
  borderLeft: '3px solid var(--yellow)', paddingLeft: '8px',
};

const fieldLabelStyle = {
  fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)',
  letterSpacing: '0.8px', textTransform: 'uppercase', marginBottom: '5px',
  display: 'block',
};

const numInputStyle = {
  width: '100%', padding: '10px 12px', borderRadius: '8px', fontSize: '20px',
  fontFamily: 'var(--font-heading)', fontWeight: 700, textAlign: 'center',
  border: '1.5px solid rgba(26,10,0,0.15)', background: 'rgba(255,255,255,0.7)',
  color: 'var(--text-primary)', outline: 'none', boxSizing: 'border-box',
};

const selectStyle = {
  width: '100%', padding: '10px 12px', borderRadius: '8px', fontSize: '14px',
  border: '1.5px solid rgba(26,10,0,0.15)', background: 'rgba(255,255,255,0.7)',
  color: 'var(--text-primary)', fontFamily: 'inherit', outline: 'none',
  boxSizing: 'border-box', cursor: 'pointer',
};
