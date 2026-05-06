/**
 * sessionStats.js — Pure stats functions for the Sessions / Climber Card view.
 * All functions are side-effect-free and testable.
 */

import {
  V_GRADES, FONT_GRADES, V_GRADE_INDEX, FONT_GRADE_INDEX,
} from './constants';

// ─── Period helpers ──────────────────────────────────────────────────────────

/**
 * Returns a Date set to Monday 00:00:00 of the week containing `date`.
 */
export function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0 = Sunday, 1 = Monday, …
  const diff = (day === 0 ? -6 : 1 - day); // shift to Monday
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Returns a Date set to the 1st of the month containing `date` at 00:00:00.
 */
export function getMonthStart(date) {
  const d = new Date(date);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Returns true if `timestamp` falls within [period.start, period.end].
 * period.start / end can be Date objects, timestamps (ms), or ±Infinity.
 */
export function isInPeriod(timestamp, period) {
  const t = new Date(timestamp).getTime();
  const s = period.start === -Infinity ? -Infinity : new Date(period.start).getTime();
  const e = period.end === Infinity ? Infinity : new Date(period.end).getTime();
  return t >= s && t <= e;
}

// ─── Period descriptor ───────────────────────────────────────────────────────

/**
 * Format a session start time into a human label like "May 5 evening".
 */
function formatSessionLabel(isoString) {
  const d = new Date(isoString);
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const month = monthNames[d.getMonth()];
  const day = d.getDate();
  const hour = d.getHours();
  let timeOfDay;
  if (hour < 12) timeOfDay = 'morning';
  else if (hour < 17) timeOfDay = 'afternoon';
  else timeOfDay = 'evening';
  return `${month} ${day} ${timeOfDay}`;
}

/**
 * Build a normalised period descriptor from a type + anchor.
 *
 * @param {'session'|'week'|'month'|'all'} type
 * @param {*} anchor  — sessionId string for 'session', Date-like for 'week'/'month', anything for 'all'
 * @param {Array} [sessions]  — full sessions array, required when type === 'session'
 * @returns {{ type, label, start, end, sessionId? }}
 */
export function makePeriod(type, anchor, sessions = []) {
  if (type === 'all') {
    return { type: 'all', label: 'All time', start: -Infinity, end: Infinity };
  }

  if (type === 'session') {
    const sessionId = anchor;
    const session = sessions.find(s => s.id === sessionId);
    if (!session) {
      // Fallback: return all-time if session not found
      return { type: 'all', label: 'All time', start: -Infinity, end: Infinity };
    }
    const start = new Date(session.startTime);
    const end = session.endTime ? new Date(session.endTime) : new Date();
    return {
      type: 'session',
      label: formatSessionLabel(session.startTime),
      start,
      end,
      sessionId,
    };
  }

  if (type === 'week') {
    const anchorDate = anchor ? new Date(anchor) : new Date();
    const weekStart = getWeekStart(anchorDate);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 7);
    weekEnd.setMilliseconds(-1);
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const label = `Week of ${monthNames[weekStart.getMonth()]} ${weekStart.getDate()}`;
    return { type: 'week', label, start: weekStart, end: weekEnd };
  }

  if (type === 'month') {
    const anchorDate = anchor ? new Date(anchor) : new Date();
    const monthStart = getMonthStart(anchorDate);
    const monthEnd = new Date(monthStart);
    monthEnd.setMonth(monthEnd.getMonth() + 1);
    monthEnd.setMilliseconds(-1);
    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const label = `${monthNames[monthStart.getMonth()]} ${monthStart.getFullYear()}`;
    return { type: 'month', label, start: monthStart, end: monthEnd };
  }

  return { type: 'all', label: 'All time', start: -Infinity, end: Infinity };
}

// ─── Period listing ──────────────────────────────────────────────────────────

/**
 * List available past periods. Returns array of period descriptors, most recent first.
 *
 * @param {Array} sessions
 * @param {'session'|'week'|'month'|'all'} type
 * @returns {Array<{type, label, start, end, sessionId?}>}
 */
export function listAvailablePeriods(sessions, type) {
  if (!sessions || sessions.length === 0) return [];

  if (type === 'all') {
    return [{ type: 'all', label: 'All time', start: -Infinity, end: Infinity }];
  }

  if (type === 'session') {
    // One per session, most recent first
    return [...sessions]
      .sort((a, b) => new Date(b.startTime) - new Date(a.startTime))
      .map(s => makePeriod('session', s.id, sessions));
  }

  if (type === 'week') {
    const seen = new Set();
    const periods = [];
    [...sessions]
      .sort((a, b) => new Date(b.startTime) - new Date(a.startTime))
      .forEach(s => {
        const ws = getWeekStart(new Date(s.startTime));
        const key = ws.toISOString();
        if (!seen.has(key)) {
          seen.add(key);
          periods.push(makePeriod('week', ws));
        }
      });
    return periods;
  }

  if (type === 'month') {
    const seen = new Set();
    const periods = [];
    [...sessions]
      .sort((a, b) => new Date(b.startTime) - new Date(a.startTime))
      .forEach(s => {
        const ms = getMonthStart(new Date(s.startTime));
        const key = ms.toISOString();
        if (!seen.has(key)) {
          seen.add(key);
          periods.push(makePeriod('month', ms));
        }
      });
    return periods;
  }

  return [];
}

// ─── Filter helpers ───────────────────────────────────────────────────────────

/**
 * Filter sessions to those with startTime overlapping a period.
 */
export function filterSessions(sessions, period) {
  if (!sessions || sessions.length === 0) return [];
  if (period.type === 'all') return sessions;
  return sessions.filter(s => isInPeriod(s.startTime, period));
}

/**
 * Filter sends across all sessions to those whose time falls in the period.
 * Returns flat array of { routeId, angle, grade, time, sessionId }.
 */
export function filterSends(sessions, period) {
  if (!sessions || sessions.length === 0) return [];
  const result = [];
  const periodSessions = filterSessions(sessions, period);
  for (const session of periodSessions) {
    for (const send of (session.sends || [])) {
      result.push({ ...send, sessionId: session.id });
    }
  }
  return result;
}

// ─── Grade utilities ──────────────────────────────────────────────────────────

/**
 * Get the numeric index of a grade string (grade system–agnostic).
 * Returns -1 if unknown.
 */
function getGradeIndex(gradeStr, gradeSystem) {
  if (!gradeStr) return -1;
  if (gradeSystem === 'Font') {
    const idx = FONT_GRADE_INDEX[gradeStr];
    return idx !== undefined ? idx : -1;
  }
  const idx = V_GRADE_INDEX[gradeStr];
  return idx !== undefined ? idx : -1;
}

/**
 * Format a grade index back to a display string.
 */
function gradeFromIndex(index, gradeSystem) {
  if (index < 0) return null;
  if (gradeSystem === 'Font') return FONT_GRADES[index] || null;
  return V_GRADES[index] || null;
}

// ─── Frequency helpers ────────────────────────────────────────────────────────

/**
 * Given an array of values, return the most frequent value (alphabetical tie-break).
 */
function mostFrequent(arr) {
  if (!arr || arr.length === 0) return null;
  const counts = {};
  for (const v of arr) {
    if (v == null) continue;
    counts[v] = (counts[v] || 0) + 1;
  }
  const keys = Object.keys(counts);
  if (keys.length === 0) return null;
  let best = keys[0];
  for (const k of keys) {
    if (counts[k] > counts[best] || (counts[k] === counts[best] && k < best)) {
      best = k;
    }
  }
  return best;
}

// ─── Climber type ─────────────────────────────────────────────────────────────

/**
 * Choose a fun climber-type label from top hold type + top technique.
 */
export function getClimberType(commonHoldType, commonTechnique) {
  if (!commonHoldType) return 'Versatile Climber';

  const h = commonHoldType;
  const t = commonTechnique;

  if (h === 'Crimps' && t === 'Heel hooks') return 'Technical Crimper';
  if (h === 'Crimps') return 'Crimp Master';
  if (h === 'Slopers' && t === 'Dynos') return 'Power Sloper';
  if (h === 'Slopers') return 'Sloper Specialist';
  if (h === 'Pinches' && t === 'Dynos') return 'Power Pincher';
  if (h === 'Pinches') return 'Pinch Specialist';
  if (h === 'Jugs') return 'Jug Hauler';
  if (h === 'Pockets') return 'Pocket Surgeon';
  if (h === 'Edges' && t === 'Heel hooks') return 'Heel-Hook Hunter';
  if (h === 'Edges') return 'Edge Worker';
  if (h === 'Undercuts') return 'Undercut Beast';
  if (h === 'Volumes' && t === 'Toe hooks') return 'Volume Dancer';
  if (h === 'Volumes') return 'Volume Rider';
  if (h === 'Macro') return 'Macro Magician';
  if (h === 'Mini jug') return 'Mini-Jug Cruiser';
  if (h === 'Jibs') return 'Jib Master';
  return 'Versatile Climber';
}

// ─── Core stats computation ───────────────────────────────────────────────────

/**
 * Compute headline stats for a period.
 *
 * @param {Array} sessions  — all sessions
 * @param {Array} routes    — all routes (shared route data)
 * @param {Object} userRouteData — { [routeId]: { sent, flashed, rating, angleSends, gradeSuggestions, attempted } }
 * @param {Object} period   — period descriptor from makePeriod()
 * @param {string} gradeSystem — 'V' or 'Font'
 * @returns {Object}
 */
export function computeStats(sessions, routes, userRouteData, period, gradeSystem = 'V') {
  const safeSessions = sessions || [];
  const safeRoutes = routes || [];
  const safeURD = userRouteData || {};

  const periodSessions = filterSessions(safeSessions, period);
  const periodSends = filterSends(safeSessions, period);

  const sessionCount = periodSessions.length;
  const sendCount = periodSends.length;

  // Flash count — check userRouteData.flashed for each sent route in this period
  let flashCount = 0;
  const seenFlashRoutes = new Set();
  for (const send of periodSends) {
    if (!seenFlashRoutes.has(send.routeId)) {
      seenFlashRoutes.add(send.routeId);
      if (safeURD[send.routeId]?.flashed) flashCount++;
    }
  }

  // Avg sends per session
  const avgSendsPerSession = sessionCount > 0 ? sendCount / sessionCount : 0;

  // Avg session length in minutes
  let totalDurationMin = 0;
  let durCount = 0;
  for (const s of periodSessions) {
    if (s.startTime && s.endTime) {
      const mins = (new Date(s.endTime) - new Date(s.startTime)) / 60000;
      if (mins > 0 && mins < 1440) { // sanity check: ignore >24h
        totalDurationMin += mins;
        durCount++;
      }
    }
  }
  const avgSessionLengthMin = durCount > 0 ? Math.round(totalDurationMin / durCount) : null;

  // Avg sessions per week
  let avgSessionsPerWeek = null;
  if (sessionCount > 0 && period.type !== 'session') {
    if (period.type === 'all') {
      // Calculate weeks span from first to last session
      const times = safeSessions.map(s => new Date(s.startTime).getTime());
      const spanMs = Math.max(...times) - Math.min(...times);
      const spanWeeks = spanMs / (7 * 24 * 60 * 60 * 1000);
      avgSessionsPerWeek = spanWeeks > 0 ? safeSessions.length / spanWeeks : null;
    } else {
      const periodStart = new Date(period.start).getTime();
      const periodEnd = new Date(period.end).getTime();
      const periodMs = periodEnd - periodStart;
      const periodWeeks = periodMs / (7 * 24 * 60 * 60 * 1000);
      avgSessionsPerWeek = periodWeeks > 0 ? sessionCount / periodWeeks : null;
    }
  }

  // Top grade in period
  let topGradeIndex = -1;
  for (const send of periodSends) {
    const idx = getGradeIndex(send.grade, gradeSystem);
    if (idx > topGradeIndex) topGradeIndex = idx;
  }
  const topGrade = topGradeIndex >= 0 ? gradeFromIndex(topGradeIndex, gradeSystem) : null;

  // Top grade by angle — only angles with sends
  const gradeByAngle = {};
  for (const send of periodSends) {
    const angle = send.angle;
    if (angle == null) continue;
    const idx = getGradeIndex(send.grade, gradeSystem);
    if (idx < 0) continue;
    if (gradeByAngle[angle] === undefined || idx > gradeByAngle[angle]) {
      gradeByAngle[angle] = idx;
    }
  }
  const topGradeByAngle = {};
  for (const [angle, idx] of Object.entries(gradeByAngle)) {
    const g = gradeFromIndex(idx, gradeSystem);
    if (g) topGradeByAngle[angle] = g;
  }

  // Collect grades, hold types, techniques, styles, angles from sends in period
  const gradeValues = [];
  const holdTypeValues = [];
  const techniqueValues = [];
  const styleValues = [];
  const angleValues = [];

  for (const send of periodSends) {
    if (send.grade) gradeValues.push(send.grade);
    if (send.angle != null) angleValues.push(send.angle);

    const route = safeRoutes.find(r => r.id === send.routeId);
    if (route) {
      if (Array.isArray(route.holdTypes)) holdTypeValues.push(...route.holdTypes);
      if (Array.isArray(route.techniques)) techniqueValues.push(...route.techniques);
      if (Array.isArray(route.styles)) styleValues.push(...route.styles);
    }
  }

  const commonGrade = mostFrequent(gradeValues);
  const commonHoldTypes = mostFrequent(holdTypeValues);
  const commonTechniques = mostFrequent(techniqueValues);
  const commonStyles = mostFrequent(styleValues);
  const commonAngles = mostFrequent(angleValues.map(String));

  // Strengths and weaknesses by hold type
  // For each hold type, find routes the user has sent that include it, compute avg grade index
  // Then filter to routes also sent within this period for period-scoped analysis
  const sentRouteIds = new Set(periodSends.map(s => s.routeId));

  const holdTypeGrades = {}; // { holdType: [gradeIndex, ...] }
  for (const routeId of sentRouteIds) {
    const route = safeRoutes.find(r => r.id === routeId);
    if (!route || !Array.isArray(route.holdTypes)) continue;
    const idx = getGradeIndex(route.grade, gradeSystem);
    if (idx < 0) continue;
    for (const ht of route.holdTypes) {
      if (!holdTypeGrades[ht]) holdTypeGrades[ht] = [];
      holdTypeGrades[ht].push(idx);
    }
  }

  const holdTypeStats = Object.entries(holdTypeGrades)
    .filter(([, grades]) => grades.length >= 2)
    .map(([holdType, grades]) => {
      const avg = grades.reduce((a, b) => a + b, 0) / grades.length;
      return { holdType, avgGradeIndex: avg, count: grades.length };
    })
    .sort((a, b) => b.avgGradeIndex - a.avgGradeIndex || a.holdType.localeCompare(b.holdType));

  const strengths = holdTypeStats.slice(0, 3).map(({ holdType, avgGradeIndex, count }) => ({
    holdType,
    avgGrade: gradeFromIndex(Math.round(avgGradeIndex), gradeSystem),
    count,
  }));
  const weaknesses = holdTypeStats.slice(-3).reverse().map(({ holdType, avgGradeIndex, count }) => ({
    holdType,
    avgGrade: gradeFromIndex(Math.round(avgGradeIndex), gradeSystem),
    count,
  }));
  // Avoid overlap when there are <= 6 total types
  const strengthSet = new Set(strengths.map(s => s.holdType));
  const filteredWeaknesses = weaknesses.filter(w => !strengthSet.has(w.holdType));

  // Routes created in period
  let createdCount = 0;
  for (const s of periodSessions) {
    createdCount += (s.routesCreated || []).length;
  }

  const climberType = getClimberType(commonHoldTypes, commonTechniques);

  return {
    sendCount,
    flashCount,
    sessionCount,
    avgSendsPerSession: Math.round(avgSendsPerSession * 10) / 10,
    avgSessionLengthMin,
    avgSessionsPerWeek: avgSessionsPerWeek != null ? Math.round(avgSessionsPerWeek * 10) / 10 : null,
    topGrade,
    topGradeIndex,
    topGradeByAngle,
    commonGrade,
    commonHoldTypes,
    commonTechniques,
    commonStyles,
    commonAngles,
    strengths,
    weaknesses: filteredWeaknesses,
    createdCount,
    climberType,
    isAllTime: period.type === 'all',
  };
}

// ─── Delta computation ────────────────────────────────────────────────────────

/**
 * Compute numeric deltas between current and previous stats.
 * Returns null for a field if previousStats is null/undefined.
 */
export function computeDelta(currentStats, previousStats) {
  if (!previousStats) return null;

  const delta = {};

  const numFields = ['sendCount', 'flashCount', 'sessionCount', 'avgSendsPerSession'];
  for (const f of numFields) {
    const curr = currentStats?.[f];
    const prev = previousStats?.[f];
    delta[f] = (curr != null && prev != null) ? curr - prev : null;
  }

  const currTopIdx = currentStats?.topGradeIndex ?? -1;
  const prevTopIdx = previousStats?.topGradeIndex ?? -1;
  delta.topGradeIndex = (currTopIdx >= 0 && prevTopIdx >= 0) ? currTopIdx - prevTopIdx : null;

  return delta;
}

// ─── Period navigation ────────────────────────────────────────────────────────

/**
 * Get the period immediately before `period` in time.
 * Returns null if there is no previous period.
 */
export function previousPeriod(period, sessions) {
  const available = listAvailablePeriods(sessions || [], period.type);
  if (!available || available.length === 0) return null;

  const idx = available.findIndex(p => {
    if (period.type === 'session') return p.sessionId === period.sessionId;
    if (period.type === 'all') return true;
    // Compare by start date
    return new Date(p.start).getTime() === new Date(period.start).getTime();
  });

  // available is most-recent-first, so "previous" (older) is at idx+1
  if (idx === -1 || idx + 1 >= available.length) return null;
  return available[idx + 1];
}

/**
 * Get the period immediately after `period` in time.
 * Returns null if already at the latest.
 */
export function nextPeriod(period, sessions) {
  const available = listAvailablePeriods(sessions || [], period.type);
  if (!available || available.length === 0) return null;

  const idx = available.findIndex(p => {
    if (period.type === 'session') return p.sessionId === period.sessionId;
    if (period.type === 'all') return true;
    return new Date(p.start).getTime() === new Date(period.start).getTime();
  });

  // available is most-recent-first, so "next" (newer) is at idx-1
  if (idx <= 0) return null;
  return available[idx - 1];
}
