import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useUndoRedo } from '../hooks/useUndoRedo';
import {
  centroid, boundingBox,
  rotatePolygon, scalePolygon, translatePolygon,
  simplifyPath, findHoldAtPoint, holdFromPolygon, pointInPolygon,
} from '../utils/polygonUtils';
import { HOLD_COLOR_DOT, HOLD_TYPES, TECHNIQUES, STYLES } from '../utils/constants';
import { computeHoldCounts, computePercentiles, colorForPercentile, availableAngles, countPassingRoutes } from '../utils/heatMap';
import holdsData from '../data/holds.json';

const TOOLS = {
  SELECT: 'select',
  DRAW: 'draw',
  COPY: 'copy',   // internal state for paste placement
};

// SVG icons for toolbar tools
const IconSelect = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 2l10 6-5 1-3 5z" />
  </svg>
);
const IconDraw = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="8,2 13,6 11,12 5,12 3,6" />
  </svg>
);
const IconUndo = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 7H10a3 3 0 110 6H8" /><path d="M3 7l3-3M3 7l3 3" />
  </svg>
);
const IconRedo = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M13 7H6a3 3 0 100 6H8" /><path d="M13 7l-3-3M13 7l-3 3" />
  </svg>
);
const IconEye = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 8s3-5 7-5 7 5 7 5-3 5-7 5-7-5-7-5z" /><circle cx="8" cy="8" r="2" />
  </svg>
);
const IconZoomReset = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="7" cy="7" r="4" /><path d="M13 13l-3-3" /><path d="M5 7h4M7 5v4" />
  </svg>
);

const TOOL_LABELS = {
  [TOOLS.SELECT]: { icon: <IconSelect />, label: 'Select', tip: 'Click holds to select · drag to move' },
  [TOOLS.DRAW]:   { icon: <IconDraw />, label: 'Draw', tip: 'Click to place vertices, click first vertex to close' },
};

const MIN_SCALE = 1;
const MAX_SCALE = 8;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function r1(v) { return Math.round(v * 10) / 10; }

function positivityLabel(val) {
  if (val <= -4) return 'Very slopey';
  if (val <= -2) return 'Slopey';
  if (val === -1) return 'Slightly slopey';
  if (val === 0) return 'Neutral';
  if (val === 1) return 'Slightly positive';
  if (val <= 3) return 'Positive';
  return 'Very juggy';
}

export default function BoardSetupView({ initialHolds, onSave, onCancel, imgSrc, imgSrcSet, imgSizes, initialManagerMode, onManagerModeChange, onEditHold, routes, boardRegion = holdsData.boardRegion }) {
  const { state: holds, setState: setHolds, undo, redo, canUndo, canRedo, beginCoalesce, endCoalesce } = useUndoRedo(initialHolds);

  const [managerMode, setManagerMode] = useState(initialManagerMode || 'boundaries'); // 'boundaries' | 'metadata' | 'heatmap'
  const [inspectedHoldId, setInspectedHoldId] = useState(null);

  // ─── Heat Map filter state ───────────────────────────────────────────
  const [hmHoldTypes, setHmHoldTypes]   = useState([]);
  const [hmTechniques, setHmTechniques] = useState([]);
  const [hmStyles, setHmStyles]         = useState([]);
  const [hmSetter, setHmSetter]         = useState('');
  const [hmAngle, setHmAngle]           = useState(null);   // number | null
  const [hmIncludeFeet, setHmIncludeFeet] = useState(true);
  const [hmFiltersOpen, setHmFiltersOpen] = useState(false);

  // Setter input has its own uncontrolled buffer for debounce feel (we update hmSetter on change directly — no debounce needed for filter math)
  const toggleHmTag = (list, setter, val) =>
    setter(prev => prev.includes(val) ? prev.filter(v => v !== val) : [...prev, val]);

  const clearHmFilters = () => {
    setHmHoldTypes([]); setHmTechniques([]); setHmStyles([]);
    setHmSetter(''); setHmAngle(null); setHmIncludeFeet(true);
  };

  const [activeTool, setActiveTool] = useState(TOOLS.SELECT);
  const [selectedIds, setSelectedIds] = useState([]);       // multi-select: array of hold IDs
  const [vertexEditId, setVertexEditId] = useState(null);   // hold currently showing vertex handles
  const [showAllOutlines, setShowAllOutlines] = useState(true);
  const [selectRotation, setSelectRotation] = useState(0);  // rotation for selected holds
  const [selectScale, setSelectScale] = useState(100);       // scale % for selected holds

  // Drawing state
  const [drawMode, setDrawMode] = useState('polygon');  // 'polygon' or 'lasso'
  const [drawPoints, setDrawPoints] = useState([]);
  const [drawClosed, setDrawClosed] = useState(false);
  const lassoActiveRef = useRef(false);
  const lassoPosRef = useRef(null);         // { clientX, clientY } during touch lasso draw — for loupe
  const lassoBoardPctRef = useRef(null);    // { x, y } board-% of current lasso point — for loupe
  const [lassoLoupeUpdate, setLassoLoupeUpdate] = useState(0); // force lasso loupe re-render
  const [lassoSelectActive, setLassoSelectActive] = useState(false); // select-lasso sub-mode

  // Copy/paste state — copy selected, click to place
  const [clipboard, setClipboard] = useState(null);     // source hold shape
  const [pasteMode, setPasteMode] = useState('single'); // 'single' (one stamp → Select) | 'multi' (stamp until Done)
  const pasteModeRef = useRef('single');                // handlers read the ref — React closures go stale
  const [placedCount, setPlacedCount] = useState(0);    // # stamped in the current multi run (for the counter)
  const shiftHeldRef = useRef(false);                   // Shift = keep stamping (laptop); independent of pasteMode
  const [pastePreviewPct, setPastePreviewPct] = useState(null); // ghost-preview cursor pos in board-% (mouse only)

  // Vertex drag state
  const [draggingVertex, setDraggingVertex] = useState(null);
  const draggingVertexRef = useRef(null);   // mirrors draggingVertex for use in event handlers
  const touchPosRef = useRef(null);         // { clientX, clientY } during touch vertex drag
  const dragVertexPctRef = useRef(null);    // { x, y } board-% position of dragged vertex
  const vertexDragStartRef = useRef(null);  // { clientX, clientY } touch start for threshold check
  const vertexDragActiveRef = useRef(false); // true once finger moves beyond threshold
  const [loupeUpdate, setLoupeUpdate] = useState(0); // incremented to force loupe re-render

  // Whole-hold drag state (for pasted hold repositioning)
  // offsetX/Y: cursor distance from hold centroid at drag-start — keeps cursor relative to hold
  const [draggingHold, setDraggingHold] = useState(null); // { holdId, isMulti, offsetX, offsetY }
  const holdDragClientRef = useRef(null);   // { clientX, clientY } during single-hold touch drag — for loupe

  // Pending hold interaction (both touch and mouse) — cleared when drag activates or gesture ends
  // Stores: { hitId, startClientX, startClientY, offsetX, offsetY }
  const pendingHoldRef = useRef(null);
  const longPressTimerRef = useRef(null);

  // Armed state: becomes true 500 ms after first hold is selected, immediately on vertex-edit.
  // When armed, dragging a selected hold body moves the hold; otherwise drag falls through to pan.
  const [armed, setArmed] = useState(false);
  const armedRef = useRef(false);
  const armedTimerRef = useRef(null);

  // Refs to current state values for use inside setTimeout/event-handler closures
  const selectedIdsRef = useRef([]);
  const vertexEditIdRef = useRef(null);
  useEffect(() => { selectedIdsRef.current = selectedIds; }, [selectedIds]);
  useEffect(() => { vertexEditIdRef.current = vertexEditId; }, [vertexEditId]);
  useEffect(() => { armedRef.current = armed; }, [armed]);
  useEffect(() => { pasteModeRef.current = pasteMode; }, [pasteMode]);

  // Image / zoom / pan
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imgSize, setImgSize] = useState({ w: 1200, h: 900 });
  const [pxScale, setPxScale] = useState(1);
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

  // Cancel long-press timer on unmount
  useEffect(() => {
    return () => {
      if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    };
  }, []);

  // Single source of truth for armed — driven by selectedIds.length and vertexEditId.
  // This covers ALL selection paths: tap, lasso-select, Select All, long-press, double-click.
  const prevSelectedCountRef = useRef(0);
  useEffect(() => {
    const prev = prevSelectedCountRef.current;
    const curr = selectedIds.length;
    prevSelectedCountRef.current = curr;

    if (curr === 0) {
      // Selection cleared — disarm immediately, cancel any pending timer
      if (armedTimerRef.current) { clearTimeout(armedTimerRef.current); armedTimerRef.current = null; }
      setArmed(false);
      armedRef.current = false;
    } else if (vertexEditId) {
      // Vertex-edit mode active (long-press or double-click) — arm immediately
      if (armedTimerRef.current) { clearTimeout(armedTimerRef.current); armedTimerRef.current = null; }
      setArmed(true);
      armedRef.current = true;
    } else if (curr >= 2) {
      // Multi-select — always armed so a drag moves the group immediately (no 500 ms delay)
      if (armedTimerRef.current) { clearTimeout(armedTimerRef.current); armedTimerRef.current = null; }
      setArmed(true);
      armedRef.current = true;
    } else if (prev === 0 && curr === 1) {
      // Transition from empty → single selection (without vertex edit) — delay 500 ms
      if (armedTimerRef.current) clearTimeout(armedTimerRef.current);
      armedTimerRef.current = setTimeout(() => {
        armedTimerRef.current = null;
        setArmed(true);
        armedRef.current = true;
      }, 500);
    }
    // If already non-empty single selection and stays single (re-tap noop), armed stays as-is.

    return () => {
      if (armedTimerRef.current) { clearTimeout(armedTimerRef.current); armedTimerRef.current = null; }
    };
  }, [selectedIds.length, vertexEditId]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !imgSize.w) return;
    const update = () => {
      const rect = svg.getBoundingClientRect();
      // getBoundingClientRect includes CSS transform — divide out zoom to get base ratio
      const zoom = scaleRef.current || 1;
      const s = Math.min(rect.width / zoom / imgSize.w, rect.height / zoom / imgSize.h);
      // Normalize to 2x display as baseline — 3x devices get thinner strokes to match 2x look
      const dprFactor = 2 / (window.devicePixelRatio || 2);
      if (s > 0) setPxScale((1 / s) * dprFactor);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(svg);
    return () => observer.disconnect();
  }, [imgSize.w, imgSize.h]);

  // ─── Coordinate conversion ──────────────────────────────────────────
  const bLeft = imgSize.w * boardRegion.left / 100;
  const bTop = imgSize.h * boardRegion.top / 100;
  const bW = imgSize.w * boardRegion.width / 100;
  const bH = imgSize.h * boardRegion.height / 100;

  const toSvgX = (x) => bLeft + (x / 100) * bW;
  const toSvgY = (y) => bTop + (y / 100) * bH;

  // Returns screen-pixels-per-SVG-unit, accounting for preserveAspectRatio="xMidYMin meet".
  // Uses getBoundingClientRect() which reliably includes CSS transforms on all browsers
  // (iOS Safari doesn't include CSS ancestor transforms in getScreenCTM()).
  function getSvgScale() {
    const svg = svgRef.current;
    if (!svg) return 1;
    const rect = svg.getBoundingClientRect();
    return Math.min(rect.width / imgSize.w, rect.height / imgSize.h);
  }

  const clientToBoardPct = useCallback((clientX, clientY) => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    // Letterbox offsets for preserveAspectRatio="xMidYMin meet"
    const uniformScale = Math.min(rect.width / imgSize.w, rect.height / imgSize.h);
    const xOffset = (rect.width - imgSize.w * uniformScale) / 2; // xMid
    const yOffset = 0;                                            // YMin
    const svgX = (clientX - rect.left - xOffset) / uniformScale;
    const svgY = (clientY - rect.top  - yOffset) / uniformScale;
    return {
      x: clamp(((svgX - bLeft) / bW) * 100, 0, 100),
      y: clamp(((svgY - bTop)  / bH) * 100, 0, 100),
    };
  }, [bLeft, bTop, bW, bH, imgSize.w, imgSize.h]);

  // Check if a click is on the first draw vertex (in screen pixel space for zoom-independent accuracy)
  const isOnFirstVertex = useCallback((pct) => {
    if (drawPoints.length < 3) return false;
    const svgScale = getSvgScale();
    const clickSvgX = toSvgX(pct.x);
    const clickSvgY = toSvgY(pct.y);
    const firstSvgX = toSvgX(drawPoints[0][0]);
    const firstSvgY = toSvgY(drawPoints[0][1]);
    const distPx = Math.hypot((clickSvgX - firstSvgX) * svgScale, (clickSvgY - firstSvgY) * svgScale);
    // First vertex circle has r=12 in SVG space — use 14px screen threshold (generous but tight)
    return distPx < 14;
  }, [drawPoints, toSvgX, toSvgY, imgSize.w, imgSize.h]);

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

  // ─── Heat Map derived data ───────────────────────────────────────────
  const hmFilters = useMemo(() => ({
    holdTypes: hmHoldTypes,
    techniques: hmTechniques,
    styles: hmStyles,
    setter: hmSetter,
    angle: hmAngle,
    includeFeet: hmIncludeFeet,
  }), [hmHoldTypes, hmTechniques, hmStyles, hmSetter, hmAngle, hmIncludeFeet]);

  const heatCounts = useMemo(
    () => managerMode === 'heatmap' ? computeHoldCounts(routes || [], hmFilters) : {},
    [managerMode, routes, hmFilters]
  );
  const heatPercentiles = useMemo(
    () => computePercentiles(heatCounts),
    [heatCounts]
  );
  const hmRouteCount = useMemo(
    () => managerMode === 'heatmap' ? countPassingRoutes(routes || [], hmFilters) : 0,
    [managerMode, routes, hmFilters]
  );
  const hmHoldCount = useMemo(
    () => Object.values(heatCounts).filter(c => c > 0).length,
    [heatCounts]
  );
  const hmAngles = useMemo(() => availableAngles(routes || []), [routes]);

  // ─── Tool actions ───────────────────────────────────────────────────

  // Derived: first selected hold (for single-selection actions like vertex editing)
  const selectedId = selectedIds.length > 0 ? selectedIds[0] : null;
  // vertexEditHold: the hold whose vertices are currently shown (may differ from selectedId in general)
  const vertexEditHold = vertexEditId ? holds.find(h => h.id === vertexEditId) : null;
  // selectedHold kept for compatibility with rotate/scale/copy actions that still use the first selected hold
  const selectedHold = selectedId ? holds.find(h => h.id === selectedId) : null;
  const isHoldSelected = (id) => selectedIds.includes(id);

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
      if (isMeta && e.key === 'a' && !e.target.closest('input')) {
        e.preventDefault();
        selectAllHolds();
        return;
      }
      if (e.key === 'Escape') {
        if (clipboard) { exitPaste(); return; }
        if (drawPoints.length > 0) { setDrawPoints([]); setDrawClosed(false); return; }
        if (selectedId) { clearSelection(); return; }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedId, selectedIds, clipboard, drawPoints, undo, redo]);

  // Track Shift independently of the buttons — held Shift keeps stamping while pasting (laptop only).
  useEffect(() => {
    const down = (e) => { if (e.key === 'Shift') shiftHeldRef.current = true; };
    const up = (e) => { if (e.key === 'Shift') shiftHeldRef.current = false; };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, []);

  // Single exit point for Copy mode → back to Select (pure setters, safe to call from any handler).
  function exitPaste() {
    setClipboard(null);
    setPastePreviewPct(null);
    setPasteMode('single');
    setPlacedCount(0);
    setActiveTool(TOOLS.SELECT);
  }

  // Store original polygons for rotation from base position
  const selectOrigPolysRef = useRef({});

  function clearSelection() {
    setSelectedIds([]);
    setVertexEditId(null);
    setLassoSelectActive(false);
    setSelectRotation(0);
    setSelectScale(100);
    selectOrigPolysRef.current = {};
    // armed is driven by the useEffect watching selectedIds.length — no manual reset needed here
  }

  function selectAllHolds() {
    setSelectedIds(holds.map(h => h.id));
    setVertexEditId(null);
  }

  function deleteSelected() {
    if (selectedIds.length === 0) return;
    setHolds(prev => prev.filter(h => !selectedIds.includes(h.id)));
    clearSelection();
  }

  function copySelected() {
    if (selectedIds.length === 0) return;
    // Copy first selected hold (single copy)
    const hold = holds.find(h => h.id === selectedIds[0]);
    if (!hold?.polygon) return;
    setClipboard({ ...hold });
    setPasteMode('single');
    setPlacedCount(0);
    setActiveTool(TOOLS.COPY);
    clearSelection();
  }

  function doPaste(pct) {
    if (!clipboard?.polygon) return;
    const srcPoly = clipboard.polygon.map(([x, y]) => [x, y]);
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
    setHolds(prev => [...prev, newHold]);
    // Multi mode OR Shift held → keep the clipboard and stay in Copy mode for repeated stamping.
    // (Shift and pasteMode are independent — Shift never flips the mode.)
    const stay = pasteModeRef.current === 'multi' || shiftHeldRef.current;
    if (stay) {
      setPlacedCount((c) => c + 1);
      return;
    }
    // Single placement → back to Select with the new hold selected (its transform handles show).
    exitPaste();
    setSelectedIds([id]);
  }

  function moveHoldTo(holdId, newCenterPct) {
    setHolds(prev => prev.map(h => {
      if (h.id !== holdId || !h.polygon) return h;
      const [oldCx, oldCy] = centroid(h.polygon);
      const dx = newCenterPct.x - oldCx;
      const dy = newCenterPct.y - oldCy;
      const newPoly = translatePolygon(h.polygon, dx, dy);
      const [cx, cy] = centroid(newPoly);
      const bb = boundingBox(newPoly);
      return { ...h, polygon: newPoly, cx: r1(cx), cy: r1(cy), w_pct: r1(bb.w), h_pct: r1(bb.h) };
    }));
  }

  // Move multiple selected holds together (delta from drag anchor)
  const moveMultiLastRef = useRef(null);
  function moveMultipleHolds(newPct) {
    const last = moveMultiLastRef.current || newPct;
    const dx = newPct.x - last.x;
    const dy = newPct.y - last.y;
    moveMultiLastRef.current = newPct;
    if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return;
    setHolds(prev => prev.map(h => {
      if (!selectedIds.includes(h.id) || !h.polygon) return h;
      const newPoly = translatePolygon(h.polygon, dx, dy);
      const [cx, cy] = centroid(newPoly);
      const bb = boundingBox(newPoly);
      return { ...h, polygon: newPoly, cx: r1(cx), cy: r1(cy), w_pct: r1(bb.w), h_pct: r1(bb.h) };
    }));
  }

  // Rotate selected holds — single hold rotates around own centroid, multi rotates around board center
  function applyRotationToSelected(rotation) {
    if (selectedIds.length === 0) return;
    const origPolys = selectOrigPolysRef.current;
    const useGroupCenter = selectedIds.length > 1;
    setHolds(prev => prev.map(h => {
      if (!selectedIds.includes(h.id) || !h.polygon) return h;
      const orig = origPolys[h.id];
      if (!orig) return h;
      let newPoly = orig.map(([x, y]) => [x, y]);
      if (rotation !== 0) {
        if (useGroupCenter) {
          // Multi-select: rotate around board center (50, 50)
          newPoly = rotatePolygon(newPoly, 50, 50, rotation);
        } else {
          // Single: rotate around hold's own centroid
          const [ocx, ocy] = centroid(orig);
          newPoly = rotatePolygon(newPoly, ocx, ocy, rotation);
        }
      }
      const [cx, cy] = centroid(newPoly);
      const bb = boundingBox(newPoly);
      return { ...h, polygon: newPoly, cx: r1(cx), cy: r1(cy), w_pct: r1(bb.w), h_pct: r1(bb.h) };
    }));
  }

  // Scale selected holds — single scales around own centroid, multi around board center
  function applyScaleToSelected(scalePct) {
    if (selectedIds.length === 0) return;
    const origPolys = selectOrigPolysRef.current;
    const factor = scalePct / 100;
    const useGroupCenter = selectedIds.length > 1;
    setHolds(prev => prev.map(h => {
      if (!selectedIds.includes(h.id) || !h.polygon) return h;
      const orig = origPolys[h.id];
      if (!orig) return h;
      let newPoly;
      if (useGroupCenter) {
        newPoly = scalePolygon(orig, factor, 50, 50);
      } else {
        const [ocx, ocy] = centroid(orig);
        newPoly = scalePolygon(orig, factor, ocx, ocy);
      }
      const [cx, cy] = centroid(newPoly);
      const bb = boundingBox(newPoly);
      return { ...h, polygon: newPoly, cx: r1(cx), cy: r1(cy), w_pct: r1(bb.w), h_pct: r1(bb.h) };
    }));
  }

  // Snapshot original polygons when rotation/scale interaction starts
  function snapshotOrigPolys() {
    beginCoalesce();
    const origPolys = {};
    for (const id of selectedIds) {
      const h = holds.find(hh => hh.id === id);
      if (h?.polygon) origPolys[id] = h.polygon.map(([x, y]) => [x, y]);
    }
    selectOrigPolysRef.current = origPolys;
    setSelectRotation(0);
    setSelectScale(100);
  }

  function finishDraw() {
    if (drawPoints.length < 3) return;
    const newHold = holdFromPolygon(drawPoints, `custom_${Date.now()}`);
    newHold.confidence = 'high';
    setHolds(prev => [...prev, newHold]);
    setDrawPoints([]);
    setDrawClosed(false);
    lassoActiveRef.current = false;
    setSelectedIds([newHold.id]);
    setActiveTool(TOOLS.SELECT);
  }

  function finishLasso() {
    if (drawPoints.length < 5) { setDrawPoints([]); lassoActiveRef.current = false; return; }
    // Simplify with low tolerance for high detail (3x more vertices than default 0.5)
    const simplified = simplifyPath(drawPoints, 0.4);
    if (simplified.length < 3) { setDrawPoints([]); lassoActiveRef.current = false; return; }
    const newHold = holdFromPolygon(simplified, `custom_${Date.now()}`);
    newHold.confidence = 'high';
    setHolds(prev => [...prev, newHold]);
    setDrawPoints([]);
    setDrawClosed(false);
    lassoActiveRef.current = false;
    setSelectedIds([newHold.id]);
    setActiveTool(TOOLS.SELECT);
  }

  // Select-lasso: on release, hit-test holds against the freehand polygon and REPLACE selection.
  function finishLassoSelect() {
    lassoActiveRef.current = false;
    lassoPosRef.current = null;
    lassoBoardPctRef.current = null;
    setLassoSelectActive(false);
    if (drawPoints.length < 3) { setDrawPoints([]); return; }
    const lassoPolygon = simplifyPath(drawPoints, 0.4);
    if (lassoPolygon.length < 3) { setDrawPoints([]); return; }
    const matched = [];
    for (const hold of holds) {
      if (!hold.polygon || hold.polygon.length < 3) {
        // Fallback: check centroid of holds without polygon
        if (pointInPolygon(hold.cx, hold.cy, lassoPolygon)) matched.push(hold.id);
        continue;
      }
      // Hit if ANY hold vertex is inside lasso OR any lasso vertex is inside hold polygon
      const holdInsideLasso = hold.polygon.some(([x, y]) => pointInPolygon(x, y, lassoPolygon));
      if (holdInsideLasso) { matched.push(hold.id); continue; }
      const lassoInsideHold = lassoPolygon.some(([x, y]) => pointInPolygon(x, y, hold.polygon));
      if (lassoInsideHold) matched.push(hold.id);
    }
    setDrawPoints([]);
    if (matched.length > 0) setSelectedIds(matched);
  }

  function addVertexToSelected() {
    if (!vertexEditHold?.polygon || vertexEditHold.polygon.length < 3) return;
    const poly = vertexEditHold.polygon;
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
      if (h.id !== vertexEditId) return h;
      const [cx, cy] = centroid(newPoly);
      const bb = boundingBox(newPoly);
      return { ...h, polygon: newPoly, cx: r1(cx), cy: r1(cy), w_pct: r1(bb.w), h_pct: r1(bb.h) };
    }));
  }

  function removeVertexFromSelected() {
    if (!vertexEditHold?.polygon || vertexEditHold.polygon.length <= 3) return;
    const poly = vertexEditHold.polygon;
    // Remove the least significant vertex (smallest triangle area with its neighbors)
    let minArea = Infinity;
    let minIdx = -1;
    for (let i = 0; i < poly.length; i++) {
      const prev = poly[(i - 1 + poly.length) % poly.length];
      const curr = poly[i];
      const next = poly[(i + 1) % poly.length];
      const area = Math.abs((next[0] - prev[0]) * (curr[1] - prev[1]) - (curr[0] - prev[0]) * (next[1] - prev[1])) / 2;
      if (area < minArea) { minArea = area; minIdx = i; }
    }
    if (minIdx < 0) return;
    const newPoly = poly.filter((_, i) => i !== minIdx);
    setHolds(prev => prev.map(h => {
      if (h.id !== vertexEditId) return h;
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
    // Metadata mode — just pan/zoom
    if (managerMode === 'metadata') {
      panDragRef.current = {
        active: true,
        startX: e.clientX, startY: e.clientY,
        basePanX: panRef.current.x, basePanY: panRef.current.y,
        moved: false,
      };
      return;
    }
    // Lasso draw — start freehand path (draw tool OR select-lasso sub-mode)
    if ((activeTool === TOOLS.DRAW && drawMode === 'lasso') ||
        (activeTool === TOOLS.SELECT && lassoSelectActive)) {
      const pct = clientToBoardPct(e.clientX, e.clientY);
      if (pct) {
        lassoActiveRef.current = true;
        setDrawPoints([[r1(pct.x), r1(pct.y)]]);
        setDrawClosed(false);
        return;
      }
    }
    // Select tool — set up pending interaction; drag activates in handleMouseMove
    if (activeTool === TOOLS.SELECT) {
      const pct = clientToBoardPct(e.clientX, e.clientY);
      if (pct) {
        const hitId = findHoldAtPoint(pct.x, pct.y, holds, 3);
        if (hitId) {
          const holdObj = holds.find(h => h.id === hitId);
          const [hcx, hcy] = holdObj?.polygon ? centroid(holdObj.polygon) : [holdObj?.cx ?? pct.x, holdObj?.cy ?? pct.y];
          const offsetX = pct.x - hcx;
          const offsetY = pct.y - hcy;
          pendingHoldRef.current = { hitId, startClientX: e.clientX, startClientY: e.clientY, offsetX, offsetY };
          // Also initialize panDrag so that if movement exceeds threshold and we don't start a hold-drag,
          // pan is already armed and ready to take over.
          panDragRef.current = {
            active: true,
            startX: e.clientX, startY: e.clientY,
            basePanX: panRef.current.x, basePanY: panRef.current.y,
            moved: false,
          };
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
    // Ghost paste preview (mouse only) — track the cursor while in Copy mode so placement is visible
    // before clicking. Doesn't return: pan-when-zoomed still works below. Touch has no hover → no ghost.
    if (activeTool === TOOLS.COPY && clipboard) {
      setPastePreviewPct(pct);
    }
    // Lasso draw — collect freehand points
    if (lassoActiveRef.current && pct) {
      setDrawPoints(prev => [...prev, [r1(pct.x), r1(pct.y)]]);
      return;
    }
    // Pending hold: if mouse moves beyond threshold, decide between hold-drag (armed) or pan
    if (pendingHoldRef.current && !draggingHold) {
      const p = pendingHoldRef.current;
      const dx = e.clientX - p.startClientX;
      const dy = e.clientY - p.startClientY;
      if (dx * dx + dy * dy > 16) { // 4px threshold
        const { hitId, offsetX, offsetY } = p;
        pendingHoldRef.current = null;
        // If armed AND the hit hold is selected → start a hold-drag
        if (armedRef.current && selectedIdsRef.current.includes(hitId)) {
          const isMulti = selectedIdsRef.current.length > 1;
          beginCoalesce();
          setDraggingHold({ holdId: hitId, isMulti, offsetX, offsetY });
          if (isMulti) moveMultiLastRef.current = pct;
          panDragRef.current.active = false; // prevent pan from also firing
          e.preventDefault();
          return;
        }
        // Not armed or hold not in selection → fall through to pan (panDragRef already initialized)
      } else {
        return; // still within threshold — don't pan yet
      }
    }
    // Drag-move hold — subtract cursor-to-centroid offset so hold doesn't jump to cursor centre
    if (draggingHold && pct) {
      if (draggingHold.isMulti) {
        moveMultipleHolds(pct);
      } else {
        moveHoldTo(draggingHold.holdId, { x: pct.x - draggingHold.offsetX, y: pct.y - draggingHold.offsetY });
      }
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
    if (isSynthesizedMouse()) { panDragRef.current.active = false; pendingHoldRef.current = null; return; }
    if (lassoActiveRef.current) {
      lassoActiveRef.current = false;
      if (activeTool === TOOLS.SELECT && lassoSelectActive) {
        finishLassoSelect();
      } else {
        finishLasso();
      }
      return;
    }
    // Pending hold interaction that never became a drag → treat as tap
    if (pendingHoldRef.current) {
      const hitId = pendingHoldRef.current.hitId;
      pendingHoldRef.current = null;
      // handleMouseDown armed panDragRef when the press landed on a hold; this early
      // return must disarm it (mirrors the touch tap branch). Otherwise pan stays armed
      // and the next bare mousemove pans the board — the laptop "stuck pan, can't edit
      // vertices after double-click" bug. (mouse events fire mousemove with no button held.)
      panDragRef.current.active = false;
      handleHoldTap(hitId);
      return;
    }
    if (draggingHold) { endCoalesce(); setDraggingHold(null); moveMultiLastRef.current = null; return; }
    if (draggingVertex) { endCoalesce(); setDraggingVertex(null); return; }
    if (panDragRef.current.active && !panDragRef.current.moved) {
      const pct = clientToBoardPct(e.clientX, e.clientY);
      if (pct) handleClick(pct);
    }
    panDragRef.current.active = false;
  }

  // handleHoldTap: called when a tap on a hold is confirmed (no drag, no long-press).
  // Rules: additive multi-select — tap adds; re-tap removes (toggles).
  // If tapping a hold that is NOT the vertex-edit hold while in vertex-edit mode → exit vertex edit.
  function handleHoldTap(hitId) {
    if (!hitId) return;
    // Exit vertex-edit mode if tapping a different hold (or any hold in vertex-edit mode)
    if (vertexEditIdRef.current && vertexEditIdRef.current !== hitId) {
      setVertexEditId(null);
    }
    const curIds = selectedIdsRef.current;
    if (curIds.includes(hitId)) {
      // Re-tap on already-selected hold → remove from selection (toggle off)
      const newIds = curIds.filter(id => id !== hitId);
      setSelectedIds(newIds);
      // armed driven by useEffect watching selectedIds.length — no manual update needed
    } else {
      // New hold — add to selection
      setSelectedIds(prev => [...prev, hitId]);
      // armed driven by useEffect watching selectedIds.length — no manual update needed
    }
  }

  function handleClick(pct) {
    // Heatmap mode — read-only, no interaction
    if (managerMode === 'heatmap') return;
    // Metadata mode — tap to inspect hold
    if (managerMode === 'metadata') {
      const hitId = findHoldAtPoint(pct.x, pct.y, holds, 3);
      setInspectedHoldId(hitId || null);
      return;
    }

    // Copy mode — click to place
    if (activeTool === TOOLS.COPY) {
      if (clipboard) {
        doPaste(pct);
      }
      return;
    }

    if (activeTool === TOOLS.SELECT) {
      const touchTolerance = Date.now() - lastTouchTimeRef.current < 500 ? 5 : 3;
      const hitId = findHoldAtPoint(pct.x, pct.y, holds, touchTolerance);
      if (!hitId) {
        // Tap empty space → deselect all
        clearSelection();
      } else {
        // Tap on hold → additive multi-select (handled via handleHoldTap)
        handleHoldTap(hitId);
      }
    } else if (activeTool === TOOLS.DRAW && drawMode === 'polygon') {
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
      // Cancel any pending hold interaction on second finger down
      if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
      pendingHoldRef.current = null;
      const t0 = e.touches[0], t1 = e.touches[1];
      pinchRef.current.lastDist = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
      return;
    }
    if (e.touches.length === 1) {
      pinchRef.current.active = false;
      const touch = e.touches[0];
      // Metadata mode — just allow pan/zoom, tap handled in handleClick
      if (managerMode === 'metadata') {
        panDragRef.current = {
          active: true,
          startX: touch.clientX, startY: touch.clientY,
          basePanX: panRef.current.x, basePanY: panRef.current.y,
          moved: false,
        };
        return;
      }
      // Lasso draw — start freehand path (draw tool OR select-lasso sub-mode)
      if ((activeTool === TOOLS.DRAW && drawMode === 'lasso') ||
          (activeTool === TOOLS.SELECT && lassoSelectActive)) {
        const pct = clientToBoardPct(touch.clientX, touch.clientY);
        if (pct) {
          lassoActiveRef.current = true;
          lassoPosRef.current = { clientX: touch.clientX, clientY: touch.clientY };
          lassoBoardPctRef.current = { x: pct.x, y: pct.y };
          setDrawPoints([[r1(pct.x), r1(pct.y)]]);
          setDrawClosed(false);
          return;
        }
      }
      // Select tool — set up pending interaction with long-press timer
      if (activeTool === TOOLS.SELECT) {
        const pct = clientToBoardPct(touch.clientX, touch.clientY);
        if (pct) {
          const hitId = findHoldAtPoint(pct.x, pct.y, holds, 5);
          if (hitId) {
            const holdObj = holds.find(h => h.id === hitId);
            const [hcx, hcy] = holdObj?.polygon ? centroid(holdObj.polygon) : [holdObj?.cx ?? pct.x, holdObj?.cy ?? pct.y];
            const offsetX = pct.x - hcx;
            const offsetY = pct.y - hcy;
            pendingHoldRef.current = { hitId, startClientX: touch.clientX, startClientY: touch.clientY, offsetX, offsetY };
            // Long-press timer — fires vertex-edit mode after 500 ms if finger hasn't moved/lifted
            longPressTimerRef.current = setTimeout(() => {
              longPressTimerRef.current = null;
              // Only fire if the pending interaction is still the same one (not cleared by move/end)
              if (!pendingHoldRef.current || pendingHoldRef.current.hitId !== hitId) return;
              pendingHoldRef.current = null;
              // Enter vertex-edit mode using refs (closures go stale — selectedIds/vertexEditId via refs)
              setSelectedIds([hitId]);
              setVertexEditId(hitId);
              // armed driven by useEffect watching vertexEditId — no manual update needed
              navigator.vibrate?.(15);
            }, 500);
            // Also initialize panDrag so that if movement exceeds threshold and we don't start a hold-drag,
            // pan is already armed and ready to take over.
            panDragRef.current = {
              active: true,
              startX: touch.clientX, startY: touch.clientY,
              basePanX: panRef.current.x, basePanY: panRef.current.y,
              moved: false,
            };
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
      // Lasso draw — collect freehand points
      if (lassoActiveRef.current && pct) {
        e.preventDefault();
        lassoPosRef.current = { clientX: touch.clientX, clientY: touch.clientY };
        lassoBoardPctRef.current = { x: pct.x, y: pct.y };
        setDrawPoints(prev => [...prev, [r1(pct.x), r1(pct.y)]]);
        setLassoLoupeUpdate(prev => prev + 1);
        return;
      }
      // Pending hold: if finger moves beyond threshold, decide between hold-drag (armed) or pan
      if (pendingHoldRef.current && !draggingHold) {
        const p = pendingHoldRef.current;
        const dx = touch.clientX - p.startClientX;
        const dy = touch.clientY - p.startClientY;
        if (dx * dx + dy * dy > 81) { // ~9px threshold — more forgiving for fingertip wobble
          if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
          const { hitId, offsetX, offsetY } = p;
          pendingHoldRef.current = null;
          // If armed AND the hit hold is selected → start a hold-drag
          if (armedRef.current && selectedIdsRef.current.includes(hitId)) {
            const isMulti = selectedIdsRef.current.length > 1;
            beginCoalesce();
            setDraggingHold({ holdId: hitId, isMulti, offsetX, offsetY });
            if (isMulti) moveMultiLastRef.current = pct;
            else holdDragClientRef.current = { clientX: touch.clientX, clientY: touch.clientY };
            panDragRef.current.active = false; // prevent pan from also firing
            e.preventDefault();
            return;
          }
          // Not armed or hold not in selection → fall through to pan (panDragRef already initialized)
        } else {
          // Still within threshold — don't pan yet
          e.preventDefault(); // prevent scroll while we're deciding
          return;
        }
      }
      if (draggingHold && pct) {
        e.preventDefault();
        if (draggingHold.isMulti) {
          moveMultipleHolds(pct);
        } else {
          holdDragClientRef.current = { clientX: touch.clientX, clientY: touch.clientY };
          moveHoldTo(draggingHold.holdId, { x: pct.x - draggingHold.offsetX, y: pct.y - draggingHold.offsetY });
        }
        return;
      }
      if (draggingVertexRef.current && pct) {
        e.preventDefault();
        // Don't move vertex until finger exceeds threshold — prevents taps from jumping vertices
        if (!vertexDragActiveRef.current) {
          const s = vertexDragStartRef.current;
          if (s && (touch.clientX - s.clientX) ** 2 + (touch.clientY - s.clientY) ** 2 < 100) return;
          vertexDragActiveRef.current = true;
        }
        touchPosRef.current = { clientX: touch.clientX, clientY: touch.clientY };
        dragVertexPctRef.current = { x: pct.x, y: pct.y };
        updateVertexPosition(draggingVertexRef.current.holdId, draggingVertexRef.current.vertexIdx, pct.x, pct.y);
        setLoupeUpdate(prev => prev + 1);
        return;
      }
      if (panDragRef.current.active) {
        const dx = touch.clientX - panDragRef.current.startX;
        const dy = touch.clientY - panDragRef.current.startY;
        if (Math.abs(dx) > 20 || Math.abs(dy) > 20) panDragRef.current.moved = true;
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
    // Cancel long-press timer on lift
    if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
    if (lassoActiveRef.current) {
      lassoActiveRef.current = false;
      lassoPosRef.current = null;
      lassoBoardPctRef.current = null;
      pinchRef.current.active = false;
      panDragRef.current.active = false;
      if (activeTool === TOOLS.SELECT && lassoSelectActive) {
        finishLassoSelect();
      } else {
        finishLasso();
      }
      return;
    }
    // Pending hold interaction that never became a drag → treat as tap
    if (pendingHoldRef.current) {
      const hitId = pendingHoldRef.current.hitId;
      pendingHoldRef.current = null;
      pinchRef.current.active = false;
      panDragRef.current.active = false;
      handleHoldTap(hitId);
      return;
    }
    if (draggingHold) { endCoalesce(); setDraggingHold(null); moveMultiLastRef.current = null; holdDragClientRef.current = null; pinchRef.current.active = false; panDragRef.current.active = false; return; }
    if (draggingVertexRef.current) {
      endCoalesce();
      const wasTap = !vertexDragActiveRef.current;
      setDraggingVertex(null); draggingVertexRef.current = null; touchPosRef.current = null; dragVertexPctRef.current = null;
      vertexDragStartRef.current = null; vertexDragActiveRef.current = false;
      pinchRef.current.active = false; panDragRef.current.active = false;
      // If finger didn't move (tap, not drag), pass through to handleClick for deselection
      if (wasTap) {
        const touch = e.changedTouches?.[0];
        if (touch) { const pct = clientToBoardPct(touch.clientX, touch.clientY); if (pct) handleClick(pct); }
      }
      return;
    }
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

  function handleDoubleClick(e) {
    if (isSynthesizedMouse()) return; // guard against iOS double-tap synthesizing this
    if (managerMode === 'boundaries' && activeTool === TOOLS.SELECT) {
      const pct = clientToBoardPct(e.clientX, e.clientY);
      if (pct) {
        const hitId = findHoldAtPoint(pct.x, pct.y, holds, 3);
        if (hitId) {
          // Enter vertex-edit mode for this hold — armed driven by useEffect watching vertexEditId
          setSelectedIds([hitId]);
          setVertexEditId(hitId);
          navigator.vibrate?.(15);
          return;
        }
      }
    }
    if (isZoomed) resetZoom();
  }

  function startVertexDrag(holdId, vertexIdx, e) {
    e.stopPropagation();
    e.preventDefault();
    beginCoalesce();
    vertexDragActiveRef.current = false;
    if (e.type === 'touchstart') {
      lastTouchTimeRef.current = Date.now();
      const touch = e.touches?.[0] || e.changedTouches?.[0];
      if (touch) {
        touchPosRef.current = { clientX: touch.clientX, clientY: touch.clientY };
        vertexDragStartRef.current = { clientX: touch.clientX, clientY: touch.clientY };
      }
      // Initialise loupe position from existing vertex coords
      const hold = holds.find(h => h.id === holdId);
      if (hold?.polygon?.[vertexIdx]) {
        dragVertexPctRef.current = { x: hold.polygon[vertexIdx][0], y: hold.polygon[vertexIdx][1] };
      }
    }
    draggingVertexRef.current = { holdId, vertexIdx };
    setDraggingVertex({ holdId, vertexIdx });
  }

  function switchTool(tool) {
    setDrawPoints([]);
    setDrawClosed(false);
    lassoActiveRef.current = false;
    setLassoSelectActive(false);
    setDrawMode('polygon');
    setVertexEditId(null);
    if (tool !== TOOLS.COPY) {
      setClipboard(null);
      setPastePreviewPct(null);
    }
    setActiveTool(tool);
    // Reset armed state on tool switch
    if (armedTimerRef.current) { clearTimeout(armedTimerRef.current); armedTimerRef.current = null; }
    setArmed(false);
    armedRef.current = false;
  }

  // ─── Derived values ─────────────────────────────────────────────────
  const isZoomed = scale > 1;
  const cursorStyle = managerMode === 'metadata' ? (isZoomed ? 'grab' : 'pointer')
    : activeTool === TOOLS.DRAW ? 'crosshair'
    : activeTool === TOOLS.COPY ? 'copy'
    : isZoomed ? 'grab' : 'default';

  // ─── SVG rendering helpers ──────────────────────────────────────────

  function renderHoldOutline(hold) {
    const isSel = isHoldSelected(hold.id);
    const isInspected = managerMode === 'metadata' && inspectedHoldId === hold.id;
    // Show vertex handles only on the vertex-edit hold (long-press / double-click to activate)
    const showVertices = managerMode === 'boundaries' && hold.id === vertexEditId;
    const hasPoly = hold.polygon?.length >= 3;
    const confidence = hold.confidence || 'high';
    const isHigh = confidence === 'high';

    // ─── Heat map rendering ───────────────────────────────────────────
    const isHeatMode = managerMode === 'heatmap';
    if (isHeatMode) {
      const heatPct = heatPercentiles[hold.id]; // undefined if unused (count 0)
      const heatColor = heatPct !== undefined ? colorForPercentile(heatPct) : null;
      const zPx = pxScale / scale;
      const lineWidth = Math.max(Math.round(0.7 * zPx), 1);

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
              fill={heatColor ? heatColor : 'rgba(220,220,220,0.70)'}
              fillOpacity={heatColor ? 0.55 : 1}
              stroke={heatColor ? heatColor : 'rgba(160,160,160,0.30)'}
              strokeOpacity={heatColor ? 1.0 : 1}
              strokeWidth={lineWidth}
              strokeDasharray="none"
              style={{ pointerEvents: 'none' }}
            />
          </g>
        );
      }

      const pts = hold.polygon.map(([x, y]) => `${toSvgX(x)},${toSvgY(y)}`).join(' ');
      return (
        <g key={hold.id}>
          <polygon points={pts}
            fill={heatColor ? heatColor : 'rgba(220,220,220,0.70)'}
            fillOpacity={heatColor ? 0.55 : 1}
            stroke={heatColor ? heatColor : 'rgba(160,160,160,0.30)'}
            strokeOpacity={heatColor ? 1.0 : 1}
            strokeWidth={lineWidth}
            strokeLinejoin="round"
            strokeDasharray="none"
            style={{ pointerEvents: 'none' }}
          />
        </g>
      );
    }

    // ─── Normal (boundaries / metadata) rendering ─────────────────────
    // In metadata mode, use brand blue for all outlines (easier to see)
    const outlineColor = managerMode === 'metadata'
      ? '#0047FF'
      : isHigh ? '#22c55e' : '#ef4444';
    const fillColor = managerMode === 'metadata'
      ? 'rgba(0,71,255,0.06)'
      : isHigh ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.06)';
    // Always use brand blue for outlines — hold color visible through image cutout, not from outline tint
    const selectedColor = '#0047FF';
    // zPx = zoom-compensated pxScale: N * zPx SVG units = N screen pixels at any zoom
    // pxScale converts screen px → SVG units at 1x zoom. Dividing by scale compensates for CSS zoom.
    const zPx = pxScale / scale;
    // Green: very thin. Selected: medium. Medium confidence: hairline.
    const lineWidth = (isSel || isInspected || showVertices) ? Math.max(Math.round(2.5 * zPx), 1) : isHigh ? Math.max(Math.round(0.7 * zPx), 1) : Math.max(Math.round(0.5 * zPx), 1);

    if (!hasPoly) {
      const cx = toSvgX(hold.cx);
      const cy = toSvgY(hold.cy);
      const w = hold.w_pct || hold.r * 2 || 4;
      const h = hold.h_pct || hold.r * 2 || 4;
      const rx = Math.max((w / 100) * bW / 2, 4);
      const ry = Math.max((h / 100) * bH / 2, 4);
      const highlighted = isSel || isInspected || showVertices;

      return (
        <g key={hold.id}>
          <ellipse cx={cx} cy={cy} rx={rx} ry={ry}
            fill={highlighted ? `${selectedColor}25` : fillColor}
            stroke={highlighted ? selectedColor : outlineColor}
            strokeWidth={lineWidth}
            strokeDasharray={!highlighted && !isHigh ? `${Math.round(6 * zPx)} ${Math.round(4 * zPx)}` : 'none'}
            style={{ pointerEvents: 'none' }}
          />
        </g>
      );
    }

    const pts = hold.polygon.map(([x, y]) => `${toSvgX(x)},${toSvgY(y)}`).join(' ');
    const highlighted = isSel || isInspected || showVertices;

    return (
      <g key={hold.id}>
        {highlighted && (
          <polygon points={pts}
            fill="none" stroke={`${selectedColor}40`} strokeWidth={Math.round(4 * zPx)}
            strokeLinejoin="round" style={{ pointerEvents: 'none' }}
          />
        )}
        <polygon points={pts}
          fill={highlighted ? `${selectedColor}25` : showAllOutlines ? fillColor : 'transparent'}
          stroke={highlighted ? selectedColor : outlineColor}
          strokeWidth={lineWidth}
          strokeLinejoin="round"
          strokeDasharray={!highlighted && !isHigh ? `${Math.round(6 * zPx)} ${Math.round(4 * zPx)}` : 'none'}
          style={{ pointerEvents: 'none' }}
        />
        {showVertices && activeTool === TOOLS.SELECT && hold.polygon.map(([x, y], idx) => {
          const sx = toSvgX(x), sy = toSvgY(y);
          const svgScale = getSvgScale();
          const vr = Math.round(2.5 * pxScale);
          const hitR = 30 / svgScale;
          return (
            <g key={idx} style={{ cursor: 'move' }}
              onMouseDown={(e) => { if (!isSynthesizedMouse()) startVertexDrag(hold.id, idx, e); }}
              onTouchStart={(e) => startVertexDrag(hold.id, idx, e)}
            >
              <circle cx={sx} cy={sy} r={hitR} fill="transparent" stroke="none" style={{ pointerEvents: 'all' }} />
              <circle cx={sx} cy={sy} r={vr}
                fill={idx === 0 ? selectedColor : '#fff'}
                stroke={idx === 0 ? '#fff' : selectedColor}
                strokeWidth={Math.max(Math.round(1.5 * pxScale), 1)}
                style={{ pointerEvents: 'none' }}
              />
            </g>
          );
        })}
      </g>
    );
  }

  // Ghost paste preview — translucent dashed copy of the clipboard hold, centred at the cursor (mouse only).
  // Uses the SAME translate logic as doPaste() → WYSIWYG. Non-interactive (pointerEvents: none).
  function renderPastePreview() {
    if (activeTool !== TOOLS.COPY || !clipboard?.polygon || !pastePreviewPct) return null;
    const srcPoly = clipboard.polygon;
    const [ocx, ocy] = centroid(srcPoly);
    const ghost = translatePolygon(srcPoly, pastePreviewPct.x - ocx, pastePreviewPct.y - ocy);
    const pts = ghost.map(([x, y]) => `${toSvgX(x)},${toSvgY(y)}`).join(' ');
    const zPx = pxScale / scale;
    return (
      <polygon
        points={pts}
        fill="rgba(0,71,255,0.12)"
        stroke="#0047FF"
        strokeWidth={Math.max(Math.round(1.5 * zPx), 1)}
        strokeDasharray={`${Math.round(5 * zPx)} ${Math.round(4 * zPx)}`}
        strokeLinejoin="round"
        style={{ pointerEvents: 'none' }}
      />
    );
  }

  function renderDrawingState() {
    const isSelectLasso = activeTool === TOOLS.SELECT && lassoSelectActive;
    if (activeTool !== TOOLS.DRAW && !isSelectLasso) return null;
    if (drawPoints.length === 0) return null;
    const zPx = pxScale / scale;
    const pts = drawPoints.map(([x, y]) => `${toSvgX(x)},${toSvgY(y)}`);
    return (
      <g style={{ pointerEvents: 'none' }}>
        {drawClosed ? (
          <>
            {/* White outline behind dashes — keeps them visible against dark board areas */}
            <polygon points={pts.join(' ')}
              fill="rgba(0,71,255,0.15)" stroke="rgba(255,255,255,0.55)"
              strokeWidth={Math.max(Math.round(3 * zPx), 2.5)}
              strokeLinejoin="round"
            />
            <polygon points={pts.join(' ')}
              fill="none" stroke="#0047FF"
              strokeWidth={Math.max(Math.round(1.5 * zPx), 1.5)}
              strokeDasharray={`${Math.max(Math.round(5 * zPx), 4)} ${Math.max(Math.round(3 * zPx), 2)}`}
              strokeLinejoin="round"
            />
          </>
        ) : drawPoints.length >= 2 ? (
          (drawMode === 'lasso' || isSelectLasso) ? (
            <>
              {/* White outline behind dashes — keeps them visible against dark board areas */}
              <polyline points={pts.join(' ')}
                fill="none" stroke="rgba(255,255,255,0.55)"
                strokeWidth={Math.max(Math.round(3 * zPx), 2.5)}
                strokeLinecap="round" strokeLinejoin="round"
              />
              <polyline points={pts.join(' ')}
                fill="none" stroke="#0047FF"
                strokeWidth={Math.max(Math.round(1.5 * zPx), 1.5)}
                strokeDasharray={`${Math.max(Math.round(5 * zPx), 4)} ${Math.max(Math.round(3 * zPx), 2)}`}
                strokeLinecap="round" strokeLinejoin="round"
              />
            </>
          ) : (
            <>
              {/* White outline behind dashes — keeps them visible against dark board areas */}
              <polyline points={pts.join(' ')}
                fill="none" stroke="rgba(255,255,255,0.55)"
                strokeWidth={Math.max(Math.round(3 * zPx), 2.5)}
                strokeLinecap="round" strokeLinejoin="round"
              />
              <polyline points={pts.join(' ')}
                fill="none" stroke="#0047FF"
                strokeWidth={Math.max(Math.round(1.5 * zPx), 1.5)}
                strokeDasharray={`${Math.max(Math.round(4 * zPx), 4)} ${Math.max(Math.round(3 * zPx), 2)}`}
                strokeLinecap="round" strokeLinejoin="round"
              />
            </>
          )
        ) : null}
        {drawMode === 'polygon' && !isSelectLasso && drawPoints.map(([x, y], idx) => {
          const sx = toSvgX(x), sy = toSvgY(y);
          return (
            <circle key={idx}
              cx={sx} cy={sy}
              r={idx === 0 ? Math.round(4 * pxScale) : Math.round(2.5 * pxScale)}
              fill={idx === 0 ? '#0047FF' : '#fff'}
              stroke={idx === 0 ? '#fff' : '#0047FF'}
              strokeWidth={Math.max(Math.round(1 * pxScale), 1)}
            />
          );
        })}
      </g>
    );
  }

  // ─── Render ─────────────────────────────────────────────────────────


  return (
    <div
      onContextMenu={(e) => e.preventDefault()}
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        background: 'var(--bg-primary)',
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
        WebkitTouchCallout: 'none', WebkitUserSelect: 'none',
      }}
    >
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

      {/* Mode toggle: Boundaries / Hold Info / Heat Map */}
      <div style={{
        padding: '4px 12px', borderBottom: '1px solid var(--border)',
        background: 'rgba(255,255,255,0.3)', display: 'flex', justifyContent: 'center',
        flexShrink: 0,
      }}>
        <div style={{ display: 'inline-flex', borderRadius: '6px', overflow: 'hidden', border: '1px solid var(--border)' }}>
          {[{ key: 'boundaries', label: 'Boundaries' }, { key: 'metadata', label: 'Hold Info' }, { key: 'heatmap', label: 'Heat Map' }].map(m => (
            <button key={m.key}
              onClick={() => { setManagerMode(m.key); onManagerModeChange?.(m.key); if (m.key === 'metadata') { setSelectedIds([]); setInspectedHoldId(null); } }}
              style={{
                padding: '4px 14px', fontSize: '10px', fontWeight: 600,
                letterSpacing: '0.5px', textTransform: 'uppercase',
                cursor: 'pointer', border: 'none',
                background: managerMode === m.key ? 'var(--accent)' : 'transparent',
                color: managerMode === m.key ? '#fff' : 'var(--text-muted)',
                transition: 'background 0.15s, color 0.15s',
              }}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* Toolbar — only in boundaries mode */}
      {managerMode === 'boundaries' && <div style={{
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
              background: activeTool === tool ? 'rgba(0,71,255,0.1)' : 'rgba(26,10,0,0.05)',
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
        ><IconUndo /></button>
        <button onClick={redo} disabled={!canRedo}
          style={{ ...iconBtnStyle, opacity: canRedo ? 1 : 0.3 }}
          title="Redo (Ctrl+Shift+Z)"
        ><IconRedo /></button>

        <div style={{ width: '1px', height: '24px', background: 'var(--border)', margin: '0 4px' }} />

        <button onClick={() => setShowAllOutlines(prev => !prev)}
          style={{ ...iconBtnStyle, background: showAllOutlines ? 'rgba(0,71,255,0.1)' : 'rgba(26,10,0,0.05)', color: showAllOutlines ? 'var(--accent)' : 'var(--text-secondary)' }}
          title="Toggle all outlines"
        ><IconEye /></button>

        {isZoomed && (
          <button onClick={resetZoom} style={{ ...iconBtnStyle, fontSize: '10px', gap: '3px', display: 'flex', alignItems: 'center' }}>
            {Math.round(scale * 100)}% <IconZoomReset />
          </button>
        )}
      </div>}

      {/* Hold Info mode toolbar */}
      {managerMode === 'metadata' && (
        <div style={{
          padding: '6px 12px', borderBottom: '1px solid var(--border)',
          background: 'rgba(255,255,255,0.4)', flexShrink: 0,
          fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600,
        }}>
          {inspectedHoldId ? 'Hold selected — see details below' : 'Tap a hold to view its info'}
        </div>
      )}


      {/* Metadata info card */}
      {managerMode === 'metadata' && inspectedHoldId && (() => {
        const hold = holds.find(h => h.id === inspectedHoldId);
        if (!hold) return null;
        const dotColor = HOLD_COLOR_DOT[hold.color] || '#888';
        const types = (hold.holdTypes || []).join(' · ') || 'No types set';
        const posVal = hold.positivity ?? 0;
        return (
          <div style={{
            padding: '10px 12px', borderBottom: '1px solid var(--border)',
            background: 'var(--bg-card)', flexShrink: 0,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
              <span style={{
                width: '14px', height: '14px', borderRadius: '50%', flexShrink: 0,
                background: dotColor, border: '2px solid rgba(26,10,0,0.15)',
              }} />
              <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', flex: 1 }}>
                {hold.name || `Hold ${hold.id.replace('custom_', '#')}`}
              </span>
              <button
                onClick={() => setInspectedHoldId(null)}
                style={{
                  padding: '3px 8px', borderRadius: '6px', border: '1px solid var(--border)',
                  background: 'transparent', color: 'var(--text-muted)', fontSize: '12px', cursor: 'pointer',
                  display: 'flex', alignItems: 'center',
                }}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <line x1="1" y1="1" x2="9" y2="9"/><line x1="9" y1="1" x2="1" y2="9"/>
                </svg>
              </button>
            </div>
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '8px' }}>
              <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>{types}</span>
              <span style={{ fontSize: '11px', color: 'var(--accent)', fontWeight: 600 }}>
                {posVal > 0 ? '+' : ''}{posVal} ({positivityLabel(posVal)})
              </span>
              {hold.material && (
                <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontStyle: 'italic' }}>{hold.material}</span>
              )}
              {hold.color && (
                <span style={{
                  fontSize: '10px', fontWeight: 600, color: dotColor,
                  padding: '1px 6px', borderRadius: '4px', background: `${dotColor}15`,
                  textTransform: 'capitalize',
                }}>{hold.color}</span>
              )}
            </div>
            {onEditHold && (
              <button
                onClick={() => onEditHold(hold)}
                style={{
                  padding: '6px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                  cursor: 'pointer', border: '1.5px solid var(--accent)',
                  background: 'var(--accent)', color: '#fff',
                }}
              >
                Edit Hold
              </button>
            )}
          </div>
        );
      })()}

      {/* ── Secondary toolbar: contextual actions — always present in boundaries to avoid layout shift ──
          minHeight is sized to fit the *largest* state (with-selection + vertex-edit = 3 rows of buttons/sliders).
          This keeps the board image at a fixed vertical position, so selecting/deselecting/entering vertex-edit
          mode doesn't jump the image around — critical because long-press relies on the finger staying on a stable target. */}
      {managerMode === 'boundaries' && (
        <div style={{
          padding: '6px 12px',
          borderBottom: '1px solid var(--border)',
          background: 'rgba(0,71,255,0.04)',
          flexShrink: 0,
          display: 'flex', gap: '6px', alignItems: 'flex-start',
          flexWrap: 'wrap', minHeight: '112px',
        }}>
          {/* Draw tool actions */}
          {activeTool === TOOLS.DRAW && (<>
            {/* Polygon / Lasso toggle — always shown in draw mode */}
            <div style={{ display: 'flex', borderRadius: '6px', overflow: 'hidden', border: '1.5px solid rgba(0,71,255,0.2)' }}>
              <button
                onClick={() => { setDrawMode('polygon'); setDrawPoints([]); setDrawClosed(false); lassoActiveRef.current = false; }}
                style={{
                  padding: '4px 10px', fontSize: '11px', fontWeight: 700, cursor: 'pointer', border: 'none',
                  background: drawMode === 'polygon' ? 'var(--accent)' : 'rgba(0,71,255,0.06)',
                  color: drawMode === 'polygon' ? '#fff' : 'var(--accent)',
                }}
              >Polygon</button>
              <button
                onClick={() => { setDrawMode('lasso'); setDrawPoints([]); setDrawClosed(false); lassoActiveRef.current = false; }}
                style={{
                  padding: '4px 10px', fontSize: '11px', fontWeight: 700, cursor: 'pointer', border: 'none',
                  borderLeft: '1px solid rgba(0,71,255,0.2)',
                  background: drawMode === 'lasso' ? 'var(--accent)' : 'rgba(0,71,255,0.06)',
                  color: drawMode === 'lasso' ? '#fff' : 'var(--accent)',
                }}
              >Lasso</button>
            </div>
            <div style={{ width: '1px', height: '20px', background: 'rgba(0,71,255,0.15)', margin: '0 2px' }} />
            {/* Contextual draw actions */}
            {drawMode === 'polygon' && drawPoints.length > 0 && !drawClosed && (
              <>
                <span style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 700 }}>{drawPoints.length} vertices — click first to close</span>
                <button onClick={() => setDrawPoints(prev => prev.slice(0, -1))} style={secBtnStyle}>Undo point</button>
                <button onClick={() => { setDrawPoints([]); setDrawClosed(false); }} style={secBtnStyle}>Reset</button>
              </>
            )}
            {drawMode === 'polygon' && drawClosed && (
              <>
                <span style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 700 }}>Polygon closed ({drawPoints.length} pts)</span>
                <button onClick={finishDraw} style={{ ...secBtnStyle, background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' }}>Create Hold</button>
                <button onClick={() => { setDrawPoints([]); setDrawClosed(false); }} style={secBtnStyle}>Redraw</button>
              </>
            )}
            {drawMode === 'lasso' && drawPoints.length === 0 && (
              <span style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 700 }}>Click and drag to trace hold shape</span>
            )}
            {drawMode === 'lasso' && drawPoints.length > 0 && (
              <span style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 700 }}>Drawing... {drawPoints.length} points</span>
            )}
          </>)}

          {/* Copy mode actions — Single (one stamp → Select) · Multi/Done (stamp until Done) · Cancel.
              Shift+click keeps stamping regardless of mode (laptop). Ghost preview follows the cursor. */}
          {activeTool === TOOLS.COPY && clipboard && (
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 700 }}>
                {pasteMode === 'multi' ? 'Click to stamp · Done to finish' : 'Click to place · Shift-click to keep stamping'}
              </span>
              <button
                onClick={() => setPasteMode('single')}
                style={{
                  ...secBtnStyle,
                  background: pasteMode === 'single' ? 'var(--accent)' : secBtnStyle.background,
                  color: pasteMode === 'single' ? '#fff' : secBtnStyle.color,
                  borderColor: pasteMode === 'single' ? 'var(--accent)' : secBtnStyle.borderColor,
                }}
              >Single</button>
              <button
                onClick={() => { if (pasteMode === 'single') setPasteMode('multi'); else exitPaste(); }}
                style={{
                  ...secBtnStyle,
                  background: pasteMode === 'multi' ? 'var(--accent)' : secBtnStyle.background,
                  color: pasteMode === 'multi' ? '#fff' : secBtnStyle.color,
                  borderColor: pasteMode === 'multi' ? 'var(--accent)' : secBtnStyle.borderColor,
                }}
              >{pasteMode === 'multi' ? 'Done' : 'Multi'}</button>
              {pasteMode === 'multi' && placedCount > 0 && (
                <span style={{ fontSize: '11px', color: 'var(--text-primary)', fontWeight: 700 }}>Placed {placedCount}</span>
              )}
              <button onClick={exitPaste} style={secBtnStyle}>Cancel</button>
            </div>
          )}

          {/* Select tool actions — three rows (full) or minimal stub when nothing selected:
              1) Lasso · Select All · [Deselect · Copy when selection exists]
              2) + Vertex · − Vertex · Confirm (gated on vertexEditId — enter via long-press or double-click)
              3) Rotate · Scale · Delete (right-aligned) */}
          {activeTool === TOOLS.SELECT && selectedIds.length === 0 && (
            /* Minimal toolbar: available before any selection is made */
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                onClick={() => setLassoSelectActive(prev => !prev)}
                style={{
                  ...secBtnStyle,
                  background: lassoSelectActive ? 'var(--accent)' : secBtnStyle.background,
                  color: lassoSelectActive ? '#fff' : secBtnStyle.color,
                  borderColor: lassoSelectActive ? 'var(--accent)' : secBtnStyle.borderColor,
                }}
              >Lasso</button>
              <button onClick={selectAllHolds} style={secBtnStyle}>Select All</button>
            </div>
          )}
          {activeTool === TOOLS.SELECT && selectedIds.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', width: '100%' }}>
              {/* Row 1 */}
              <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                <button
                  onClick={() => setLassoSelectActive(prev => !prev)}
                  style={{
                    ...secBtnStyle,
                    background: lassoSelectActive ? 'var(--accent)' : secBtnStyle.background,
                    color: lassoSelectActive ? '#fff' : secBtnStyle.color,
                    borderColor: lassoSelectActive ? 'var(--accent)' : secBtnStyle.borderColor,
                  }}
                >Lasso</button>
                <button onClick={selectAllHolds} style={secBtnStyle}>Select All</button>
                <button onClick={clearSelection} style={secBtnStyle}>Deselect</button>
                {selectedIds.length === 1 && (
                  <button onClick={copySelected} style={secBtnStyle} disabled={!selectedHold?.polygon}>Copy</button>
                )}
              </div>

              {/* Row 2 — vertex edit (only available when vertexEditId is set via long-press or double-click) */}
              {vertexEditId && (
                <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700, letterSpacing: '0.3px', textTransform: 'uppercase' }}>Vertices</span>
                  <button onClick={addVertexToSelected} style={secBtnStyle} disabled={!vertexEditHold?.polygon}>+ Vertex</button>
                  <button onClick={removeVertexFromSelected} style={secBtnStyle} disabled={!vertexEditHold?.polygon || vertexEditHold.polygon.length <= 3}>− Vertex</button>
                  {vertexEditHold?.confidence === 'medium' && (
                    <button
                      onClick={() => setHolds(prev => prev.map(h => h.id === vertexEditId ? { ...h, confidence: 'high' } : h))}
                      style={{ ...secBtnStyle, background: '#22c55e', color: '#fff', borderColor: '#22c55e' }}
                    >Confirm</button>
                  )}
                  <button onClick={() => setVertexEditId(null)} style={{ ...secBtnStyle, fontSize: '10px' }}>Done</button>
                </div>
              )}

              {/* Row 3 */}
              <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Rotate</span>
                  <input type="range" min="-180" max="180" step="5"
                    value={selectRotation}
                    onMouseDown={snapshotOrigPolys}
                    onTouchStart={snapshotOrigPolys}
                    onMouseUp={endCoalesce}
                    onTouchEnd={endCoalesce}
                    onTouchCancel={endCoalesce}
                    onChange={(e) => {
                      const rot = parseInt(e.target.value);
                      setSelectRotation(rot);
                      applyRotationToSelected(rot);
                    }}
                    style={{ width: '60px', accentColor: 'var(--accent)' }}
                  />
                  <span style={{ fontSize: '10px', color: 'var(--text-primary)', fontWeight: 700, minWidth: '26px' }}>
                    {selectRotation}°
                  </span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Scale</span>
                  <input type="range" min="25" max="300" step="5"
                    value={selectScale}
                    onMouseDown={snapshotOrigPolys}
                    onTouchStart={snapshotOrigPolys}
                    onMouseUp={endCoalesce}
                    onTouchEnd={endCoalesce}
                    onTouchCancel={endCoalesce}
                    onChange={(e) => {
                      const s = parseInt(e.target.value);
                      setSelectScale(s);
                      applyScaleToSelected(s);
                    }}
                    style={{ width: '60px', accentColor: 'var(--accent)' }}
                  />
                  <span style={{ fontSize: '10px', color: 'var(--text-primary)', fontWeight: 700, minWidth: '30px' }}>
                    {selectScale}%
                  </span>
                </div>

                <button onClick={deleteSelected}
                  style={{ ...secBtnStyle, marginLeft: 'auto', color: '#FF5252', borderColor: 'rgba(255,82,82,0.35)', background: 'rgba(255,171,148,0.25)' }}>
                  Delete{selectedIds.length > 1 ? ` (${selectedIds.length})` : ''}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Canvas — no top padding so image sits flush under toolbar; sides + bottom keep peach visible */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative', padding: '0 6px 6px' }}>
        <div
          ref={containerRef}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={() => {
            if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
            pendingHoldRef.current = null;
            pinchRef.current.active = false;
            panDragRef.current.active = false;
          }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={(e) => { setPastePreviewPct(null); handleMouseUp(e); }}
          onDoubleClick={handleDoubleClick}
          onContextMenu={(e) => e.preventDefault()}
          style={{
            width: '100%', height: '100%',
            touchAction: 'none', userSelect: 'none',
            WebkitTouchCallout: 'none', WebkitUserSelect: 'none',
            cursor: cursorStyle, overflow: 'hidden',
          }}
        >
          {/* height:100% fills the flex-1 canvas so image maxHeight:100% fits regardless of toolbar count */}
          <div style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
            transformOrigin: 'center center',
            willChange: 'transform',
            height: '100%',
            display: 'flex', justifyContent: 'center', alignItems: 'flex-start',
          }}>
            <img
              src={imgSrc}
              srcSet={imgSrcSet}
              sizes={imgSizes}
              alt="Climbing board"
              onLoad={(e) => {
                setImgSize({ w: e.target.naturalWidth, h: e.target.naturalHeight });
                setImageLoaded(true);
              }}
              onContextMenu={(e) => e.preventDefault()}
              style={{
                maxWidth: '100%', maxHeight: '100%',
                display: 'block', opacity: imageLoaded ? 1 : 0.3,
                borderRadius: '6px',
                WebkitTouchCallout: 'none', WebkitUserSelect: 'none',
                filter: managerMode === 'heatmap' ? 'grayscale(100%) brightness(1.15) contrast(0.45)' : 'none',
                transition: 'filter 0.2s',
              }}
              draggable={false}
            />
            {/* Dimming overlay — metadata mode with inspected hold */}
            {imageLoaded && managerMode === 'metadata' && inspectedHoldId && (() => {
              const inspected = holds.find(h => h.id === inspectedHoldId);
              if (!inspected) return null;
              return (
                <svg
                  viewBox={`0 0 ${imgSize.w} ${imgSize.h}`}
                  width="100%" height="100%"
                  preserveAspectRatio="xMidYMin meet"
                  style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}
                >
                  <defs>
                    <mask id="metadata-hold-mask">
                      <rect width={imgSize.w} height={imgSize.h} fill="white" fillOpacity="0.6" />
                      {inspected.polygon?.length >= 3 ? (
                        <polygon
                          points={inspected.polygon.map(([x, y]) => `${toSvgX(x)},${toSvgY(y)}`).join(' ')}
                          fill="black" stroke="black" strokeWidth={Math.round(5 * pxScale)} strokeLinejoin="round"
                        />
                      ) : (() => {
                        const m = Math.round(2.5 * pxScale);
                        return (
                          <ellipse
                            cx={toSvgX(inspected.cx)} cy={toSvgY(inspected.cy)}
                            rx={Math.max(((inspected.w_pct || inspected.r * 2 || 4) / 100) * bW / 2 + m, m)}
                            ry={Math.max(((inspected.h_pct || inspected.r * 2 || 4) / 100) * bH / 2 + m, m)}
                            fill="black"
                          />
                        );
                      })()}
                    </mask>
                  </defs>
                  <rect width={imgSize.w} height={imgSize.h} fill="white" mask="url(#metadata-hold-mask)" />
                </svg>
              );
            })()}
            {imageLoaded && (
              <svg
                ref={svgRef}
                viewBox={`0 0 ${imgSize.w} ${imgSize.h}`}
                preserveAspectRatio="xMidYMin meet"
                style={{
                  position: 'absolute', top: 0, left: 0,
                  width: '100%', height: '100%',
                  overflow: 'visible', pointerEvents: 'none',
                }}
              >
                {(showAllOutlines || managerMode === 'heatmap') && holds.map(hold => renderHoldOutline(hold))}
                {!showAllOutlines && managerMode !== 'heatmap' && selectedIds.length > 0 && holds.filter(h => selectedIds.includes(h.id)).map(h => renderHoldOutline(h))}
                {renderDrawingState()}
                {renderPastePreview()}
              </svg>
            )}
          </div>
        </div>

        {/* Heat map legend — bottom-right of canvas, read-only overlay */}
        {managerMode === 'heatmap' && (
          <div style={{
            position: 'absolute', bottom: 14, right: 14,
            background: 'var(--bg-card)',
            boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
            borderRadius: '8px',
            padding: '8px 10px',
            pointerEvents: 'none',
            zIndex: 20,
            minWidth: 0,
          }}>
            {/* Gradient swatches */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '2px', marginBottom: '5px' }}>
              {['#3b82f6', '#06b6d4', '#fbbf24', '#f97316', '#ef4444'].map(c => (
                <div key={c} style={{ width: 14, height: 14, borderRadius: '3px', background: c, flexShrink: 0 }} />
              ))}
            </div>
            <div style={{ fontSize: '9px', color: 'var(--text-muted)', fontFamily: 'DM Sans, sans-serif', letterSpacing: '0.3px', marginBottom: '5px' }}>
              low &rarr; high
            </div>
            {/* Unused swatch */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
              <div style={{ width: 10, height: 10, borderRadius: '50%', background: 'rgba(180,180,180,0.45)', border: '1px solid rgba(180,180,180,0.6)', flexShrink: 0 }} />
              <span style={{ fontSize: '9px', color: 'var(--text-muted)', fontFamily: 'DM Sans, sans-serif' }}>unused</span>
            </div>
          </div>
        )}
      </div>

      {/* Heat Map filter panel — below the board, collapsible */}
      {managerMode === 'heatmap' && (
        <div style={{
          flexShrink: 0,
          borderTop: '1px solid var(--border)',
          background: 'rgba(255,255,255,0.6)',
          display: 'flex', flexDirection: 'column',
        }}>
          {/* Header — always visible, click to expand/collapse */}
          <div
            onClick={() => setHmFiltersOpen(prev => !prev)}
            style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              padding: '8px 12px', cursor: 'pointer', userSelect: 'none',
              minHeight: '40px',
            }}
          >
            <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'var(--font-heading)' }}>
              Filters
            </span>
            <span style={{ fontSize: '10px', color: 'var(--text-muted)', transition: 'transform 0.15s', display: 'inline-block', transform: hmFiltersOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}>
              ▸
            </span>
            <span style={{ flex: 1, fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', whiteSpace: 'nowrap', textAlign: 'right' }}>
              {hmRouteCount} routes · {hmHoldCount} holds used
            </span>
          </div>

          {/* Expanded body — filter rows + action row */}
          {hmFiltersOpen && (
            <div style={{
              padding: '4px 12px 8px 12px',
              borderTop: '1px solid rgba(26,10,0,0.06)',
              overflowY: 'auto', maxHeight: '40vh',
            }}>
              {/* Row 1: Hold Types */}
              <div style={{ marginBottom: '6px' }}>
                <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '3px' }}>Hold Types</div>
                <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                  {HOLD_TYPES.map(ht => {
                    const on = hmHoldTypes.includes(ht);
                    return (
                      <button key={ht} onClick={() => toggleHmTag(hmHoldTypes, setHmHoldTypes, ht)}
                        style={{
                          padding: '3px 8px', borderRadius: '8px', fontSize: '10px',
                          border: on ? '1.5px solid var(--accent)' : '1.5px solid rgba(26,10,0,0.1)',
                          background: on ? 'var(--accent-dim)' : 'transparent',
                          color: on ? 'var(--accent)' : 'var(--text-muted)',
                          cursor: 'pointer', fontWeight: 500,
                        }}
                      >{ht}</button>
                    );
                  })}
                </div>
              </div>

              {/* Row 2: Techniques */}
              <div style={{ marginBottom: '6px' }}>
                <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '3px' }}>Techniques</div>
                <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                  {TECHNIQUES.map(t => {
                    const on = hmTechniques.includes(t);
                    return (
                      <button key={t} onClick={() => toggleHmTag(hmTechniques, setHmTechniques, t)}
                        style={{
                          padding: '3px 8px', borderRadius: '8px', fontSize: '10px',
                          border: on ? '1.5px solid var(--accent)' : '1.5px solid rgba(26,10,0,0.1)',
                          background: on ? 'var(--accent-dim)' : 'transparent',
                          color: on ? 'var(--accent)' : 'var(--text-muted)',
                          cursor: 'pointer', fontWeight: 500,
                        }}
                      >{t}</button>
                    );
                  })}
                </div>
              </div>

              {/* Row 3: Styles */}
              <div style={{ marginBottom: '6px' }}>
                <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '3px' }}>Styles</div>
                <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                  {STYLES.map(s => {
                    const on = hmStyles.includes(s);
                    return (
                      <button key={s} onClick={() => toggleHmTag(hmStyles, setHmStyles, s)}
                        style={{
                          padding: '3px 8px', borderRadius: '8px', fontSize: '10px',
                          border: on ? '1.5px solid var(--accent)' : '1.5px solid rgba(26,10,0,0.1)',
                          background: on ? 'var(--accent-dim)' : 'transparent',
                          color: on ? 'var(--accent)' : 'var(--text-muted)',
                          cursor: 'pointer', fontWeight: 500,
                        }}
                      >{s}</button>
                    );
                  })}
                </div>
              </div>

              {/* Row 4: Setter input */}
              <div style={{ marginBottom: '6px' }}>
                <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '3px' }}>Setter</div>
                <input
                  type="text"
                  value={hmSetter}
                  onChange={e => setHmSetter(e.target.value)}
                  placeholder="Filter by setter…"
                  style={{
                    width: '100%', boxSizing: 'border-box',
                    padding: '5px 8px', borderRadius: '6px',
                    border: '1.5px solid rgba(26,10,0,0.15)', background: 'var(--bg-input)',
                    color: 'var(--text-primary)', fontSize: '12px',
                  }}
                />
              </div>

              {/* Row 5: Angle dropdown */}
              <div style={{ marginBottom: '8px' }}>
                <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '3px' }}>Angle</div>
                <select
                  value={hmAngle === null ? '' : String(hmAngle)}
                  onChange={e => setHmAngle(e.target.value === '' ? null : Number(e.target.value))}
                  style={{
                    padding: '5px 8px', borderRadius: '6px',
                    border: '1.5px solid rgba(26,10,0,0.15)', background: 'var(--bg-input)',
                    color: 'var(--text-primary)', fontSize: '12px', cursor: 'pointer',
                  }}
                >
                  <option value="">All</option>
                  {hmAngles.map(a => (
                    <option key={a} value={String(a)}>{a}°</option>
                  ))}
                </select>
              </div>

              {/* Action row: Include feet toggle + Clear button */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                <button
                  onClick={() => setHmIncludeFeet(prev => !prev)}
                  style={{
                    padding: '5px 10px', borderRadius: '16px', fontSize: '11px',
                    fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px',
                    border: hmIncludeFeet ? '1.5px solid rgba(26,10,0,0.15)' : '1.5px solid var(--accent)',
                    background: hmIncludeFeet ? 'transparent' : 'var(--accent-dim)',
                    color: hmIncludeFeet ? 'var(--text-secondary)' : 'var(--accent)',
                  }}
                >
                  <div style={{
                    width: '28px', height: '16px', borderRadius: '8px', position: 'relative',
                    background: hmIncludeFeet ? 'rgba(26,10,0,0.15)' : 'var(--accent)',
                    transition: 'background 0.2s', flexShrink: 0,
                  }}>
                    <div style={{
                      width: '12px', height: '12px', borderRadius: '50%', background: '#fff',
                      position: 'absolute', top: '2px',
                      left: hmIncludeFeet ? '14px' : '2px',
                      transition: 'left 0.2s',
                      boxShadow: '0 1px 2px rgba(26,10,0,0.2)',
                    }} />
                  </div>
                  Include feet
                </button>
                <button
                  onClick={clearHmFilters}
                  style={{
                    padding: '4px 10px', borderRadius: '8px',
                    border: '1px solid rgba(255,82,82,0.3)', background: 'rgba(255,82,82,0.06)',
                    color: '#FF5252', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                >
                  Clear
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Vertex drag magnifier loupe — touch only */}
      {draggingVertex && touchPosRef.current && dragVertexPctRef.current && (() => {
        const LOUPE_W = 180;
        const LOUPE_H = 120;
        const LOUPE_RADIUS = 60;
        const MAGNIFICATION = 3 * scale;
        const OFFSET_ABOVE = 80;

        const { clientX, clientY } = touchPosRef.current;
        const { x: vtxBoardX, y: vtxBoardY } = dragVertexPctRef.current;

        const vtxImgFracX = (boardRegion.left / 100) + (vtxBoardX / 100) * (boardRegion.width / 100);
        const vtxImgFracY = (boardRegion.top / 100) + (vtxBoardY / 100) * (boardRegion.height / 100);

        const magW = LOUPE_W * MAGNIFICATION;
        const magH = magW * (imgSize.h / imgSize.w);

        const imgLeft = -(vtxImgFracX * magW) + LOUPE_W / 2;
        const imgTop  = -(vtxImgFracY * magH) + LOUPE_H / 2;

        // Full polygon + vertices overlay — same coordinate system as main board SVG
        const hold = holds.find(h => h.id === draggingVertex.holdId);
        const poly = hold?.polygon;
        const idx = draggingVertex.vertexIdx;

        const loupeLeft = clamp(clientX - LOUPE_W / 2, 4, window.innerWidth - LOUPE_W - 4);
        const loupeTop  = clamp(clientY - OFFSET_ABOVE - LOUPE_H, 4, clientY - OFFSET_ABOVE);

        // Loupe pxScale: match main board proportions at the loupe's magnification
        // The loupe renders imgSize.w SVG units across magW CSS pixels
        const loupePxScale = imgSize.w / magW;
        // Apply same DPR normalization as main view
        const dprFactor = 2 / (window.devicePixelRatio || 2);
        const lPx = loupePxScale * dprFactor;

        return (
          <div style={{
            position: 'fixed', left: loupeLeft, top: loupeTop,
            width: LOUPE_W, height: LOUPE_H,
            borderRadius: `${LOUPE_RADIUS}px`,
            border: '2px solid rgba(255,255,255,0.9)',
            boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
            overflow: 'hidden', pointerEvents: 'none', zIndex: 300,
            background: '#1a0a00',
          }}>
            <img src={imgSrc} srcSet={imgSrcSet} sizes={imgSizes} alt="" draggable={false}
              style={{ position: 'absolute', width: magW, height: magH, left: imgLeft, top: imgTop, pointerEvents: 'none' }}
            />
            {poly && poly.length >= 3 && (
              <svg
                viewBox={`0 0 ${imgSize.w} ${imgSize.h}`}
                preserveAspectRatio="none"
                style={{ position: 'absolute', left: imgLeft, top: imgTop, width: magW, height: magH, pointerEvents: 'none' }}
              >
                <polygon
                  points={poly.map(([x, y]) => `${toSvgX(x)},${toSvgY(y)}`).join(' ')}
                  fill="none" stroke="#0047FF" strokeWidth={Math.max(Math.round(2 * lPx), 1)}
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </div>
        );
      })()}

      {/* Single-hold move magnifier loupe — touch only, multi-select excluded */}
      {draggingHold && !draggingHold.isMulti && holdDragClientRef.current && (() => {
        const hold = holds.find(h => h.id === draggingHold.holdId);
        if (!hold) return null;
        const [hcx, hcy] = hold.polygon ? centroid(hold.polygon) : [hold.cx, hold.cy];

        const LOUPE_W = 180;
        const LOUPE_H = 120;
        const LOUPE_RADIUS = 60;
        const MAGNIFICATION = 3 * scale;
        const OFFSET_ABOVE = 80;

        const { clientX, clientY } = holdDragClientRef.current;

        // Centre the magnified view on the hold's centroid (the detail the thumb covers)
        const imgFracX = (boardRegion.left / 100) + (hcx / 100) * (boardRegion.width / 100);
        const imgFracY = (boardRegion.top / 100) + (hcy / 100) * (boardRegion.height / 100);

        const magW = LOUPE_W * MAGNIFICATION;
        const magH = magW * (imgSize.h / imgSize.w);

        const imgLeft = -(imgFracX * magW) + LOUPE_W / 2;
        const imgTop  = -(imgFracY * magH) + LOUPE_H / 2;

        const loupeLeft = clamp(clientX - LOUPE_W / 2, 4, window.innerWidth - LOUPE_W - 4);
        const loupeTop  = clamp(clientY - OFFSET_ABOVE - LOUPE_H, 4, clientY - OFFSET_ABOVE);

        const loupePxScale = imgSize.w / magW;
        const dprFactor = 2 / (window.devicePixelRatio || 2);
        const lPx = loupePxScale * dprFactor;

        const poly = hold.polygon;

        return (
          <div style={{
            position: 'fixed', left: loupeLeft, top: loupeTop,
            width: LOUPE_W, height: LOUPE_H,
            borderRadius: `${LOUPE_RADIUS}px`,
            border: '2px solid rgba(255,255,255,0.9)',
            boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
            overflow: 'hidden', pointerEvents: 'none', zIndex: 300,
            background: '#1a0a00',
          }}>
            <img src={imgSrc} srcSet={imgSrcSet} sizes={imgSizes} alt="" draggable={false}
              style={{ position: 'absolute', width: magW, height: magH, left: imgLeft, top: imgTop, pointerEvents: 'none' }}
            />
            {poly && poly.length >= 3 && (
              <svg
                viewBox={`0 0 ${imgSize.w} ${imgSize.h}`}
                preserveAspectRatio="none"
                style={{ position: 'absolute', left: imgLeft, top: imgTop, width: magW, height: magH, pointerEvents: 'none' }}
              >
                <polygon
                  points={poly.map(([x, y]) => `${toSvgX(x)},${toSvgY(y)}`).join(' ')}
                  fill="none" stroke="#0047FF" strokeWidth={Math.max(Math.round(2 * lPx), 1)}
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </div>
        );
      })()}

      {/* Lasso draw magnifier loupe — touch only, shown while drawing */}
      {lassoActiveRef.current && lassoPosRef.current && lassoBoardPctRef.current && (() => {
        const LOUPE_W = 180;
        const LOUPE_H = 120;
        const LOUPE_RADIUS = 60;
        const MAGNIFICATION = 3 * scale;
        const OFFSET_ABOVE = 80;

        const { clientX, clientY } = lassoPosRef.current;
        const { x: lassoBoardX, y: lassoBoardY } = lassoBoardPctRef.current;

        const lassoImgFracX = (boardRegion.left / 100) + (lassoBoardX / 100) * (boardRegion.width / 100);
        const lassoImgFracY = (boardRegion.top / 100) + (lassoBoardY / 100) * (boardRegion.height / 100);

        const magW = LOUPE_W * MAGNIFICATION;
        const magH = magW * (imgSize.h / imgSize.w);

        const imgLeft = -(lassoImgFracX * magW) + LOUPE_W / 2;
        const imgTop  = -(lassoImgFracY * magH) + LOUPE_H / 2;

        const loupeLeft = clamp(clientX - LOUPE_W / 2, 4, window.innerWidth - LOUPE_W - 4);
        const loupeTop  = clamp(clientY - OFFSET_ABOVE - LOUPE_H, 4, clientY - OFFSET_ABOVE);

        // Loupe-specific pxScale so the trace line stays fine at magnification
        const loupePxScale = imgSize.w / magW;
        const dprFactor = 2 / (window.devicePixelRatio || 2);
        const lPx = loupePxScale * dprFactor;
        const lzPx = lPx / scale;

        // Build SVG points for the lasso path drawn so far
        const lassoPts = drawPoints.map(([x, y]) => `${toSvgX(x)},${toSvgY(y)}`).join(' ');

        return (
          <div style={{
            position: 'fixed', left: loupeLeft, top: loupeTop,
            width: LOUPE_W, height: LOUPE_H,
            borderRadius: `${LOUPE_RADIUS}px`,
            border: '2px solid rgba(255,255,255,0.9)',
            boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
            overflow: 'hidden', pointerEvents: 'none', zIndex: 300,
            background: '#1a0a00',
          }}>
            <img src={imgSrc} srcSet={imgSrcSet} sizes={imgSizes} alt="" draggable={false}
              style={{ position: 'absolute', width: magW, height: magH, left: imgLeft, top: imgTop, pointerEvents: 'none' }}
            />
            {drawPoints.length >= 2 && (
              <svg
                viewBox={`0 0 ${imgSize.w} ${imgSize.h}`}
                preserveAspectRatio="none"
                style={{ position: 'absolute', left: imgLeft, top: imgTop, width: magW, height: magH, pointerEvents: 'none' }}
              >
                <polyline points={lassoPts}
                  fill="none" stroke="rgba(255,255,255,0.55)"
                  strokeWidth={Math.max(Math.round(3 * lzPx), 2.5)}
                  strokeLinecap="round" strokeLinejoin="round"
                />
                <polyline points={lassoPts}
                  fill="none" stroke="#0047FF"
                  strokeWidth={Math.max(Math.round(1.5 * lzPx), 1.5)}
                  strokeDasharray={`${Math.max(Math.round(5 * lzPx), 4)} ${Math.max(Math.round(3 * lzPx), 2)}`}
                  strokeLinecap="round" strokeLinejoin="round"
                />
                {/* Crosshair dot at current tip */}
                <circle
                  cx={toSvgX(lassoBoardX)} cy={toSvgY(lassoBoardY)}
                  r={Math.max(Math.round(2 * lPx), 2)}
                  fill="#0047FF" stroke="white" strokeWidth={Math.max(Math.round(lPx), 1)}
                />
              </svg>
            )}
          </div>
        );
      })()}
    </div>
  );
}

const headerBtnStyle = {
  padding: '4px 10px', borderRadius: '6px', fontSize: '11px', cursor: 'pointer',
  border: '1px solid rgba(26,10,0,0.15)', background: 'rgba(26,10,0,0.06)',
  color: 'var(--text-secondary)', fontWeight: 600,
};

const iconBtnStyle = {
  width: '32px', height: '32px', borderRadius: '6px',
  border: '1px solid rgba(26,10,0,0.1)', background: 'rgba(26,10,0,0.05)',
  color: 'var(--text-secondary)', fontSize: '16px',
  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
};

const secBtnStyle = {
  padding: '5px 12px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
  cursor: 'pointer', border: '1px solid rgba(255,171,148,0.55)', background: 'rgba(255,171,148,0.18)',
  color: 'var(--accent)',
};

