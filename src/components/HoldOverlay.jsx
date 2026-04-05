import { MODE_COLORS } from '../utils/constants';

/**
 * Renders a single hold as SVG elements inside a parent <svg>.
 *
 * Route view: bold colored outlines, tinted fill, large labels.
 * The board image is dimmed separately (BoardView) so these pop.
 */
export default function HoldOverlay({ hold, boardRegion, imgSize, selection, onTap, interactive, pxScale = 1 }) {
  const selType  = selection?.[hold.id];
  const isSelected = !!selType;
  const color    = isSelected ? MODE_COLORS[selType] : null;

  // Convert board-area percentages → SVG natural-pixel coordinates
  const bLeft = imgSize.w * boardRegion.left  / 100;
  const bTop  = imgSize.h * boardRegion.top   / 100;
  const bW    = imgSize.w * boardRegion.width  / 100;
  const bH    = imgSize.h * boardRegion.height / 100;

  const toSvgX = (x_pct) => bLeft + (x_pct / 100) * bW;
  const toSvgY = (y_pct) => bTop  + (y_pct / 100) * bH;

  const cx = toSvgX(hold.cx);
  const cy = toSvgY(hold.cy);

  const w = hold.w_pct !== undefined ? hold.w_pct : hold.r * 2;
  const h = hold.h_pct !== undefined ? hold.h_pct : hold.r * 2;
  const rx = Math.max((w / 100) * bW / 2, 2);
  const ry = Math.max((h / 100) * bH / 2, 2);

  const hasPolygon = hold.polygon && hold.polygon.length >= 3;
  const polyPoints = hasPolygon
    ? hold.polygon.map(([px, py]) => `${toSvgX(px)},${toSvgY(py)}`).join(' ')
    : null;

  // ── Unselected holds: very subtle ──
  if (!isSelected) {
    return (
      <g style={{ pointerEvents: 'none' }}>
        {hasPolygon ? (
          <polygon points={polyPoints} fill="transparent" stroke="rgba(255,255,255,0.12)" strokeWidth={0.8} strokeLinejoin="round" />
        ) : (
          <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill="transparent" stroke="rgba(255,255,255,0.12)" strokeWidth={0.8} />
        )}
      </g>
    );
  }

  // ── Selected hold styling ──
  const strokeW = Math.round(1.5 * pxScale);
  const glowW = Math.round(2.5 * pxScale);
  const fillColor = 'transparent';
  const glowColor = `${color}44`;

  const label = selType === 'start'    ? 'START'
              : selType === 'finish'   ? 'TOP'
              : selType === 'foot'     ? 'FOOT'
              : selType === 'handOnly' ? 'HAND'
              : null;

  const fontSize = Math.max(bW * 0.010, 8);
  const pillW = fontSize * (label ? label.length * 0.7 + 1.2 : 0);
  const pillH = fontSize * 1.5;

  // Bottom of the hold shape in SVG coords — label goes below this
  const bottomY = hasPolygon
    ? Math.max(...hold.polygon.map(([, y]) => toSvgY(y)))
    : cy + ry;
  const labelY = bottomY + strokeW / 2 + pillH / 2 + 6; // gap below outline

  return (
    <g style={{ pointerEvents: 'none' }}>
      {/* Layer 1: Wide outer glow */}
      {hasPolygon ? (
        <polygon points={polyPoints} fill="none" stroke={glowColor} strokeWidth={glowW} strokeLinejoin="round" />
      ) : (
        <ellipse cx={cx} cy={cy} rx={rx + Math.round(1 * pxScale)} ry={ry + Math.round(1 * pxScale)} fill="none" stroke={glowColor} strokeWidth={glowW} />
      )}

      {/* Layer 2: Outline (no fill) */}
      {hasPolygon ? (
        <polygon points={polyPoints} fill={fillColor} stroke={color} strokeWidth={strokeW} strokeLinejoin="round" />
      ) : (
        <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill={fillColor} stroke={color} strokeWidth={strokeW} />
      )}

      {/* Layer 3: Label pill below the hold */}
      {label && (
        <>
          <rect
            x={cx - pillW / 2} y={labelY - pillH / 2}
            width={pillW} height={pillH}
            rx={pillH / 2} ry={pillH / 2}
            fill={color}
            style={{ filter: 'drop-shadow(0 2px 4px rgba(26,10,0,0.5))' }}
          />
          <text
            x={cx} y={labelY}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={fontSize}
            fontWeight="900"
            fontFamily="var(--font-heading)"
            letterSpacing="1.5"
            fill="#fff"
            style={{ pointerEvents: 'none', userSelect: 'none' }}
          >
            {label}
          </text>
        </>
      )}

      {/* Small bright dot for regular hand holds */}
      {!label && (
        <circle
          cx={cx} cy={cy}
          r={Math.max(bW * 0.006, 4)}
          fill="#fff"
          stroke={color}
          strokeWidth={Math.max(Math.round(0.7 * pxScale), 1)}
          style={{ filter: 'drop-shadow(0 1px 3px rgba(26,10,0,0.7))' }}
        />
      )}
    </g>
  );
}
