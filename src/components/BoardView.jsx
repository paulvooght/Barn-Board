import { useState, useRef, useEffect } from 'react';
import HoldOverlay from './HoldOverlay';
import holdsData from '../data/holds.json';

const MIN_SCALE = 1;
const MAX_SCALE = 5;

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

export default function BoardView({ holds, selection, onHoldTap, interactive, children }) {
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imgSize, setImgSize]         = useState({ w: 1200, h: 900 });
  const [scale, setScale]             = useState(1);
  const [pan, setPan]                 = useState({ x: 0, y: 0 });

  const containerRef = useRef(null);
  const scaleRef     = useRef(1);
  const panRef       = useRef({ x: 0, y: 0 });
  const pinchRef     = useRef({ active: false, lastDist: 0 });
  const dragRef      = useRef({ active: false, startX: 0, startY: 0, basePanX: 0, basePanY: 0, moved: false });
  const mouseRef     = useRef({ active: false, startX: 0, startY: 0, basePanX: 0, basePanY: 0, moved: false });

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

  function handleTouchStart(e) {
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
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) dragRef.current.moved = true;
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

  function handleTouchEnd() { pinchRef.current.active = false; }

  // ─── Mouse drag-to-pan (desktop) ──────────────────────────────────────
  function handleMouseDown(e) {
    if (e.button !== 0) return;
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
    if (!mouseRef.current.active) return;
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

  function handleMouseUp() { mouseRef.current.active = false; setMouseDown(false); }

  function resetZoom() {
    scaleRef.current = 1; panRef.current = { x: 0, y: 0 };
    setScale(1); setPan({ x: 0, y: 0 });
  }

  const isZoomed  = scale > 1;
  const [mouseDown, setMouseDown] = useState(false);

  const zoomBtnStyle = {
    width: '32px', height: '32px',
    borderRadius: '8px',
    border: '1px solid rgba(0,0,0,0.18)',
    background: 'rgba(255,255,255,0.88)',
    color: 'var(--text-secondary)',
    fontSize: '18px', lineHeight: 1,
    fontWeight: 700,
    cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    boxShadow: '0 1px 4px rgba(0,0,0,0.12)',
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
          background: 'rgba(0,0,0,0.05)',
          touchAction: isZoomed ? 'none' : 'pan-y',
          userSelect: 'none',
          cursor: isZoomed ? (mouseDown ? 'grabbing' : 'grab') : 'default',
        }}
      >
        <div
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
            transformOrigin: 'center center',
            willChange: 'transform',
          }}
        >
          <img
            src="/Board background.jpg"
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

          {imageLoaded && (
            <svg
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
            </svg>
          )}
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
