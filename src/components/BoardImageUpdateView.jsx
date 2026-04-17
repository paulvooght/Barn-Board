import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import holdsData from '../data/holds.json';

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

// ─── Perspective warp helpers ─────────────────────────────────────────────────
// computeHomography: builds a 3×3 projective transform from 4 point pairs.
// Usage: dx = (h0*sx + h1*sy + h2) / (h6*sx + h7*sy + 1)
//        dy = (h3*sx + h4*sy + h5) / (h6*sx + h7*sy + 1)

function computeHomography(srcPts, dstPts) {
  // Build 8×8 system: for each point pair (src[i] → dst[i]):
  //   sx*h0 + sy*h1 + h2 - sx*dx*h6 - sy*dx*h7 = dx
  //   sx*h3 + sy*h4 + h5 - sx*dy*h6 - sy*dy*h7 = dy
  const n = 8;
  const M = [];
  for (let i = 0; i < 4; i++) {
    const [sx, sy] = srcPts[i];
    const [dx, dy] = dstPts[i];
    M.push([sx, sy, 1, 0, 0, 0, -sx * dx, -sy * dx, dx]);
    M.push([0, 0, 0, sx, sy, 1, -sx * dy, -sy * dy, dy]);
  }

  // Gaussian elimination with partial pivoting
  for (let col = 0; col < n; col++) {
    let maxVal = 0, maxRow = col;
    for (let row = col; row < n; row++) {
      if (Math.abs(M[row][col]) > maxVal) {
        maxVal = Math.abs(M[row][col]);
        maxRow = row;
      }
    }
    [M[col], M[maxRow]] = [M[maxRow], M[col]];

    const pivot = M[col][col];
    if (Math.abs(pivot) < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1]; // identity fallback

    for (let j = col; j <= n; j++) M[col][j] /= pivot;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = M[row][col];
      for (let j = col; j <= n; j++) M[row][j] -= factor * M[col][j];
    }
  }

  const h = M.map(row => row[n]);
  return [...h, 1]; // [h0, h1, h2, h3, h4, h5, h6, h7, 1]
}

// ─── Perspective warp helper (pixel-by-pixel homography) ─────────────────────
// srcQuad / dstQuad: arrays of 4 [x, y] points [TL, TR, BL, BR].
// For each output pixel, computes the inverse homography to find the source
// pixel, then samples with bilinear interpolation. No triangle mesh artifacts.

function perspectiveWarp(sourceCanvas, srcQuad, dstQuad, outW, outH) {
  const W = outW || sourceCanvas.width;
  const H = outH || sourceCanvas.height;
  const sw = sourceCanvas.width;
  const sh = sourceCanvas.height;

  // Get source pixel data
  const srcCtx = sourceCanvas.getContext('2d');
  const srcData = srcCtx.getImageData(0, 0, sw, sh);
  const src = srcData.data;

  // Create output canvas
  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const outCtx = out.getContext('2d');
  const outImgData = outCtx.createImageData(W, H);
  const dst = outImgData.data;

  // Compute inverse homography: maps output coords → source coords
  const Hi = computeHomography(dstQuad, srcQuad);

  for (let dy = 0; dy < H; dy++) {
    for (let dx = 0; dx < W; dx++) {
      // Apply inverse homography to get source position
      const w = Hi[6] * dx + Hi[7] * dy + Hi[8];
      if (Math.abs(w) < 1e-10) continue;
      const sx = (Hi[0] * dx + Hi[1] * dy + Hi[2]) / w;
      const sy = (Hi[3] * dx + Hi[4] * dy + Hi[5]) / w;

      // Skip pixels far outside source bounds
      if (sx < -1 || sx > sw || sy < -1 || sy > sh) continue;

      // Clamp to source bounds for edge pixels (prevents black edges)
      const sxc = Math.max(0, Math.min(sx, sw - 1.001));
      const syc = Math.max(0, Math.min(sy, sh - 1.001));

      // Bilinear interpolation
      const x0 = Math.floor(sxc);
      const y0 = Math.floor(syc);
      const x1 = Math.min(x0 + 1, sw - 1);
      const y1 = Math.min(y0 + 1, sh - 1);
      const fx = sxc - x0;
      const fy = syc - y0;

      const idx00 = (y0 * sw + x0) * 4;
      const idx10 = (y0 * sw + x1) * 4;
      const idx01 = (y1 * sw + x0) * 4;
      const idx11 = (y1 * sw + x1) * 4;
      const outIdx = (dy * W + dx) * 4;

      for (let c = 0; c < 4; c++) {
        dst[outIdx + c] = Math.round(
          (1 - fx) * (1 - fy) * src[idx00 + c] +
          fx * (1 - fy) * src[idx10 + c] +
          (1 - fx) * fy * src[idx01 + c] +
          fx * fy * src[idx11 + c]
        );
      }
    }
  }

  outCtx.putImageData(outImgData, 0, 0);
  return out;
}

// ─── Mark Corners step component ─────────────────────────────────────────────
// User drags 4 free-moving pins to the physical board corners (any quad shape).
// Props:
//   croppedCanvas  — HTMLCanvasElement
//   initialQuad    — null | { tl, tr, br, bl } where each is {x, y} in canvas px
//   onDone(quad)   — called with { tl, tr, br, bl } in canvas px
//   onBack()

function MarkCornersStep({ croppedCanvas, initialQuad, onDone, onBack }) {
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

  // ── Pin state — all 4 pins stored independently ───────────────────────────
  // Defaults: 10%/90% of cropped canvas dimensions — user drags to actual corners
  const defaultQuad = useCallback(() => ({
    tl: { x: imgW * 0.10, y: imgH * 0.10 },
    tr: { x: imgW * 0.90, y: imgH * 0.10 },
    br: { x: imgW * 0.90, y: imgH * 0.90 },
    bl: { x: imgW * 0.10, y: imgH * 0.90 },
  }), [imgW, imgH]);

  const [pins, setPins] = useState(() => initialQuad ?? defaultQuad());

  // Refs so event handlers see current values without stale closures
  const pinsRef = useRef(pins);
  useEffect(() => { pinsRef.current = pins; }, [pins]);

  // ── Drag state ────────────────────────────────────────────────────────────
  // kind: 'tl' | 'tr' | 'br' | 'bl' | 'pan'
  const dragRef = useRef(null); // { kind, startClientX, startClientY, startPin, touchId? }

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

  // ── Clamp helper ──────────────────────────────────────────────────────────
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
        startPin: { ...pinsRef.current[kind] },
        touchId: t.identifier,
      };
    } else {
      if (Date.now() - lastTouchTimeRef.current < 500) return;
      isTouchDragRef.current = false;
      dragRef.current = {
        kind,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startPin: { ...pinsRef.current[kind] },
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
    const sp = dragRef.current.startPin;
    const kind = dragRef.current.kind;

    const newPos = clampPin(sp.x + dx, sp.y + dy);

    setPins(prev => ({ ...prev, [kind]: newPos }));

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
    onDone(pins);
  };

  // ── Render ────────────────────────────────────────────────────────────────
  const PIN_RADIUS = 10;  // visual radius in SVG units (canvas pixels)
  const PIN_HIT = 22;     // half of 44px touch hit target

  const PIN_DEFS = [
    { key: 'tl', label: 'TL' },
    { key: 'tr', label: 'TR' },
    { key: 'br', label: 'BR' },
    { key: 'bl', label: 'BL' },
  ];

  // Dashed quad outline: TL → TR → BR → BL → TL
  const quadPoints = [
    pins.tl, pins.tr, pins.br, pins.bl, pins.tl,
  ].map(p => `${p.x},${p.y}`).join(' ');

  return (
    <div>
      <p style={{ margin: '0 0 12px', fontSize: '13px', color: 'rgba(26,10,0,0.6)', lineHeight: 1.5 }}>
        Drag the 4 pins to the 4 physical corners of the climbing board (TL, TR, BL, BR).
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

          {/* SVG overlay — quad outline, pins, labels */}
          <svg
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible' }}
            viewBox={`0 0 ${imgW} ${imgH}`}
            preserveAspectRatio="none"
          >
            {/* Dashed polygon outline connecting the 4 pins */}
            <polyline
              points={quadPoints}
              fill="none"
              stroke="rgba(255,255,255,0.8)"
              strokeWidth={2}
              strokeDasharray="8 5"
              pointerEvents="none"
            />

            {/* Pins */}
            {PIN_DEFS.map(({ key, label }) => {
              const pos = pins[key];
              // Label positioning: offset away from corner
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
        const pinPos = pinsRef.current[pinKey];
        if (!pinPos) return null;
        const pinCanvasX = pinPos.x;
        const pinCanvasY = pinPos.y;

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

// ─── Confirm step component ───────────────────────────────────────────────────
// Warps the cropped canvas so that the user's quad maps to the fixed boardRegion,
// shows the result with hold overlay, and provides Save / Adjust corners buttons.

function ConfirmStep({ croppedCanvas, quad, currentImageUrl, holds, imageName, nameError, saving, saveError, onNameChange, onSave, onAdjust }) {
  const [warpedCanvas, setWarpedCanvas] = useState(null);
  const [warping, setWarping] = useState(true);

  // Load old image to get natural dimensions, then compute warp
  useEffect(() => {
    setWarping(true);
    setWarpedCanvas(null);

    const br = holdsData.boardRegion;

    const doWarp = (oldImgW, oldImgH) => {
      // Source quad: user's pin positions in cropped canvas coords [TL, TR, BL, BR]
      const srcQuad = [
        [quad.tl.x, quad.tl.y],
        [quad.tr.x, quad.tr.y],
        [quad.bl.x, quad.bl.y],
        [quad.br.x, quad.br.y],
      ];

      // Destination quad: boardRegion corners in old image pixel coordinates [TL, TR, BL, BR]
      const dL = (br.left / 100) * oldImgW;
      const dT = (br.top / 100) * oldImgH;
      const dR = ((br.left + br.width) / 100) * oldImgW;
      const dB = ((br.top + br.height) / 100) * oldImgH;
      const dstQuad = [
        [dL, dT],
        [dR, dT],
        [dL, dB],
        [dR, dB],
      ];

      // Yield to let spinner paint, then run synchronous warp
      setTimeout(() => {
        try {
          const result = perspectiveWarp(croppedCanvas, srcQuad, dstQuad, oldImgW, oldImgH);
          setWarpedCanvas(result);
        } finally {
          setWarping(false);
        }
      }, 0);
    };

    // Load old image to get its natural dimensions
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => doWarp(img.naturalWidth, img.naturalHeight);
    img.onerror = () => {
      // Fallback: use cropped canvas dimensions (warp will be approximate)
      console.warn('[ConfirmStep] Could not load old image for dimensions, using cropped canvas size as fallback');
      doWarp(croppedCanvas.width, croppedCanvas.height);
    };
    img.src = currentImageUrl;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [croppedCanvas, quad, currentImageUrl]);

  // Memoize data URL to avoid re-calling toDataURL on every render
  const warpedSrc = useMemo(
    () => warpedCanvas ? warpedCanvas.toDataURL('image/jpeg', JPEG_QUALITY) : null,
    [warpedCanvas]
  );

  const br = holdsData.boardRegion;

  return (
    <div>
      {/* Warped image preview with hold overlay */}
      <div style={{ marginBottom: '16px' }}>
        <div style={{
          fontSize: '10px', fontWeight: 700, letterSpacing: '1px',
          textTransform: 'uppercase', color: '#0047FF', marginBottom: '6px',
          textAlign: 'center', fontFamily: 'Space Mono, monospace',
        }}>
          Warped Board Image — Check hold positions
        </div>

        <div style={{ position: 'relative', width: '100%' }}>
          {warping ? (
            <div style={{
              width: '100%',
              paddingBottom: '75%', // approximate aspect ratio placeholder
              background: 'rgba(26,10,0,0.06)',
              borderRadius: '10px',
              border: '2px solid #0047FF',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              position: 'relative',
            }}>
              <div style={{
                position: 'absolute', inset: 0,
                display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center',
                gap: '10px',
              }}>
                <div style={{
                  width: 32, height: 32,
                  border: '3px solid rgba(0,71,255,0.2)',
                  borderTopColor: '#0047FF',
                  borderRadius: '50%',
                  animation: 'spin 0.8s linear infinite',
                }} />
                <span style={{
                  fontSize: '12px', fontWeight: 600,
                  color: 'rgba(26,10,0,0.5)',
                  fontFamily: 'Space Mono, monospace',
                }}>
                  Warping image…
                </span>
              </div>
            </div>
          ) : warpedSrc ? (
            <>
              <img
                src={warpedSrc}
                alt="Warped board preview"
                style={{
                  width: '100%', borderRadius: '10px', display: 'block',
                  border: '2px solid #0047FF',
                }}
              />
              {/* Hold overlay SVG — uses holdsData.boardRegion and warped canvas dimensions */}
              {holds && holds.length > 0 && warpedCanvas && (
                <svg
                  style={{
                    position: 'absolute', inset: 0,
                    width: '100%', height: '100%',
                    borderRadius: '10px',
                    pointerEvents: 'none',
                  }}
                  viewBox={`0 0 ${warpedCanvas.width} ${warpedCanvas.height}`}
                  preserveAspectRatio="none"
                >
                  {holds.map((hold) => {
                    const imgW = warpedCanvas.width;
                    const imgH = warpedCanvas.height;
                    const bLeft = imgW * br.left / 100;
                    const bTop  = imgH * br.top / 100;
                    const bW    = imgW * br.width / 100;
                    const bH    = imgH * br.height / 100;
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
            </>
          ) : null}
        </div>
        <div style={{
          marginTop: '5px', fontSize: '11px', color: 'rgba(26,10,0,0.5)',
          textAlign: 'center', fontFamily: 'Space Mono, monospace',
        }}>
          {warping ? 'Computing perspective warp…' : `${holds?.length ?? 0} holds overlaid — check they line up with the physical holds`}
        </div>
      </div>

      {/* Spinner keyframes (injected once via style tag) */}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

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
            onChange={onNameChange}
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
          onClick={onAdjust}
          style={secondaryBtnStyle}
          disabled={saving || warping}
        >
          Adjust corners
        </button>
        <button
          onClick={() => onSave(warpedCanvas)}
          disabled={saving || warping || !!nameError || !imageName.trim() || !warpedCanvas}
          style={{
            ...primaryBtnStyle,
            flex: 1,
            opacity: (saving || warping || !!nameError || !imageName.trim() || !warpedCanvas) ? 0.5 : 1,
            cursor: (saving || warping || !!nameError || !imageName.trim() || !warpedCanvas) ? 'not-allowed' : 'pointer',
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

export default function BoardImageUpdateView({ currentImgSrc, currentImageName, currentImageUrl, holds, onSave, onCancel }) {
  const [step, setStep] = useState('upload'); // 'upload' | 'crop' | 'markCorners' | 'confirm'

  // Upload step state
  const [uploadedDataUrl, setUploadedDataUrl] = useState(null);
  const [uploadedWidth, setUploadedWidth] = useState(0);
  const [uploadedHeight, setUploadedHeight] = useState(0);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);

  // Crop canvas (set after crop step)
  const [croppedCanvas, setCroppedCanvas] = useState(null);

  // Quad set by MarkCornersStep — persisted so "Adjust corners" re-enters with last pins
  // { tl, tr, br, bl } each {x, y} in cropped canvas pixel coords
  const [pendingQuad, setPendingQuad] = useState(null);

  // Confirm step state
  const [imageName, setImageName] = useState(() => autoIncrementName(currentImageName || 'Barn_Set_01_V5'));
  const [nameError, setNameError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

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

  // Called by ConfirmStep with the warped canvas
  const handleSave = async (warpedCanvas) => {
    const err = validateName(imageName);
    if (err) { setNameError(err); return; }
    setSaving(true);
    setSaveError('');
    try {
      const full = await canvasToBlob(warpedCanvas, JPEG_QUALITY);
      const w2000 = await resizeToBlob(warpedCanvas, 2000, JPEG_QUALITY);
      const w1200 = await resizeToBlob(warpedCanvas, 1200, JPEG_QUALITY);
      const w800 = await resizeToBlob(warpedCanvas, 800, JPEG_QUALITY);
      await onSave({
        imageName: imageName.trim(),
        imageBlobs: { full, w2000, w1200, w800 },
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
          initialQuad={pendingQuad}
          onDone={(quad) => { setPendingQuad(quad); setStep('confirm'); }}
          onBack={() => setStep('crop')}
        />
      )}

      {/* ── Step 4: Confirm ── */}
      {step === 'confirm' && croppedCanvas && pendingQuad && (
        <ConfirmStep
          croppedCanvas={croppedCanvas}
          quad={pendingQuad}
          currentImageUrl={currentImageUrl}
          holds={holds}
          imageName={imageName}
          nameError={nameError}
          saving={saving}
          saveError={saveError}
          onNameChange={handleNameChange}
          onSave={handleSave}
          onAdjust={() => { setSaveError(''); setStep('markCorners'); }}
        />
      )}
    </div>
  );
}
