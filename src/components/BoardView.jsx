import { useState, useRef, useEffect } from 'react';
import HoldOverlay from './HoldOverlay';
import holdsData from '../data/holds.json';

const MIN_SCALE = 1;
const MAX_SCALE = 5;

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

export default function BoardView({ holds, selection, onHoldTap, interactive, dimBoard, imgSrc, imgSrcSet, imgSizes, holdSnapshots, children }) {
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imgSize, setImgSize]         = useState({ w: 1200, h: 900 });
  const [scale, setScale]             = useState(1);
  const [pan, setPan]                 = useState({ x: 0, y: 0 });

  const containerRef    = useRef(null);
  const scaleRef        = useRef(1);
  const panRef          = useRef({ x: 0, y: 0 });
  const pinchRef        = useRef({ active: false, lastDist: 0 });
  const dragRef         = useRef({ active: false, startX: 0, startY: 0, basePanX: 0, basePanY: 0, moved: false });
  const mouseRef        = useRef({ active: false, startX: 0, startY: 0, basePanX: 0, basePanY: 0, moved: false });
  const lastTouchTimeRef = useRef(0);
  const isSynthesizedMouse = () => Date.now() - lastTouchTimeRef.current < 500;

  const { boardRegion } = holdsData;
  const allHolds = holds ?? holdsData.holds;

  useEffect(() => { scaleRef.current = scale; }, [scale]);
  useEffect(() => { panRef.current = pan; }, [pan]);

  function doZoom(newScale, pivotX, pivotY) {
    const el = containerRef.current;
    if (!el) return;
    const prevScale = scaleRef.current;
    const prevPan   = panRef.current;
    const clamped   = clamp(newScale, MIN_SCALE, MAX_SCALE);
    const ratio     = clamped / prevScale;
    const maxX      = el.offsetWidth  * (clamped - 1) / 2;
    const maxY      = el.offsetHeight * (clamped - 1) / 2;
    const nx        = clamp(pivotX + ratio * (prevPan.x - pivotX), -maxX, maxX);
    const ny        = clamp(pivotY + ratio * (prevPan.y - pivotY), -maxY, maxY);
    scaleRef.current = clamped;
    panRef.current   = { x: nx, y: ny };
    setScale(clamped);
    setPan({ x: nx, y: ny });
  }

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

  // ─── Hit-test: find which hold (if any) is at a screen point ────────
  const svgRef = useRef(null);

  function findHoldAtPoint(clientX, clientY) {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();

    // Convert screen coords → SVG natural coords (accounting for zoom/pan)
    const svgX = ((clientX - rect.left) / rect.width)  * imgSize.w;
    const svgY = ((clientY - rect.top)  / rect.height) * imgSize.h;

    // Convert SVG coords → board-area percentages
    const bLeft = imgSize.w * boardRegion.left  / 100;
    const bTop  = imgSize.h * boardRegion.top   / 100;
    const bW    = imgSize.w * boardRegion.width  / 100;
    const bH    = imgSize.h * boardRegion.height / 100;
    const bx = (svgX - bLeft) / bW * 100;
    const by = (svgY - bTop)  / bH * 100;

    // Min tap radius in board-area % (very generous for fat fingers on phone)
    const tapRadius = 5;

    // Check polygon containment first, then distance to center
    let bestId = null;
    let bestDist = Infinity;

    for (const hold of allHolds) {
      // Quick bounding-box check with tap radius margin
      const hw = (hold.w_pct || 2) / 2 + tapRadius;
      const hh = (hold.h_pct || 2) / 2 + tapRadius;
      if (Math.abs(bx - hold.cx) > hw || Math.abs(by - hold.cy) > hh) continue;

      // Point-in-polygon test
      if (hold.polygon && hold.polygon.length >= 3) {
        if (pointInPolygon(bx, by, hold.polygon, tapRadius)) {
          // If inside polygon, use distance for priority (closest center wins)
          const d = Math.hypot(bx - hold.cx, by - hold.cy);
          if (d < bestDist) { bestDist = d; bestId = hold.id; }
          continue;
        }
      }

      // Distance to center fallback
      const d = Math.hypot(bx - hold.cx, by - hold.cy);
      if (d < tapRadius && d < bestDist) {
        bestDist = d;
        bestId = hold.id;
      }
    }
    return bestId;
  }

  function pointInPolygon(px, py, polygon, margin) {
    // Expand check: first try exact containment, then try within margin of any edge
    if (raycast(px, py, polygon)) return true;
    // Check distance to nearest edge
    for (let i = 0; i < polygon.length; i++) {
      const [ax, ay] = polygon[i];
      const [bx, by] = polygon[(i + 1) % polygon.length];
      if (distToSegment(px, py, ax, ay, bx, by) < margin) return true;
    }
    return false;
  }

  function raycast(px, py, polygon) {
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

  function distToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  function handleTouchStart(e) {
    lastTouchTimeRef.current = Date.now();
    if (e.touches.length === 2) {
      pinchRef.current.active = true;
      dragRef.current.active  = false;
      const t0 = e.touches[0], t1 = e.touches[1];
      pinchRef.current.lastDist = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
    } else if (e.touches.length === 1) {
      pinchRef.current.active = false;
      dragRef.current = {
        active: true,
        startX: e.touches[0].clientX,
        startY: e.touches[0].clientY,
        basePanX: panRef.current.x,
        basePanY: panRef.current.y,
        moved: false,
      };
    }
  }

  function handleTouchMove(e) {
    if (pinchRef.current.active && e.touches.length === 2) {
      e.preventDefault();
      const t0   = e.touches[0], t1 = e.touches[1];
      const dist = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
      const factor = dist / pinchRef.current.lastDist;
      pinchRef.current.lastDist = dist;
      const rect   = containerRef.current.getBoundingClientRect();
      const pivotX = (t0.clientX + t1.clientX) / 2 - rect.left  - rect.width  / 2;
      const pivotY = (t0.clientY + t1.clientY) / 2 - rect.top   - rect.height / 2;
      doZoom(scaleRef.current * factor, pivotX, pivotY);
    } else if (dragRef.current.active && e.touches.length === 1) {
      const dx = e.touches[0].clientX - dragRef.current.startX;
      const dy = e.touches[0].clientY - dragRef.current.startY;
      if (Math.abs(dx) > 12 || Math.abs(dy) > 12) dragRef.current.moved = true;
      if (scaleRef.current > 1 && dragRef.current.moved) {
        e.preventDefault();
        const el   = containerRef.current;
        const maxX = el ? el.offsetWidth  * (scaleRef.current - 1) / 2 : 0;
        const maxY = el ? el.offsetHeight * (scaleRef.current - 1) / 2 : 0;
        const nx   = clamp(dragRef.current.basePanX + dx, -maxX, maxX);
        const ny   = clamp(dragRef.current.basePanY + dy, -maxY, maxY);
        panRef.current = { x: nx, y: ny };
        setPan({ x: nx, y: ny });
      }
    }
  }

  function handleTouchEnd(e) {
    // If single-finger tap (no drag movement), check for hold hit
    if (dragRef.current.active && !dragRef.current.moved && interactive && onHoldTap) {
      const touch = e.changedTouches?.[0];
      const clientX = touch ? touch.clientX : dragRef.current.startX;
      const clientY = touch ? touch.clientY : dragRef.current.startY;
      const hitId = findHoldAtPoint(clientX, clientY);
      if (hitId) onHoldTap(hitId);
    }
    pinchRef.current.active = false;
    dragRef.current.active  = false;
  }

  // ─── Mouse drag-to-pan (desktop) ──────────────────────────────────────
  function handleMouseDown(e) {
    if (e.button !== 0 || isSynthesizedMouse()) return;
    mouseRef.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      basePanX: panRef.current.x,
      basePanY: panRef.current.y,
      moved: false,
    };
    if (scaleRef.current > 1) setMouseDown(true);
  }

  function handleMouseMove(e) {
    if (!mouseRef.current.active || isSynthesizedMouse()) return;
    const dx = e.clientX - mouseRef.current.startX;
    const dy = e.clientY - mouseRef.current.startY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) mouseRef.current.moved = true;
    if (scaleRef.current > 1 && mouseRef.current.moved) {
      const el   = containerRef.current;
      const maxX = el ? el.offsetWidth  * (scaleRef.current - 1) / 2 : 0;
      const maxY = el ? el.offsetHeight * (scaleRef.current - 1) / 2 : 0;
      panRef.current = {
        x: clamp(mouseRef.current.basePanX + dx, -maxX, maxX),
        y: clamp(mouseRef.current.basePanY + dy, -maxY, maxY),
      };
      setPan({ ...panRef.current });
    }
  }

  function handleMouseUp(e) {
    if (isSynthesizedMouse()) { mouseRef.current.active = false; return; }
    // If click (no drag movement), check for hold hit
    if (mouseRef.current.active && !mouseRef.current.moved && interactive && onHoldTap) {
      const hitId = findHoldAtPoint(e.clientX, e.clientY);
      if (hitId) onHoldTap(hitId);
    }
    mouseRef.current.active = false;
    setMouseDown(false);
  }

  function resetZoom() {
    scaleRef.current = 1; panRef.current = { x: 0, y: 0 };
    setScale(1); setPan({ x: 0, y: 0 });
  }

  const isZoomed  = scale > 1;
  const [mouseDown, setMouseDown] = useState(false);

  const zoomBtnStyle = {
    width: '32px', height: '32px',
    borderRadius: '8px',
    border: '1px solid rgba(26,10,0,0.18)',
    background: 'rgba(255,255,255,0.88)',
    color: 'var(--text-secondary)',
    fontSize: '18px', lineHeight: 1,
    fontWeight: 700,
    cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    boxShadow: '0 1px 4px rgba(26,10,0,0.12)',
  };

  return (
    <div style={{ padding: '0 0 4px' }}>
      {children && (
        <div style={{ padding: '8px 12px 6px' }}>
          {children}
        </div>
      )}

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
          position: 'relative',
          width: '100%',
          overflow: 'hidden',
          border: '1px solid var(--border)',
          borderLeft: 'none',
          borderRight: 'none',
          background: 'rgba(26,10,0,0.05)',
          touchAction: (isZoomed || interactive) ? 'none' : 'pan-y',
          userSelect: 'none',
          cursor: isZoomed ? (mouseDown ? 'grabbing' : 'grab') : 'default',
        }}
      >
        <div
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
            transformOrigin: 'center center',
          }}
        >
          <div style={{
            position: 'relative',
            border: '12px solid #FFE227',
            borderRadius: '2px',
            lineHeight: 0,
          }}>
          <img
            src={imgSrc || '/Barn_Set_01_V5.jpg'}
            srcSet={imgSrcSet}
            sizes={imgSizes}
            alt="Climbing board"
            onLoad={(e) => {
              setImgSize({ w: e.target.naturalWidth, h: e.target.naturalHeight });
              setImageLoaded(true);
            }}
            style={{
              width: '100%',
              display: 'block',
              opacity: imageLoaded ? 1 : 0.3,
              transition: 'opacity 0.4s',
            }}
            draggable={false}
          />

          {imageLoaded && dimBoard && (() => {
            const bLeft = imgSize.w * boardRegion.left / 100;
            const bTop  = imgSize.h * boardRegion.top / 100;
            const bW    = imgSize.w * boardRegion.width / 100;
            const bH    = imgSize.h * boardRegion.height / 100;
            const toX = (x) => bLeft + (x / 100) * bW;
            const toY = (y) => bTop  + (y / 100) * bH;
            const selectedHolds = allHolds.filter(h => selection?.[h.id]);
            return (
              <svg
                viewBox={`0 0 ${imgSize.w} ${imgSize.h}`}
                width="100%" height="100%"
                preserveAspectRatio="none"
                style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}
              >
                <defs>
                  <mask id="hold-cutout-mask">
                    <rect width={imgSize.w} height={imgSize.h} fill="white" fillOpacity="0.6" />
                    {selectedHolds.map(hold => {
                      if (hold.polygon?.length >= 3) {
                        const pts = hold.polygon.map(([x, y]) => `${toX(x)},${toY(y)}`).join(' ');
                        return <polygon key={hold.id} points={pts} fill="black" stroke="black" strokeWidth={16} strokeLinejoin="round" />;
                      }
                      const w = hold.w_pct !== undefined ? hold.w_pct : hold.r * 2;
                      const h = hold.h_pct !== undefined ? hold.h_pct : hold.r * 2;
                      return <ellipse key={hold.id} cx={toX(hold.cx)} cy={toY(hold.cy)} rx={Math.max((w / 100) * bW / 2 + 8, 10)} ry={Math.max((h / 100) * bH / 2 + 8, 10)} fill="black" />;
                    })}
                  </mask>
                </defs>
                <rect width={imgSize.w} height={imgSize.h} fill="white" mask="url(#hold-cutout-mask)" />
              </svg>
            );
          })()}

          {imageLoaded && (
            <svg
              ref={svgRef}
              viewBox={`0 0 ${imgSize.w} ${imgSize.h}`}
              width="100%"
              height="100%"
              preserveAspectRatio="none"
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                overflow: 'visible',
                pointerEvents: 'none',
              }}
            >
              {allHolds.map(hold => (
                <HoldOverlay
                  key={hold.id}
                  hold={hold}
                  boardRegion={boardRegion}
                  imgSize={imgSize}
                  selection={selection}
                  onTap={onHoldTap}
                  interactive={interactive}
                />
              ))}
              {/* Ghost outlines for missing/deleted holds */}
              {dimBoard && holdSnapshots && (() => {
                const holdIdSet = new Set(allHolds.map(h => h.id));
                const bL = imgSize.w * boardRegion.left / 100;
                const bT = imgSize.h * boardRegion.top / 100;
                const bWidth = imgSize.w * boardRegion.width / 100;
                const bHeight = imgSize.h * boardRegion.height / 100;
                const gX = (x) => bL + (x / 100) * bWidth;
                const gY = (y) => bT + (y / 100) * bHeight;
                return Object.entries(selection || {}).filter(([id]) => !holdIdSet.has(id)).map(([id]) => {
                  const snap = holdSnapshots[id];
                  if (!snap) return null;
                  if (snap.polygon?.length >= 3) {
                    const pts = snap.polygon.map(([x, y]) => `${gX(x)},${gY(y)}`).join(' ');
                    return (
                      <g key={`ghost-${id}`} style={{ pointerEvents: 'none' }}>
                        <polygon points={pts} fill="none" stroke="#FF1493" strokeWidth={6} strokeDasharray="10 6" strokeLinejoin="round" opacity={0.8} />
                        <text x={gX(snap.cx)} y={gY(snap.cy)} textAnchor="middle" dominantBaseline="central"
                          fontSize={Math.max(bWidth * 0.018, 14)} fontWeight="900" fill="#FF1493"
                          style={{ pointerEvents: 'none' }}
                        >✕</text>
                      </g>
                    );
                  }
                  const w = snap.w_pct !== undefined ? snap.w_pct : (snap.r || 2) * 2;
                  const h = snap.h_pct !== undefined ? snap.h_pct : (snap.r || 2) * 2;
                  const rx = Math.max((w / 100) * bWidth / 2, 4);
                  const ry = Math.max((h / 100) * bHeight / 2, 4);
                  return (
                    <g key={`ghost-${id}`} style={{ pointerEvents: 'none' }}>
                      <ellipse cx={gX(snap.cx)} cy={gY(snap.cy)} rx={rx} ry={ry} fill="none" stroke="#FF1493" strokeWidth={6} strokeDasharray="10 6" opacity={0.8} />
                      <text x={gX(snap.cx)} y={gY(snap.cy)} textAnchor="middle" dominantBaseline="central"
                        fontSize={Math.max(bWidth * 0.018, 14)} fontWeight="900" fill="#FF1493"
                        style={{ pointerEvents: 'none' }}
                      >✕</text>
                    </g>
                  );
                });
              })()}
            </svg>
          )}
          </div>{/* end yellow border wrapper */}
        </div>

        {/* Zoom controls — always render all 3 so layout never shifts on first zoom */}
        <div style={{
          position: 'absolute', top: '10px', right: '10px',
          zIndex: 30, display: 'flex', flexDirection: 'column', gap: '4px',
        }}>
          <button
            onClick={(e) => { e.stopPropagation(); doZoom(scaleRef.current * 1.5, 0, 0); }}
            style={zoomBtnStyle}
          >
            +
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); if (isZoomed) doZoom(scaleRef.current / 1.5, 0, 0); }}
            style={{ ...zoomBtnStyle, opacity: isZoomed ? 1 : 0.35, cursor: isZoomed ? 'pointer' : 'default' }}
          >
            −
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); resetZoom(); }}
            style={{ ...zoomBtnStyle, fontSize: '11px', height: '24px', visibility: isZoomed ? 'visible' : 'hidden' }}
          >
            ↺
          </button>
        </div>
      </div>
    </div>
  );
}
