import { getYouTubeId } from '../utils/constants';
import Icon from './Icon';

export default function RouteCard({ route, sent, communityRating, ratingCount, communityGrade, onView, onRate, onToggleSent, missingHoldCount, onRemoveFromPlaylist }) {
  const displayRating = Math.round(communityRating || 0);
  const hasVideo  = !!getYouTubeId(route.youtubeUrl);
  const hasAngleGrades = (route.angleGrades || []).length > 0;
  const hasMissing = (missingHoldCount || 0) > 0;

  // Border color priority: missing (hot pink) > sent (cyan) > default
  const borderColor = hasMissing ? '#FF1493' : sent ? '#22d3ee' : 'var(--border)';
  const borderWidth = hasMissing || sent ? '2px' : '1px';

  return (
    <div
      onClick={onView}
      style={{
        background: 'var(--bg-card)',
        border: `${borderWidth} solid ${borderColor}`,
        borderRadius: '12px',
        padding: '12px 14px',
        cursor: 'pointer',
        transition: 'border-color 0.15s, box-shadow 0.15s',
        marginBottom: '8px',
        boxShadow: hasMissing ? '0 2px 8px rgba(255,20,147,0.12)' : sent ? '0 2px 8px rgba(34,211,238,0.15)' : '0 2px 6px rgba(26,10,0,0.06)',
        display: 'flex',
        gap: '12px',
        position: 'relative',
      }}
      onMouseEnter={e => { if (!hasMissing) { e.currentTarget.style.borderColor = 'rgba(0,71,255,0.4)'; e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,71,255,0.12)'; } }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = borderColor; e.currentTarget.style.boxShadow = hasMissing ? '0 2px 8px rgba(255,20,147,0.12)' : sent ? '0 2px 8px rgba(34,211,238,0.15)' : '0 2px 6px rgba(26,10,0,0.06)'; }}
    >
      {/* ── LEFT: Grade pill + angle + Name ── */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '2px' }}>
          <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <span style={{
              background: 'var(--yellow)', color: 'var(--text-primary)',
              padding: '5px 14px', borderRadius: '10px',
              fontSize: '15px', fontWeight: 800, fontFamily: 'var(--font-heading)',
              lineHeight: 1.1,
            }}>
              {route.grade}
            </span>
            {communityGrade && communityGrade !== route.grade && (
              <span style={{
                fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)',
                marginTop: '2px',
              }}>
                {communityGrade}
              </span>
            )}
            {route.angle && (
              <span style={{
                fontSize: '10px', fontWeight: 700, fontFamily: 'var(--font-heading)',
                color: 'var(--accent)', marginTop: '3px',
              }}>
                {route.angle}°
              </span>
            )}
          </div>
          <div style={{ minWidth: 0 }}>
            <span style={{
              fontWeight: 700, color: 'var(--text-primary)', fontSize: '16px',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              lineHeight: 1.2, display: 'block',
            }}>
              {route.name}
            </span>
            {route.description && (
              <span style={{
                fontSize: '11px', color: 'var(--text-muted)', fontStyle: 'italic',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                display: 'block', lineHeight: 1.3,
              }}>
                {route.description}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* ── RIGHT: Icons, rating, sent ── */}
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'flex-end',
        justifyContent: 'space-between', flexShrink: 0, gap: '6px',
      }}>
        {/* Top-right: indicators + sent */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {hasMissing && (
            <span
              title={`${missingHoldCount} hold${missingHoldCount > 1 ? 's' : ''} no longer on the board`}
              style={{
                fontSize: '10px', fontWeight: 800,
                background: 'rgba(255,20,147,0.12)', color: '#FF1493',
                padding: '2px 6px', borderRadius: '6px',
                fontFamily: 'var(--font-heading)',
                border: '1px solid rgba(255,20,147,0.3)',
              }}
            >
              ⚠ {missingHoldCount}
            </span>
          )}
          {hasVideo && (
            <span title="Has beta video" style={{ opacity: 0.45 }}><Icon name="video" size={12}/></span>
          )}
          {hasAngleGrades && (
            <span
              title={`${route.angleGrades.length} angle grade${route.angleGrades.length > 1 ? 's' : ''}`}
              style={{
                fontSize: '9px', fontWeight: 800,
                background: 'rgba(0,71,255,0.1)', color: 'var(--accent)',
                padding: '1px 5px', borderRadius: '6px',
                fontFamily: 'var(--font-heading)',
              }}
            >
              +{route.angleGrades.length}
            </span>
          )}
          {onRemoveFromPlaylist && (
            <button
              onClick={(e) => { e.stopPropagation(); onRemoveFromPlaylist(); }}
              title="Remove from playlist"
              style={{
                width: '24px', height: '24px', borderRadius: '6px', flexShrink: 0,
                border: '1.5px solid rgba(26,10,0,0.15)', background: 'rgba(26,10,0,0.06)',
                color: 'var(--text-muted)', fontSize: '13px', fontWeight: 700, lineHeight: 1,
                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              ✕
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); onToggleSent(); }}
            title={sent ? 'Mark as not sent' : 'Mark as sent'}
            style={{
              width: '24px', height: '24px', borderRadius: '6px', flexShrink: 0,
              border: sent ? '2px solid #7DD3E8' : '2px solid rgba(26,10,0,0.2)',
              background: sent ? '#7DD3E8' : 'transparent',
              color: '#fff', fontSize: '13px', fontWeight: 900, lineHeight: 1,
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'all 0.15s',
            }}
          >
            {sent ? '✓' : ''}
          </button>
        </div>

        {/* Bottom-right: community star rating */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}
          onClick={e => e.stopPropagation()}
        >
          {[1, 2, 3, 4, 5].map(star => (
            <button
              key={star}
              onClick={() => onRate(star)}
              title={`Rate ${star} star${star > 1 ? 's' : ''}`}
              style={{
                background: 'none', border: 'none', padding: '1px',
                cursor: 'pointer', fontSize: '14px', lineHeight: 1,
                color: star <= displayRating ? '#FFE800' : 'rgba(26,10,0,0.15)',
                textShadow: star <= displayRating ? '0 1px 3px rgba(26,10,0,0.15)' : 'none',
                transition: 'color 0.1s, transform 0.1s',
              }}
              onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.25)'; }}
              onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; }}
            >
              {star <= displayRating ? '★' : '☆'}
            </button>
          ))}
          {ratingCount > 0 && (
            <span style={{ fontSize: '9px', color: 'rgba(26,10,0,0.35)', marginLeft: '2px', lineHeight: 1 }}>
              ({ratingCount})
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
