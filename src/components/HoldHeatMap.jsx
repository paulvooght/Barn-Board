import { useState, useRef, useEffect } from 'react';

// ─── Color ramp helper ───────────────────────────────────────────────────────

/**
 * Interpolate between two RGB colours.
 * t: 0 → colorA, 1 → colorB
 */
function lerpRgb(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

const PEACH  = [255, 171, 148]; // #FFAB94
const ORANGE = [255, 140,   0]; // #FF8C00
const PINK   = [255,  45, 120]; // #FF2D78

/**
 * Three-stop gradient: peach → orange → pink
 * count = 0 → peach base; count = maxCount → pink
 */
function heatColor(count, maxCount) {
  if (maxCount === 0 || count === 0) return '#FFAB94';
  const t = count / maxCount; // 0..1
  let rgb;
  if (t < 0.5) {
    rgb = lerpRgb(PEACH, ORANGE, t * 2);
  } else {
    rgb = lerpRgb(ORANGE, PINK, (t - 0.5) * 2);
  }
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

// Legend swatches — sample the ramp at 5 points
const LEGEND_STOPS = [0, 0.25, 0.5, 0.75, 1].map(t => {
  if (t === 0) return '#FFAB94';
  const dummy = Math.round(t * 10);
  return heatColor(dummy, 10);
});

// ─── Tooltip auto-dismiss timer ───────────────────────────────────────────────

const TOOLTIP_TTL_MS = 3000;

// ─── Component ────────────────────────────────────────────────────────────────

export default function HoldHeatMap({
  boardImageSrc,
  boardRegion,
  allHolds,
  heat,
  periodLabel,
}) {
  const { counts = {}, maxCount = 0, totalSends = 0 } = heat || {};

  const imgRef  = useRef(null);
  const svgRef  = useRef(null);
  const timerRef = useRef(null);

  const [imgSize, setImgSize]     = useState({ w: 1200, h: 900 });
  const [imageLoaded, setImageLoaded] = useState(false);
  const [tooltip, setTooltip]     = useState(null); // { holdId, x, y, text }

  // Re-detect natural size if the src changes (e.g. config update)
  useEffect(() => {
    setImageLoaded(false);
  }, [boardImageSrc]);

  // Auto-dismiss tooltip
  function armDismiss() {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setTooltip(null), TOOLTIP_TTL_MS);
  }

  function handleHoldClick(e, hold) {
    e.stopPropagation();
    const count = counts[hold.id] || 0;
    const text = count > 0 ? `Used in ${count} send${count === 1 ? '' : 's'}` : 'Not used';

    // Position tooltip at click point relative to the SVG container
    const svgEl = svgRef.current;
    if (svgEl) {
      const rect = svgEl.getBoundingClientRect();
      const clientX = e.clientX ?? (e.touches?.[0]?.clientX);
      const clientY = e.clientY ?? (e.touches?.[0]?.clientY);
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      setTooltip({ holdId: hold.id, x, y, text });
      armDismiss();
    }
  }

  function handleContainerClick() {
    setTooltip(null);
  }

  // Coordinate conversion — same math as HoldOverlay / BoardView
  const bLeft = imgSize.w * boardRegion.left  / 100;
  const bTop  = imgSize.h * boardRegion.top   / 100;
  const bW    = imgSize.w * boardRegion.width  / 100;
  const bH    = imgSize.h * boardRegion.height / 100;

  const toSvgX = (x_pct) => bLeft + (x_pct / 100) * bW;
  const toSvgY = (y_pct) => bTop  + (y_pct / 100) * bH;

  // ── Styles ───────────────────────────────────────────────────────────────────

  const cardStyle = {
    background: 'var(--bg-card)',
    borderRadius: '12px',
    border: '1px solid var(--border)',
    overflow: 'hidden',
    marginBottom: '12px',
  };

  const headerStyle = {
    padding: '14px 16px 10px',
  };

  const titleStyle = {
    fontFamily: 'var(--font-heading)',
    fontWeight: 800,
    fontSize: '11px',
    color: 'var(--accent)',
    letterSpacing: '1px',
    textTransform: 'uppercase',
    margin: '0 0 4px',
  };

  const subheadStyle = {
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '11px',
    color: 'var(--text-muted)',
    margin: 0,
  };

  // ── Empty state ───────────────────────────────────────────────────────────────

  if (totalSends === 0) {
    return (
      <div style={cardStyle}>
        <div style={headerStyle}>
          <p style={titleStyle}>Hold Heat Map</p>
          <p style={{ ...subheadStyle, fontStyle: 'italic', marginTop: '8px', opacity: 0.6 }}>
            No sends in this period — nothing to map yet.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={cardStyle} onClick={handleContainerClick}>
      {/* Header */}
      <div style={headerStyle}>
        <p style={titleStyle}>Hold Heat Map</p>
        <p style={subheadStyle}>
          Showing holds used during {periodLabel} · {totalSends} send{totalSends === 1 ? '' : 's'}
        </p>
      </div>

      {/* Board image + SVG overlay */}
      <div style={{ position: 'relative', lineHeight: 0 }} ref={svgRef}>
        <img
          ref={imgRef}
          src={boardImageSrc}
          alt="Climbing board heat map"
          onLoad={(e) => {
            const nw = e.target.naturalWidth;
            const nh = e.target.naturalHeight;
            setImgSize({ w: nw, h: nh });
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
            }}
          >
            {(allHolds || []).map((hold) => {
              const count = counts[hold.id] || 0;
              const opacity = count > 0 ? 0.5 + 0.4 * (count / maxCount) : 0.08;
              const fill = heatColor(count, maxCount);
              const hasPolygon = hold.polygon && hold.polygon.length >= 3;

              if (hasPolygon) {
                const pts = hold.polygon.map(([px, py]) => `${toSvgX(px)},${toSvgY(py)}`).join(' ');
                return (
                  <polygon
                    key={hold.id}
                    points={pts}
                    fill={fill}
                    fillOpacity={opacity}
                    stroke="rgba(255,255,255,0.6)"
                    strokeWidth={2}
                    strokeLinejoin="round"
                    style={{ cursor: 'pointer' }}
                    onClick={(e) => handleHoldClick(e, hold)}
                  />
                );
              }

              // Fallback: ellipse for holds without polygon
              const cx = toSvgX(hold.cx);
              const cy = toSvgY(hold.cy);
              const w = hold.w_pct !== undefined ? hold.w_pct : (hold.r || 2) * 2;
              const h = hold.h_pct !== undefined ? hold.h_pct : (hold.r || 2) * 2;
              const rx = Math.max((w / 100) * bW / 2, 2);
              const ry = Math.max((h / 100) * bH / 2, 2);

              return (
                <ellipse
                  key={hold.id}
                  cx={cx}
                  cy={cy}
                  rx={rx}
                  ry={ry}
                  fill={fill}
                  fillOpacity={opacity}
                  stroke="rgba(255,255,255,0.6)"
                  strokeWidth={2}
                  style={{ cursor: 'pointer' }}
                  onClick={(e) => handleHoldClick(e, hold)}
                />
              );
            })}
          </svg>
        )}

        {/* Tooltip */}
        {tooltip && (
          <div
            style={{
              position: 'absolute',
              left: Math.min(tooltip.x + 8, (svgRef.current?.offsetWidth || 300) - 130),
              top: tooltip.y - 36,
              background: 'rgba(26,10,0,0.88)',
              color: '#fff',
              fontSize: '11px',
              fontWeight: 700,
              fontFamily: "'DM Sans', sans-serif",
              padding: '5px 10px',
              borderRadius: '6px',
              pointerEvents: 'none',
              whiteSpace: 'nowrap',
              zIndex: 10,
              boxShadow: '0 2px 8px rgba(26,10,0,0.4)',
            }}
          >
            {tooltip.text}
          </div>
        )}
      </div>

      {/* Legend */}
      <div style={{ padding: '10px 16px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, minWidth: 24 }}>Low</span>
          <div style={{ flex: 1, display: 'flex', gap: '3px' }}>
            {LEGEND_STOPS.map((color, i) => (
              <div
                key={i}
                style={{
                  flex: 1,
                  height: '10px',
                  borderRadius: i === 0 ? '4px 0 0 4px' : i === LEGEND_STOPS.length - 1 ? '0 4px 4px 0' : 0,
                  background: color,
                  opacity: 0.85,
                }}
              />
            ))}
          </div>
          <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, minWidth: 24, textAlign: 'right' }}>High</span>
        </div>
      </div>
    </div>
  );
}
