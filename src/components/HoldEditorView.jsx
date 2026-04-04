import { useState, useRef, useEffect } from 'react';
import holdsData from '../data/holds.json';
import Icon from './Icon';
import { MATERIALS } from '../utils/constants';

const { boardRegion } = holdsData;
const HANDLE_R  = 10;
const HIT_EXTRA = 10;
const CLOSE_THRESHOLD_PCT = 5;
const MIN_SCALE = 1;
const MAX_SCALE = 12;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function r1(v) { return Math.round(v * 10) / 10; }

function centroid(pts) {
  const cx = pts.reduce((s, [x]) => s + x, 0) / pts.length;
  const cy = pts.reduce((s, [, y]) => s + y, 0) / pts.length;
  return { cx: r1(cx), cy: r1(cy) };
}

function boundingBox(pts) {
  const xs = pts.map(([x]) => x);
  const ys = pts.map(([, y]) => y);
  return {
    w_pct: r1(Math.max(...xs) - Math.min(...xs)),
    h_pct: r1(Math.max(...ys) - Math.min(...ys)),
  };
}

function positivityLabel(val) {
  if (val <= -4) return 'Very slopey';
  if (val <= -2) return 'Slopey';
  if (val === -1) return 'Slightly slopey';
  if (val === 0) return 'Neutral / flat';
  if (val === 1) return 'Slightly positive';
  if (val <= 3) return 'Positive';
  return 'Very juggy';
}

const COLOR_OPTIONS = [
  { val: 'black',  label: 'Black',  dot: '#444' },
  { val: 'blue',   label: 'Blue',   dot: '#0047FF' },
  { val: 'purple', label: 'Purple', dot: '#c084fc' },
  { val: 'green',  label: 'Green',  dot: '#22a870' },
  { val: 'orange', label: 'Orange', dot: '#FF8C00' },
  { val: 'yellow', label: 'Yellow', dot: '#D4A000' },
  { val: 'pink',   label: 'Pink',   dot: '#FF69B4' },
  { val: 'red',    label: 'Red',    dot: '#FF5252' },
  { val: 'white',  label: 'White',  dot: '#888' },
  { val: 'cyan',   label: 'Cyan',   dot: '#22d3ee' },
  { val: 'grey',   label: 'Grey',   dot: '#999' },
  { val: 'wood',   label: 'Wood',   dot: '#b08860' },
];

const HOLD_TYPE_OPTIONS = ['Jug', 'Mini Jug', 'Crimp', 'Half Crimp', 'Pinch', 'Sloper', 'Edge', 'Pocket', 'Undercut', 'Volume', 'Macro'];

export default function HoldEditorView({ mode, hold, allHolds, imgSrc, imgSrcSet, imgSizes, onSave, onCancel, onDelete }) {
  const defaultMeta = {
    color: 'black', size: 'medium', area: 0, notes: '',
    verified: true, name: '', holdTypes: [], positivity: 0, material: '',
  };
  const [meta, setMeta]               = useState(hold ? { ...defaultMeta, ...hold } : defaultMeta);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imgSize, setImgSize]         = useState({ w: 1200, h: 900 });

  // Polygon state
  const [points, setPoints]               = useState(() => hold?.polygon?.length >= 3 ? hold.polygon : []);
  const [closed, reactSetClosed]          = useState(mode === 'edit' && hold?.polygon?.length >= 3);
  const closedRef                         = useRef(mode === 'edit' && hold?.polygon?.length >= 3);
  const setClosed = (val) => { closedRef.current = val; reactSetClosed(val); };
  const [cursorPct, setCursorPct]         = useState(null);
  const [draggingIdx, setDraggingIdx]     = useState(null);

  // Draw vs Navigate mode
  const [drawMode, setDrawMode] = useState(mode === 'edit');

  // Zoom / pan state
  const [scale, setScale]         = useState(1);
  const [pan,   setPan]           = useState({ x: 0, y: 0 });
  const [panActive, setPanActive] = useState(false);

  const containerRef   = useRef(null);
  const svgRef         = useRef(null);
  const scaleRef       = useRef(1);
  const panRef         = useRef({ x: 0, y: 0 });
  const pinchRef       = useRef({ active: false, lastDist: 0 });
  const mousePanRef    = useRef({ active: false, startX: 0, startY: 0, basePanX: 0, basePanY: 0, moved: false });

  // Vertex drag — tracked separately for mouse and touch
  const vertexDragActive  = useRef(false);   // is a vertex currently being dragged?
  const draggingIdxRef    = useRef(null);    // mirrors draggingIdx — safe to read in event handlers
  const vertexDragTouchId = useRef(null);    // touch.identifier for mobile vertex drag

  // SVG tap detection — used to place vertices via native touch events (not synthesized onClick)
  const svgTapRef = useRef(null);            // { id, startX, startY } of the touch we're tracking for a tap

  // Block synthesized mouse events on mobile — after any touch, ignore mouse events for 500ms
  const lastTouchTimeRef = useRef(0);
  const isSynthesizedMouse = () => Date.now() - lastTouchTimeRef.current < 500;

  useEffect(() => { scaleRef.current = scale; }, [scale]);
  useEffect(() => { panRef.current = pan; }, [pan]);

  // ─── Zoom helpers ────────────────────────────────────────────────────
  function doZoom(newScale, pivotX, pivotY) {
    const el = containerRef.current;
    if (!el) return;
    const prev    = scaleRef.current;
    const clamped = clamp(newScale, MIN_SCALE, MAX_SCALE);
    const ratio   = clamped / prev;
    const maxX    = el.offsetWidth  * (clamped - 1) / 2;
    const maxY    = el.offsetHeight * (clamped - 1) / 2;
    const nx      = clamp(pivotX + ratio * (panRef.current.x - pivotX), -maxX, maxX);
    const ny      = clamp(pivotY + ratio * (panRef.current.y - pivotY), -maxY, maxY);
    scaleRef.current = clamped;
    panRef.current   = { x: nx, y: ny };
    setScale(clamped);
    setPan({ x: nx, y: ny });
  }

  function resetZoom() {
    scaleRef.current = 1; panRef.current = { x: 0, y: 0 };
    setScale(1); setPan({ x: 0, y: 0 });
  }

  // Scroll wheel zoom (desktop)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      const rect   = el.getBoundingClientRect();
      const pivotX = e.clientX - rect.left  - rect.width  / 2;
      const pivotY = e.clientY - rect.top   - rect.height / 2;
      doZoom(scaleRef.current * (e.deltaY < 0 ? 1.12 : 0.9), pivotX, pivotY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // ─── Coordinate helpers ──────────────────────────────────────────────
  // Using svgRef.getBoundingClientRect() — reflects actual rendered position after zoom/pan transform.
  const getImgPxFromClientXY = (clientX, clientY) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    return {
      x: (clientX - rect.left) / rect.width  * imgSize.w,
      y: (clientY - rect.top)  / rect.height * imgSize.h,
    };
  };
  const getImgPx = (e) => getImgPxFromClientXY(e.clientX, e.clientY);

  const bLeft = imgSize.w * boardRegion.left   / 100;
  const bTop  = imgSize.h * boardRegion.top    / 100;
  const bW    = imgSize.w * boardRegion.width  / 100;
  const bH    = imgSize.h * boardRegion.height / 100;

  const toSvgX = (x) => bLeft + (x / 100) * bW;
  const toSvgY = (y) => bTop  + (y / 100) * bH;

  const imgPxToBoardPct = ({ x, y }) => ({
    cx: clamp(((x - bLeft) / bW) * 100, 0, 100),
    cy: clamp(((y - bTop)  / bH) * 100, 0, 100),
  });

  // ─── Vertex placement ─────────────────────────────────────────────────
  // Shared logic: check for close-polygon distance, then add vertex.
  const placeVertex = (clientX, clientY) => {
    if (!drawMode || closedRef.current) return;
    const pct = imgPxToBoardPct(getImgPxFromClientXY(clientX, clientY));
    if (points.length >= 3) {
      const dx = pct.cx - points[0][0];
      const dy = pct.cy - points[0][1];
      if (Math.hypot(dx, dy) < CLOSE_THRESHOLD_PCT) {
        setClosed(true);
        return;
      }
    }
    setPoints(prev => [...prev, [r1(pct.cx), r1(pct.cy)]]);
  };

  // ─── Touch handlers ───────────────────────────────────────────────────
  // IMPORTANT: vertex touch drag is started from the vertex circle's onTouchStart
  // (with stopPropagation to block handleTouchStart), then tracked here in handleTouchMove
  // by matching touch.identifier so we don't need setPointerCapture.

  function handleTouchStart(e) {
    lastTouchTimeRef.current = Date.now();
    // Vertex drag touchstart calls stopPropagation, so this will NOT fire during vertex drag
    if (vertexDragActive.current) return;
    if (e.touches.length === 2) {
      pinchRef.current.active = true;
      const t0 = e.touches[0], t1 = e.touches[1];
      pinchRef.current.lastDist = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
    } else if (e.touches.length === 1) {
      pinchRef.current.active = false;
      mousePanRef.current = {
        active: true,
        startX: e.touches[0].clientX, startY: e.touches[0].clientY,
        basePanX: panRef.current.x,   basePanY: panRef.current.y,
        moved: false,
      };
    }
  }

  function handleTouchMove(e) {
    // ── Vertex drag (highest priority) ──
    if (vertexDragActive.current && vertexDragTouchId.current !== null) {
      const dt = Array.from(e.touches).find(t => t.identifier === vertexDragTouchId.current);
      if (dt) {
        e.preventDefault();
        const pct = imgPxToBoardPct(getImgPxFromClientXY(dt.clientX, dt.clientY));
        const idx = draggingIdxRef.current;
        if (idx !== null) {
          setPoints(prev => {
            const next = [...prev];
            next[idx] = [r1(pct.cx), r1(pct.cy)];
            return next;
          });
        }
        return; // don't also pan
      }
    }

    // ── Pinch zoom ──
    if (pinchRef.current.active && e.touches.length === 2) {
      e.preventDefault();
      const t0 = e.touches[0], t1 = e.touches[1];
      const dist   = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
      const factor = dist / pinchRef.current.lastDist;
      pinchRef.current.lastDist = dist;
      const rect   = containerRef.current.getBoundingClientRect();
      const pivotX = (t0.clientX + t1.clientX) / 2 - rect.left  - rect.width  / 2;
      const pivotY = (t0.clientY + t1.clientY) / 2 - rect.top   - rect.height / 2;
      doZoom(scaleRef.current * factor, pivotX, pivotY);
      return;
    }

    // ── Single-finger pan ──
    if (mousePanRef.current.active && e.touches.length === 1) {
      const dx = e.touches[0].clientX - mousePanRef.current.startX;
      const dy = e.touches[0].clientY - mousePanRef.current.startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) mousePanRef.current.moved = true;
      if (scaleRef.current > 1 && mousePanRef.current.moved) {
        e.preventDefault();
        const el   = containerRef.current;
        const maxX = el ? el.offsetWidth  * (scaleRef.current - 1) / 2 : 0;
        const maxY = el ? el.offsetHeight * (scaleRef.current - 1) / 2 : 0;
        panRef.current = {
          x: clamp(mousePanRef.current.basePanX + dx, -maxX, maxX),
          y: clamp(mousePanRef.current.basePanY + dy, -maxY, maxY),
        };
        setPan({ ...panRef.current });
      }
    }
  }

  function handleTouchEnd(e) {
    // End vertex drag if the drag touch lifted
    if (vertexDragActive.current && vertexDragTouchId.current !== null) {
      const ended = Array.from(e.changedTouches).find(t => t.identifier === vertexDragTouchId.current);
      if (ended) {
        vertexDragActive.current   = false;
        vertexDragTouchId.current  = null;
        draggingIdxRef.current     = null;
        setDraggingIdx(null);
        return;
      }
    }
    pinchRef.current.active     = false;
    mousePanRef.current.active  = false;
  }

  // ─── SVG touch handlers — native tap-based vertex placement ──────────
  // By using touchstart/touchend instead of synthesized onClick, we get
  // accurate coordinates and no ghost vertex issues on mobile.

  function handleSvgTouchStart(e) {
    // Always use closedRef.current (not stale closure 'closed') so we get the real current value
    if (!drawMode || closedRef.current || vertexDragActive.current) return;
    const touch = e.changedTouches[0];
    svgTapRef.current = { id: touch.identifier, startX: touch.clientX, startY: touch.clientY };
  }

  function handleSvgTouchEnd(e) {
    if (!svgTapRef.current) return;
    if (!drawMode || closedRef.current || vertexDragActive.current) {
      svgTapRef.current = null;
      return;
    }
    const touch = Array.from(e.changedTouches).find(t => t.identifier === svgTapRef.current.id);
    if (!touch) return;
    const dx = touch.clientX - svgTapRef.current.startX;
    const dy = touch.clientY - svgTapRef.current.startY;
    svgTapRef.current = null;
    // Only place a vertex if this was a real tap (finger barely moved)
    if (Math.abs(dx) > 12 || Math.abs(dy) > 12) return;
    placeVertex(touch.clientX, touch.clientY);
  }

  // ─── Mouse handlers (desktop) ────────────────────────────────────────
  function handleMouseDown(e) {
    if (e.button !== 0) return;
    if (isSynthesizedMouse()) return; // block synthesized mouse events on mobile
    if (vertexDragActive.current) return; // vertex drag in progress — don't start pan
    mousePanRef.current = {
      active: true,
      startX: e.clientX, startY: e.clientY,
      basePanX: panRef.current.x, basePanY: panRef.current.y,
      moved: false,
    };
    if (scaleRef.current > 1) setPanActive(true);
  }

  function handleMouseMove(e) {
    if (isSynthesizedMouse()) return;
    // ── Desktop vertex drag ──
    if (vertexDragActive.current && draggingIdxRef.current !== null) {
      const pct = imgPxToBoardPct(getImgPxFromClientXY(e.clientX, e.clientY));
      setPoints(prev => {
        const next = [...prev];
        next[draggingIdxRef.current] = [r1(pct.cx), r1(pct.cy)];
        return next;
      });
      return; // don't also pan
    }
    // ── Pan ──
    if (!mousePanRef.current.active) return;
    const dx = e.clientX - mousePanRef.current.startX;
    const dy = e.clientY - mousePanRef.current.startY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) mousePanRef.current.moved = true;
    if (scaleRef.current > 1 && mousePanRef.current.moved) {
      const el   = containerRef.current;
      const maxX = el ? el.offsetWidth  * (scaleRef.current - 1) / 2 : 0;
      const maxY = el ? el.offsetHeight * (scaleRef.current - 1) / 2 : 0;
      panRef.current = {
        x: clamp(mousePanRef.current.basePanX + dx, -maxX, maxX),
        y: clamp(mousePanRef.current.basePanY + dy, -maxY, maxY),
      };
      setPan({ ...panRef.current });
    }
  }

  function handleMouseUp() {
    if (isSynthesizedMouse()) return;
    mousePanRef.current.active = false;
    setPanActive(false);
    // Also end vertex drag if it was running
    if (vertexDragActive.current) {
      vertexDragActive.current = false;
      draggingIdxRef.current   = null;
      setDraggingIdx(null);
    }
  }

  // ─── Desktop vertex drag start ────────────────────────────────────────
  const startVertexDragMouse = (idx, e) => {
    if (e.button !== 0) return;
    e.stopPropagation(); // prevent handleMouseDown from also starting a pan
    vertexDragActive.current = true;
    draggingIdxRef.current   = idx;
    setDraggingIdx(idx);
  };

  // ─── Mobile vertex drag start ─────────────────────────────────────────
  const startVertexDragTouch = (idx, e) => {
    e.stopPropagation(); // prevent handleTouchStart from starting a pan
    svgTapRef.current = null;  // cancel any pending SVG tap so no vertex is placed
    const touch = e.changedTouches[0];
    vertexDragActive.current   = true;
    vertexDragTouchId.current  = touch.identifier;
    draggingIdxRef.current     = idx;
    setDraggingIdx(idx);
  };

  // ─── Desktop: SVG mouse up — place vertex ─────────────────────────────
  const handleSvgMouseUp = (e) => {
    if (e.button !== 0) return;
    if (isSynthesizedMouse()) return;
    if (!drawMode || closedRef.current) return;
    if (vertexDragActive.current) return; // a vertex was being dragged
    if (mousePanRef.current.moved) return; // was panning
    placeVertex(e.clientX, e.clientY);
  };

  // ─── Desktop: cursor preview (dashed line following mouse) ────────────
  const handleSvgMouseMove = (e) => {
    if (closed) return;
    setCursorPct(imgPxToBoardPct(getImgPx(e)));
  };

  // ─── Save ─────────────────────────────────────────────────────────────
  const canSave = closed && points.length >= 3;
  const handleSave = () => {
    const { cx, cy }       = centroid(points);
    const { w_pct, h_pct } = boundingBox(points);
    onSave({ ...meta, cx, cy, w_pct, h_pct, r: r1(Math.max(w_pct, h_pct) / 2), polygon: points });
  };

  const toggleHoldType = (type) => {
    setMeta(prev => {
      const current = prev.holdTypes || [];
      return {
        ...prev,
        holdTypes: current.includes(type)
          ? current.filter(t => t !== type)
          : [...current, type],
      };
    });
  };

  // ─── Derived SVG values ───────────────────────────────────────────────
  const bgHolds   = (allHolds || []).filter(h => h.id !== meta.id);
  const svgPts    = points.map(([x, y]) => `${toSvgX(x)},${toSvgY(y)}`).join(' ');
  const nearFirst = !closed && points.length >= 3 && cursorPct &&
    Math.hypot(cursorPct.cx - points[0][0], cursorPct.cy - points[0][1]) < CLOSE_THRESHOLD_PCT;

  const instruction = closed
    ? `Polygon complete (${points.length} pts) — drag vertices to adjust`
    : !drawMode
      ? 'Navigate mode — zoom & pan to find the hold, then switch to Draw'
      : points.length === 0
        ? 'Draw mode — tap the board to place the first vertex'
        : points.length < 3
          ? `${points.length} point${points.length === 1 ? '' : 's'} — keep tapping`
          : 'Tap near first point ● to close';

  const isZoomed = scale > 1;

  // Disable native touch handling when we need full control
  // (draw mode, closed polygon vertex editing, or zoomed pan)
  const needsFullTouchControl = isZoomed || drawMode || closed;

  const zoomBtnStyle = {
    width: '32px', height: '32px', borderRadius: '8px',
    border: '1px solid rgba(26,10,0,0.18)', background: 'rgba(255,255,255,0.88)',
    color: 'var(--text-secondary)', fontSize: '18px', lineHeight: 1,
    fontWeight: 700, cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    boxShadow: '0 1px 4px rgba(26,10,0,0.12)',
  };

  return (
    <div style={{ padding: '12px' }}>
      {/* Mode toggle + instruction */}
      {!closed && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
          <button
            onClick={() => setDrawMode(prev => !prev)}
            style={{
              flexShrink: 0,
              padding: '5px 12px', borderRadius: '20px', fontSize: '11px',
              fontWeight: 700, cursor: 'pointer',
              border: drawMode ? '1.5px solid rgba(0,71,255,0.5)' : '1.5px solid rgba(26,10,0,0.18)',
              background: drawMode ? 'rgba(0,71,255,0.12)' : 'rgba(255,255,255,0.7)',
              color: drawMode ? 'var(--accent)' : 'var(--text-secondary)',
            }}
          >
            {drawMode
              ? <><Icon name="pencil" size={12} style={{ marginRight: 4 }}/>Draw</>
              : <><Icon name="hand" size={12} style={{ marginRight: 4 }}/>Navigate</>
            }
          </button>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', letterSpacing: '0.5px' }}>
            {instruction}
          </div>
        </div>
      )}
      {closed && (
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', letterSpacing: '1px', textTransform: 'uppercase', marginBottom: '8px' }}>
          {instruction}
        </div>
      )}
      {isZoomed && (
        <div style={{ fontSize: '10px', color: 'var(--text-dim)', marginBottom: '4px', textAlign: 'right' }}>
          {Math.round(scale * 100)}% · double-tap to reset
        </div>
      )}

      {/* ── Board + SVG editor ── */}
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
          position: 'relative', width: '100%',
          borderRadius: '12px', overflow: 'hidden',
          border: '1px solid var(--border)', background: 'rgba(26,10,0,0.05)',
          touchAction: needsFullTouchControl ? 'none' : 'pan-y',
          userSelect: 'none',
          cursor: panActive ? 'grabbing'
            : isZoomed ? 'grab'
            : closed ? 'default'
            : drawMode ? 'crosshair' : 'grab',
        }}
      >
        {/* Transform wrapper for zoom/pan */}
        <div style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
          transformOrigin: 'center center',
          willChange: 'transform',
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
            style={{ width: '100%', display: 'block', opacity: imageLoaded ? 1 : 0.3, transition: 'opacity 0.4s' }}
            draggable={false}
          />

          {imageLoaded && (
            <svg
              ref={svgRef}
              viewBox={`0 0 ${imgSize.w} ${imgSize.h}`}
              width="100%" height="100%"
              preserveAspectRatio="none"
              style={{ position: 'absolute', top: 0, left: 0, overflow: 'visible' }}
              onMouseUp={handleSvgMouseUp}
              onMouseMove={handleSvgMouseMove}
              onTouchStart={handleSvgTouchStart}
              onTouchEnd={handleSvgTouchEnd}
            >
              {/* Background holds */}
              {bgHolds.map(h => {
                if (h.polygon?.length >= 3) {
                  const pts = h.polygon.map(([px, py]) => `${toSvgX(px)},${toSvgY(py)}`).join(' ');
                  return <polygon key={h.id} points={pts} fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="1" />;
                }
                const hcx = toSvgX(h.cx), hcy = toSvgY(h.cy);
                const w = h.w_pct ?? h.r * 2, hh = h.h_pct ?? h.r * 2;
                const hrx = Math.max((w / 100) * bW / 2, 2), hry = Math.max((hh / 100) * bH / 2, 2);
                return <ellipse key={h.id} cx={hcx} cy={hcy} rx={hrx} ry={hry} fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="1" />;
              })}

              {/* Board area hint */}
              {points.length === 0 && (
                <rect
                  x={bLeft} y={bTop} width={bW} height={bH}
                  fill="rgba(0,71,255,0.04)" stroke="rgba(0,71,255,0.25)"
                  strokeWidth="1.5" strokeDasharray="6 4"
                  style={{ pointerEvents: 'none' }}
                />
              )}

              {/* Completed polygon */}
              {closed && points.length >= 3 && (
                <polygon points={svgPts} fill="rgba(0,71,255,0.18)" stroke="#0047FF"
                  strokeWidth="2.5" strokeDasharray="6 3" style={{ pointerEvents: 'none' }} />
              )}

              {/* In-progress polyline */}
              {!closed && points.length >= 2 && (
                <polyline points={svgPts} fill="none" stroke="#0047FF"
                  strokeWidth="2" strokeDasharray="5 3" style={{ pointerEvents: 'none' }} />
              )}

              {/* Cursor preview line (desktop hover only) */}
              {!closed && points.length >= 1 && cursorPct && (
                <line
                  x1={toSvgX(points[points.length - 1][0])} y1={toSvgY(points[points.length - 1][1])}
                  x2={toSvgX(cursorPct.cx)} y2={toSvgY(cursorPct.cy)}
                  stroke="#0047FF" strokeWidth="1.5" strokeDasharray="4 4" strokeOpacity="0.5"
                  style={{ pointerEvents: 'none' }}
                />
              )}

              {/* Vertex handles */}
              {points.map(([x, y], idx) => {
                const svgX = toSvgX(x), svgY = toSvgY(y);
                const isFirst  = idx === 0;
                const canClose = isFirst && points.length >= 3 && !closed;
                return (
                  <g key={idx}>
                    {/* Large transparent hit target */}
                    <circle
                      cx={svgX} cy={svgY}
                      r={HANDLE_R + HIT_EXTRA + (canClose ? 4 : 0)}
                      fill="transparent"
                      style={{ pointerEvents: 'all', cursor: closed ? 'move' : canClose ? 'cell' : 'default' }}
                      onMouseDown={(e) => { if (!isSynthesizedMouse() && closedRef.current) startVertexDragMouse(idx, e); }}
                      onTouchStart={(e) => {
                        lastTouchTimeRef.current = Date.now();
                        // ALWAYS stop propagation on vertex touches — prevents the SVG
                        // tap handler from seeing this touch and placing a duplicate vertex.
                        e.stopPropagation();
                        if (closedRef.current) startVertexDragTouch(idx, e);
                      }}
                      onClick={canClose ? (e) => { e.stopPropagation(); setClosed(true); } : undefined}
                    />
                    {/* Visible dot */}
                    <circle
                      cx={svgX} cy={svgY}
                      r={isFirst ? HANDLE_R + 2 : HANDLE_R - 2}
                      fill={nearFirst && isFirst ? '#22a870' : isFirst ? '#0047FF' : '#fff'}
                      stroke={isFirst ? '#1A0A00' : '#0047FF'}
                      strokeWidth="2" style={{ pointerEvents: 'none' }}
                    />
                    {canClose && nearFirst && (
                      <circle cx={svgX} cy={svgY} r={HANDLE_R + 10}
                        fill="none" stroke="#22a870" strokeWidth="2" strokeOpacity="0.7"
                        style={{ pointerEvents: 'none' }}
                      />
                    )}
                    {!closed && idx > 0 && (
                      <text x={svgX + HANDLE_R + 3} y={svgY + 4}
                        fontSize="10" fill="rgba(0,71,255,0.7)"
                        style={{ pointerEvents: 'none', userSelect: 'none' }}>
                        {idx + 1}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
          )}
        </div>

        {/* Zoom controls — always render all 3 so layout never shifts on first zoom */}
        <div style={{
          position: 'absolute', top: '10px', right: '10px',
          zIndex: 30, display: 'flex', flexDirection: 'column', gap: '4px',
        }}>
          <button onClick={(e) => { e.stopPropagation(); doZoom(scaleRef.current * 1.5, 0, 0); }} style={zoomBtnStyle}>+</button>
          <button
            onClick={(e) => { e.stopPropagation(); if (isZoomed) doZoom(scaleRef.current / 1.5, 0, 0); }}
            style={{ ...zoomBtnStyle, opacity: isZoomed ? 1 : 0.35, cursor: isZoomed ? 'pointer' : 'default' }}
          >−</button>
          <button onClick={(e) => { e.stopPropagation(); resetZoom(); }}
            style={{ ...zoomBtnStyle, fontSize: '11px', height: '24px', visibility: isZoomed ? 'visible' : 'hidden' }}>↺</button>
        </div>
      </div>

      {/* ── Drawing controls ── */}
      {points.length > 0 && !closed && (
        <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
          <button onClick={() => setPoints(prev => prev.slice(0, -1))} style={drawBtnStyle}>← Undo</button>
          <button onClick={() => { setPoints([]); setCursorPct(null); }} style={drawBtnStyle}>Reset</button>
        </div>
      )}
      {closed && (
        <button onClick={() => setClosed(false)} style={{ ...drawBtnStyle, marginTop: '8px' }}>Redraw</button>
      )}

      {/* ── Hold Metadata ── */}
      <div style={{
        marginTop: '16px', background: 'var(--bg-card)',
        borderRadius: '12px', border: '1px solid var(--border)',
        padding: '14px', display: 'flex', flexDirection: 'column', gap: '14px',
      }}>
        <div style={metaSectionTitle}>Hold Details</div>

        {/* Name */}
        <div>
          <label style={metaLabel}>Name <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>(optional)</span></label>
          <input
            type="text"
            placeholder="e.g. Big blue pinch, small crimp..."
            value={meta.name || ''}
            onChange={(e) => setMeta(prev => ({ ...prev, name: e.target.value }))}
            style={metaInputStyle}
          />
        </div>

        {/* Colour */}
        <div>
          <label style={metaLabel}>Hold Colour</label>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {COLOR_OPTIONS.map(({ val, label, dot }) => {
              const on = meta.color === val;
              return (
                <button key={val} onClick={() => setMeta(prev => ({ ...prev, color: val }))} style={{
                  display: 'flex', alignItems: 'center', gap: '5px',
                  padding: '5px 10px', borderRadius: '20px', fontSize: '11px', cursor: 'pointer',
                  border: on ? '2px solid #0047FF' : '2px solid rgba(26,10,0,0.15)',
                  background: on ? 'rgba(0,71,255,0.1)' : 'rgba(255,255,255,0.6)',
                  color: on ? '#0047FF' : 'var(--text-secondary)',
                }}>
                  <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: dot, flexShrink: 0 }} />
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Hold Type */}
        <div>
          <label style={metaLabel}>Hold Type <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>(select all that apply)</span></label>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {HOLD_TYPE_OPTIONS.map(type => {
              const on = (meta.holdTypes || []).includes(type);
              return (
                <button key={type} onClick={() => toggleHoldType(type)} style={{
                  padding: '5px 12px', borderRadius: '20px', fontSize: '11px', cursor: 'pointer',
                  border: on ? '2px solid #0047FF' : '2px solid rgba(26,10,0,0.15)',
                  background: on ? 'rgba(0,71,255,0.1)' : 'rgba(255,255,255,0.6)',
                  color: on ? '#0047FF' : 'var(--text-secondary)', fontWeight: on ? 700 : 400,
                }}>
                  {type}
                </button>
              );
            })}
          </div>
        </div>

        {/* Positivity */}
        <div>
          <label style={metaLabel}>
            Positivity —&nbsp;
            <span style={{ color: 'var(--accent)', fontWeight: 700 }}>
              {meta.positivity > 0 ? '+' : ''}{meta.positivity ?? 0} ({positivityLabel(meta.positivity ?? 0)})
            </span>
          </label>
          <input
            type="range" min="-5" max="5" step="1"
            value={meta.positivity ?? 0}
            onChange={(e) => setMeta(prev => ({ ...prev, positivity: parseInt(e.target.value) }))}
            style={{ width: '100%', accentColor: '#0047FF', margin: '4px 0' }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: 'var(--text-dim)' }}>
            <span>−5 Very slopey</span><span>0 Flat</span><span>+5 Very juggy</span>
          </div>
        </div>

        {/* Material */}
        <div>
          <label style={metaLabel}>Material</label>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {MATERIALS.map(m => {
              const on = meta.material === m;
              return (
                <button key={m} onClick={() => setMeta(prev => ({ ...prev, material: prev.material === m ? '' : m }))} style={{
                  padding: '5px 12px', borderRadius: '20px', fontSize: '11px', cursor: 'pointer',
                  border: on ? '2px solid var(--accent)' : '2px solid rgba(26,10,0,0.12)',
                  background: on ? 'rgba(0,71,255,0.1)' : 'rgba(26,10,0,0.04)',
                  color: on ? 'var(--accent)' : 'var(--text-secondary)',
                  fontWeight: on ? 700 : 400,
                }}>
                  {m}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Actions ── */}
      <div style={{ display: 'flex', gap: '8px', marginTop: '14px' }}>
        {mode === 'edit' && onDelete && (
          <button onClick={onDelete} style={{
            flex: 1, padding: '10px', borderRadius: '8px', fontSize: '13px', cursor: 'pointer',
            border: '1px solid rgba(255,82,82,0.4)', background: 'rgba(255,82,82,0.08)',
            color: '#FF5252', fontWeight: 600,
          }}>Delete</button>
        )}
        <button onClick={onCancel} style={{
          flex: 1, padding: '10px', borderRadius: '8px', fontSize: '13px', cursor: 'pointer',
          border: '1px solid rgba(26,10,0,0.15)', background: 'rgba(26,10,0,0.06)', color: 'var(--text-secondary)',
        }}>Cancel</button>
        <button onClick={handleSave} disabled={!canSave} style={{
          flex: 2, padding: '10px', borderRadius: '8px', fontSize: '13px',
          fontWeight: 700, cursor: canSave ? 'pointer' : 'default', border: 'none',
          background: canSave ? '#0047FF' : 'rgba(26,10,0,0.12)',
          color: canSave ? '#fff' : 'var(--text-dim)',
          transition: 'background 0.2s',
        }}>
          {mode === 'add' ? 'Add Hold' : 'Save Changes'}
        </button>
      </div>
    </div>
  );
}

const drawBtnStyle = {
  padding: '5px 14px', borderRadius: '6px', fontSize: '11px', cursor: 'pointer',
  border: '1px solid rgba(26,10,0,0.15)', background: 'rgba(26,10,0,0.06)', color: 'var(--text-secondary)',
};

const metaSectionTitle = {
  fontSize: '11px', fontWeight: 800, color: 'var(--accent)',
  letterSpacing: '1.5px', textTransform: 'uppercase',
  borderLeft: '3px solid var(--yellow)', paddingLeft: '8px',
};

const metaLabel = {
  display: 'block', fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)',
  letterSpacing: '0.8px', textTransform: 'uppercase', marginBottom: '6px',
};

const metaInputStyle = {
  width: '100%', boxSizing: 'border-box', padding: '9px 12px', borderRadius: '8px',
  border: '1.5px solid rgba(26,10,0,0.15)', background: 'var(--bg-input)',
  fontSize: '13px', color: 'var(--text-primary)', outline: 'none',
};
