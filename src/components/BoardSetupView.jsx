import { useState, useRef, useEffect, useCallback } from 'react';
import { useUndoRedo } from '../hooks/useUndoRedo';
import {
  centroid, boundingBox,
  rotatePolygon, translatePolygon,
  findHoldAtPoint, holdFromPolygon,
} from '../utils/polygonUtils';
import holdsData from '../data/holds.json';

const { boardRegion } = holdsData;
const IMG_SRC = '/Board background.jpg';

const TOOLS = {
  SELECT: 'select',
  DRAW: 'draw',
  COPY: 'copy',
};

const TOOL_LABELS = {
  [TOOLS.SELECT]: { icon: '↖', label: 'Select', tip: 'Click a hold to select it' },
  [TOOLS.DRAW]:   { icon: '⬠', label: 'Draw', tip: 'Click to place vertices, click first vertex to close' },
  [TOOLS.COPY]:   { icon: '⧉', label: 'Copy', tip: 'Select a hold, click Copy, then click to place' },
};

const MIN_SCALE = 1;
const MAX_SCALE = 8;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function r1(v) { return Math.round(v * 10) / 10; }

export default function BoardSetupView({ initialHolds, onSave, onCancel }) {
  const { state: holds, setState: setHolds, undo, redo, canUndo, canRedo } = useUndoRedo(initialHolds);

  const [activeTool, setActiveTool] = useState(TOOLS.SELECT);
  const [selectedId, setSelectedId] = useState(null);
  const [showAllOutlines, setShowAllOutlines] = useState(true);

  // Drawing state
  const [drawPoints, setDrawPoints] = useState([]);
  const [drawClosed, setDrawClosed] = useState(false);

  // Copy/paste state — place first, then rotate, click off to finish
  const [clipboard, setClipboard] = useState(null);     // source hold shape
  const [pastedHoldId, setPastedHoldId] = useState(null); // ID of just-pasted hold (rotate phase)
  const [pasteRotation, setPasteRotation] = useState(0);

  // Vertex drag state
  const [draggingVertex, setDraggingVertex] = useState(null);

  // Whole-hold drag state (for pasted hold repositioning)
  const [draggingHold, setDraggingHold] = useState(null); // { holdId, startPct }

  // Image / zoom / pan
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imgSize, setImgSize] = useState({ w: 1200, h: 900 });
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });

  const containerRef = useRef(null);
  const svgRef = useRef(null);
  const scaleRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const pinchRef = useRef({ active: false, lastDist: 0 });
  const panDragRef = useRef({ active: false, startX: 0, startY: 0, basePanX: 0, basePanY: 0, moved: false });
  const lastTouchTimeRef = useRef(0);
  const isSynthesizedMouse = () => Date.now() - lastTouchTimeRef.current < 500;

  useEffect(() => { scaleRef.current = scale; }, [scale]);
  useEffect(() => { panRef.current = pan; }, [pan]);

  // ─── Coordinate conversion ──────────────────────────────────────────
  const bLeft = imgSize.w * boardRegion.left / 100;
  const bTop = imgSize.h * boardRegion.top / 100;
  const bW = imgSize.w * boardRegion.width / 100;
  const bH = imgSize.h * boardRegion.height / 100;

  const toSvgX = (x) => bLeft + (x / 100) * bW;
  const toSvgY = (y) => bTop + (y / 100) * bH;

  const clientToBoardPct = useCallback((clientX, clientY) => {
    const svg = svgRef.current;
    if (!svg) return null;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const svgPt = pt.matrixTransform(ctm.inverse());
    return {
      x: clamp(((svgPt.x - bLeft) / bW) * 100, 0, 100),
      y: clamp(((svgPt.y - bTop) / bH) * 100, 0, 100),
    };
  }, [bLeft, bTop, bW, bH]);

  // Check if a click is on the first draw vertex (in SVG pixel space for zoom-independent accuracy)
  const isOnFirstVertex = useCallback((pct) => {
    if (drawPoints.length < 3) return false;
    const svg = svgRef.current;
    if (!svg) return false;
    const ctm = svg.getScreenCTM();
    if (!ctm) return false;
    // Convert both points to screen pixels for zoom-independent distance
    const scale = ctm.a; // uniform scale factor from SVG to screen
    const clickSvgX = toSvgX(pct.x);
    const clickSvgY = toSvgY(pct.y);
    const firstSvgX = toSvgX(drawPoints[0][0]);
    const firstSvgY = toSvgY(drawPoints[0][1]);
    const distPx = Math.hypot((clickSvgX - firstSvgX) * scale, (clickSvgY - firstSvgY) * scale);
    // First vertex circle has r=12 in SVG space — use 14px screen threshold (generous but tight)
    return distPx < 14;
  }, [drawPoints, toSvgX, toSvgY]);

  // ─── Zoom ───────────────────────────────────────────────────────────
  function doZoom(newScale, pivotX, pivotY) {
    const el = containerRef.current;
    if (!el) return;
    const prev = scaleRef.current;
    const clamped = clamp(newScale, MIN_SCALE, MAX_SCALE);
    const ratio = clamped / prev;
    const maxX = el.offsetWidth * (clamped - 1) / 2;
    const maxY = el.offsetHeight * (clamped - 1) / 2;
    const nx = clamp(pivotX + ratio * (panRef.current.x - pivotX), -maxX, maxX);
    const ny = clamp(pivotY + ratio * (panRef.current.y - pivotY), -maxY, maxY);
    scaleRef.current = clamped;
    panRef.current = { x: nx, y: ny };
    setScale(clamped);
    setPan({ x: nx, y: ny });
  }

  function resetZoom() {
    scaleRef.current = 1; panRef.current = { x: 0, y: 0 };
    setScale(1); setPan({ x: 0, y: 0 });
  }

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const pivotX = e.clientX - rect.left - rect.width / 2;
      const pivotY = e.clientY - rect.top - rect.height / 2;
      // Trackpad sends many small deltas; mouse wheel sends large discrete ones.
      // Dampen trackpad by using a gentler multiplier for small deltas.
      const absDelta = Math.abs(e.deltaY);
      let factor;
      if (absDelta < 10) {
        // Trackpad — very gentle
        factor = e.deltaY < 0 ? 1.02 : 0.98;
      } else if (absDelta < 50) {
        // Moderate trackpad gesture
        factor = e.deltaY < 0 ? 1.04 : 0.96;
      } else {
        // Mouse wheel — normal speed
        factor = e.deltaY < 0 ? 1.12 : 0.9;
      }
      doZoom(scaleRef.current * factor, pivotX, pivotY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // ─── Keyboard shortcuts ─────────────────────────────────────────────
  useEffect(() => {
    const handler = (e) => {
      const isMeta = e.metaKey || e.ctrlKey;
      if (isMeta && !e.shiftKey && e.key === 'z') { e.preventDefault(); undo(); return; }
      if (isMeta && e.shiftKey && e.key === 'z') { e.preventDefault(); redo(); return; }
      if (isMeta && e.key === 'Z') { e.preventDefault(); redo(); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId && !e.target.closest('input')) {
        e.preventDefault();
        deleteSelected();
        return;
      }
      if (isMeta && e.key === 'c' && selectedId) {
        e.preventDefault();
        copySelected();
        return;
      }
      if (e.key === 'Escape') {
        if (pastedHoldId) { setPastedHoldId(null); setPasteRotation(0); setActiveTool(TOOLS.SELECT); return; }
        if (clipboard) { setClipboard(null); setPasteRotation(0); setActiveTool(TOOLS.SELECT); return; }
        if (drawPoints.length > 0) { setDrawPoints([]); setDrawClosed(false); return; }
        if (selectedId) { setSelectedId(null); return; }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedId, clipboard, pastedHoldId, drawPoints, undo, redo]);

  // ─── Tool actions ───────────────────────────────────────────────────

  const selectedHold = selectedId ? holds.find(h => h.id === selectedId) : null;

  function deleteSelected() {
    if (!selectedId) return;
    setHolds(prev => prev.filter(h => h.id !== selectedId));
    setSelectedId(null);
  }

  function copySelected() {
    if (!selectedHold?.polygon) return;
    setClipboard({ ...selectedHold });
    setPasteRotation(0);
    setPastedHoldId(null);
    setActiveTool(TOOLS.COPY);
    setSelectedId(null);
  }

  function doPaste(pct) {
    if (!clipboard?.polygon) return;
    const srcPoly = clipboard.polygon.map(([x, y]) => [x, y]); // deep copy
    const [ocx, ocy] = centroid(srcPoly);
    const dx = pct.x - ocx;
    const dy = pct.y - ocy;
    const newPoly = translatePolygon(srcPoly, dx, dy);
    const id = `custom_${Date.now()}`;
    const newHold = holdFromPolygon(newPoly, id, clipboard.color);
    newHold.name = clipboard.name ? `${clipboard.name} (copy)` : '';
    newHold.holdTypes = clipboard.holdTypes || [];
    newHold.positivity = clipboard.positivity || 0;
    newHold.confidence = 'high';
    // Store the original unrotated polygon + paste center for rotation
    newHold._pasteCx = pct.x;
    newHold._pasteCy = pct.y;
    newHold._origPoly = newPoly.map(([x, y]) => [x, y]); // unrotated copy
    setHolds(prev => [...prev, newHold]);
    // Enter rotate phase — hold is placed, now user can rotate
    setPastedHoldId(id);
    setPasteRotation(0);
    setSelectedId(id);
  }

  function applyRotationToPasted(rotation) {
    if (!pastedHoldId) return;
    setHolds(prev => prev.map(h => {
      if (h.id !== pastedHoldId || !h._origPoly || !h._pasteCx) return h;
      // Always rotate from the original unrotated polygon
      let newPoly = h._origPoly.map(([x, y]) => [x, y]);
      if (rotation !== 0) {
        newPoly = rotatePolygon(newPoly, h._pasteCx, h._pasteCy, rotation);
      }
      const [cx, cy] = centroid(newPoly);
      const bb = boundingBox(newPoly);
      return { ...h, polygon: newPoly, cx: r1(cx), cy: r1(cy), w_pct: r1(bb.w), h_pct: r1(bb.h) };
    }));
  }

  function movePastedHold(newCenterPct) {
    if (!pastedHoldId) return;
    setHolds(prev => prev.map(h => {
      if (h.id !== pastedHoldId || !h.polygon) return h;
      const [oldCx, oldCy] = centroid(h.polygon);
      const dx = newCenterPct.x - oldCx;
      const dy = newCenterPct.y - oldCy;
      const newPoly = translatePolygon(h.polygon, dx, dy);
      const [cx, cy] = centroid(newPoly);
      const bb = boundingBox(newPoly);
      // Also update _origPoly and _pasteCx/_pasteCy so rotation still works from new position
      const newOrigPoly = h._origPoly
        ? translatePolygon(h._origPoly, dx, dy)
        : newPoly.map(([x, y]) => [x, y]);
      return {
        ...h, polygon: newPoly,
        cx: r1(cx), cy: r1(cy), w_pct: r1(bb.w), h_pct: r1(bb.h),
        _pasteCx: r1(newCenterPct.x), _pasteCy: r1(newCenterPct.y),
        _origPoly: newOrigPoly,
      };
    }));
  }

  function finishPaste() {
    // Clean up internal _paste fields from the hold
    if (pastedHoldId) {
      setHolds(prev => prev.map(h => {
        if (h.id !== pastedHoldId) return h;
        const { _pasteCx, _pasteCy, _origPoly, ...clean } = h;
        return clean;
      }));
    }
    setPastedHoldId(null);
    setPasteRotation(0);
    setClipboard(null);
    setActiveTool(TOOLS.SELECT);
    setSelectedId(null);
  }

  function finishDraw() {
    if (drawPoints.length < 3) return;
    const newHold = holdFromPolygon(drawPoints, `custom_${Date.now()}`);
    newHold.confidence = 'high';
    setHolds(prev => [...prev, newHold]);
    setDrawPoints([]);
    setDrawClosed(false);
    setSelectedId(newHold.id);
    setActiveTool(TOOLS.SELECT);
  }

  function addVertexToSelected() {
    if (!selectedHold?.polygon || selectedHold.polygon.length < 3) return;
    const poly = selectedHold.polygon;
    let longestIdx = 0, longestDist = 0;
    for (let i = 0; i < poly.length; i++) {
      const j = (i + 1) % poly.length;
      const d = Math.hypot(poly[j][0] - poly[i][0], poly[j][1] - poly[i][1]);
      if (d > longestDist) { longestDist = d; longestIdx = i; }
    }
    const i = longestIdx;
    const j = (i + 1) % poly.length;
    const midX = r1((poly[i][0] + poly[j][0]) / 2);
    const midY = r1((poly[i][1] + poly[j][1]) / 2);
    const newPoly = [...poly];
    newPoly.splice(j, 0, [midX, midY]);
    setHolds(prev => prev.map(h => {
      if (h.id !== selectedId) return h;
      const [cx, cy] = centroid(newPoly);
      const bb = boundingBox(newPoly);
      return { ...h, polygon: newPoly, cx: r1(cx), cy: r1(cy), w_pct: r1(bb.w), h_pct: r1(bb.h) };
    }));
  }

  function updateVertexPosition(holdId, vertexIdx, newX, newY) {
    setHolds(prev => prev.map(h => {
      if (h.id !== holdId || !h.polygon) return h;
      const newPoly = [...h.polygon];
      newPoly[vertexIdx] = [r1(newX), r1(newY)];
      const [cx, cy] = centroid(newPoly);
      const bb = boundingBox(newPoly);
      return { ...h, polygon: newPoly, cx: r1(cx), cy: r1(cy), w_pct: r1(bb.w), h_pct: r1(bb.h), r: r1(Math.max(bb.w, bb.h) / 2) };
    }));
  }

  // ─── Mouse event handlers ──────────────────────────────────────────

  function handleMouseDown(e) {
    if (e.button !== 0 || isSynthesizedMouse()) return;
    // If pasted hold exists, check if click is on it to start drag-move
    if (pastedHoldId) {
      const pct = clientToBoardPct(e.clientX, e.clientY);
      if (pct) {
        const hitId = findHoldAtPoint(pct.x, pct.y, holds, 3);
        if (hitId === pastedHoldId) {
          setDraggingHold({ holdId: pastedHoldId, startPct: pct });
          return;
        }
      }
    }
    panDragRef.current = {
      active: true,
      startX: e.clientX, startY: e.clientY,
      basePanX: panRef.current.x, basePanY: panRef.current.y,
      moved: false,
    };
  }

  function handleMouseMove(e) {
    if (isSynthesizedMouse()) return;
    const pct = clientToBoardPct(e.clientX, e.clientY);
    // Drag-move pasted hold
    if (draggingHold && pct) {
      movePastedHold(pct);
      return;
    }
    if (draggingVertex && pct) {
      updateVertexPosition(draggingVertex.holdId, draggingVertex.vertexIdx, pct.x, pct.y);
      return;
    }
    if (panDragRef.current.active) {
      const dx = e.clientX - panDragRef.current.startX;
      const dy = e.clientY - panDragRef.current.startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) panDragRef.current.moved = true;
      if (scaleRef.current > 1 && panDragRef.current.moved) {
        const el = containerRef.current;
        const maxX = el ? el.offsetWidth * (scaleRef.current - 1) / 2 : 0;
        const maxY = el ? el.offsetHeight * (scaleRef.current - 1) / 2 : 0;
        panRef.current = {
          x: clamp(panDragRef.current.basePanX + dx, -maxX, maxX),
          y: clamp(panDragRef.current.basePanY + dy, -maxY, maxY),
        };
        setPan({ ...panRef.current });
      }
    }
  }

  function handleMouseUp(e) {
    if (isSynthesizedMouse()) { panDragRef.current.active = false; return; }
    if (draggingHold) { setDraggingHold(null); return; }
    if (draggingVertex) { setDraggingVertex(null); return; }
    if (panDragRef.current.active && !panDragRef.current.moved) {
      const pct = clientToBoardPct(e.clientX, e.clientY);
      if (pct) handleClick(pct);
    }
    panDragRef.current.active = false;
  }

  function handleClick(pct) {
    // Paste rotate phase — clicking away from pasted hold finishes
    if (pastedHoldId) {
      const hitId = findHoldAtPoint(pct.x, pct.y, holds, 3);
      if (hitId !== pastedHoldId) {
        finishPaste();
      }
      return;
    }

    // Copy mode
    if (activeTool === TOOLS.COPY) {
      if (clipboard) {
        // Have clipboard — click to paste
        doPaste(pct);
      } else {
        // No clipboard yet — click a hold to copy it
        const hitId = findHoldAtPoint(pct.x, pct.y, holds, 3);
        if (hitId) {
          const hold = holds.find(h => h.id === hitId);
          if (hold?.polygon) {
            setClipboard({ ...hold });
            setPasteRotation(0);
            setSelectedId(null);
          }
        }
      }
      return;
    }

    if (activeTool === TOOLS.SELECT) {
      const hitId = findHoldAtPoint(pct.x, pct.y, holds, 3);
      setSelectedId(hitId);
    } else if (activeTool === TOOLS.DRAW) {
      if (drawClosed) {
        finishDraw();
      } else if (drawPoints.length >= 3 && isOnFirstVertex(pct)) {
        // Close — user clicked on the first vertex
        setDrawClosed(true);
      } else {
        setDrawPoints(prev => [...prev, [r1(pct.x), r1(pct.y)]]);
      }
    }
  }

  // ─── Touch event handlers ──────────────────────────────────────────

  function handleTouchStart(e) {
    lastTouchTimeRef.current = Date.now();
    if (e.touches.length === 2) {
      pinchRef.current.active = true;
      panDragRef.current.active = false;
      const t0 = e.touches[0], t1 = e.touches[1];
      pinchRef.current.lastDist = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
      return;
    }
    if (e.touches.length === 1) {
      pinchRef.current.active = false;
      const touch = e.touches[0];
      // If pasted hold exists, check if touch is on it to start drag-move
      if (pastedHoldId) {
        const pct = clientToBoardPct(touch.clientX, touch.clientY);
        if (pct) {
          const hitId = findHoldAtPoint(pct.x, pct.y, holds, 3);
          if (hitId === pastedHoldId) {
            setDraggingHold({ holdId: pastedHoldId, startPct: pct });
            return;
          }
        }
      }
      panDragRef.current = {
        active: true,
        startX: touch.clientX, startY: touch.clientY,
        basePanX: panRef.current.x, basePanY: panRef.current.y,
        moved: false,
      };
    }
  }

  function handleTouchMove(e) {
    if (pinchRef.current.active && e.touches.length === 2) {
      e.preventDefault();
      const t0 = e.touches[0], t1 = e.touches[1];
      const dist = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
      const factor = dist / pinchRef.current.lastDist;
      pinchRef.current.lastDist = dist;
      const rect = containerRef.current.getBoundingClientRect();
      const pivotX = (t0.clientX + t1.clientX) / 2 - rect.left - rect.width / 2;
      const pivotY = (t0.clientY + t1.clientY) / 2 - rect.top - rect.height / 2;
      doZoom(scaleRef.current * factor, pivotX, pivotY);
      return;
    }
    if (e.touches.length === 1) {
      const touch = e.touches[0];
      const pct = clientToBoardPct(touch.clientX, touch.clientY);
      if (draggingHold && pct) {
        e.preventDefault();
        movePastedHold(pct);
        return;
      }
      if (draggingVertex && pct) {
        e.preventDefault();
        updateVertexPosition(draggingVertex.holdId, draggingVertex.vertexIdx, pct.x, pct.y);
        return;
      }
      if (panDragRef.current.active) {
        const dx = touch.clientX - panDragRef.current.startX;
        const dy = touch.clientY - panDragRef.current.startY;
        if (Math.abs(dx) > 12 || Math.abs(dy) > 12) panDragRef.current.moved = true;
        if (scaleRef.current > 1 && panDragRef.current.moved) {
          e.preventDefault();
          const el = containerRef.current;
          const maxX = el ? el.offsetWidth * (scaleRef.current - 1) / 2 : 0;
          const maxY = el ? el.offsetHeight * (scaleRef.current - 1) / 2 : 0;
          panRef.current = {
            x: clamp(panDragRef.current.basePanX + dx, -maxX, maxX),
            y: clamp(panDragRef.current.basePanY + dy, -maxY, maxY),
          };
          setPan({ ...panRef.current });
        }
      }
    }
  }

  function handleTouchEnd(e) {
    if (draggingHold) { setDraggingHold(null); pinchRef.current.active = false; panDragRef.current.active = false; return; }
    if (draggingVertex) { setDraggingVertex(null); pinchRef.current.active = false; panDragRef.current.active = false; return; }
    if (panDragRef.current.active && !panDragRef.current.moved) {
      const touch = e.changedTouches?.[0];
      if (touch) {
        const pct = clientToBoardPct(touch.clientX, touch.clientY);
        if (pct) handleClick(pct);
      }
    }
    pinchRef.current.active = false;
    panDragRef.current.active = false;
  }

  function startVertexDrag(holdId, vertexIdx, e) {
    e.stopPropagation();
    if (e.type === 'touchstart') lastTouchTimeRef.current = Date.now();
    setDraggingVertex({ holdId, vertexIdx });
  }

  function switchTool(tool) {
    setDrawPoints([]);
    setDrawClosed(false);
    if (tool !== TOOLS.COPY) {
      setClipboard(null);
      setPasteRotation(0);
      setPastedHoldId(null);
    }
    setActiveTool(tool);
  }

  // ─── Derived values ─────────────────────────────────────────────────
  const isZoomed = scale > 1;
  const cursorStyle = activeTool === TOOLS.DRAW ? 'crosshair'
    : activeTool === TOOLS.COPY && clipboard ? 'copy'
    : isZoomed ? 'grab' : 'default';

  // ─── SVG rendering helpers ──────────────────────────────────────────

  function renderHoldOutline(hold) {
    const isSelected = hold.id === selectedId;
    const hasPoly = hold.polygon?.length >= 3;
    const confidence = hold.confidence || 'high';
    const isHigh = confidence === 'high';

    const outlineColor = isHigh ? '#22c55e' : '#ef4444';
    const fillColor = isHigh ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.06)';
    const selectedColor = '#0047FF';
    // Thicker lines for confirmed (high) holds
    const lineWidth = isSelected ? 10 : isHigh ? 10 : 4;

    if (!hasPoly) {
      const cx = toSvgX(hold.cx);
      const cy = toSvgY(hold.cy);
      const w = hold.w_pct || hold.r * 2 || 4;
      const h = hold.h_pct || hold.r * 2 || 4;
      const rx = Math.max((w / 100) * bW / 2, 4);
      const ry = Math.max((h / 100) * bH / 2, 4);
      return (
        <g key={hold.id}>
          <ellipse cx={cx} cy={cy} rx={rx} ry={ry}
            fill={isSelected ? 'rgba(0,71,255,0.15)' : fillColor}
            stroke={isSelected ? selectedColor : outlineColor}
            strokeWidth={lineWidth}
            strokeDasharray={!isSelected && !isHigh ? '8 5' : 'none'}
            style={{ pointerEvents: 'none' }}
          />
        </g>
      );
    }

    const pts = hold.polygon.map(([x, y]) => `${toSvgX(x)},${toSvgY(y)}`).join(' ');

    return (
      <g key={hold.id}>
        {isSelected && (
          <polygon points={pts}
            fill="none" stroke="rgba(0,71,255,0.25)" strokeWidth={10}
            strokeLinejoin="round" style={{ pointerEvents: 'none' }}
          />
        )}
        <polygon points={pts}
          fill={isSelected ? 'rgba(0,71,255,0.15)' : showAllOutlines ? fillColor : 'transparent'}
          stroke={isSelected ? selectedColor : outlineColor}
          strokeWidth={lineWidth}
          strokeLinejoin="round"
          strokeDasharray={!isSelected && !isHigh ? '8 5' : 'none'}
          style={{ pointerEvents: 'none' }}
        />
        {isSelected && activeTool === TOOLS.SELECT && hold.polygon.map(([x, y], idx) => {
          const sx = toSvgX(x), sy = toSvgY(y);
          return (
            <circle key={idx} cx={sx} cy={sy} r={8}
              fill={idx === 0 ? selectedColor : '#fff'}
              stroke={idx === 0 ? '#fff' : selectedColor}
              strokeWidth={2}
              style={{ pointerEvents: 'all', cursor: 'move' }}
              onMouseDown={(e) => { if (!isSynthesizedMouse()) startVertexDrag(hold.id, idx, e); }}
              onTouchStart={(e) => startVertexDrag(hold.id, idx, e)}
            />
          );
        })}
      </g>
    );
  }

  function renderDrawingState() {
    if (activeTool !== TOOLS.DRAW || drawPoints.length === 0) return null;
    const pts = drawPoints.map(([x, y]) => `${toSvgX(x)},${toSvgY(y)}`);
    return (
      <g style={{ pointerEvents: 'none' }}>
        {drawClosed ? (
          <polygon points={pts.join(' ')}
            fill="rgba(0,71,255,0.15)" stroke="#0047FF"
            strokeWidth={2.5} strokeDasharray="6 3"
          />
        ) : drawPoints.length >= 2 ? (
          <polyline points={pts.join(' ')}
            fill="none" stroke="#0047FF"
            strokeWidth={2} strokeDasharray="5 3"
          />
        ) : null}
        {drawPoints.map(([x, y], idx) => (
          <circle key={idx}
            cx={toSvgX(x)} cy={toSvgY(y)}
            r={idx === 0 ? 12 : 6}
            fill={idx === 0 ? '#0047FF' : '#fff'}
            stroke={idx === 0 ? '#fff' : '#0047FF'}
            strokeWidth={2}
          />
        ))}
      </g>
    );
  }

  // ─── Render ─────────────────────────────────────────────────────────

  const highCount = holds.filter(h => h.confidence === 'high').length;
  const medCount = holds.filter(h => h.confidence === 'medium').length;

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 200,
      background: 'var(--bg-primary)',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        padding: '10px 16px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-primary)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        flexShrink: 0,
      }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '16px', fontFamily: 'var(--font-heading)', fontWeight: 700, color: 'var(--accent)' }}>
            HOLD MANAGER
          </h2>
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>
            {holds.length} holds · {TOOL_LABELS[activeTool]?.tip}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          <button onClick={onCancel} style={headerBtnStyle}>Cancel</button>
          <button onClick={() => onSave(holds)} style={{ ...headerBtnStyle, background: 'var(--accent)', color: '#fff', border: 'none', fontWeight: 700 }}>
            Save & Exit
          </button>
        </div>
      </div>

      {/* Toolbar */}
      <div style={{
        padding: '6px 12px',
        borderBottom: '1px solid var(--border)',
        background: 'rgba(255,255,255,0.4)',
        display: 'flex', gap: '4px', alignItems: 'center',
        flexWrap: 'wrap', flexShrink: 0,
      }}>
        {Object.entries(TOOL_LABELS).map(([tool, { icon, label }]) => (
          <button key={tool}
            onClick={() => switchTool(tool)}
            style={{
              padding: '5px 10px', borderRadius: '6px', fontSize: '12px',
              cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px',
              border: activeTool === tool ? '2px solid var(--accent)' : '2px solid transparent',
              background: activeTool === tool ? 'rgba(0,71,255,0.1)' : 'rgba(0,0,0,0.05)',
              color: activeTool === tool ? 'var(--accent)' : 'var(--text-secondary)',
              fontWeight: activeTool === tool ? 700 : 400,
            }}
          >
            <span style={{ fontSize: '14px' }}>{icon}</span>
            {label}
          </button>
        ))}

        <div style={{ width: '1px', height: '24px', background: 'var(--border)', margin: '0 4px' }} />

        <button onClick={undo} disabled={!canUndo}
          style={{ ...iconBtnStyle, opacity: canUndo ? 1 : 0.3 }}
          title="Undo (Ctrl+Z)"
        >↩</button>
        <button onClick={redo} disabled={!canRedo}
          style={{ ...iconBtnStyle, opacity: canRedo ? 1 : 0.3 }}
          title="Redo (Ctrl+Shift+Z)"
        >↪</button>

        <div style={{ width: '1px', height: '24px', background: 'var(--border)', margin: '0 4px' }} />

        <button onClick={deleteSelected} disabled={!selectedId}
          style={{ ...iconBtnStyle, opacity: selectedId ? 1 : 0.3, color: selectedId ? '#FF5252' : 'var(--text-dim)' }}
          title="Delete selected (Del)"
        >🗑</button>

        <button onClick={() => setShowAllOutlines(prev => !prev)}
          style={{ ...iconBtnStyle, background: showAllOutlines ? 'rgba(0,71,255,0.1)' : 'rgba(0,0,0,0.05)' }}
          title="Toggle all outlines"
        >◻</button>

        {isZoomed && (
          <button onClick={resetZoom} style={{ ...iconBtnStyle, fontSize: '10px' }}>
            {Math.round(scale * 100)}% ↺
          </button>
        )}
      </div>

      {/* Canvas */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        <div
          ref={containerRef}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onDoubleClick={isZoomed ? resetZoom : undefined}
          style={{
            width: '100%', height: '100%',
            touchAction: 'none', userSelect: 'none',
            cursor: cursorStyle, overflow: 'hidden',
          }}
        >
          <div style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
            transformOrigin: 'center center',
            willChange: 'transform',
            display: 'flex', justifyContent: 'center',
          }}>
            <img
              src={IMG_SRC}
              alt="Climbing board"
              onLoad={(e) => {
                setImgSize({ w: e.target.naturalWidth, h: e.target.naturalHeight });
                setImageLoaded(true);
              }}
              style={{
                maxWidth: '100%', maxHeight: 'calc(100vh - 120px)',
                display: 'block', opacity: imageLoaded ? 1 : 0.3,
              }}
              draggable={false}
            />
            {imageLoaded && (
              <svg
                ref={svgRef}
                viewBox={`0 0 ${imgSize.w} ${imgSize.h}`}
                preserveAspectRatio="xMidYMid meet"
                style={{
                  position: 'absolute', top: 0, left: 0,
                  width: '100%', height: '100%',
                  overflow: 'visible', pointerEvents: 'none',
                }}
              >
                {showAllOutlines && holds.map(hold => renderHoldOutline(hold))}
                {!showAllOutlines && selectedId && selectedHold && renderHoldOutline(selectedHold)}
                {renderDrawingState()}
              </svg>
            )}
          </div>
        </div>
      </div>

      {/* Bottom panel */}
      <div style={{
        padding: '8px 12px',
        borderTop: '1px solid var(--border)',
        background: 'rgba(255,255,255,0.5)',
        flexShrink: 0,
        display: 'flex', gap: '6px', alignItems: 'center',
        flexWrap: 'wrap', minHeight: '44px',
      }}>
        {/* Draw tool */}
        {activeTool === TOOLS.DRAW && drawPoints.length > 0 && !drawClosed && (
          <>
            <span style={statusStyle}>{drawPoints.length} vertices — click first vertex to close</span>
            <button onClick={() => setDrawPoints(prev => prev.slice(0, -1))} style={actionBtnStyle}>Undo point</button>
            <button onClick={() => { setDrawPoints([]); setDrawClosed(false); }} style={actionBtnStyle}>Reset</button>
          </>
        )}
        {activeTool === TOOLS.DRAW && drawClosed && (
          <>
            <span style={statusStyle}>Polygon closed ({drawPoints.length} pts)</span>
            <button onClick={finishDraw} style={{ ...actionBtnStyle, background: 'var(--accent)', color: '#fff', fontWeight: 700 }}>Create Hold</button>
            <button onClick={() => { setDrawPoints([]); setDrawClosed(false); }} style={actionBtnStyle}>Redraw</button>
          </>
        )}

        {/* Select tool: selected hold */}
        {activeTool === TOOLS.SELECT && selectedHold && !pastedHoldId && (
          <>
            <span style={statusStyle}>
              {selectedHold.name || selectedHold.id} · {selectedHold.color}
              {selectedHold.polygon ? ` · ${selectedHold.polygon.length} pts` : ''}
              {selectedHold.confidence === 'medium' ? ' · ⚠ medium' : ' · ✓ high'}
            </span>
            {selectedHold.confidence === 'medium' && (
              <button
                onClick={() => setHolds(prev => prev.map(h => h.id === selectedId ? { ...h, confidence: 'high' } : h))}
                style={{ ...actionBtnStyle, background: '#22c55e', color: '#fff', fontWeight: 700, border: 'none' }}
              >Confirm</button>
            )}
            <button onClick={addVertexToSelected} style={actionBtnStyle} disabled={!selectedHold.polygon}>+ Vertex</button>
            <button onClick={copySelected} style={actionBtnStyle} disabled={!selectedHold.polygon}>Copy</button>
            <button onClick={deleteSelected} style={{ ...actionBtnStyle, color: '#FF5252' }}>Delete</button>
          </>
        )}

        {/* Copy mode — no clipboard yet, click a hold to copy */}
        {activeTool === TOOLS.COPY && !clipboard && !pastedHoldId && (
          <>
            <span style={statusStyle}>Click a hold to copy it</span>
            <button onClick={() => switchTool(TOOLS.SELECT)} style={actionBtnStyle}>Cancel</button>
          </>
        )}

        {/* Copy mode — clipboard ready, click to place */}
        {activeTool === TOOLS.COPY && clipboard && !pastedHoldId && (
          <>
            <span style={statusStyle}>Click on the board to place the copy</span>
            <button onClick={() => { setClipboard(null); setPasteRotation(0); switchTool(TOOLS.SELECT); }} style={actionBtnStyle}>Cancel</button>
          </>
        )}

        {/* Paste phase — placed, drag to move, rotate, then Done */}
        {pastedHoldId && (
          <>
            <span style={statusStyle}>Drag hold to move · Rotate · Done</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Rotate:</span>
              <input type="range" min="-180" max="180" step="5"
                value={pasteRotation}
                onChange={(e) => {
                  const rot = parseInt(e.target.value);
                  setPasteRotation(rot);
                  applyRotationToPasted(rot);
                }}
                style={{ width: '100px', accentColor: 'var(--accent)' }}
              />
              <span style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 600, minWidth: '32px' }}>
                {pasteRotation}°
              </span>
            </div>
            <button onClick={finishPaste} style={{ ...actionBtnStyle, background: 'var(--accent)', color: '#fff', fontWeight: 700 }}>Done</button>
          </>
        )}

        {/* Default: hold count */}
        {activeTool === TOOLS.SELECT && !selectedHold && !clipboard && !pastedHoldId && (
          <>
            <span style={statusStyle}>
              {holds.length} holds · {highCount} high{medCount > 0 ? ` · ${medCount} medium` : ''}
            </span>
            {medCount > 0 && (
              <button
                onClick={() => {
                  if (window.confirm(`Delete all ${medCount} medium-confidence holds?`)) {
                    setHolds(prev => prev.filter(h => h.confidence !== 'medium'));
                  }
                }}
                style={{ ...actionBtnStyle, color: '#FF5252', borderColor: 'rgba(255,82,82,0.3)' }}
              >Delete all medium</button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const headerBtnStyle = {
  padding: '6px 14px', borderRadius: '8px', fontSize: '12px', cursor: 'pointer',
  border: '1px solid rgba(0,0,0,0.15)', background: 'rgba(0,0,0,0.06)',
  color: 'var(--text-secondary)',
};

const iconBtnStyle = {
  width: '32px', height: '32px', borderRadius: '6px',
  border: '1px solid rgba(0,0,0,0.1)', background: 'rgba(0,0,0,0.05)',
  color: 'var(--text-secondary)', fontSize: '16px',
  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
};

const actionBtnStyle = {
  padding: '5px 12px', borderRadius: '6px', fontSize: '11px', cursor: 'pointer',
  border: '1px solid rgba(0,0,0,0.15)', background: 'rgba(0,0,0,0.06)',
  color: 'var(--text-secondary)',
};

const statusStyle = {
  fontSize: '11px', color: 'var(--text-muted)', letterSpacing: '0.5px',
};
