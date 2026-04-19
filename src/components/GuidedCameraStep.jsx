import { useEffect, useRef, useState } from 'react';
import holdsData from '../data/holds.json';

// ─── Board photo reference dimensions ────────────────────────────────────────
// Source: holds.json imageFile (Barn_Set_01_V5.jpg) — 1500 × 1463 px natural size.
// Future improvement: read from holds.json metadata dynamically.
const PHOTO_W = 1500;
const PHOTO_H = 1463;
const TARGET_ASPECT = PHOTO_W / PHOTO_H; // ≈ 1.0253

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
// viewBox matches board photo dimensions (1500 × 1463).
// boardRegion percentages are converted to viewBox coords.

function GuideOverlay({ isPortrait }) {
  if (!isPortrait) return null;

  // Board region in viewBox coords (px equivalent within PHOTO_W × PHOTO_H space)
  const bLeft = (BOARD_REGION.left / 100) * PHOTO_W;
  const bTop = (BOARD_REGION.top / 100) * PHOTO_H;
  const bW = (BOARD_REGION.width / 100) * PHOTO_W;
  const bH = (BOARD_REGION.height / 100) * PHOTO_H;

  // Convert a hold's board-area % to viewBox coords
  const toVX = (x_pct) => bLeft + (x_pct / 100) * bW;
  const toVY = (y_pct) => bTop + (y_pct / 100) * bH;

  // Stroke/dash sizes scaled to viewBox (1500px wide)
  const outlineStroke = PHOTO_W * 0.004;   // ~6px
  const tickStroke = PHOTO_W * 0.007;      // ~10.5px
  const tickLen = PHOTO_W * 0.025;         // ~37.5px
  const holdStroke = PHOTO_W * 0.0025;     // ~3.75px
  const dashA = PHOTO_W * 0.012;
  const dashB = PHOTO_W * 0.006;

  return (
    <svg
      viewBox={`0 0 ${PHOTO_W} ${PHOTO_H}`}
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
        strokeWidth={outlineStroke}
        rx={outlineStroke * 0.5}
        strokeDasharray={`${dashA} ${dashB}`}
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
            <line x1={cx} y1={cy} x2={cx + dx * tickLen} y2={cy} stroke="#FF6B35" strokeWidth={tickStroke} strokeLinecap="round" />
            <line x1={cx} y1={cy} x2={cx} y2={cy + dy * tickLen} stroke="#FF6B35" strokeWidth={tickStroke} strokeLinecap="round" />
          </g>
        );
      })}

      {/* Anchor holds — low opacity polygons or ellipses */}
      {ANCHOR_HOLDS.map((hold) => {
        const hasPolygon = hold.polygon && hold.polygon.length >= 3;
        if (hasPolygon) {
          const pts = hold.polygon
            .map(([px, py]) => `${toVX(px).toFixed(1)},${toVY(py).toFixed(1)}`)
            .join(' ');
          return (
            <polygon
              key={hold.id}
              points={pts}
              fill="rgba(255,107,53,0.18)"
              stroke="#FF6B35"
              strokeWidth={holdStroke}
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
            rx={Math.max(rx, PHOTO_W * 0.003)}
            ry={Math.max(ry, PHOTO_W * 0.003)}
            fill="rgba(255,107,53,0.18)"
            stroke="#FF6B35"
            strokeWidth={holdStroke}
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
      const videoW = video.videoWidth;
      const videoH = video.videoHeight;
      const videoAspect = videoW / videoH;

      // Crop the captured frame to match the aspect ratio the user is framing against
      let cropX, cropY, cropW, cropH;
      if (videoAspect > TARGET_ASPECT) {
        // Video is wider than target — crop horizontally
        cropH = videoH;
        cropW = videoH * TARGET_ASPECT;
        cropX = (videoW - cropW) / 2;
        cropY = 0;
      } else {
        // Video is taller than target — crop vertically
        cropW = videoW;
        cropH = videoW / TARGET_ASPECT;
        cropX = 0;
        cropY = (videoH - cropH) / 2;
      }

      const canvas = document.createElement('canvas');
      canvas.width = cropW;
      canvas.height = cropH;
      canvas.getContext('2d').drawImage(video, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
      stopStream();
      onCaptured(dataUrl, cropW, cropH);
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
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {/* Tip text — absolute in outer container (letterbox area, top) */}
      <div
        style={{
          position: 'absolute',
          top: 16,
          left: 0,
          right: 0,
          padding: '8px 16px',
          color: '#fff',
          fontSize: '13px',
          fontFamily: 'DM Sans, sans-serif',
          lineHeight: 1.4,
          textAlign: 'center',
          zIndex: 1,
        }}
      >
        {isPortrait
          ? 'Line up the board corners with the orange box, then tap Capture.'
          : '↩ Rotate to portrait to use guided camera.'}
      </div>

      {/* Aspect-locked camera frame — matches board photo ratio */}
      <div
        style={{
          position: 'relative',
          aspectRatio: `${PHOTO_W} / ${PHOTO_H}`,
          maxWidth: '100vw',
          maxHeight: '100vh',
          width: '100%',
          overflow: 'hidden',
        }}
      >
        {/* Video feed */}
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          onCanPlay={() => setReady(true)}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            display: 'block',
          }}
        />

        {/* SVG board outline overlay — viewBox matches board photo dims, no distortion */}
        <GuideOverlay isPortrait={isPortrait} />

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

      {/* Controls — absolute in outer container (letterbox area, bottom) */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          display: 'flex',
          gap: '12px',
          padding: '16px',
          paddingBottom: 'max(24px, env(safe-area-inset-bottom))',
          zIndex: 1,
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
            background: 'rgba(0,0,0,0.55)',
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
