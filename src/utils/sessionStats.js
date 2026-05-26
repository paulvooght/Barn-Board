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

// ─── Warm-up filter helpers ───────────────────────────────────────────────────

/**
 * Returns the grade index used as the "warm-up reference":
 * hardest send within the last 90 days, falling back to all-time top
 * if there are no sends in the last 90 days.
 * Returns -1 if no sends ever.
 */
export function getWarmupReferenceIndex(sessions, gradeSystem) {
  const safeSessions = sessions || [];
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;

  let recentTop = -1;
  let allTimeTop = -1;

  for (const session of safeSessions) {
    for (const send of (session.sends || [])) {
      const idx = getGradeIndex(send.grade, gradeSystem);
      if (idx < 0) continue;
      if (idx > allTimeTop) allTimeTop = idx;
      const t = send.time
        ? new Date(send.time).getTime()
        : new Date(session.startTime).getTime();
      if (t >= cutoff && idx > recentTop) recentTop = idx;
    }
  }

  if (allTimeTop < 0) return -1;
  return recentTop >= 0 ? recentTop : allTimeTop;
}

/**
 * Given a top-grade index, return the warm-up ceiling index.
 * Sends with grade index <= ceiling are warm-ups.
 * Returns -1 to disable the filter when the climber's top grade is below V4.
 *
 * Bucket table (V-grade-anchored, applied to grade indices):
 *   topIndex < 4         → -1 (disabled)
 *   topIndex in [4,7]    → topIndex - 3
 *   topIndex in [8,10]   → topIndex - 4
 *   topIndex >= 11       → 4  (anything ≤ V4 is warm-up)
 */
export function getWarmupCeilingIndex(topIndex) {
  if (topIndex < 4) return -1;
  if (topIndex <= 7) return topIndex - 3;
  if (topIndex <= 10) return topIndex - 4;
  return 4;
}

/**
 * Convenience: returns the ceiling index in one call.
 */
export function getWarmupCeiling(sessions, gradeSystem) {
  const top = getWarmupReferenceIndex(sessions, gradeSystem);
  if (top < 0) return -1;
  return getWarmupCeilingIndex(top);
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

  const periodSessions = filterSessions(safeSessions, period);
  const periodSends = filterSends(safeSessions, period);

  const sessionCount = periodSessions.length;
  const sendCount = periodSends.length;

  // Avg session length in minutes
  let totalDurationMin = 0;
  let durCount = 0;
  for (const s of periodSessions) {
    if (s.startTime && s.endTime) {
      const mins = (new Date(s.endTime) - new Date(s.startTime)) / 60000;
      if (mins > 0 && mins < 1440) {
        totalDurationMin += mins;
        durCount++;
      }
    }
  }
  const avgSessionLengthMin = durCount > 0 ? Math.round(totalDurationMin / durCount) : null;
  const exactSessionLengthMin = period.type === 'session' ? avgSessionLengthMin : undefined;

  // Avg sessions per week
  let avgSessionsPerWeek = null;
  if (sessionCount > 0 && period.type !== 'session') {
    if (period.type === 'all') {
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

  // Top grade in period (no warm-up filter — raw max)
  let topGradeIndex = -1;
  let topGradeRoute = null;
  for (const send of periodSends) {
    const idx = getGradeIndex(send.grade, gradeSystem);
    if (idx > topGradeIndex) {
      topGradeIndex = idx;
      const route = safeRoutes.find(r => r.id === send.routeId);
      topGradeRoute = {
        grade: send.grade,
        routeId: send.routeId,
        name: route?.name || null,
      };
    }
  }
  const topGrade = topGradeIndex >= 0 ? gradeFromIndex(topGradeIndex, gradeSystem) : null;

  // Routes created in period
  let createdCount = 0;
  for (const s of periodSessions) {
    createdCount += (s.routesCreated || []).length;
  }

  // ── Warm-up filter ────────────────────────────────────────────────────────
  // ceiling is derived from all-time (or recent) top, not limited to period
  const warmupCeiling = getWarmupCeiling(safeSessions, gradeSystem);

  const nonWarmupSends = periodSends.filter(send => {
    if (warmupCeiling < 0) return true;
    const idx = getGradeIndex(send.grade, gradeSystem);
    return idx < 0 || idx > warmupCeiling;
  });
  const nonWarmupSendCount = nonWarmupSends.length;

  // avgGrade — mean grade index of non-warm-up sends, rounded back to nearest grade
  let avgGrade = null;
  let avgGradeSampleSize = 0;
  if (nonWarmupSends.length > 0) {
    const indices = nonWarmupSends
      .map(s => getGradeIndex(s.grade, gradeSystem))
      .filter(i => i >= 0);
    if (indices.length > 0) {
      const mean = indices.reduce((a, b) => a + b, 0) / indices.length;
      avgGrade = gradeFromIndex(Math.round(mean), gradeSystem);
      avgGradeSampleSize = indices.length;
    }
  }

  // topGradePerHoldType — max grade per hold type across non-warm-up sends
  const holdTypeTopIdx = {};
  for (const send of nonWarmupSends) {
    const idx = getGradeIndex(send.grade, gradeSystem);
    if (idx < 0) continue;
    const route = safeRoutes.find(r => r.id === send.routeId);
    if (!route || !Array.isArray(route.holdTypes)) continue;
    for (const ht of route.holdTypes) {
      if (holdTypeTopIdx[ht] === undefined || idx > holdTypeTopIdx[ht]) {
        holdTypeTopIdx[ht] = idx;
      }
    }
  }
  const topGradePerHoldType = Object.entries(holdTypeTopIdx)
    .sort((a, b) => b[1] - a[1])
    .map(([holdType, idx]) => ({ holdType, grade: gradeFromIndex(idx, gradeSystem) }));

  // Unique non-warm-up sent route IDs in period (deduplicated)
  const nonWarmupRouteIds = new Set(nonWarmupSends.map(s => s.routeId));
  const nonWarmupRouteCount = nonWarmupRouteIds.size;

  // holdTypeComposition — % of unique non-warm-up routes containing each hold type
  const holdTypeCounts = {};
  for (const routeId of nonWarmupRouteIds) {
    const route = safeRoutes.find(r => r.id === routeId);
    if (!route || !Array.isArray(route.holdTypes)) continue;
    for (const ht of route.holdTypes) {
      holdTypeCounts[ht] = (holdTypeCounts[ht] || 0) + 1;
    }
  }
  const holdTypeComposition = nonWarmupRouteCount > 0
    ? Object.entries(holdTypeCounts)
        .map(([value, count]) => ({ value, percent: Math.round(count / nonWarmupRouteCount * 100) }))
        .sort((a, b) => b.percent - a.percent)
        .slice(0, 5)
    : [];

  // styleComposition — % of unique non-warm-up routes containing each style
  const styleCounts = {};
  for (const routeId of nonWarmupRouteIds) {
    const route = safeRoutes.find(r => r.id === routeId);
    if (!route || !Array.isArray(route.styles)) continue;
    for (const st of route.styles) {
      styleCounts[st] = (styleCounts[st] || 0) + 1;
    }
  }
  const styleComposition = nonWarmupRouteCount > 0
    ? Object.entries(styleCounts)
        .map(([value, count]) => ({ value, percent: Math.round(count / nonWarmupRouteCount * 100) }))
        .sort((a, b) => b.percent - a.percent)
        .slice(0, 3)
    : [];

  // angleComposition — % of non-warm-up sends (not deduped) per angle
  const angleCounts = {};
  for (const send of nonWarmupSends) {
    if (send.angle == null) continue;
    angleCounts[send.angle] = (angleCounts[send.angle] || 0) + 1;
  }
  const angleComposition = nonWarmupSendCount > 0
    ? Object.entries(angleCounts)
        .map(([value, count]) => ({ value: Number(value), percent: Math.round(count / nonWarmupSendCount * 100) }))
        .sort((a, b) => b.percent - a.percent)
        .slice(0, 5)
    : [];

  return {
    // Activity (no warm-up filter)
    sendCount,
    sessionCount,
    createdCount,
    avgSessionLengthMin,
    avgSessionsPerWeek: avgSessionsPerWeek != null ? Math.round(avgSessionsPerWeek * 10) / 10 : null,
    exactSessionLengthMin,

    // Grade
    topGrade,
    topGradeIndex,
    topGradeRoute,
    avgGrade,
    avgGradeSampleSize,

    // Composition (warm-up filtered)
    topGradePerHoldType,
    holdTypeComposition,
    styleComposition,
    angleComposition,

    // Sample-size guard
    nonWarmupSendCount,

    // Misc
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

// ─── Delta computation ────────────────────────────────────────────────────────

/**
 * Compute numeric deltas between current and previous stats.
 * Returns null for a field if previousStats is null/undefined.
 */
export function computeDelta(currentStats, previousStats) {
  if (!previousStats) return null;

  const delta = {};

  const numFields = ['sendCount', 'sessionCount'];
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
