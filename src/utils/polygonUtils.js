/**
 * Polygon utility functions for the Board Setup editor.
 *
 * All coordinates are in board-area percentages (0-100)
 * unless otherwise noted.
 */

// ─── Ramer-Douglas-Peucker path simplification ─────────────────────
// Used by the brush/lasso tool to convert freehand paths into clean polygons.

function perpendicularDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function simplifyPath(points, tolerance = 0.5) {
  if (points.length <= 2) return points;

  let maxDist = 0;
  let maxIdx = 0;
  const [ax, ay] = points[0];
  const [bx, by] = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDist(points[i][0], points[i][1], ax, ay, bx, by);
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }

  if (maxDist > tolerance) {
    const left = simplifyPath(points.slice(0, maxIdx + 1), tolerance);
    const right = simplifyPath(points.slice(maxIdx), tolerance);
    return [...left.slice(0, -1), ...right];
  }

  return [points[0], points[points.length - 1]];
}

// ─── Point-in-polygon (raycast) ─────────────────────────────────────

export function pointInPolygon(px, py, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// ─── Distance from point to polygon edge ────────────────────────────

export function distToPolygonEdge(px, py, polygon) {
  let minDist = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const [ax, ay] = polygon[i];
    const [bx, by] = polygon[(i + 1) % polygon.length];
    minDist = Math.min(minDist, perpendicularDist(px, py, ax, ay, bx, by));
  }
  return minDist;
}

// ─── Polygon centroid ───────────────────────────────────────────────

export function centroid(polygon) {
  const cx = polygon.reduce((s, [x]) => s + x, 0) / polygon.length;
  const cy = polygon.reduce((s, [, y]) => s + y, 0) / polygon.length;
  return [cx, cy];
}

// ─── Bounding box ───────────────────────────────────────────────────

export function boundingBox(polygon) {
  const xs = polygon.map(([x]) => x);
  const ys = polygon.map(([, y]) => y);
  return {
    minX: Math.min(...xs), maxX: Math.max(...xs),
    minY: Math.min(...ys), maxY: Math.max(...ys),
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
  };
}

// ─── Rotate polygon around a center ─────────────────────────────────

export function rotatePolygon(polygon, centerX, centerY, angleDeg) {
  const rad = angleDeg * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return polygon.map(([x, y]) => {
    const dx = x - centerX;
    const dy = y - centerY;
    return [
      Math.round((centerX + dx * cos - dy * sin) * 100) / 100,
      Math.round((centerY + dx * sin + dy * cos) * 100) / 100,
    ];
  });
}

// ─── Translate polygon ──────────────────────────────────────────────

export function translatePolygon(polygon, dx, dy) {
  return polygon.map(([x, y]) => [
    Math.round((x + dx) * 100) / 100,
    Math.round((y + dy) * 100) / 100,
  ]);
}

// ─── Line-segment intersection ──────────────────────────────────────

function lineSegIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const denom = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
  if (Math.abs(denom) < 1e-10) return null;
  const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / denom;
  const u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / denom;
  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
    return {
      x: ax + t * (bx - ax),
      y: ay + t * (by - ay),
      t,
      u,
    };
  }
  return null;
}

// ─── Split a polygon with a line ────────────────────────────────────
// Returns [poly1, poly2] if the line crosses the polygon at 2+ points,
// or null if the line doesn't properly bisect it.

export function splitPolygonWithLine(polygon, lineStart, lineEnd) {
  const [lx1, ly1] = lineStart;
  const [lx2, ly2] = lineEnd;

  // Find all intersection points with polygon edges
  const intersections = [];
  for (let i = 0; i < polygon.length; i++) {
    const [ax, ay] = polygon[i];
    const [bx, by] = polygon[(i + 1) % polygon.length];
    const hit = lineSegIntersect(ax, ay, bx, by, lx1, ly1, lx2, ly2);
    if (hit) {
      intersections.push({ edgeIdx: i, x: hit.x, y: hit.y, t: hit.t });
    }
  }

  if (intersections.length < 2) return null;

  // Sort by position along the cut line
  intersections.sort((a, b) => {
    const da = Math.hypot(a.x - lx1, a.y - ly1);
    const db = Math.hypot(b.x - lx1, b.y - ly1);
    return da - db;
  });

  // Use first and last intersection to define the cut
  const cut1 = intersections[0];
  const cut2 = intersections[intersections.length - 1];

  if (cut1.edgeIdx === cut2.edgeIdx) return null;

  // Build two polygons by walking the original polygon edges
  const p1 = [[cut1.x, cut1.y]];
  const p2 = [[cut2.x, cut2.y]];

  let inFirst = true;
  for (let i = 0; i < polygon.length; i++) {
    const edgeStart = (cut1.edgeIdx + 1 + i) % polygon.length;
    const pt = polygon[edgeStart];

    if (inFirst) {
      p1.push([pt[0], pt[1]]);
      if (edgeStart === cut2.edgeIdx || (edgeStart === (cut2.edgeIdx + 1) % polygon.length && i > 0)) {
        // Check if we've passed cut2's edge
      }
      // Check if cut2 is on the edge starting at edgeStart
      if (edgeStart === cut2.edgeIdx) {
        p1.push([cut2.x, cut2.y]);
        inFirst = false;
      }
    } else {
      p2.push([pt[0], pt[1]]);
      if (edgeStart === cut1.edgeIdx) {
        p2.push([cut1.x, cut1.y]);
        break;
      }
    }
  }

  // Validate both polygons have enough vertices
  if (p1.length < 3 || p2.length < 3) return null;

  // Round coordinates
  const round = (poly) => poly.map(([x, y]) => [
    Math.round(x * 100) / 100,
    Math.round(y * 100) / 100,
  ]);

  return [round(p1), round(p2)];
}

// ─── Find which polygon a point is inside ───────────────────────────

export function findHoldAtPoint(px, py, holds, tapRadius = 3) {
  let bestId = null;
  let bestDist = Infinity;

  for (const hold of holds) {
    // Quick bounding box check
    const hw = (hold.w_pct || 4) / 2 + tapRadius;
    const hh = (hold.h_pct || 4) / 2 + tapRadius;
    if (Math.abs(px - hold.cx) > hw || Math.abs(py - hold.cy) > hh) continue;

    if (hold.polygon && hold.polygon.length >= 3) {
      if (pointInPolygon(px, py, hold.polygon)) {
        const d = Math.hypot(px - hold.cx, py - hold.cy);
        if (d < bestDist) { bestDist = d; bestId = hold.id; }
        continue;
      }
      // Check edge proximity
      if (distToPolygonEdge(px, py, hold.polygon) < tapRadius) {
        const d = Math.hypot(px - hold.cx, py - hold.cy);
        if (d < bestDist) { bestDist = d; bestId = hold.id; }
        continue;
      }
    }

    // Center distance fallback
    const d = Math.hypot(px - hold.cx, py - hold.cy);
    if (d < tapRadius && d < bestDist) {
      bestDist = d;
      bestId = hold.id;
    }
  }
  return bestId;
}

// ─── Create hold object from polygon ────────────────────────────────

export function holdFromPolygon(polygon, id, color = 'black') {
  const [cx, cy] = centroid(polygon);
  const bb = boundingBox(polygon);
  return {
    id,
    color,
    size: bb.w > 8 || bb.h > 8 ? 'large' : bb.w > 4 || bb.h > 4 ? 'medium' : 'small',
    cx: Math.round(cx * 10) / 10,
    cy: Math.round(cy * 10) / 10,
    w_pct: Math.round(bb.w * 10) / 10,
    h_pct: Math.round(bb.h * 10) / 10,
    r: Math.round(Math.max(bb.w, bb.h) / 2 * 10) / 10,
    polygon: polygon.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]),
    verified: true,
    custom: true,
    notes: '',
  };
}
