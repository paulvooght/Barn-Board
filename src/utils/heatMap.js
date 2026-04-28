/**
 * heatMap.js — Pure utility functions for the Hold Usage Heat Map feature.
 * No React imports — easily testable.
 */

/**
 * Returns { holdId: count } for the routes that pass the filters.
 *
 * filters shape:
 *   { holdTypes: string[], techniques: string[], styles: string[],
 *     setter: string, angle: number|null, includeFeet: boolean }
 */
export function computeHoldCounts(routes, filters) {
  if (!routes || !routes.length) return {};

  const {
    holdTypes = [],
    techniques = [],
    styles = [],
    setter = '',
    angle = null,
    includeFeet = true,
  } = filters || {};

  const counts = {};

  for (const route of routes) {
    // holdTypes filter: route must have ALL selected types
    if (holdTypes.length > 0 && !holdTypes.every(ht => route.holdTypes?.includes(ht))) continue;

    // techniques filter: route must have ALL selected techniques
    if (techniques.length > 0 && !techniques.every(t => route.techniques?.includes(t))) continue;

    // styles filter: route must have ALL selected styles
    if (styles.length > 0 && !styles.every(s => route.styles?.includes(s))) continue;

    // setter filter: case-insensitive substring match
    if (setter.trim()) {
      const q = setter.trim().toLowerCase();
      if (!route.setter || !route.setter.toLowerCase().includes(q)) continue;
    }

    // angle filter: pass if angle is in route's creator-confirmed angles
    if (angle !== null) {
      const routeAngles = [
        route.angle,
        ...(route.angleGrades || []).map(ag => ag.angle),
      ];
      if (!routeAngles.includes(angle)) continue;
    }

    // Count holds
    for (const [holdId, role] of Object.entries(route.holds || {})) {
      if (role === 'foot' && !includeFeet) continue;
      counts[holdId] = (counts[holdId] || 0) + 1;
    }
  }

  return counts;
}

/**
 * Returns { holdId: percentile } where percentile ∈ [0, 1].
 * Holds with count 0 are NOT included (caller treats absence as "unused").
 * Uses rank-percentile on non-zero counts: rank / (N - 1) for N non-zero holds, or 0 if N === 1.
 */
export function computePercentiles(counts) {
  if (!counts) return {};

  const entries = Object.entries(counts).filter(([, c]) => c > 0);
  if (entries.length === 0) return {};

  // Sort by count ascending so rank 0 = lowest
  entries.sort((a, b) => a[1] - b[1]);

  const N = entries.length;
  const result = {};

  entries.forEach(([holdId], rank) => {
    result[holdId] = N === 1 ? 0 : rank / (N - 1);
  });

  return result;
}

/**
 * Returns a CSS color string for a percentile in [0, 1].
 * Discrete tiers for sharp visual signal:
 *   p < 0.25 → '#3b82f6' (cool blue)
 *   p < 0.50 → '#06b6d4' (cyan)
 *   p < 0.75 → '#fbbf24' (amber)
 *   p < 0.95 → '#f97316' (orange)
 *   p ≤ 1.00 → '#ef4444' (hot red)
 */
export function colorForPercentile(p) {
  if (p < 0.25) return '#3b82f6';
  if (p < 0.50) return '#06b6d4';
  if (p < 0.75) return '#fbbf24';
  if (p < 0.95) return '#f97316';
  return '#ef4444';
}

/**
 * Returns the sorted, deduped list of "creator-confirmed angles" present in the routes.
 * For each route: includes route.angle plus every angle in route.angleGrades[].
 * Returns number[].
 */
export function availableAngles(routes) {
  if (!routes || !routes.length) return [];

  const angleSet = new Set();
  for (const route of routes) {
    if (typeof route.angle === 'number') angleSet.add(route.angle);
    for (const ag of route.angleGrades || []) {
      if (typeof ag.angle === 'number') angleSet.add(ag.angle);
    }
  }

  return [...angleSet].sort((a, b) => a - b);
}

/**
 * Count how many routes pass the given filters (without counting holds).
 * Used for the "N routes · M holds used" display in the filter bar.
 */
export function countPassingRoutes(routes, filters) {
  if (!routes || !routes.length) return 0;

  const {
    holdTypes = [],
    techniques = [],
    styles = [],
    setter = '',
    angle = null,
    includeFeet = true,
  } = filters || {};

  let count = 0;
  for (const route of routes) {
    if (holdTypes.length > 0 && !holdTypes.every(ht => route.holdTypes?.includes(ht))) continue;
    if (techniques.length > 0 && !techniques.every(t => route.techniques?.includes(t))) continue;
    if (styles.length > 0 && !styles.every(s => route.styles?.includes(s))) continue;
    if (setter.trim()) {
      const q = setter.trim().toLowerCase();
      if (!route.setter || !route.setter.toLowerCase().includes(q)) continue;
    }
    if (angle !== null) {
      const routeAngles = [
        route.angle,
        ...(route.angleGrades || []).map(ag => ag.angle),
      ];
      if (!routeAngles.includes(angle)) continue;
    }
    count++;
  }
  return count;
}
