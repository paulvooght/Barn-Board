import { useState, useRef, useEffect, useCallback, useMemo } from 'react';

// ─── Image helpers ────────────────────────────────────────────────────────────

function canvasToBlob(canvas, quality) {
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
}

function resizeToBlob(sourceCanvas, targetWidth, quality) {
  if (sourceCanvas.width <= targetWidth) {
    return canvasToBlob(sourceCanvas, quality);
  }
  const scale = targetWidth / sourceCanvas.width;
  const c = document.createElement('canvas');
  c.width = targetWidth;
  c.height = Math.round(sourceCanvas.height * scale);
  c.getContext('2d').drawImage(sourceCanvas, 0, 0, c.width, c.height);
  return new Promise(resolve => c.toBlob(resolve, 'image/jpeg', quality));
}

const MAX_IMAGE_WIDTH = 2000;
const JPEG_QUALITY = 0.85;

// ─── Auto-increment name helper ───────────────────────────────────────────────

function autoIncrementName(name) {
  // Match _V followed by digits at the end of the string
  const match = name.match(/^(.*_V)(\d+)$/);
  if (match) {
    return match[1] + (parseInt(match[2], 10) + 1);
  }
  // No version pattern — append _V2
  return name + '_V2';
}

// ─── Crop step component ──────────────────────────────────────────────────────

function CropStep({ imageDataUrl, imageWidth, imageHeight, onNext, onBack }) {
  const containerRef = useRef(null);
  const lastTouchTimeRef = useRef(0);

  // Crop rect in image-pixel coordinates
  const initCrop = useCallback((iw, ih) => ({
    x: Math.round(iw * 0.05),
    y: Math.round(ih * 0.05),
    w: Math.round(iw * 0.90),
    h: Math.round(ih * 0.90),
  }), []);

  const [crop, setCrop] = useState(() => initCrop(imageWidth, imageHeight));
  const [displayScale, setDisplayScale] = useState(1);

  // Loupe state
  const loupePosRef = useRef(null);      // { clientX, clientY }
  const isTouchDragRef = useRef(false);
  const [showLoupe, setShowLoupe] = useState(false);

  // Recalculate display scale when container resizes
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      setDisplayScale(rect.width / imageWidth);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [imageWidth]);

  // Drag state tracked via ref to avoid stale closures
  const dragRef = useRef(null); // { type: 'move'|corner, startX, startY, startCrop }

  const getEventPos = (e) => {
    if (e.touches) {
      return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
    return { x: e.clientX, y: e.clientY };
  };

  const toImageCoords = (clientX, clientY) => {
    const el = containerRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    return {
      x: (clientX - rect.left) / displayScale,
      y: (clientY - rect.top) / displayScale,
    };
  };

  const clampCrop = (c, iw, ih) => {
    const x = Math.max(0, Math.min(c.x, iw - 10));
    const y = Math.max(0, Math.min(c.y, ih - 10));
    const w = Math.max(10, Math.min(c.w, iw - x));
    const h = Math.max(10, Math.min(c.h, ih - y));
    return { x, y, w, h };
  };

  const handleMoveStart = (e, type) => {
    if (e.touches) {
      lastTouchTimeRef.current = Date.now();
      e.stopPropagation();
      isTouchDragRef.current = true;
      setShowLoupe(true);
    } else {
      if (Date.now() - lastTouchTimeRef.current < 500) return;
      isTouchDragRef.current = false;
    }
    const pos = getEventPos(e);
    dragRef.current = { type, startX: pos.x, startY: pos.y, startCrop: { ...crop } };
  };

  const handleMoveMove = useCallback((e) => {
    if (!dragRef.current) return;
    const pos = getEventPos(e);
    const dx = (pos.x - dragRef.current.startX) / displayScale;
    const dy = (pos.y - dragRef.current.startY) / displayScale;
    const sc = dragRef.current.startCrop;

    let next;
    switch (dragRef.current.type) {
      case 'move':
        next = { x: sc.x + dx, y: sc.y + dy, w: sc.w, h: sc.h };
        break;
      case 'tl':
        next = { x: sc.x + dx, y: sc.y + dy, w: sc.w - dx, h: sc.h - dy };
        break;
      case 'tr':
        next = { x: sc.x, y: sc.y + dy, w: sc.w + dx, h: sc.h - dy };
        break;
      case 'bl':
        next = { x: sc.x + dx, y: sc.y, w: sc.w - dx, h: sc.h + dy };
        break;
      case 'br':
        next = { x: sc.x, y: sc.y, w: sc.w + dx, h: sc.h + dy };
        break;
      default:
        return;
    }
    setCrop(clampCrop(next, imageWidth, imageHeight));
    if (isTouchDragRef.current) {
      loupePosRef.current = { clientX: pos.x, clientY: pos.y };
    }
  }, [displayScale, imageWidth, imageHeight]);

  const handleMoveEnd = useCallback(() => {
    dragRef.current = null;
    loupePosRef.current = null;
    isTouchDragRef.current = false;
    setShowLoupe(false);
  }, []);

  useEffect(() => {
    window.addEventListener('mousemove', handleMoveMove);
    window.addEventListener('mouseup', handleMoveEnd);
    window.addEventListener('touchmove', handleMoveMove, { passive: false });
    window.addEventListener('touchend', handleMoveEnd);
    return () => {
      window.removeEventListener('mousemove', handleMoveMove);
      window.removeEventListener('mouseup', handleMoveEnd);
      window.removeEventListener('touchmove', handleMoveMove);
      window.removeEventListener('touchend', handleMoveEnd);
    };
  }, [handleMoveMove, handleMoveEnd]);

  const handleApplyCrop = () => {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(crop.w);
    canvas.height = Math.round(crop.h);
    const ctx = canvas.getContext('2d');
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, canvas.width, canvas.height);
      onNext(canvas);
    };
    img.src = imageDataUrl;
  };

  // Display coordinates (pixels on screen)
  const dx = crop.x * displayScale;
  const dy = crop.y * displayScale;
  const dw = crop.w * displayScale;
  const dh = crop.h * displayScale;

  const HANDLE_SIZE = 22; // half of 44px

  const cornerHandles = [
    { key: 'tl', cx: dx, cy: dy },
    { key: 'tr', cx: dx + dw, cy: dy },
    { key: 'bl', cx: dx, cy: dy + dh },
    { key: 'br', cx: dx + dw, cy: dy + dh },
  ];

  return (
    <div>
      <p style={{ margin: '0 0 12px', fontSize: '13px', color: 'var(--text-secondary)' }}>
        Drag the corners or the rectangle to set the crop area.
      </p>

      {/* Image + crop overlay */}
      <div
        ref={containerRef}
        style={{ position: 'relative', width: '100%', userSelect: 'none', touchAction: 'none' }}
      >
        <img
          src={imageDataUrl}
          alt="Upload preview"
          style={{ display: 'block', width: '100%', height: 'auto' }}
          draggable={false}
        />

        {/* Dim overlay — 4 rectangles around the crop */}
        <svg
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
          viewBox={`0 0 ${imageWidth * displayScale} ${imageHeight * displayScale}`}
          preserveAspectRatio="none"
        >
          {/* Top */}
          <rect x={0} y={0} width={imageWidth * displayScale} height={dy} fill="rgba(0,0,0,0.5)" />
          {/* Bottom */}
          <rect x={0} y={dy + dh} width={imageWidth * displayScale} height={imageHeight * displayScale - dy - dh} fill="rgba(0,0,0,0.5)" />
          {/* Left */}
          <rect x={0} y={dy} width={dx} height={dh} fill="rgba(0,0,0,0.5)" />
          {/* Right */}
          <rect x={dx + dw} y={dy} width={imageWidth * displayScale - dx - dw} height={dh} fill="rgba(0,0,0,0.5)" />
          {/* Crop border */}
          <rect x={dx} y={dy} width={dw} height={dh} fill="none" stroke="white" strokeWidth="2" />
        </svg>

        {/* Draggable body of the crop rect */}
        <div
          onMouseDown={(e) => handleMoveStart(e, 'move')}
          onTouchStart={(e) => handleMoveStart(e, 'move')}
          style={{
            position: 'absolute',
            left: dx, top: dy, width: dw, height: dh,
            cursor: 'move',
            touchAction: 'none',
          }}
        />

        {/* Corner handles */}
        {cornerHandles.map(({ key, cx, cy }) => (
          <div
            key={key}
            onMouseDown={(e) => { e.stopPropagation(); handleMoveStart(e, key); }}
            onTouchStart={(e) => { e.stopPropagation(); handleMoveStart(e, key); }}
            style={{
              position: 'absolute',
              left: cx - HANDLE_SIZE,
              top: cy - HANDLE_SIZE,
              width: HANDLE_SIZE * 2,
              height: HANDLE_SIZE * 2,
              cursor: key === 'tl' || key === 'br' ? 'nwse-resize' : 'nesw-resize',
              touchAction: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <div style={{
              width: 16,
              height: 16,
              borderRadius: '50%',
              background: 'white',
              boxShadow: '0 1px 4px rgba(0,0,0,0.4)',
              border: '2px solid #0047FF',
            }} />
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: '10px', marginTop: '16px' }}>
        <button onClick={onBack} style={secondaryBtnStyle}>← Back</button>
        <button onClick={handleApplyCrop} style={{ ...primaryBtnStyle, flex: 1 }}>
          Next →
        </button>
      </div>

      {/* Loupe magnifier — only on corner drags during touch */}
      {showLoupe && dragRef.current && dragRef.current.type !== 'move' && loupePosRef.current && (() => {
        const LOUPE_W = 180;
        const LOUPE_H = 120;
        const LOUPE_RADIUS = 60;
        const MAGNIFICATION = 3;
        const OFFSET_ABOVE = 80;

        const { clientX, clientY } = loupePosRef.current;

        // Handle position in image pixel coords
        let handleX, handleY;
        switch (dragRef.current.type) {
          case 'tl': handleX = crop.x; handleY = crop.y; break;
          case 'tr': handleX = crop.x + crop.w; handleY = crop.y; break;
          case 'bl': handleX = crop.x; handleY = crop.y + crop.h; break;
          case 'br': handleX = crop.x + crop.w; handleY = crop.y + crop.h; break;
          default: return null;
        }

        const magW = LOUPE_W * MAGNIFICATION;
        const magH = magW * (imageHeight / imageWidth);
        const imgLeft = -(handleX / imageWidth * magW) + LOUPE_W / 2;
        const imgTop = -(handleY / imageHeight * magH) + LOUPE_H / 2;

        // Crop boundary in loupe coords
        const imgPixelScale = magW / imageWidth;
        const cL = (crop.x - handleX) * imgPixelScale + LOUPE_W / 2;
        const cT = (crop.y - handleY) * imgPixelScale + LOUPE_H / 2;
        const cR = (crop.x + crop.w - handleX) * imgPixelScale + LOUPE_W / 2;
        const cB = (crop.y + crop.h - handleY) * imgPixelScale + LOUPE_H / 2;

        const clamp = (v, min, max) => Math.max(min, Math.min(v, max));
        const loupeLeft = clamp(clientX - LOUPE_W / 2, 4, window.innerWidth - LOUPE_W - 4);
        const loupeTop = clamp(clientY - OFFSET_ABOVE - LOUPE_H, 4, clientY - OFFSET_ABOVE);

        return (
          <div key="loupe" style={{
            position: 'fixed', left: loupeLeft, top: loupeTop,
            width: LOUPE_W, height: LOUPE_H,
            borderRadius: `${LOUPE_RADIUS}px`,
            border: '2px solid rgba(255,255,255,0.9)',
            boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
            overflow: 'hidden', pointerEvents: 'none', zIndex: 300,
            background: '#1a0a00',
          }}>
            <img src={imageDataUrl} alt="" draggable={false}
              style={{ position: 'absolute', width: magW, height: magH, left: imgLeft, top: imgTop, pointerEvents: 'none' }}
            />
            <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
              <defs>
                <mask id="cropLoupeMask">
                  <rect width={LOUPE_W} height={LOUPE_H} fill="white" />
                  <rect x={cL} y={cT} width={cR - cL} height={cB - cT} fill="black" />
                </mask>
              </defs>
              <rect width={LOUPE_W} height={LOUPE_H} fill="rgba(0,0,0,0.45)" mask="url(#cropLoupeMask)" />
              {/* Crosshair lines */}
              <line x1={LOUPE_W/2 - 12} y1={LOUPE_H/2} x2={LOUPE_W/2 + 12} y2={LOUPE_H/2}
                stroke="white" strokeWidth="1.5" strokeOpacity="0.9" />
              <line x1={LOUPE_W/2} y1={LOUPE_H/2 - 12} x2={LOUPE_W/2} y2={LOUPE_H/2 + 12}
                stroke="white" strokeWidth="1.5" strokeOpacity="0.9" />
            </svg>
          </div>
        );
      })()}
    </div>
  );
}

// ─── (computeHomography, perspectiveWarp, computePerspectiveCSS, AlignStep deleted — Task D) ───

// ─── Mark Corners step component ─────────────────────────────────────────────
// User drags 4 pins onto the physical board corners. TL and BR are master pins;
// TR and BL are derived (rectangle always enforced). Outputs a boardRegion
// { left, top, width, height } as percentages of the cropped canvas dimensions.

function MarkCornersStep({ croppedCanvas, previousBoardRegion, onDone, onBack }) {
  const containerRef = useRef(null);
  const lastTouchTimeRef = useRef(0);

  const imgW = croppedCanvas.width;
  const imgH = croppedCanvas.height;

  // Memoize the data URL so we don't call toDataURL on every render
  const croppedSrc = useMemo(() => croppedCanvas.toDataURL('image/jpeg', 0.85), [croppedCanvas]);

  // Display scale: CSS pixels per canvas pixel
  const [displayScale, setDisplayScale] = useState(1);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      setDisplayScale(rect.width / imgW);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [imgW]);

  // ── Pin state ─────────────────────────────────────────────────────────────
  // Only TL and BR are stored; TR and BL are derived.
  // All coords are in canvas pixel space.
  const initTL = useCallback(() => ({
    x: (previousBoardRegion.left / 100) * imgW,
    y: (previousBoardRegion.top / 100) * imgH,
  }), [previousBoardRegion, imgW, imgH]);

  const initBR = useCallback(() => ({
    x: ((previousBoardRegion.left + previousBoardRegion.width) / 100) * imgW,
    y: ((previousBoardRegion.top + previousBoardRegion.height) / 100) * imgH,
  }), [previousBoardRegion, imgW, imgH]);

  const [tl, setTl] = useState(initTL);
  const [br, setBr] = useState(initBR);

  // Refs so event handlers always see latest values without stale closures
  const tlRef = useRef(tl);
  const brRef = useRef(br);
  useEffect(() => { tlRef.current = tl; }, [tl]);
  useEffect(() => { brRef.current = br; }, [br]);

  // Derived corners (rectangle always enforced)
  const tr = { x: br.x, y: tl.y };
  const bl = { x: tl.x, y: br.y };

  // ── Drag state ────────────────────────────────────────────────────────────
  // kind: 'tl' | 'tr' | 'bl' | 'br'
  const dragRef = useRef(null); // { kind, startClientX, startClientY, startTl, startBr, touchId? }

  // ── Loupe state ───────────────────────────────────────────────────────────
  const loupePosRef = useRef(null);   // { clientX, clientY }
  const isTouchDragRef = useRef(false);
  const [showLoupe, setShowLoupe] = useState(false);

  // ── Zoom/pan (pinch + wheel) ───────────────────────────────────────────────
  const [zoom, setZoom] = useState({ scale: 1, panX: 0, panY: 0 });
  const zoomRef = useRef({ scale: 1, panX: 0, panY: 0 });
  const pinchRef = useRef(null);

  // Wheel zoom handler
  const handleWheel = useCallback((e) => {
    e.preventDefault();
    const rect = containerRef.current.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;

    const absDelta = Math.abs(e.deltaY);
    let delta;
    if (absDelta < 10) delta = e.deltaY * 0.003;
    else if (absDelta < 50) delta = e.deltaY * 0.008;
    else delta = e.deltaY * 0.015;

    const oldScale = zoomRef.current.scale;
    const newScale = Math.max(1, Math.min(5, oldScale * (1 - delta)));
    let panX = cx - (cx - zoomRef.current.panX) * (newScale / oldScale);
    let panY = cy - (cy - zoomRef.current.panY) * (newScale / oldScale);

    if (newScale <= 1.02) { panX = 0; panY = 0; }
    const newZoom = { scale: newScale <= 1.02 ? 1 : newScale, panX, panY };
    setZoom(newZoom);
    zoomRef.current = newZoom;
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  // ── Clamp helpers ─────────────────────────────────────────────────────────
  const MIN_GAP = 10; // minimum distance between TL and BR in canvas pixels

  const clampPin = (x, y) => ({
    x: Math.max(0, Math.min(x, imgW)),
    y: Math.max(0, Math.min(y, imgH)),
  });

  // ── Drag start ────────────────────────────────────────────────────────────
  const startDrag = (e, kind) => {
    if (e.touches) {
      lastTouchTimeRef.current = Date.now();
      e.stopPropagation();
      e.preventDefault();
      const t = e.touches[0];
      isTouchDragRef.current = true;
      setShowLoupe(true);
      dragRef.current = {
        kind,
        startClientX: t.clientX,
        startClientY: t.clientY,
        startTl: { ...tlRef.current },
        startBr: { ...brRef.current },
        touchId: t.identifier,
      };
    } else {
      if (Date.now() - lastTouchTimeRef.current < 500) return;
      isTouchDragRef.current = false;
      dragRef.current = {
        kind,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startTl: { ...tlRef.current },
        startBr: { ...brRef.current },
      };
    }
  };

  // ── Drag move ─────────────────────────────────────────────────────────────
  const handleMove = useCallback((e) => {
    // ── Pinch zoom ──
    if (pinchRef.current && e.touches && e.touches.length >= 2) {
      e.preventDefault();
      const t0 = e.touches[0], t1 = e.touches[1];
      const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      const newMidX = (t0.clientX + t1.clientX) / 2;
      const newMidY = (t0.clientY + t1.clientY) / 2;

      const scaleRatio = dist / pinchRef.current.startDist;
      const newScale = Math.max(1, Math.min(5, pinchRef.current.startScale * scaleRatio));

      const rect = containerRef.current.getBoundingClientRect();
      const cx = pinchRef.current.startMidX - rect.left;
      const cy = pinchRef.current.startMidY - rect.top;
      let panX = cx - (cx - pinchRef.current.startPanX) * (newScale / pinchRef.current.startScale);
      let panY = cy - (cy - pinchRef.current.startPanY) * (newScale / pinchRef.current.startScale);

      panX += (newMidX - pinchRef.current.startMidX);
      panY += (newMidY - pinchRef.current.startMidY);

      if (newScale <= 1.02) { panX = 0; panY = 0; }
      const newZoom = { scale: newScale <= 1.02 ? 1 : newScale, panX, panY };
      setZoom(newZoom);
      zoomRef.current = newZoom;
      return;
    }

    if (!dragRef.current) return;

    let clientX, clientY;
    if (e.touches) {
      // Find the right touch by identifier
      const t = Array.from(e.touches).find(
        tt => tt.identifier === dragRef.current.touchId
      );
      if (!t) return;
      clientX = t.clientX;
      clientY = t.clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }

    if (dragRef.current.kind === 'pan') {
      const panX = dragRef.current.startPanX + (clientX - dragRef.current.startClientX);
      const panY = dragRef.current.startPanY + (clientY - dragRef.current.startClientY);
      const newZoom = { scale: zoomRef.current.scale, panX, panY };
      setZoom(newZoom);
      zoomRef.current = newZoom;
      return;
    }

    const dx = (clientX - dragRef.current.startClientX) / (displayScale * zoomRef.current.scale);
    const dy = (clientY - dragRef.current.startClientY) / (displayScale * zoomRef.current.scale);
    const sTl = dragRef.current.startTl;
    const sBr = dragRef.current.startBr;

    let newTl = { ...sTl };
    let newBr = { ...sBr };

    switch (dragRef.current.kind) {
      case 'tl':
        // TL moves both left and top
        newTl = clampPin(sTl.x + dx, sTl.y + dy);
        // Enforce min gap
        newTl.x = Math.min(newTl.x, newBr.x - MIN_GAP);
        newTl.y = Math.min(newTl.y, newBr.y - MIN_GAP);
        break;
      case 'br':
        // BR moves both right and bottom
        newBr = clampPin(sBr.x + dx, sBr.y + dy);
        newBr.x = Math.max(newBr.x, newTl.x + MIN_GAP);
        newBr.y = Math.max(newBr.y, newTl.y + MIN_GAP);
        break;
      case 'tr':
        // TR drag updates TL.y (top) and BR.x (right)
        newTl = { ...sTl, y: clampPin(sTl.x, sTl.y + dy).y };
        newBr = { ...sBr, x: clampPin(sBr.x + dx, sBr.y).x };
        newTl.y = Math.min(newTl.y, newBr.y - MIN_GAP);
        newBr.x = Math.max(newBr.x, newTl.x + MIN_GAP);
        break;
      case 'bl':
        // BL drag updates TL.x (left) and BR.y (bottom)
        newTl = { ...sTl, x: clampPin(sTl.x + dx, sTl.y).x };
        newBr = { ...sBr, y: clampPin(sBr.x, sBr.y + dy).y };
        newTl.x = Math.min(newTl.x, newBr.x - MIN_GAP);
        newBr.y = Math.max(newBr.y, newTl.y + MIN_GAP);
        break;
      default:
        return;
    }

    setTl(newTl);
    setBr(newBr);

    if (isTouchDragRef.current) {
      loupePosRef.current = { clientX, clientY };
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayScale, imgW, imgH]);

  // ── Drag end ──────────────────────────────────────────────────────────────
  const handleEnd = useCallback((e) => {
    if (pinchRef.current) {
      const remaining = e && e.touches ? e.touches.length : 0;
      if (remaining < 2) {
        pinchRef.current = null;
        if (zoomRef.current.scale < 1.05) {
          const reset = { scale: 1, panX: 0, panY: 0 };
          setZoom(reset);
          zoomRef.current = reset;
        }
      }
      return;
    }
    dragRef.current = null;
    if (isTouchDragRef.current) {
      loupePosRef.current = null;
      isTouchDragRef.current = false;
      setShowLoupe(false);
    }
  }, []);

  // Global move/end listeners
  useEffect(() => {
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleEnd);
    window.addEventListener('touchmove', handleMove, { passive: false });
    window.addEventListener('touchend', handleEnd);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleEnd);
      window.removeEventListener('touchmove', handleMove);
      window.removeEventListener('touchend', handleEnd);
    };
  }, [handleMove, handleEnd]);

  // ── Next handler ──────────────────────────────────────────────────────────
  const handleNext = () => {
    const boardRegion = {
      left:   (tl.x / imgW) * 100,
      top:    (tl.y / imgH) * 100,
      width:  ((br.x - tl.x) / imgW) * 100,
      height: ((br.y - tl.y) / imgH) * 100,
    };
    onDone(boardRegion);
  };

  // ── Render ────────────────────────────────────────────────────────────────
  const PIN_RADIUS = 10;  // visual radius in SVG units (canvas pixels at displayScale)
  const PIN_HIT = 22;     // half of 44px touch hit target

  // All 4 corner positions for rendering
  const pins = [
    { key: 'tl', label: 'TL', pos: tl },
    { key: 'tr', label: 'TR', pos: tr },
    { key: 'bl', label: 'BL', pos: bl },
    { key: 'br', label: 'BR', pos: br },
  ];

  // Rectangle in SVG viewBox units (canvas pixel space)
  const rectX = tl.x;
  const rectY = tl.y;
  const rectW = br.x - tl.x;
  const rectH = br.y - tl.y;

  return (
    <div>
      <p style={{ margin: '0 0 12px', fontSize: '13px', color: 'rgba(26,10,0,0.6)', lineHeight: 1.5 }}>
        Drag the 4 pins to the corners of the physical climbing board.
      </p>

      {/* Image + SVG overlay */}
      <div
        ref={containerRef}
        onTouchStart={(e) => {
          if (e.touches.length >= 2) {
            dragRef.current = null;
            const t0 = e.touches[0], t1 = e.touches[1];
            const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
            const midX = (t0.clientX + t1.clientX) / 2;
            const midY = (t0.clientY + t1.clientY) / 2;
            pinchRef.current = {
              startDist: dist,
              startScale: zoomRef.current.scale,
              startPanX: zoomRef.current.panX,
              startPanY: zoomRef.current.panY,
              startMidX: midX,
              startMidY: midY,
            };
          } else if (e.touches.length === 1 && zoomRef.current.scale > 1) {
            // Single finger on background while zoomed → pan
            lastTouchTimeRef.current = Date.now();
            const t = e.touches[0];
            dragRef.current = {
              kind: 'pan',
              startClientX: t.clientX,
              startClientY: t.clientY,
              startPanX: zoomRef.current.panX,
              startPanY: zoomRef.current.panY,
            };
          }
        }}
        style={{
          position: 'relative',
          width: '100%',
          userSelect: 'none',
          touchAction: 'none',
          overflow: 'hidden',
          borderRadius: '10px',
          border: '1px solid rgba(26,10,0,0.12)',
        }}
      >
        {/* Inner zoom/pan wrapper */}
        <div style={{
          transformOrigin: '0 0',
          transform: `translate(${zoom.panX}px, ${zoom.panY}px) scale(${zoom.scale})`,
          width: '100%',
          position: 'relative',
        }}>
          {/* The cropped board image */}
          <img
            src={croppedSrc}
            alt="Cropped board"
            draggable={false}
            style={{ display: 'block', width: '100%', height: 'auto', pointerEvents: 'none' }}
          />

          {/* SVG overlay — pins, rectangle, labels */}
          <svg
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible' }}
            viewBox={`0 0 ${imgW} ${imgH}`}
            preserveAspectRatio="none"
          >
            {/* Dashed rectangle outline */}
            <rect
              x={rectX} y={rectY} width={rectW} height={rectH}
              fill="none"
              stroke="rgba(255,255,255,0.8)"
              strokeWidth={2}
              strokeDasharray="8 5"
              pointerEvents="none"
            />

            {/* Pins */}
            {pins.map(({ key, label, pos }) => {
              // Label positioning: offset to avoid overlapping the pin
              const isRight = key === 'tr' || key === 'br';
              const isBottom = key === 'bl' || key === 'br';
              const labelX = pos.x + (isRight ? -(PIN_RADIUS + 4) : (PIN_RADIUS + 4));
              const labelY = pos.y + (isBottom ? (PIN_RADIUS + 14) : -(PIN_RADIUS + 4));
              const textAnchor = isRight ? 'end' : 'start';

              return (
                <g key={key}>
                  {/* Invisible large hit target */}
                  <circle
                    cx={pos.x} cy={pos.y} r={PIN_HIT}
                    fill="transparent"
                    style={{ cursor: 'grab', touchAction: 'none' }}
                    onMouseDown={(e) => { e.stopPropagation(); startDrag(e, key); }}
                    onTouchStart={(e) => { e.stopPropagation(); startDrag(e, key); }}
                  />
                  {/* Visible pin */}
                  <circle
                    cx={pos.x} cy={pos.y} r={PIN_RADIUS}
                    fill="#0047FF"
                    stroke="white"
                    strokeWidth={2}
                    style={{ filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.5))', pointerEvents: 'none' }}
                  />
                  {/* Label */}
                  <text
                    x={labelX} y={labelY}
                    fontSize={14}
                    fontWeight="700"
                    fontFamily="Space Mono, monospace"
                    fill="white"
                    stroke="rgba(0,0,0,0.6)"
                    strokeWidth={3}
                    paintOrder="stroke"
                    textAnchor={textAnchor}
                    pointerEvents="none"
                  >
                    {label}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      </div>

      {/* Buttons */}
      <div style={{ display: 'flex', gap: '10px', marginTop: '16px' }}>
        <button onClick={onBack} style={secondaryBtnStyle}>← Back</button>
        <button onClick={handleNext} style={{ ...primaryBtnStyle, flex: 1 }}>
          Next →
        </button>
      </div>

      {/* Loupe magnifier — only shown during touch pin drag */}
      {showLoupe && dragRef.current && dragRef.current.kind !== 'pan' && loupePosRef.current && (() => {
        const LOUPE_W = 180;
        const LOUPE_H = 120;
        const LOUPE_RADIUS = 60;
        const MAGNIFICATION = 3;
        const OFFSET_ABOVE = 80;

        const { clientX, clientY } = loupePosRef.current;

        // Current pin position in canvas pixel space
        const pinKey = dragRef.current.kind;
        let pinCanvasX, pinCanvasY;
        switch (pinKey) {
          case 'tl': pinCanvasX = tlRef.current.x; pinCanvasY = tlRef.current.y; break;
          case 'br': pinCanvasX = brRef.current.x; pinCanvasY = brRef.current.y; break;
          case 'tr': pinCanvasX = brRef.current.x; pinCanvasY = tlRef.current.y; break;
          case 'bl': pinCanvasX = tlRef.current.x; pinCanvasY = brRef.current.y; break;
          default: return null;
        }

        // Map canvas coords to loupe display
        const magW = LOUPE_W * MAGNIFICATION;
        const magH = magW * (imgH / imgW);
        const imgLeft = -(pinCanvasX / imgW * magW) + LOUPE_W / 2;
        const imgTop  = -(pinCanvasY / imgH * magH) + LOUPE_H / 2;

        const clamp = (v, min, max) => Math.max(min, Math.min(v, max));
        const loupeLeft = clamp(clientX - LOUPE_W / 2, 4, window.innerWidth - LOUPE_W - 4);
        const loupeTop  = clamp(clientY - OFFSET_ABOVE - LOUPE_H, 4, clientY - OFFSET_ABOVE);

        return (
          <div key="corners-loupe" style={{
            position: 'fixed', left: loupeLeft, top: loupeTop,
            width: LOUPE_W, height: LOUPE_H,
            borderRadius: `${LOUPE_RADIUS}px`,
            border: '2px solid rgba(255,255,255,0.9)',
            boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
            overflow: 'hidden', pointerEvents: 'none', zIndex: 300,
            background: '#1a0a00',
          }}>
            <img src={croppedSrc} alt="" draggable={false}
              style={{ position: 'absolute', width: magW, height: magH, left: imgLeft, top: imgTop, pointerEvents: 'none' }}
            />
            <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
              {/* Crosshair */}
              <line x1={LOUPE_W/2 - 12} y1={LOUPE_H/2} x2={LOUPE_W/2 + 12} y2={LOUPE_H/2}
                stroke="white" strokeWidth="1.5" strokeOpacity="0.9" />
              <line x1={LOUPE_W/2} y1={LOUPE_H/2 - 12} x2={LOUPE_W/2} y2={LOUPE_H/2 + 12}
                stroke="white" strokeWidth="1.5" strokeOpacity="0.9" />
            </svg>
          </div>
        );
      })()}
    </div>
  );
}

// ─── Shared button styles ─────────────────────────────────────────────────────

const primaryBtnStyle = {
  padding: '13px 20px',
  borderRadius: '12px',
  fontSize: '15px',
  fontWeight: 700,
  cursor: 'pointer',
  border: 'none',
  background: '#0047FF',
  color: '#fff',
  fontFamily: 'DM Sans, sans-serif',
};

const secondaryBtnStyle = {
  padding: '13px 20px',
  borderRadius: '12px',
  fontSize: '14px',
  fontWeight: 600,
  cursor: 'pointer',
  border: '1px solid rgba(26,10,0,0.15)',
  background: 'rgba(26,10,0,0.06)',
  color: '#1A0A00',
  fontFamily: 'DM Sans, sans-serif',
};

// ─── Main wizard component ────────────────────────────────────────────────────

export default function BoardImageUpdateView({ currentImgSrc, currentImageName, previousBoardRegion, holds, onSave, onCancel }) {
  const [step, setStep] = useState('upload'); // 'upload' | 'crop' | 'markCorners' | 'confirm'

  // Upload step state
  const [uploadedDataUrl, setUploadedDataUrl] = useState(null);
  const [uploadedWidth, setUploadedWidth] = useState(0);
  const [uploadedHeight, setUploadedHeight] = useState(0);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);

  // Crop canvas (set after crop step)
  const [croppedCanvas, setCroppedCanvas] = useState(null);

  // boardRegion set by MarkCornersStep — persisted so "Adjust corners" re-enters with last pins
  const [pendingBoardRegion, setPendingBoardRegion] = useState(null);

  // Confirm step state
  const [imageName, setImageName] = useState(() => autoIncrementName(currentImageName || 'Barn_Set_01_V5'));
  const [nameError, setNameError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  // Memoized data URL for the confirm step preview (avoids repeated toDataURL calls)
  const confirmImageSrc = useMemo(
    () => (step === 'confirm' && croppedCanvas ? croppedCanvas.toDataURL('image/jpeg', JPEG_QUALITY) : null),
    // Only recompute when croppedCanvas identity changes (not on every render)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [croppedCanvas]
  );

  const stepLabels = {
    upload: 'Step 1 of 4 — Upload',
    crop: 'Step 2 of 4 — Crop',
    markCorners: 'Step 3 of 4 — Mark Corners',
    confirm: 'Step 4 of 4 — Confirm',
  };

  // ── Upload step handlers ──────────────────────────────────────────────────

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);

    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let w = img.naturalWidth;
      let h = img.naturalHeight;

      const canvas = document.createElement('canvas');
      if (w > MAX_IMAGE_WIDTH) {
        const scale = MAX_IMAGE_WIDTH / w;
        w = MAX_IMAGE_WIDTH;
        h = Math.round(h * scale);
      }
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);

      setUploadedWidth(w);
      setUploadedHeight(h);
      setUploadedDataUrl(canvas.toDataURL('image/jpeg', JPEG_QUALITY));
      setUploading(false);
    };
    img.onerror = () => { URL.revokeObjectURL(url); setUploading(false); };
    img.src = url;
    // Reset file input so the same file can be re-selected
    e.target.value = '';
  };

  // ── Confirm step handlers ──────────────────────────────────────────────────

  const validateName = (name) => {
    if (!name.trim()) return 'Name cannot be empty';
    if (!/^[a-zA-Z0-9_-]+$/.test(name.trim())) return 'Only letters, numbers, underscores, and hyphens allowed';
    return '';
  };

  const handleNameChange = (e) => {
    const val = e.target.value;
    setImageName(val);
    setNameError(validateName(val));
  };

  const handleSave = async () => {
    const err = validateName(imageName);
    if (err) { setNameError(err); return; }
    setSaving(true);
    setSaveError('');
    try {
      const full = await canvasToBlob(croppedCanvas, JPEG_QUALITY);
      const w2000 = await resizeToBlob(croppedCanvas, 2000, JPEG_QUALITY);
      const w1200 = await resizeToBlob(croppedCanvas, 1200, JPEG_QUALITY);
      const w800 = await resizeToBlob(croppedCanvas, 800, JPEG_QUALITY);
      await onSave({
        imageName: imageName.trim(),
        imageBlobs: { full, w2000, w1200, w800 },
        boardRegion: pendingBoardRegion,
      });
    } catch (err) {
      console.error('[BoardImageUpdate] Save failed:', err);
      const msg = err?.message || String(err);
      setSaveError(`Upload failed: ${msg}`);
      setSaving(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ padding: '16px 12px', maxWidth: '480px', margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
        <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 700, fontFamily: 'Space Mono, monospace' }}>
          Update Board Image
        </h2>
        <button
          onClick={onCancel}
          style={{
            padding: '5px 12px', borderRadius: '8px', fontSize: '11px', cursor: 'pointer',
            border: '1px solid rgba(26,10,0,0.15)', background: 'rgba(26,10,0,0.06)',
            color: '#1A0A00', fontFamily: 'DM Sans, sans-serif',
          }}
        >
          Cancel
        </button>
      </div>

      {/* Step indicator */}
      <div style={{
        marginBottom: '20px',
        fontSize: '11px',
        fontWeight: 700,
        letterSpacing: '1px',
        textTransform: 'uppercase',
        color: '#0047FF',
        fontFamily: 'Space Mono, monospace',
      }}>
        {stepLabels[step]}
      </div>

      {/* ── Step 1: Upload ── */}
      {step === 'upload' && (
        <div>
          <p style={{ margin: '0 0 16px', fontSize: '14px', color: '#1A0A00', lineHeight: 1.5 }}>
            Take a photo of the board or choose one from your gallery.
          </p>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleFileChange}
            style={{ display: 'none' }}
          />

          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            style={{
              ...primaryBtnStyle,
              width: '100%',
              marginBottom: '12px',
              opacity: uploading ? 0.6 : 1,
            }}
          >
            {uploading ? 'Loading…' : '📷 Choose / Take Photo'}
          </button>

          {/* Preview */}
          {uploadedDataUrl && (
            <div style={{ marginBottom: '16px' }}>
              <img
                src={uploadedDataUrl}
                alt="Uploaded preview"
                style={{ width: '100%', borderRadius: '10px', display: 'block', border: '1px solid rgba(26,10,0,0.12)' }}
              />
              <div style={{
                marginTop: '6px', fontSize: '11px', color: 'rgba(26,10,0,0.45)',
                textAlign: 'center', fontFamily: 'Space Mono, monospace',
              }}>
                {uploadedWidth} × {uploadedHeight}px
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: '10px' }}>
            <button onClick={onCancel} style={secondaryBtnStyle}>Cancel</button>
            <button
              onClick={() => setStep('crop')}
              disabled={!uploadedDataUrl}
              style={{
                ...primaryBtnStyle,
                flex: 1,
                opacity: uploadedDataUrl ? 1 : 0.4,
                cursor: uploadedDataUrl ? 'pointer' : 'not-allowed',
              }}
            >
              Next →
            </button>
          </div>
        </div>
      )}

      {/* ── Step 2: Crop ── */}
      {step === 'crop' && uploadedDataUrl && (
        <CropStep
          imageDataUrl={uploadedDataUrl}
          imageWidth={uploadedWidth}
          imageHeight={uploadedHeight}
          onNext={(canvas) => { setCroppedCanvas(canvas); setStep('markCorners'); }}
          onBack={() => setStep('upload')}
        />
      )}

      {/* ── Step 3: Mark Corners ── */}
      {step === 'markCorners' && croppedCanvas && (
        <MarkCornersStep
          croppedCanvas={croppedCanvas}
          previousBoardRegion={pendingBoardRegion ?? previousBoardRegion}
          onDone={(boardRegion) => { setPendingBoardRegion(boardRegion); setStep('confirm'); }}
          onBack={() => setStep('crop')}
        />
      )}

      {/* ── Step 4: Confirm ── */}
      {step === 'confirm' && croppedCanvas && pendingBoardRegion && (
        <div>
          {/* Full-width preview of new image with hold overlay */}
          <div style={{ marginBottom: '16px' }}>
            <div style={{
              fontSize: '10px', fontWeight: 700, letterSpacing: '1px',
              textTransform: 'uppercase', color: '#0047FF', marginBottom: '6px',
              textAlign: 'center', fontFamily: 'Space Mono, monospace',
            }}>
              New Board Image — Check hold positions
            </div>
            <div style={{ position: 'relative', width: '100%' }}>
              <img
                src={confirmImageSrc}
                alt="New board preview"
                style={{
                  width: '100%', borderRadius: '10px', display: 'block',
                  border: '2px solid #0047FF',
                }}
              />
              {/* Hold overlay SVG */}
              {holds && holds.length > 0 && (
                <svg
                  style={{
                    position: 'absolute', inset: 0,
                    width: '100%', height: '100%',
                    borderRadius: '10px',
                    pointerEvents: 'none',
                  }}
                  viewBox={`0 0 ${croppedCanvas.width} ${croppedCanvas.height}`}
                  preserveAspectRatio="none"
                >
                  {holds.map((hold) => {
                    const imgSize = { w: croppedCanvas.width, h: croppedCanvas.height };
                    const br = pendingBoardRegion;
                    const bLeft = imgSize.w * br.left / 100;
                    const bTop  = imgSize.h * br.top / 100;
                    const bW    = imgSize.w * br.width / 100;
                    const bH    = imgSize.h * br.height / 100;
                    const toX = (x_pct) => bLeft + (x_pct / 100) * bW;
                    const toY = (y_pct) => bTop  + (y_pct / 100) * bH;

                    const hasPolygon = hold.polygon && hold.polygon.length >= 3;
                    const polyPoints = hasPolygon
                      ? hold.polygon.map(([px, py]) => `${toX(px)},${toY(py)}`).join(' ')
                      : null;
                    const cx = toX(hold.cx);
                    const cy = toY(hold.cy);
                    const w = hold.w_pct !== undefined ? hold.w_pct : (hold.r || 2) * 2;
                    const h = hold.h_pct !== undefined ? hold.h_pct : (hold.r || 2) * 2;
                    const rx = Math.max((w / 100) * bW / 2, 2);
                    const ry = Math.max((h / 100) * bH / 2, 2);

                    return (
                      <g key={hold.id} style={{ pointerEvents: 'none' }}>
                        {hasPolygon ? (
                          <polygon
                            points={polyPoints}
                            fill="rgba(34,211,238,0.08)"
                            stroke="rgba(34,211,238,0.7)"
                            strokeWidth={1.5}
                            strokeLinejoin="round"
                          />
                        ) : (
                          <ellipse
                            cx={cx} cy={cy} rx={rx} ry={ry}
                            fill="rgba(34,211,238,0.08)"
                            stroke="rgba(34,211,238,0.7)"
                            strokeWidth={1.5}
                          />
                        )}
                      </g>
                    );
                  })}
                </svg>
              )}
            </div>
            <div style={{
              marginTop: '5px', fontSize: '11px', color: 'rgba(26,10,0,0.5)',
              textAlign: 'center', fontFamily: 'Space Mono, monospace',
            }}>
              {holds?.length ?? 0} holds overlaid — check they line up with the physical holds
            </div>
          </div>

          {/* Name input */}
          <div style={{ marginBottom: '20px' }}>
            <label style={{
              display: 'block', marginBottom: '6px',
              fontSize: '11px', fontWeight: 700, letterSpacing: '1px',
              textTransform: 'uppercase', color: 'rgba(26,10,0,0.55)',
              fontFamily: 'Space Mono, monospace',
            }}>
              Image Name
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0' }}>
              <input
                type="text"
                value={imageName}
                onChange={handleNameChange}
                style={{
                  flex: 1,
                  padding: '11px 12px',
                  borderRadius: '10px 0 0 10px',
                  border: nameError ? '2px solid #ef4444' : '1px solid rgba(26,10,0,0.2)',
                  background: '#fff',
                  fontSize: '14px',
                  color: '#1A0A00',
                  fontFamily: 'Space Mono, monospace',
                  outline: 'none',
                }}
                placeholder="Barn_Set_01_V6"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
              <div style={{
                padding: '11px 12px',
                borderRadius: '0 10px 10px 0',
                border: '1px solid rgba(26,10,0,0.2)',
                borderLeft: 'none',
                background: 'rgba(26,10,0,0.04)',
                fontSize: '14px',
                color: 'rgba(26,10,0,0.45)',
                fontFamily: 'Space Mono, monospace',
                whiteSpace: 'nowrap',
              }}>
                .jpg
              </div>
            </div>
            {nameError && (
              <div style={{ marginTop: '5px', fontSize: '12px', color: '#ef4444' }}>{nameError}</div>
            )}
          </div>

          <div style={{ display: 'flex', gap: '10px' }}>
            <button
              onClick={() => { setSaveError(''); setStep('markCorners'); }}
              style={secondaryBtnStyle}
              disabled={saving}
            >
              Adjust corners
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !!nameError || !imageName.trim()}
              style={{
                ...primaryBtnStyle,
                flex: 1,
                opacity: (saving || !!nameError || !imageName.trim()) ? 0.5 : 1,
                cursor: (saving || !!nameError || !imageName.trim()) ? 'not-allowed' : 'pointer',
              }}
            >
              {saving ? 'Saving…' : 'Looks right — Save'}
            </button>
          </div>
          {saveError && (
            <div style={{ marginTop: '10px', padding: '10px', borderRadius: '8px', background: '#fef2f2', color: '#dc2626', fontSize: '13px' }}>
              {saveError}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
