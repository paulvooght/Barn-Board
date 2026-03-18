import { MODE_COLORS } from '../utils/constants';

/**
 * Renders a single hold as SVG elements inside a parent <svg>.
 * Uses polygon contour when available, falls back to ellipse (w_pct × h_pct),
 * then circle (r) for legacy data.
 */
export default function HoldOverlay({ hold, boardRegion, imgSize, selection, onTap, interactive }) {
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

  // Radii from w_pct/h_pct if present, otherwise fall back to r
  const w = hold.w_pct !== undefined ? hold.w_pct : hold.r * 2;
  const h = hold.h_pct !== undefined ? hold.h_pct : hold.r * 2;
  const rx = Math.max((w / 100) * bW / 2, 2);
  const ry = Math.max((h / 100) * bH / 2, 2);

  // Minimum invisible tap target (≈ 44 CSS px equivalent in SVG space)
  const minTap = Math.max(bW * 0.022, 18);

  const strokeColor = isSelected ? color : 'rgba(255,255,255,0.18)';
  const fillColor   = isSelected ? `${color}22` : 'transparent';
  const strokeW     = isSelected ? 2.5 : 1;

  const label = selType === 'start'    ? 'S'
              : selType === 'finish'   ? 'F'
              : selType === 'foot'     ? '🦶'
              : selType === 'handOnly' ? 'H'
              : '●';

  const hasPolygon = hold.polygon && hold.polygon.length >= 3;

  const polyPoints = hasPolygon
    ? hold.polygon.map(([px, py]) => `${toSvgX(px)},${toSvgY(py)}`).join(' ')
    : null;

  const handleClick = interactive
    ? (e) => { e.stopPropagation(); onTap(hold.id); }
    : undefined;

  const fontSize = Math.max(bW * 0.016, 10);

  return (
    <g
      onClick={handleClick}
      style={{ pointerEvents: interactive ? 'all' : 'none', cursor: interactive ? 'pointer' : 'default' }}
    >
      {/* Invisible tap target — ensures small holds are still tappable */}
      {interactive && (
        <ellipse
          cx={cx} cy={cy}
          rx={Math.max(rx, minTap)}
          ry={Math.max(ry, minTap)}
          fill="transparent"
          stroke="none"
          style={{ pointerEvents: 'all' }}
        />
      )}

      {/* Outer glow when selected */}
      {isSelected && (hasPolygon ? (
        <polygon
          points={polyPoints}
          fill="none"
          stroke={`${color}33`}
          strokeWidth={8}
          strokeLinejoin="round"
          style={{ pointerEvents: 'none' }}
        />
      ) : (
        <ellipse
          cx={cx} cy={cy} rx={rx + 4} ry={ry + 4}
          fill="none"
          stroke={`${color}33`}
          strokeWidth={8}
          style={{ pointerEvents: 'none' }}
        />
      ))}

      {/* Main shape */}
      {hasPolygon ? (
        <polygon
          points={polyPoints}
          fill={fillColor}
          stroke={strokeColor}
          strokeWidth={strokeW}
          strokeLinejoin="round"
        />
      ) : (
        <ellipse
          cx={cx} cy={cy} rx={rx} ry={ry}
          fill={fillColor}
          stroke={strokeColor}
          strokeWidth={strokeW}
        />
      )}

      {/* Label */}
      {isSelected && (
        <text
          x={cx} y={cy}
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={fontSize}
          fontWeight="700"
          fill={color}
          style={{
            pointerEvents: 'none',
            userSelect: 'none',
            filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.95))',
          }}
        >
          {label}
        </text>
      )}
    </g>
  );
}
