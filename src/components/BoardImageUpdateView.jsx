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

// ─── Homography solver ──────────────────────────────────────────────────────
// Computes 3×3 homography matrix H that maps srcPts → dstPts.
// srcPts, dstPts: arrays of 4 [x, y] in order [TL, TR, BL, BR].
// Returns 9-element array [h0..h8] where h8 = 1.
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

// ─── CSS perspective transform from 4-corner mapping ─────────────────────────
// Computes a CSS matrix3d that maps an element's corners (0,0)→(w,0)→(0,h)→(w,h)
// to arbitrary destination points dst = [[x,y], ...] for [TL, TR, BL, BR].

function computePerspectiveCSS(w, h, dst) {
  const [dx0, dy0] = dst[0];
  const [dx1, dy1] = dst[1];
  const [dx2, dy2] = dst[2];
  const [dx3, dy3] = dst[3];

  // Solve 2×2 system for perspective params
  const a1 = (dx1 - dx3) * w, b1 = (dx2 - dx3) * h, c1 = dx3 - dx1 - dx2 + dx0;
  const a2 = (dy1 - dy3) * w, b2 = (dy2 - dy3) * h, c2 = dy3 - dy1 - dy2 + dy0;
  const det = a1 * b2 - a2 * b1;
  if (Math.abs(det) < 1e-10) return 'none';

  const g = (c1 * b2 - c2 * b1) / det;
  const hh = (a1 * c2 - a2 * c1) / det;
  const a = (dx1 - dx0) / w + dx1 * g;
  const d = (dy1 - dy0) / w + dy1 * g;
  const b = (dx2 - dx0) / h + dx2 * hh;
  const e = (dy2 - dy0) / h + dy2 * hh;

  // CSS matrix3d column-major
  return `matrix3d(${a},${d},0,${g}, ${b},${e},0,${hh}, 0,0,1,0, ${dx0},${dy0},0,1)`;
}

// ─── Align step component ─────────────────────────────────────────────────────
// phase: 'align' | 'trim'

function AlignStep({ croppedCanvas, currentImgSrc, phase, onAlignDone, onTrimDone, onSkip, onBack }) {
  const containerRef = useRef(null);
  const lastTouchTimeRef = useRef(0);

  // Old image natural dimensions
  const [oldImgSize, setOldImgSize] = useState(null); // { w, h }

  // Display scale: workspace-pixels per workspace-unit
  const [displayScale, setDisplayScale] = useState(1);

  // Foreground (new image) opacity (0–1)
  const [fgOpacity, setFgOpacity] = useState(0.7);

  // Pin positions in WORKSPACE units (not screen pixels)
  // Initialised once we know oldImgSize + croppedCanvas sizes
  const [pins, setPins] = useState(null);

  // Trim rect in workspace units: { x, y, w, h }
  const [trimRect, setTrimRect] = useState(null);

  // Drag state via ref (avoid stale closures)
  const dragRef = useRef(null);

  // ── Zoom state (pinch + wheel) — MUST be before early return ──────────────
  const [zoom, setZoom] = useState({ scale: 1, panX: 0, panY: 0 });
  const zoomRef = useRef({ scale: 1, panX: 0, panY: 0 });
  const pinchRef = useRef(null);

  // ── Loupe for trim phase — MUST be before early return ────────────────────
  const loupePosRef = useRef(null);
  const isTouchDragRef = useRef(false);
  const [showLoupe, setShowLoupe] = useState(false);

  // ── Load old image dimensions ──────────────────────────────────────────────
  useEffect(() => {
    if (!currentImgSrc) return;
    const img = new Image();
    img.onload = () => setOldImgSize({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = currentImgSrc;
  }, [currentImgSrc]);

  // ── Workspace geometry ─────────────────────────────────────────────────────
  // Workspace is 40% larger than old image (20% padding each side)
  const wsW = oldImgSize ? oldImgSize.w * 1.4 : 0;
  const wsH = oldImgSize ? oldImgSize.h * 1.4 : 0;

  // Old image offset within workspace (in workspace units)
  const oldOffX = oldImgSize ? oldImgSize.w * 0.2 : 0;
  const oldOffY = oldImgSize ? oldImgSize.h * 0.2 : 0;

  // Cropped image is centered over old image
  // In workspace units, the cropped image's TL corner:
  const cropOffX = oldImgSize
    ? oldOffX + (oldImgSize.w - croppedCanvas.width) / 2
    : 0;
  const cropOffY = oldImgSize
    ? oldOffY + (oldImgSize.h - croppedCanvas.height) / 2
    : 0;

  // ── Init pins once geometry is ready ──────────────────────────────────────
  useEffect(() => {
    if (!oldImgSize) return;
    const cw = croppedCanvas.width;
    const ch = croppedCanvas.height;
    // 4 corners of the cropped image in workspace units: [TL, TR, BL, BR]
    setPins([
      { x: cropOffX,      y: cropOffY },       // TL
      { x: cropOffX + cw, y: cropOffY },       // TR
      { x: cropOffX,      y: cropOffY + ch },  // BL
      { x: cropOffX + cw, y: cropOffY + ch },  // BR
    ]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oldImgSize]);

  // ── Init trim rect when entering trim phase ────────────────────────────────
  useEffect(() => {
    if (phase === 'trim' && oldImgSize) {
      setTrimRect({ x: oldOffX, y: oldOffY, w: oldImgSize.w, h: oldImgSize.h });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // ── Track display scale via ResizeObserver ─────────────────────────────────
  // Deps include pins so it re-runs when workspace first renders (guard passes)
  const workspaceVisible = oldImgSize !== null && pins !== null;
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !wsW) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      setDisplayScale(rect.width / wsW);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [wsW, workspaceVisible]);

  // ── Wheel zoom handler — MUST be before early return ──────────────────────
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

  // Wire up wheel event (passive: false needed to call preventDefault)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  // Reset zoom when switching phases
  useEffect(() => {
    const reset = { scale: 1, panX: 0, panY: 0 };
    setZoom(reset);
    zoomRef.current = reset;
  }, [phase]);

  // ── Drag handlers ──────────────────────────────────────────────────────────
  const startDrag = (e, pinIdx) => {
    if (e.touches) {
      lastTouchTimeRef.current = Date.now();
      e.stopPropagation();
      e.preventDefault();
      const t = e.touches[0];
      dragRef.current = {
        kind: 'pin', pinIdx,
        startClientX: t.clientX, startClientY: t.clientY,
        startPinX: pins[pinIdx].x, startPinY: pins[pinIdx].y,
      };
    } else {
      if (Date.now() - lastTouchTimeRef.current < 500) return;
      dragRef.current = {
        kind: 'pin', pinIdx,
        startClientX: e.clientX, startClientY: e.clientY,
        startPinX: pins[pinIdx].x, startPinY: pins[pinIdx].y,
      };
    }
  };

  const startTrimDrag = (e, type) => {
    if (e.touches) {
      lastTouchTimeRef.current = Date.now();
      e.stopPropagation();
      e.preventDefault();
      const t = e.touches[0];
      isTouchDragRef.current = true;
      setShowLoupe(true);
      dragRef.current = {
        kind: 'trim', type,
        startClientX: t.clientX, startClientY: t.clientY,
        startRect: { ...trimRect },
      };
    } else {
      if (Date.now() - lastTouchTimeRef.current < 500) return;
      isTouchDragRef.current = false;
      dragRef.current = {
        kind: 'trim', type,
        startClientX: e.clientX, startClientY: e.clientY,
        startRect: { ...trimRect },
      };
    }
  };

  const handleMove = useCallback((e) => {
    // Handle pinch zoom
    if (pinchRef.current && e.touches && e.touches.length >= 2) {
      e.preventDefault();
      const t0 = e.touches[0], t1 = e.touches[1];
      const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      const newMidX = (t0.clientX + t1.clientX) / 2;
      const newMidY = (t0.clientY + t1.clientY) / 2;

      const scaleRatio = dist / pinchRef.current.startDist;
      const newScale = Math.max(1, Math.min(5, pinchRef.current.startScale * scaleRatio));

      // Zoom centered on initial pinch midpoint
      const rect = containerRef.current.getBoundingClientRect();
      const cx = pinchRef.current.startMidX - rect.left;
      const cy = pinchRef.current.startMidY - rect.top;
      let panX = cx - (cx - pinchRef.current.startPanX) * (newScale / pinchRef.current.startScale);
      let panY = cy - (cy - pinchRef.current.startPanY) * (newScale / pinchRef.current.startScale);

      // Add pan from finger movement
      panX += (newMidX - pinchRef.current.startMidX);
      panY += (newMidY - pinchRef.current.startMidY);

      if (newScale <= 1.02) { panX = 0; panY = 0; }

      const newZoom = { scale: newScale <= 1.02 ? 1 : newScale, panX, panY };
      setZoom(newZoom);
      zoomRef.current = newZoom;
      return;
    }

    if (!dragRef.current) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;

    if (dragRef.current.kind === 'pin') {
      const dx = (clientX - dragRef.current.startClientX) / (displayScale * zoomRef.current.scale);
      const dy = (clientY - dragRef.current.startClientY) / (displayScale * zoomRef.current.scale);
      const idx = dragRef.current.pinIdx;
      setPins(prev => prev.map((p, i) =>
        i === idx ? { x: dragRef.current.startPinX + dx, y: dragRef.current.startPinY + dy } : p
      ));
    } else if (dragRef.current.kind === 'trim') {
      const dx = (clientX - dragRef.current.startClientX) / (displayScale * zoomRef.current.scale);
      const dy = (clientY - dragRef.current.startClientY) / (displayScale * zoomRef.current.scale);
      const sr = dragRef.current.startRect;
      let next;
      switch (dragRef.current.type) {
        case 'move': next = { x: sr.x + dx, y: sr.y + dy, w: sr.w, h: sr.h }; break;
        case 'tl': next = { x: sr.x + dx, y: sr.y + dy, w: sr.w - dx, h: sr.h - dy }; break;
        case 'tr': next = { x: sr.x, y: sr.y + dy, w: sr.w + dx, h: sr.h - dy }; break;
        case 'bl': next = { x: sr.x + dx, y: sr.y, w: sr.w - dx, h: sr.h + dy }; break;
        case 'br': next = { x: sr.x, y: sr.y, w: sr.w + dx, h: sr.h + dy }; break;
        default: return;
      }
      setTrimRect({
        x: Math.max(0, next.x), y: Math.max(0, next.y),
        w: Math.max(10, Math.min(next.w, wsW)), h: Math.max(10, Math.min(next.h, wsH)),
      });
      if (isTouchDragRef.current) {
        loupePosRef.current = { clientX, clientY };
      }
    } else if (dragRef.current.kind === 'pan') {
      const panX = dragRef.current.startPanX + (clientX - dragRef.current.startClientX);
      const panY = dragRef.current.startPanY + (clientY - dragRef.current.startClientY);
      const newZoom = { scale: zoomRef.current.scale, panX, panY };
      setZoom(newZoom);
      zoomRef.current = newZoom;
    }
  }, [displayScale, wsW, wsH]);

  const handleEnd = useCallback((e) => {
    if (pinchRef.current) {
      const remaining = e && e.touches ? e.touches.length : 0;
      if (remaining < 2) {
        pinchRef.current = null;
        // Snap to 1 if close
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

  // Memoize cropped image src — MUST be before early return (rules of hooks)
  const croppedSrc = useMemo(() => croppedCanvas.toDataURL('image/jpeg', 0.85), [croppedCanvas]);

  // ── Apply final warp and advance (align phase) ─────────────────────────────
  const handleAlignNext = () => {
    onAlignDone();
  };

  // ── Apply warp + crop (trim phase) ────────────────────────────────────────
  const handleTrimNext = () => {
    if (!pins || !trimRect) return;
    const cw = croppedCanvas.width;
    const ch = croppedCanvas.height;
    // Source quad = the 4 corners of the original cropped image [TL, TR, BL, BR]
    const srcQuad = [[0, 0], [cw, 0], [0, ch], [cw, ch]];
    // Dest quad = where those corners should land in the output (pin positions relative to trim rect)
    const dstQuad = pins.map(p => [p.x - trimRect.x, p.y - trimRect.y]);
    const outW = Math.round(trimRect.w);
    const outH = Math.round(trimRect.h);
    const warped = perspectiveWarp(croppedCanvas, srcQuad, dstQuad, outW, outH);
    onTrimDone(warped);
  };

  // ── Nothing to show until old image loads ─────────────────────────────────
  if (!oldImgSize || !pins) {
    return (
      <div style={{ textAlign: 'center', padding: '40px 0', color: 'rgba(26,10,0,0.5)', fontSize: '14px' }}>
        Loading…
      </div>
    );
  }

  const PIN_RADIUS = 10; // visual radius (px on screen)
  const PIN_HIT = 22;    // half of 44px hit target

  return (
    <div>
      <p style={{ margin: '0 0 12px', fontSize: '13px', color: 'rgba(26,10,0,0.6)', lineHeight: 1.5 }}>
        {phase === 'align'
          ? 'Drag the corner pins to align the new image with the current board image underneath.'
          : 'Adjust the crop rectangle to frame the board area, then tap Next.'
        }
      </p>

      {/* Workspace */}
      <div
        ref={containerRef}
        onTouchStart={(e) => {
          if (e.touches.length >= 2) {
            // Cancel any active single-finger drag, switch to pinch mode
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
            // Single finger on empty space while zoomed → start pan
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
          background: '#FFAB94',
        }}
      >
        {/* Inner wrapper — zoom + pan applied here */}
        <div style={{
          transformOrigin: '0 0',
          transform: `translate(${zoom.panX}px, ${zoom.panY}px) scale(${zoom.scale})`,
          width: '100%',
          position: 'relative',
        }}>
          {/* Aspect-ratio spacer */}
          <div style={{ paddingBottom: `${(wsH / wsW) * 100}%` }} />

          {/* Old image — background layer (hidden in trim phase) */}
          {phase === 'align' && (
            <img
              src={currentImgSrc}
              alt="Current board"
              draggable={false}
              style={{
                position: 'absolute',
                left: `${(oldOffX / wsW) * 100}%`,
                top: `${(oldOffY / wsH) * 100}%`,
                width: `${(oldImgSize.w / wsW) * 100}%`,
                pointerEvents: 'none',
              }}
            />
          )}

          {/* New image overlay — CSS matrix3d makes corners follow pins */}
          <img
            src={croppedSrc}
            alt="New board"
            draggable={false}
            style={{
              position: 'absolute',
              left: `${(cropOffX / wsW) * 100}%`,
              top: `${(cropOffY / wsH) * 100}%`,
              width: `${(croppedCanvas.width / wsW) * 100}%`,
              opacity: phase === 'trim' ? 1 : fgOpacity,
              pointerEvents: 'none',
              transformOrigin: '0 0',
              transform: computePerspectiveCSS(
                croppedCanvas.width * displayScale,
                croppedCanvas.height * displayScale,
                pins.map(p => [
                  (p.x - cropOffX) * displayScale,
                  (p.y - cropOffY) * displayScale,
                ])
              ),
            }}
          />

          {/* Corner pins — only in align phase */}
          {phase === 'align' && pins.map((pin, idx) => {
            const screenX = pin.x * displayScale;
            const screenY = pin.y * displayScale;
            return (
              <div
                key={idx}
                onMouseDown={(e) => { e.stopPropagation(); startDrag(e, idx); }}
                onTouchStart={(e) => { e.stopPropagation(); startDrag(e, idx); }}
                style={{
                  position: 'absolute',
                  left: screenX - PIN_HIT,
                  top: screenY - PIN_HIT,
                  width: PIN_HIT * 2,
                  height: PIN_HIT * 2,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'grab',
                  touchAction: 'none',
                }}
              >
                <div style={{
                  width: PIN_RADIUS * 2,
                  height: PIN_RADIUS * 2,
                  borderRadius: '50%',
                  background: '#0047FF',
                  border: '2px solid white',
                  boxShadow: '0 2px 6px rgba(0,0,0,0.5)',
                }} />
              </div>
            );
          })}

          {/* Trim crop rect — only in trim phase */}
          {phase === 'trim' && trimRect && (() => {
            const tx = trimRect.x * displayScale;
            const ty = trimRect.y * displayScale;
            const tw = trimRect.w * displayScale;
            const th = trimRect.h * displayScale;
            const totalW = wsW * displayScale;
            const totalH = wsH * displayScale;
            const HANDLE_SIZE = 22;

            const corners = [
              { key: 'tl', cx: tx, cy: ty },
              { key: 'tr', cx: tx + tw, cy: ty },
              { key: 'bl', cx: tx, cy: ty + th },
              { key: 'br', cx: tx + tw, cy: ty + th },
            ];

            return (
              <>
                {/* Dim overlay around crop rect */}
                <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
                  viewBox={`0 0 ${totalW} ${totalH}`} preserveAspectRatio="none">
                  <rect x={0} y={0} width={totalW} height={ty} fill="rgba(0,0,0,0.5)" />
                  <rect x={0} y={ty + th} width={totalW} height={totalH - ty - th} fill="rgba(0,0,0,0.5)" />
                  <rect x={0} y={ty} width={tx} height={th} fill="rgba(0,0,0,0.5)" />
                  <rect x={tx + tw} y={ty} width={totalW - tx - tw} height={th} fill="rgba(0,0,0,0.5)" />
                  <rect x={tx} y={ty} width={tw} height={th} fill="none" stroke="white" strokeWidth="2" />
                </svg>

                {/* Draggable crop body */}
                <div
                  onMouseDown={(e) => startTrimDrag(e, 'move')}
                  onTouchStart={(e) => startTrimDrag(e, 'move')}
                  style={{
                    position: 'absolute', left: tx, top: ty, width: tw, height: th,
                    cursor: 'move', touchAction: 'none',
                  }}
                />

                {/* Corner handles */}
                {corners.map(({ key, cx, cy }) => (
                  <div
                    key={key}
                    onMouseDown={(e) => { e.stopPropagation(); startTrimDrag(e, key); }}
                    onTouchStart={(e) => { e.stopPropagation(); startTrimDrag(e, key); }}
                    style={{
                      position: 'absolute', left: cx - HANDLE_SIZE, top: cy - HANDLE_SIZE,
                      width: HANDLE_SIZE * 2, height: HANDLE_SIZE * 2,
                      cursor: key === 'tl' || key === 'br' ? 'nwse-resize' : 'nesw-resize',
                      touchAction: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}
                  >
                    <div style={{
                      width: 16, height: 16, borderRadius: '50%',
                      background: 'white', boxShadow: '0 1px 4px rgba(0,0,0,0.4)',
                      border: '2px solid #0047FF',
                    }} />
                  </div>
                ))}
              </>
            );
          })()}
        </div>{/* end inner zoom wrapper */}
      </div>

      {/* Loupe for trim phase — with crosshair + crop dim overlay */}
      {phase === 'trim' && showLoupe && dragRef.current && dragRef.current.kind === 'trim' && dragRef.current.type !== 'move' && loupePosRef.current && (() => {
        const LOUPE_W = 180;
        const LOUPE_H = 120;
        const LOUPE_RADIUS = 60;
        const MAGNIFICATION = 3;
        const OFFSET_ABOVE = 80;

        const { clientX, clientY } = loupePosRef.current;
        const tr = trimRect;
        if (!tr) return null;

        // Handle position in workspace coords
        let handleWsX, handleWsY;
        switch (dragRef.current.type) {
          case 'tl': handleWsX = tr.x; handleWsY = tr.y; break;
          case 'tr': handleWsX = tr.x + tr.w; handleWsY = tr.y; break;
          case 'bl': handleWsX = tr.x; handleWsY = tr.y + tr.h; break;
          case 'br': handleWsX = tr.x + tr.w; handleWsY = tr.y + tr.h; break;
          default: return null;
        }

        // Convert handle to old-image fraction coords for the loupe image
        const oldImgFracX = (handleWsX - oldOffX) / oldImgSize.w;
        const oldImgFracY = (handleWsY - oldOffY) / oldImgSize.h;

        const magW = LOUPE_W * MAGNIFICATION;
        const magH = magW * (oldImgSize.h / oldImgSize.w);
        const imgLeft = -(oldImgFracX * magW) + LOUPE_W / 2;
        const imgTop = -(oldImgFracY * magH) + LOUPE_H / 2;

        // Crop boundary in loupe coords (trim rect maps to old-image coords)
        const imgPixelScale = magW / oldImgSize.w;
        // Handle in old-image coords
        const handleOldX = handleWsX - oldOffX;
        const handleOldY = handleWsY - oldOffY;
        const cL = (tr.x - oldOffX - handleOldX) * imgPixelScale + LOUPE_W / 2;
        const cT = (tr.y - oldOffY - handleOldY) * imgPixelScale + LOUPE_H / 2;
        const cR = (tr.x + tr.w - oldOffX - handleOldX) * imgPixelScale + LOUPE_W / 2;
        const cB = (tr.y + tr.h - oldOffY - handleOldY) * imgPixelScale + LOUPE_H / 2;

        const clamp = (v, min, max) => Math.max(min, Math.min(v, max));
        const loupeLeft = clamp(clientX - LOUPE_W / 2, 4, window.innerWidth - LOUPE_W - 4);
        const loupeTop = clamp(clientY - OFFSET_ABOVE - LOUPE_H, 4, clientY - OFFSET_ABOVE);

        return (
          <div key="trim-loupe" style={{
            position: 'fixed', left: loupeLeft, top: loupeTop,
            width: LOUPE_W, height: LOUPE_H,
            borderRadius: `${LOUPE_RADIUS}px`,
            border: '2px solid rgba(255,255,255,0.9)',
            boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
            overflow: 'hidden', pointerEvents: 'none', zIndex: 300,
            background: '#1a0a00',
          }}>
            <img src={currentImgSrc} alt="" draggable={false}
              style={{ position: 'absolute', width: magW, height: magH, left: imgLeft, top: imgTop, pointerEvents: 'none' }}
            />
            <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
              <defs>
                <mask id="trimLoupeMask">
                  <rect width={LOUPE_W} height={LOUPE_H} fill="white" />
                  <rect x={cL} y={cT} width={cR - cL} height={cB - cT} fill="black" />
                </mask>
              </defs>
              <rect width={LOUPE_W} height={LOUPE_H} fill="rgba(0,0,0,0.45)" mask="url(#trimLoupeMask)" />
              <line x1={LOUPE_W/2 - 12} y1={LOUPE_H/2} x2={LOUPE_W/2 + 12} y2={LOUPE_H/2}
                stroke="white" strokeWidth="1.5" strokeOpacity="0.9" />
              <line x1={LOUPE_W/2} y1={LOUPE_H/2 - 12} x2={LOUPE_W/2} y2={LOUPE_H/2 + 12}
                stroke="white" strokeWidth="1.5" strokeOpacity="0.9" />
            </svg>
          </div>
        );
      })()}

      {/* Background opacity slider — only in align phase */}
      {phase === 'align' && (
        <div style={{ marginTop: '14px' }}>
          <label style={{
            display: 'block',
            marginBottom: '5px',
            fontSize: '11px',
            fontWeight: 700,
            letterSpacing: '1px',
            textTransform: 'uppercase',
            color: 'rgba(26,10,0,0.55)',
            fontFamily: 'Space Mono, monospace',
          }}>
            New image opacity — {Math.round(fgOpacity * 100)}%
          </label>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(fgOpacity * 100)}
            onChange={(e) => setFgOpacity(Number(e.target.value) / 100)}
            style={{ width: '100%', accentColor: '#0047FF' }}
          />
        </div>
      )}

      {/* Buttons */}
      <div style={{ display: 'flex', gap: '10px', marginTop: '16px' }}>
        <button onClick={onBack} style={secondaryBtnStyle}>← Back</button>
        {phase === 'align' && (
          <button onClick={onSkip} style={secondaryBtnStyle}>Skip</button>
        )}
        <button
          onClick={phase === 'align' ? handleAlignNext : handleTrimNext}
          style={{ ...primaryBtnStyle, flex: 1 }}
        >
          Next →
        </button>
      </div>

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

export default function BoardImageUpdateView({ currentImgSrc, currentImageName, onSave, onCancel }) {
  const [step, setStep] = useState('upload'); // 'upload' | 'crop' | 'align' | 'trim' | 'confirm'

  // Upload step state
  const [uploadedDataUrl, setUploadedDataUrl] = useState(null);
  const [uploadedWidth, setUploadedWidth] = useState(0);
  const [uploadedHeight, setUploadedHeight] = useState(0);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);

  // Crop → Align: original crop preserved so align can re-read it on "back"
  const [originalCropCanvas, setOriginalCropCanvas] = useState(null);

  // Final canvas for confirm/save (set by trim step, or by skip)
  const [croppedCanvas, setCroppedCanvas] = useState(null);

  // Confirm step state
  const [imageName, setImageName] = useState(() => autoIncrementName(currentImageName || 'Barn_Set_01_V5'));
  const [nameError, setNameError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const stepLabels = {
    upload: 'Step 1 of 5 — Upload', crop: 'Step 2 of 5 — Crop', align: 'Step 3 of 5 — Align',
    trim: 'Step 4 of 5 — Trim', confirm: 'Step 5 of 5 — Confirm',
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
      await onSave({ imageName: imageName.trim(), imageBlobs: { full, w2000, w1200, w800 } });
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
          onNext={(canvas) => { setOriginalCropCanvas(canvas); setStep('align'); }}
          onBack={() => setStep('upload')}
        />
      )}

      {/* ── Steps 3-4: Align + Trim — kept mounted through confirm for "Back" state preservation ── */}
      {(step === 'align' || step === 'trim' || step === 'confirm') && originalCropCanvas && (
        <div style={{ display: step === 'confirm' ? 'none' : undefined }}>
          <AlignStep
            croppedCanvas={originalCropCanvas}
            currentImgSrc={currentImgSrc}
            phase={step === 'confirm' ? 'trim' : step}
            onAlignDone={() => setStep('trim')}
            onTrimDone={(canvas) => { setCroppedCanvas(canvas); setStep('confirm'); }}
            onSkip={() => { setCroppedCanvas(originalCropCanvas); setStep('confirm'); }}
            onBack={() => setStep(step === 'trim' ? 'align' : 'crop')}
          />
        </div>
      )}

      {/* ── Step 5: Confirm ── */}
      {step === 'confirm' && croppedCanvas && (
        <div>
          {/* Full-width preview of new image */}
          <div style={{ marginBottom: '16px' }}>
            <div style={{
              fontSize: '10px', fontWeight: 700, letterSpacing: '1px',
              textTransform: 'uppercase', color: '#0047FF', marginBottom: '6px',
              textAlign: 'center', fontFamily: 'Space Mono, monospace',
            }}>
              New Board Image
            </div>
            <img
              src={croppedCanvas.toDataURL('image/jpeg', JPEG_QUALITY)}
              alt="New board preview"
              style={{
                width: '100%', borderRadius: '10px', display: 'block',
                border: '2px solid #0047FF',
              }}
            />
          </div>

          {/* Small current image for reference */}
          <div style={{ marginBottom: '16px' }}>
            <div style={{
              fontSize: '10px', fontWeight: 700, letterSpacing: '1px',
              textTransform: 'uppercase', color: 'rgba(26,10,0,0.45)', marginBottom: '6px',
              textAlign: 'center', fontFamily: 'Space Mono, monospace',
            }}>
              Current Image (for reference)
            </div>
            <img
              src={currentImgSrc}
              alt="Current board"
              style={{
                width: '60%', borderRadius: '8px', display: 'block',
                border: '1px solid rgba(26,10,0,0.12)', margin: '0 auto',
              }}
            />
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
            <button onClick={() => { setStep('trim'); setSaveError(''); }} style={secondaryBtnStyle} disabled={saving}>
              ← Adjust
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
              {saving ? 'Saving…' : 'Save & Apply'}
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
