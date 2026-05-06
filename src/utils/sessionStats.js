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

// ─── Hold heat map ────────────────────────────────────────────────────────────

/**
 * Aggregate hold usage across sends in a period.
 *
 * For period type 'all': iterates userRouteData keys where sent=true, looks up the route,
 * counts each hold once per route (total sent count, not per-session).
 * For other period types: uses filterSends() so the same route sent twice = counted twice.
 *
 * @param {Array}  sessions      — all sessions
 * @param {Array}  routes        — all routes (shared route data, each has .holds obj)
 * @param {Object} userRouteData — { [routeId]: { sent, flashed, ... } }
 * @param {Object} period        — period descriptor from makePeriod()
 * @returns {{ counts: { [holdId]: number }, maxCount: number, totalSends: number }}
 */
export function computeHoldHeat(sessions, routes, userRouteData, period) {
  const safeRoutes = routes || [];
  const safeURD = userRouteData || {};
  const counts = {};
  let totalSends = 0;

  if (period.type === 'all') {
    // One count per route the user has marked sent
    for (const [routeId, urd] of Object.entries(safeURD)) {
      if (!urd?.sent) continue;
      const route = safeRoutes.find(r => r.id === routeId);
      if (!route?.holds) continue;
      totalSends++;
      for (const holdId of Object.keys(route.holds)) {
        counts[holdId] = (counts[holdId] || 0) + 1;
      }
    }
  } else {
    // One count per send event in the period (same route sent twice = counted twice)
    const periodSends = filterSends(sessions || [], period);
    totalSends = periodSends.length;
    for (const send of periodSends) {
      const route = safeRoutes.find(r => r.id === send.routeId);
      if (!route?.holds) continue;
      for (const holdId of Object.keys(route.holds)) {
        counts[holdId] = (counts[holdId] || 0) + 1;
      }
    }
  }

  const maxCount = counts && Object.keys(counts).length > 0
    ? Math.max(...Object.values(counts))
    : 0;

  return { counts, maxCount, totalSends };
}

// ─── Sends timeline (sparkline data) ─────────────────────────────────────────

/**
 * Sends-per-session timeline within a period.
 * For 'session' periods: returns single-element array.
 * For 'week'/'month'/'all': returns array sorted oldest → newest, one entry per session in period.
 * Each entry: { sessionId, date, sendCount, flashCount }
 *
 * @param {Array} sessions
 * @param {Object} period — period descriptor from makePeriod()
 * @param {Object} [userRouteData] — optional, used to detect flashes
 * @returns {Array<{ sessionId, date, sendCount, flashCount }>}
 */
export function computeSendsTimeline(sessions, period, userRouteData = {}) {
  if (!sessions || sessions.length === 0) return [];

  const periodSessions = filterSessions(sessions, period);
  if (periodSessions.length === 0) return [];

  // Sort oldest first
  const sorted = [...periodSessions].sort(
    (a, b) => new Date(a.startTime) - new Date(b.startTime)
  );

  return sorted.map(s => {
    const sends = s.sends || [];
    const sendCount = sends.length;
    let flashCount = 0;
    const seen = new Set();
    for (const send of sends) {
      if (!seen.has(send.routeId)) {
        seen.add(send.routeId);
        if (userRouteData[send.routeId]?.flashed) flashCount++;
      }
    }
    return {
      sessionId: s.id,
      date: s.startTime,
      sendCount,
      flashCount,
    };
  });
}

// ─── Streaks ──────────────────────────────────────────────────────────────────

/**
 * Streaks: counted in consecutive weeks with at least 1 session.
 * Returns { currentStreakWeeks, longestStreakWeeks, totalSessions, totalSends, totalFlashes }
 * Always all-time — period-independent.
 *
 * @param {Array} sessions
 * @param {Object} [userRouteData]
 * @returns {{ currentStreakWeeks, longestStreakWeeks, totalSessions, totalSends, totalFlashes }}
 */
export function computeStreaks(sessions, userRouteData = {}) {
  if (!sessions || sessions.length === 0) {
    return {
      currentStreakWeeks: 0,
      longestStreakWeeks: 0,
      totalSessions: 0,
      totalSends: 0,
      totalFlashes: 0,
    };
  }

  // Collect unique week-start ISO strings where there was at least one session
  const weekSet = new Set();
  let totalSends = 0;
  for (const s of sessions) {
    const ws = getWeekStart(new Date(s.startTime));
    weekSet.add(ws.toISOString());
    totalSends += (s.sends || []).length;
  }

  // Total flashes from userRouteData
  let totalFlashes = 0;
  for (const urd of Object.values(userRouteData || {})) {
    if (urd?.flashed) totalFlashes++;
  }

  // Sort week starts oldest → newest
  const weekStarts = [...weekSet]
    .map(iso => new Date(iso))
    .sort((a, b) => a - b);

  // Walk through weeks; count consecutive runs (each adjacent pair differs by exactly 7 days)
  const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  let longestStreak = 1;
  let currentRun = 1;
  for (let i = 1; i < weekStarts.length; i++) {
    const diff = weekStarts[i].getTime() - weekStarts[i - 1].getTime();
    if (Math.abs(diff - ONE_WEEK_MS) < 1000) {
      // Adjacent weeks (within 1s rounding margin) — consecutive
      currentRun++;
    } else {
      currentRun = 1;
    }
    if (currentRun > longestStreak) longestStreak = currentRun;
  }

  // Current streak: walk backwards from the most recent active week
  // We allow the streak to still be "alive" if the most recent week is this week or last week
  const now = new Date();
  const thisWeekStart = getWeekStart(now);
  const lastWeekStart = new Date(thisWeekStart.getTime() - ONE_WEEK_MS);

  const mostRecentWeek = weekStarts[weekStarts.length - 1];
  const mostRecentMs = mostRecentWeek.getTime();

  let currentStreakWeeks = 0;
  if (
    mostRecentMs === thisWeekStart.getTime() ||
    mostRecentMs === lastWeekStart.getTime()
  ) {
    // Streak is still alive — count backwards
    currentStreakWeeks = 1;
    for (let i = weekStarts.length - 2; i >= 0; i--) {
      const diff = weekStarts[i + 1].getTime() - weekStarts[i].getTime();
      if (Math.abs(diff - ONE_WEEK_MS) < 1000) {
        currentStreakWeeks++;
      } else {
        break;
      }
    }
  }

  return {
    currentStreakWeeks,
    longestStreakWeeks: Math.max(longestStreak, weekStarts.length > 0 ? 1 : 0),
    totalSessions: sessions.length,
    totalSends,
    totalFlashes,
  };
}

// ─── Personal records ─────────────────────────────────────────────────────────

/**
 * Personal records — all-time bests.
 * Returns {
 *   topGrade: { grade, sessionId, time } | null,
 *   topGradeByAngle: { [angle]: { grade, sessionId, time } },
 *   hardestFlash: { grade, routeId, time } | null,
 *   totalFlashes: number,
 * }
 *
 * @param {Array} sessions
 * @param {Array} routes
 * @param {Object} userRouteData
 * @param {string} gradeSystem
 */
export function computePersonalRecords(sessions, routes, userRouteData, gradeSystem = 'V') {
  const safeSessions = sessions || [];
  const safeRoutes = routes || [];
  const safeURD = userRouteData || {};

  // Collect all sends ever across all sessions
  const allSends = [];
  for (const s of safeSessions) {
    for (const send of (s.sends || [])) {
      allSends.push({ ...send, sessionId: s.id });
    }
  }

  // Grade lookup helpers (inline to avoid closure issues)
  function getIdx(gradeStr) {
    if (!gradeStr) return -1;
    if (gradeSystem === 'Font') {
      const idx = FONT_GRADE_INDEX[gradeStr];
      return idx !== undefined ? idx : -1;
    }
    const idx = V_GRADE_INDEX[gradeStr];
    return idx !== undefined ? idx : -1;
  }

  // Top grade overall
  let topGradeIdx = -1;
  let topGradeEntry = null;
  for (const send of allSends) {
    const idx = getIdx(send.grade);
    if (idx > topGradeIdx) {
      topGradeIdx = idx;
      topGradeEntry = { grade: send.grade, sessionId: send.sessionId, time: send.time };
    }
  }

  // Top grade by angle
  const angleMap = {}; // { angle: { idx, entry } }
  for (const send of allSends) {
    if (send.angle == null) continue;
    const idx = getIdx(send.grade);
    if (idx < 0) continue;
    if (!angleMap[send.angle] || idx > angleMap[send.angle].idx) {
      angleMap[send.angle] = {
        idx,
        entry: { grade: send.grade, sessionId: send.sessionId, time: send.time },
      };
    }
  }
  const topGradeByAngle = {};
  for (const [angle, { entry }] of Object.entries(angleMap)) {
    topGradeByAngle[angle] = entry;
  }

  // Hardest flash — look at routes where userRouteData.flashed === true,
  // use the route's grade (not send grade, which might be from a different angle)
  let hardestFlashIdx = -1;
  let hardestFlashEntry = null;
  let totalFlashes = 0;
  for (const [routeId, urd] of Object.entries(safeURD)) {
    if (!urd?.flashed) continue;
    totalFlashes++;
    const route = safeRoutes.find(r => r.id === routeId);
    if (!route) continue;
    const idx = getIdx(route.grade);
    if (idx > hardestFlashIdx) {
      hardestFlashIdx = idx;
      // Find earliest send of this route across sessions to get time
      let flashTime = null;
      for (const s of safeSessions) {
        const matchSend = (s.sends || []).find(snd => snd.routeId === routeId);
        if (matchSend) {
          flashTime = matchSend.time;
          break;
        }
      }
      hardestFlashEntry = { grade: route.grade, routeId, time: flashTime };
    }
  }

  return {
    topGrade: topGradeEntry,
    topGradeByAngle,
    hardestFlash: hardestFlashEntry,
    totalFlashes,
  };
}

// ─── Unfinished business ──────────────────────────────────────────────────────

/**
 * Unfinished business — attempted but never sent.
 * Returns array of route IDs.
 * Source: userRouteData entries where attempted=true AND sent=false AND flashed=false.
 * Sort: most recently attempted first (from session data); otherwise routeId order.
 *
 * @param {Array} sessions
 * @param {Array} routes
 * @param {Object} userRouteData
 * @returns {string[]}
 */
export function computeUnfinished(sessions, routes, userRouteData) {
  const safeURD = userRouteData || {};
  const safeRoutes = routes || [];
  const safeSessions = sessions || [];

  // Collect routeIds that are attempted but not sent/flashed
  const candidates = Object.entries(safeURD)
    .filter(([, urd]) => urd?.attempted === true && !urd?.sent && !urd?.flashed)
    .map(([routeId]) => routeId)
    // Only include routes that still exist
    .filter(routeId => safeRoutes.some(r => r.id === routeId));

  if (candidates.length === 0) return [];

  // Find most recent attempt time per route from sessions
  const lastAttemptTime = {};
  for (const s of safeSessions) {
    const sessionTime = new Date(s.startTime).getTime();
    for (const routeId of (s.routesAttempted || [])) {
      if (!lastAttemptTime[routeId] || sessionTime > lastAttemptTime[routeId]) {
        lastAttemptTime[routeId] = sessionTime;
      }
    }
    // Also check sends (a send is also an attempt)
    for (const send of (s.sends || [])) {
      const t = send.time ? new Date(send.time).getTime() : sessionTime;
      if (!lastAttemptTime[send.routeId] || t > lastAttemptTime[send.routeId]) {
        lastAttemptTime[send.routeId] = t;
      }
    }
  }

  // Sort: most recently attempted first; fallback to routeId string order
  return [...candidates].sort((a, b) => {
    const ta = lastAttemptTime[a] || 0;
    const tb = lastAttemptTime[b] || 0;
    if (tb !== ta) return tb - ta;
    return a < b ? -1 : 1;
  });
}

// ─── Average sessions per week (all-time) ────────────────────────────────────

/**
 * Compute average sessions per week across all sessions (all-time span).
 * Used by SessionRollup streaks card.
 * Returns null if there are fewer than 2 sessions.
 *
 * @param {Array} sessions
 * @returns {number|null}
 */
export function computeAvgSessionsPerWeek(sessions) {
  if (!sessions || sessions.length < 2) return sessions?.length === 1 ? 1 : null;
  const times = sessions.map(s => new Date(s.startTime).getTime());
  const spanMs = Math.max(...times) - Math.min(...times);
  const spanWeeks = spanMs / (7 * 24 * 60 * 60 * 1000);
  return spanWeeks > 0 ? sessions.length / spanWeeks : null;
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
