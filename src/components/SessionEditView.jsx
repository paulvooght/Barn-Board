import { useState, useMemo } from 'react';
import { V_GRADES, FONT_GRADES } from '../utils/constants';
import { getWeekStart } from '../utils/sessionStats';
import AngleStateChip from './AngleStateChip';

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
 * Get the available angles for a route.
 * Union of route.angle (headline) and all route.angleGrades[].angle values,
 * deduped and sorted ascending. Falls back to [] if neither is set.
 */
function getRouteAngles(route) {
  if (!route) return [];
  const set = new Set();
  if (route.angle != null) set.add(route.angle);
  if (route.angleGrades && route.angleGrades.length > 0) {
    route.angleGrades.forEach(ag => { if (ag.angle != null) set.add(ag.angle); });
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * Lookup the grade for a given angle on a route.
 * Falls back to route.grade if not found in angleGrades.
 */
function gradeForAngle(route, angle) {
  if (route.angleGrades) {
    const ag = route.angleGrades.find(a => a.angle === angle);
    if (ag) return ag.grade;
  }
  return route.grade;
}

// Ordering used to resolve conflicting/duplicate signals when initialising
// per-angle state from stored session data (flash beats sent beats tried).
const STATE_RANK = { empty: 0, tried: 1, sent: 2, flash: 3 };

/**
 * RoutePickerModal
 *
 * Props:
 *   routes       — full routes array
 *   playlists    — user's playlists [{ id, name, routeIds: [...] }]
 *   loggedIds    — Set of route IDs already logged (to show as already added)
 *   onPick(routeId) — called when user taps a route
 *   onClose()    — close without picking
 */
function RoutePickerModal({ routes, playlists = [], loggedIds = new Set(), onPick, onClose }) {
  const [tab, setTab] = useState('all'); // 'all' | 'playlists'
  const [searchText, setSearchText] = useState('');
  const [gradeFilter, setGradeFilter] = useState('');
  const [selectedPlaylist, setSelectedPlaylist] = useState(null);

  const filteredRoutes = useMemo(() => {
    let list = routes || [];
    if (selectedPlaylist) {
      const pl = playlists.find(p => p.id === selectedPlaylist);
      if (pl) list = list.filter(r => pl.routeIds.includes(r.id));
    }
    if (searchText.trim()) {
      const q = searchText.trim().toLowerCase();
      list = list.filter(r =>
        (r.name || '').toLowerCase().includes(q) ||
        (r.grade || '').toLowerCase().includes(q)
      );
    }
    if (gradeFilter) {
      list = list.filter(r => r.grade === gradeFilter);
    }
    return list;
  }, [routes, playlists, selectedPlaylist, searchText, gradeFilter]);

  const allGrades = useMemo(() => {
    const g = new Set((routes || []).map(r => r.grade).filter(Boolean));
    return [...g].sort();
  }, [routes]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(26,10,0,0.5)',
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg-page, #FFAB94)',
          borderRadius: '18px 18px 0 0',
          width: '100%', maxWidth: '480px',
          maxHeight: '85vh',
          display: 'flex', flexDirection: 'column',
          padding: '0 0 env(safe-area-inset-bottom, 0)',
        }}
      >
        {/* Handle bar */}
        <div style={{ display: 'flex', justifyContent: 'center', padding: '10px 0 6px' }}>
          <div style={{ width: '40px', height: '4px', borderRadius: '2px', background: 'rgba(26,10,0,0.2)' }} />
        </div>

        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '4px 16px 12px',
        }}>
          <div style={{ fontSize: '15px', fontWeight: 800, fontFamily: 'var(--font-heading)', color: 'var(--text-primary)' }}>
            Add Route
          </div>
          <button
            onClick={onClose}
            style={{
              width: '30px', height: '30px', borderRadius: '50%', border: 'none',
              background: 'rgba(26,10,0,0.1)', color: 'var(--text-primary)',
              fontSize: '16px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            ✕
          </button>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', padding: '0 16px', gap: '6px', marginBottom: '10px' }}>
          {['all', 'playlists'].map(t => (
            <button
              key={t}
              onClick={() => { setTab(t); setSelectedPlaylist(null); setSearchText(''); setGradeFilter(''); }}
              style={{
                padding: '7px 16px', borderRadius: '8px', border: 'none',
                fontSize: '13px', fontWeight: 700, cursor: 'pointer',
                background: tab === t ? 'var(--accent)' : 'rgba(26,10,0,0.08)',
                color: tab === t ? '#fff' : 'var(--text-secondary)',
                transition: 'background 0.15s, color 0.15s',
              }}
            >
              {t === 'all' ? 'All Routes' : 'Playlists'}
            </button>
          ))}
        </div>

        {tab === 'all' && (
          /* Search + filter row */
          <div style={{ display: 'flex', gap: '8px', padding: '0 16px', marginBottom: '10px' }}>
            <input
              type="text"
              placeholder="Search name or grade…"
              value={searchText}
              onChange={e => setSearchText(e.target.value)}
              style={{
                flex: 1, padding: '8px 12px', borderRadius: '8px', fontSize: '13px',
                border: '1.5px solid rgba(26,10,0,0.15)', background: 'rgba(255,255,255,0.7)',
                color: 'var(--text-primary)', outline: 'none', fontFamily: 'inherit',
              }}
            />
            <select
              value={gradeFilter}
              onChange={e => setGradeFilter(e.target.value)}
              style={{
                padding: '8px 10px', borderRadius: '8px', fontSize: '13px',
                border: '1.5px solid rgba(26,10,0,0.15)', background: 'rgba(255,255,255,0.7)',
                color: 'var(--text-primary)', fontFamily: 'inherit', outline: 'none', cursor: 'pointer',
              }}
            >
              <option value="">All grades</option>
              {allGrades.map(g => <option key={g} value={g}>{g}</option>)}
            </select>
          </div>
        )}

        {tab === 'playlists' && !selectedPlaylist && (
          <div style={{ padding: '0 16px 8px', fontSize: '11px', color: 'var(--text-dim)' }}>
            Tap a playlist to see its routes.
          </div>
        )}

        {tab === 'playlists' && selectedPlaylist && (
          <div style={{ padding: '0 16px 8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              onClick={() => setSelectedPlaylist(null)}
              style={{
                padding: '5px 12px', borderRadius: '7px', fontSize: '12px', fontWeight: 700,
                border: '1.5px solid rgba(26,10,0,0.15)', background: 'transparent',
                color: 'var(--text-secondary)', cursor: 'pointer',
              }}
            >
              ← Back
            </button>
            <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>
              {playlists.find(p => p.id === selectedPlaylist)?.name || 'Playlist'}
            </div>
          </div>
        )}

        {/* Scrollable list */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 16px 16px' }}>
          {tab === 'playlists' && !selectedPlaylist ? (
            playlists.length === 0 ? (
              <div style={{ padding: '20px 0', textAlign: 'center', fontSize: '13px', color: 'var(--text-dim)' }}>
                No playlists yet.
              </div>
            ) : (
              playlists.map(pl => (
                <button
                  key={pl.id}
                  onClick={() => setSelectedPlaylist(pl.id)}
                  style={{
                    width: '100%', padding: '12px 14px', borderRadius: '10px',
                    background: 'var(--bg-card)', border: '1px solid var(--border)',
                    marginBottom: '8px', cursor: 'pointer', textAlign: 'left',
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  }}
                >
                  <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>{pl.name}</span>
                  <span style={{ fontSize: '12px', color: 'var(--text-dim)' }}>
                    {(routes || []).filter(r => pl.routeIds.includes(r.id)).length} routes →
                  </span>
                </button>
              ))
            )
          ) : (
            filteredRoutes.length === 0 ? (
              <div style={{ padding: '20px 0', textAlign: 'center', fontSize: '13px', color: 'var(--text-dim)' }}>
                No routes found.
              </div>
            ) : (
              filteredRoutes.map(route => {
                const alreadyLogged = loggedIds.has(route.id);
                return (
                  <button
                    key={route.id}
                    onClick={() => !alreadyLogged && onPick(route.id)}
                    disabled={alreadyLogged}
                    style={{
                      width: '100%', padding: '10px 12px', borderRadius: '10px',
                      background: 'var(--bg-card)', border: `1px solid ${alreadyLogged ? 'rgba(26,10,0,0.08)' : 'var(--border)'}`,
                      marginBottom: '7px', cursor: alreadyLogged ? 'default' : 'pointer',
                      textAlign: 'left', display: 'flex', alignItems: 'center', gap: '10px',
                      opacity: alreadyLogged ? 0.5 : 1,
                    }}
                  >
                    <span style={{
                      background: 'var(--yellow)', color: 'var(--text-primary)',
                      padding: '3px 10px', borderRadius: '8px',
                      fontSize: '13px', fontWeight: 800, fontFamily: 'var(--font-heading)',
                      flexShrink: 0,
                    }}>
                      {route.grade}
                    </span>
                    <span style={{
                      flex: 1, fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>
                      {route.name || 'Unnamed route'}
                    </span>
                    {route.angle && (
                      <span style={{ fontSize: '11px', color: 'var(--accent)', fontFamily: 'var(--font-heading)', fontWeight: 700, flexShrink: 0 }}>
                        {route.angle}°
                      </span>
                    )}
                    {alreadyLogged && (
                      <span style={{ fontSize: '10px', color: 'var(--text-dim)', flexShrink: 0 }}>added</span>
                    )}
                  </button>
                );
              })
            )
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * SessionEditView
 *
 * Props:
 *   session       — the session object being edited
 *   allSessions   — full sessions array (for week-ordinal computation)
 *   gradeSystem   — 'V' or 'Font'
 *   routes        — full routes array (for route picker and name/grade display)
 *   playlists     — user's playlists
 *   onSave(updatedSession) — called with the modified session
 *   onCancel()    — back without saving
 */
export default function SessionEditView({
  session,
  allSessions = [],
  gradeSystem = 'V',
  routes = [],
  playlists = [],
  onSave,
  onCancel,
}) {
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

  // ── Route log state ──
  // Derive initial logged route IDs (union of all 4 sources)
  const initLoggedIds = useMemo(() => {
    const ids = new Set([
      ...(session.routesAttempted || []),
      ...(session.routesSent || []),
      ...((session.sends || []).map(s => s.routeId)),
      ...(session.flashedRouteIds || []),
    ]);
    return [...ids];
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- intentionally only on mount

  // Per-route, per-angle state: { [routeId]: { [angle]: 'tried' | 'sent' | 'flash' } }
  // Angles absent from a route's map are implicitly 'empty'.
  const initAngleStates = useMemo(() => {
    const map = {};
    initLoggedIds.forEach(id => {
      const route = (routes || []).find(r => r.id === id);
      const headlineAngle = route ? route.angle : undefined;
      const routeSends = (session.sends || []).filter(s => s.routeId === id);

      // Legacy back-compat: old sessions recorded flash at the route level
      // (flashedRouteIds) before flash was tracked per-angle on each send.
      const legacyFlash = (session.flashedRouteIds || []).includes(id)
        && !routeSends.some(s => s.flash === true);

      const angleStates = {};
      routeSends.forEach(send => {
        // A route-level send (no angle recorded) maps onto the route's
        // headline angle so it stays visible/editable instead of being lost.
        const angle = send.angle != null ? send.angle : headlineAngle;
        if (angle == null) return;
        const state = (send.flash === true || legacyFlash) ? 'flash' : 'sent';
        const existing = angleStates[angle];
        if (!existing || STATE_RANK[state] > STATE_RANK[existing]) {
          angleStates[angle] = state;
        }
      });

      const attemptsEntry = (session.angleAttempts || []).find(a => a.routeId === id);
      if (attemptsEntry) {
        (attemptsEntry.angles || []).forEach(angle => {
          if (!angleStates[angle]) angleStates[angle] = 'tried';
        });
      }

      // A route logged with no sends and no angleAttempts at all (attempted-only,
      // no angle data) still needs a visible/editable chip — seed its headline angle.
      if (Object.keys(angleStates).length === 0 && headlineAngle != null) {
        angleStates[headlineAngle] = 'tried';
      }

      map[id] = angleStates;
    });
    return map;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- intentionally only on mount

  const [loggedIds, setLoggedIds] = useState(initLoggedIds);
  const [routeAngleStates, setRouteAngleStates] = useState(initAngleStates);
  const [showPicker, setShowPicker] = useState(false);

  // ── Header info ──
  const sessionDate = new Date(session.startTime);
  const dateLabel = formatDate(sessionDate);
  const weekOrdinal = useMemo(
    () => sessionOrdinalInWeek(session, allSessions),
    [session, allSessions]
  );

  // ── Grades for warmup dropdown ──
  const grades = gradeSystem === 'Font' ? FONT_GRADES : V_GRADES;

  // ── Routes lookup map ──
  const routeMap = useMemo(() => {
    const m = {};
    (routes || []).forEach(r => { m[r.id] = r; });
    return m;
  }, [routes]);

  // ── Dirty check ──
  const isDirty = useMemo(() => {
    const newDurationMs = (hours * 3600 + mins * 60) * 1000;
    const origDurationMs = Math.round(initDurationMs / 60000) * 60000;
    const newDurRounded = Math.round(newDurationMs / 60000) * 60000;
    if (newDurRounded !== origDurationMs) return true;

    const origAngles = [...(session.anglesClimbed || [])].sort((a, b) => a - b);
    const nextAngles = [...anglesClimbed].sort((a, b) => a - b);
    if (JSON.stringify(origAngles) !== JSON.stringify(nextAngles)) return true;

    if ((warmupGrade || '') !== (session.warmupGrade || '')) return true;

    // Check route log changes
    const origLoggedIds = new Set([
      ...(session.routesAttempted || []),
      ...(session.routesSent || []),
      ...((session.sends || []).map(s => s.routeId)),
      ...(session.flashedRouteIds || []),
    ]);
    if (loggedIds.length !== origLoggedIds.size) return true;
    if (loggedIds.some(id => !origLoggedIds.has(id))) return true;

    // Check per-route, per-angle states
    const normalizeAngleStates = (m) =>
      Object.keys(m || {}).sort((a, b) => a - b).map(k => `${k}:${m[k]}`);
    for (const id of loggedIds) {
      const origNorm = normalizeAngleStates(initAngleStates[id]);
      const newNorm = normalizeAngleStates(routeAngleStates[id]);
      if (JSON.stringify(origNorm) !== JSON.stringify(newNorm)) return true;
    }

    return false;
  }, [hours, mins, anglesClimbed, warmupGrade, loggedIds, routeAngleStates, session, initDurationMs, initAngleStates]);

  // ── Route log handlers ──

  const handleAddRoute = (routeId) => {
    if (loggedIds.includes(routeId)) return; // no-op if already logged
    setLoggedIds(prev => [...prev, routeId]);
    setRouteAngleStates(prev => ({ ...prev, [routeId]: {} }));
    setShowPicker(false);
  };

  const handleRemoveRoute = (routeId) => {
    setLoggedIds(prev => prev.filter(id => id !== routeId));
    setRouteAngleStates(prev => {
      const next = { ...prev };
      delete next[routeId];
      return next;
    });
  };

  // Cycle one angle's state on one route: empty → tried → sent → flash → empty.
  const handleCycleAngleState = (routeId, angle) => {
    setRouteAngleStates(prev => {
      const routeStates = prev[routeId] || {};
      const cur = routeStates[angle] || 'empty';
      const next = cur === 'empty' ? 'tried'
                 : cur === 'tried' ? 'sent'
                 : cur === 'sent'  ? 'flash'
                 :                   'empty';
      const nextRouteStates = { ...routeStates };
      if (next === 'empty') {
        delete nextRouteStates[angle];
      } else {
        nextRouteStates[angle] = next;
      }
      return { ...prev, [routeId]: nextRouteStates };
    });
  };

  // ── Save handler ──
  const handleSave = () => {
    const newEndTime = session.startTime
      ? new Date(new Date(session.startTime).getTime() + (hours * 3600 + mins * 60) * 1000).toISOString()
      : session.endTime;

    // routesAttempted = every logged route, regardless of angle state — the
    // trash button is how a route leaves a session, not an empty chip state.
    const newRoutesAttempted = [...loggedIds];

    const timestampForSends = session.endTime || session.startTime || new Date().toISOString();
    const newSends = [];
    const newRoutesSentSet = new Set();
    const newFlashedSet = new Set();
    const newAngleAttempts = [];

    loggedIds.forEach(routeId => {
      const route = routeMap[routeId];
      const angleStates = routeAngleStates[routeId] || {};
      const loggedAngles = Object.keys(angleStates).map(Number).sort((a, b) => a - b);

      // Every angle with any non-empty state (tried, sent, or flash) counts
      // as an attempt — flash ⊂ sent ⊂ tried, matching live logging in App.jsx.
      if (loggedAngles.length > 0) {
        newAngleAttempts.push({ routeId, angles: loggedAngles });
      }

      loggedAngles.forEach(angle => {
        const state = angleStates[angle];
        if (state !== 'sent' && state !== 'flash') return;
        newRoutesSentSet.add(routeId);
        const send = {
          routeId,
          angle,
          grade: route ? gradeForAngle(route, angle) : '',
          time: timestampForSends,
        };
        if (state === 'flash') {
          send.flash = true;
          newFlashedSet.add(routeId);
        }
        newSends.push(send);
      });
    });

    const updated = {
      ...session,
      endTime: newEndTime,
      anglesClimbed,
      warmupGrade: warmupGrade || undefined,
      routesAttempted: newRoutesAttempted,
      routesSent: [...newRoutesSentSet],
      sends: newSends,
      flashedRouteIds: newFlashedSet.size > 0 ? [...newFlashedSet] : undefined,
      angleAttempts: newAngleAttempts.length > 0 ? newAngleAttempts : undefined,
    };
    // Clean up undefined fields
    if (!updated.warmupGrade) delete updated.warmupGrade;
    if (!updated.flashedRouteIds) delete updated.flashedRouteIds;
    if (!updated.angleAttempts) delete updated.angleAttempts;

    onSave(updated);
  };

  // ── Angle chip toggle (session-level) ──
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

      {/* ── Routes Logged card ── */}
      <div style={{ ...cardStyle, marginTop: '12px' }}>
        <div style={sectionTitleStyle}>Routes Logged</div>

        {loggedIds.length === 0 && (
          <div style={{ fontSize: '12px', color: 'var(--text-dim)', marginBottom: '10px', lineHeight: 1.4 }}>
            No routes logged on this session yet.
          </div>
        )}

        {loggedIds.map(routeId => {
          const route = routeMap[routeId];
          const angleStates = routeAngleStates[routeId] || {};
          // Chips shown = the route's defined angles ∪ any angle that already
          // has a state (so an angle logged in this session but no longer
          // graded on the route still shows and can be cleared).
          const chipAngleSet = new Set(route ? getRouteAngles(route) : []);
          Object.keys(angleStates).forEach(a => chipAngleSet.add(Number(a)));
          const chipAngles = [...chipAngleSet].sort((a, b) => a - b);

          return (
            <div
              key={routeId}
              style={{
                borderRadius: '10px', padding: '10px 12px', marginBottom: '8px',
                background: 'rgba(255,255,255,0.5)',
                border: '1px solid rgba(26,10,0,0.1)',
              }}
            >
              {/* Top row: grade pill + name + trash */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                <span style={{
                  background: 'var(--yellow)', color: 'var(--text-primary)',
                  padding: '3px 10px', borderRadius: '8px',
                  fontSize: '12px', fontWeight: 800, fontFamily: 'var(--font-heading)',
                  flexShrink: 0,
                }}>
                  {route?.grade || '?'}
                </span>
                <span style={{
                  flex: 1, fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {route?.name || routeId}
                </span>
                <button
                  onClick={() => handleRemoveRoute(routeId)}
                  title="Remove from session"
                  style={{
                    width: '28px', height: '28px', borderRadius: '7px', border: 'none',
                    background: 'rgba(220,50,50,0.1)', color: '#dc3232',
                    fontSize: '14px', cursor: 'pointer', flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  🗑
                </button>
              </div>

              {/* Per-angle 4-state chips — grade + angle, colour conveys state */}
              {chipAngles.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                  {chipAngles.map(angle => (
                    <AngleStateChip
                      key={angle}
                      grade={route ? gradeForAngle(route, angle) : ''}
                      angle={angle}
                      state={angleStates[angle] || 'empty'}
                      onClick={() => handleCycleAngleState(routeId, angle)}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {/* Add route button */}
        <button
          onClick={() => setShowPicker(true)}
          style={{
            width: '100%', padding: '10px', borderRadius: '9px',
            border: '1.5px dashed rgba(26,10,0,0.2)', background: 'transparent',
            color: 'var(--accent)', fontSize: '13px', fontWeight: 700, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
            marginTop: loggedIds.length > 0 ? '4px' : '0',
          }}
        >
          + Add route
        </button>
      </div>

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

      {/* ── Route picker modal ── */}
      {showPicker && (
        <RoutePickerModal
          routes={routes}
          playlists={playlists}
          loggedIds={new Set(loggedIds)}
          onPick={handleAddRoute}
          onClose={() => setShowPicker(false)}
        />
      )}
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
