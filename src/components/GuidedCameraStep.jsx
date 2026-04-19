import { useEffect, useRef, useState } from 'react';
import holdsData from '../data/holds.json';

// ─── Anchor hold selection ────────────────────────────────────────────────────
// Divide the board area into a 4×3 grid (columns × rows).
// For each cell, pick the hold with the largest area (w_pct × h_pct).
// Returns up to 12 holds (fewer if some cells are empty).

function selectAnchorHolds(holds) {
  const COLS = 4;
  const ROWS = 3;
  const cellW = 100 / COLS;
  const cellH = 100 / ROWS;

  const cells = Array.from({ length: COLS * ROWS }, () => null);

  for (const hold of holds) {
    if (hold.hidden) continue;
    const col = Math.min(Math.floor(hold.cx / cellW), COLS - 1);
    const row = Math.min(Math.floor(hold.cy / cellH), ROWS - 1);
    const idx = row * COLS + col;
    const area = (hold.w_pct ?? hold.r * 2) * (hold.h_pct ?? hold.r * 2);
    const existing = cells[idx];
    const existingArea = existing
      ? (existing.w_pct ?? existing.r * 2) * (existing.h_pct ?? existing.r * 2)
      : -1;
    if (!existing || area > existingArea) {
      cells[idx] = hold;
    }
  }

  return cells.filter(Boolean);
}

const ANCHOR_HOLDS = selectAnchorHolds(holdsData.holds);
const BOARD_REGION = holdsData.boardRegion; // { left, top, width, height } as %

// ─── Board outline + hold overlay (SVG) ──────────────────────────────────────
// viewBox is 100×100 (unitless) for simplicity — positions are already %.

function GuideOverlay({ isPortrait }) {
  if (!isPortrait) return null;

  // Board rect in viewBox units (0-100)
  const bLeft = BOARD_REGION.left;
  const bTop = BOARD_REGION.top;
  const bW = BOARD_REGION.width;
  const bH = BOARD_REGION.height;

  // Convert a hold's board-area % to viewBox %
  const toVX = (x_pct) => bLeft + (x_pct / 100) * bW;
  const toVY = (y_pct) => bTop + (y_pct / 100) * bH;

  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
      }}
    >
      {/* Board outline rectangle */}
      <rect
        x={bLeft}
        y={bTop}
        width={bW}
        height={bH}
        fill="rgba(255,107,53,0.08)"
        stroke="#FF6B35"
        strokeWidth="0.4"
        rx="0.2"
        strokeDasharray="1.2 0.6"
      />

      {/* Corner tick marks for easier alignment */}
      {[
        [bLeft, bTop],
        [bLeft + bW, bTop],
        [bLeft, bTop + bH],
        [bLeft + bW, bTop + bH],
      ].map(([cx, cy], i) => {
        const dx = cx === bLeft ? 1 : -1;
        const dy = cy === bTop ? 1 : -1;
        return (
          <g key={i}>
            <line x1={cx} y1={cy} x2={cx + dx * 2.5} y2={cy} stroke="#FF6B35" strokeWidth="0.7" strokeLinecap="round" />
            <line x1={cx} y1={cy} x2={cx} y2={cy + dy * 2.5} stroke="#FF6B35" strokeWidth="0.7" strokeLinecap="round" />
          </g>
        );
      })}

      {/* Anchor holds — low opacity polygons or ellipses */}
      {ANCHOR_HOLDS.map((hold) => {
        const hasPolygon = hold.polygon && hold.polygon.length >= 3;
        if (hasPolygon) {
          const pts = hold.polygon
            .map(([px, py]) => `${toVX(px).toFixed(3)},${toVY(py).toFixed(3)}`)
            .join(' ');
          return (
            <polygon
              key={hold.id}
              points={pts}
              fill="rgba(255,107,53,0.18)"
              stroke="#FF6B35"
              strokeWidth="0.25"
              strokeLinejoin="round"
              opacity={0.75}
            />
          );
        }
        const cx = toVX(hold.cx);
        const cy = toVY(hold.cy);
        const rx = ((hold.w_pct ?? hold.r * 2) / 100) * bW / 2;
        const ry = ((hold.h_pct ?? hold.r * 2) / 100) * bH / 2;
        return (
          <ellipse
            key={hold.id}
            cx={cx}
            cy={cy}
            rx={Math.max(rx, 0.3)}
            ry={Math.max(ry, 0.3)}
            fill="rgba(255,107,53,0.18)"
            stroke="#FF6B35"
            strokeWidth="0.25"
            opacity={0.75}
          />
        );
      })}
    </svg>
  );
}

// ─── GuidedCameraStep ─────────────────────────────────────────────────────────

export default function GuidedCameraStep({ onCaptured, onCancel }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [error, setError] = useState(null);
  const [ready, setReady] = useState(false);
  const [isPortrait, setIsPortrait] = useState(
    () => typeof window !== 'undefined' && window.innerHeight >= window.innerWidth
  );
  const [capturing, setCapturing] = useState(false);

  // Track orientation
  useEffect(() => {
    const check = () => setIsPortrait(window.innerHeight >= window.innerWidth);
    check();
    window.addEventListener('resize', check);
    window.addEventListener('orientationchange', check);
    return () => {
      window.removeEventListener('resize', check);
      window.removeEventListener('orientationchange', check);
    };
  }, []);

  // Start camera
  useEffect(() => {
    let cancelled = false;

    async function startCamera() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 2560 },
            height: { ideal: 1920 },
          },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      } catch (err) {
        if (!cancelled) {
          console.error('[GuidedCamera] getUserMedia error:', err);
          setError('Could not access the camera. Please allow camera access and try again.');
        }
      }
    }

    startCamera();

    return () => {
      cancelled = true;
      stopStream();
    };
  }, []);

  function stopStream() {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }

  function handleCancel() {
    stopStream();
    onCancel();
  }

  function handleCapture() {
    const video = videoRef.current;
    if (!video || !ready) return;
    setCapturing(true);

    try {
      const w = video.videoWidth;
      const h = video.videoHeight;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(video, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
      stopStream();
      onCaptured(dataUrl, w, h);
    } catch (err) {
      console.error('[GuidedCamera] Capture error:', err);
      setCapturing(false);
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: '#000',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Camera + overlay */}
      <div style={{ position: 'relative', flex: 1, overflow: 'hidden' }}>
        {/* Video feed */}
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          onCanPlay={() => setReady(true)}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            display: 'block',
          }}
        />

        {/* SVG board outline overlay */}
        <GuideOverlay isPortrait={isPortrait} />

        {/* Tip text — top bar */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            padding: '12px 16px',
            background: 'rgba(0,0,0,0.55)',
            color: '#fff',
            fontSize: '13px',
            fontFamily: 'DM Sans, sans-serif',
            lineHeight: 1.4,
            textAlign: 'center',
          }}
        >
          {isPortrait
            ? 'Line up the board corners with the orange box, then tap Capture.'
            : '↩ Rotate to portrait to use guided camera.'}
        </div>

        {/* Error message */}
        {error && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(0,0,0,0.75)',
              color: '#fff',
              padding: '24px',
              textAlign: 'center',
              fontFamily: 'DM Sans, sans-serif',
              gap: '16px',
            }}
          >
            <span style={{ fontSize: '15px' }}>{error}</span>
            <button
              onClick={handleCancel}
              style={{
                padding: '13px 24px',
                borderRadius: '12px',
                fontSize: '15px',
                fontWeight: 700,
                cursor: 'pointer',
                border: '2px solid #fff',
                background: 'transparent',
                color: '#fff',
                fontFamily: 'DM Sans, sans-serif',
              }}
            >
              Back
            </button>
          </div>
        )}
      </div>

      {/* Bottom controls */}
      <div
        style={{
          display: 'flex',
          gap: '12px',
          padding: '16px',
          background: 'rgba(0,0,0,0.75)',
          safeAreaInsetBottom: 'env(safe-area-inset-bottom)',
          paddingBottom: 'max(16px, env(safe-area-inset-bottom))',
        }}
      >
        <button
          onClick={handleCancel}
          style={{
            flex: 1,
            padding: '16px',
            borderRadius: '14px',
            fontSize: '15px',
            fontWeight: 700,
            cursor: 'pointer',
            border: '2px solid rgba(255,255,255,0.35)',
            background: 'transparent',
            color: '#fff',
            fontFamily: 'DM Sans, sans-serif',
            minHeight: '56px',
          }}
        >
          Cancel
        </button>
        <button
          onClick={handleCapture}
          disabled={!ready || capturing || !!error}
          style={{
            flex: 2,
            padding: '16px',
            borderRadius: '14px',
            fontSize: '15px',
            fontWeight: 700,
            cursor: ready && !capturing && !error ? 'pointer' : 'not-allowed',
            border: 'none',
            background: ready && !capturing && !error ? '#FF6B35' : 'rgba(255,107,53,0.4)',
            color: '#fff',
            fontFamily: 'DM Sans, sans-serif',
            minHeight: '56px',
            transition: 'background 0.2s',
          }}
        >
          {capturing ? 'Capturing…' : '📷 Capture'}
        </button>
      </div>
    </div>
  );
}
