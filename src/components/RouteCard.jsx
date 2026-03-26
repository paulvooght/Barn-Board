import { getYouTubeId } from '../utils/constants';

export default function RouteCard({ route, onView, onRate, onToggleSent }) {
  const rating    = route.rating || 0;
  const sent      = !!route.sent;
  const hasVideo  = !!getYouTubeId(route.youtubeUrl);
  const hasAngleGrades = (route.angleGrades || []).length > 0;

  return (
    <div
      onClick={onView}
      style={{
        background: 'var(--bg-card)',
        border: sent ? '1.5px solid #7DD3E8' : '1px solid var(--border)',
        borderRadius: '12px',
        padding: '12px 14px',
        cursor: 'pointer',
        transition: 'border-color 0.15s, box-shadow 0.15s',
        marginBottom: '8px',
        boxShadow: '0 2px 6px rgba(26,10,0,0.06)',
        display: 'flex',
        gap: '12px',
      }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(0,71,255,0.4)'; e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,71,255,0.12)'; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = sent ? '#7DD3E8' : 'var(--border)'; e.currentTarget.style.boxShadow = '0 2px 6px rgba(26,10,0,0.06)'; }}
    >
      {/* ── LEFT: Grade + Name (prominent) ── */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' }}>
          <span style={{
            background: 'var(--yellow)', color: 'var(--text-primary)',
            padding: '5px 14px', borderRadius: '10px',
            fontSize: '15px', fontWeight: 800, fontFamily: 'var(--font-heading)',
            flexShrink: 0, lineHeight: 1.1,
          }}>
            {route.grade}
          </span>
          <span style={{
            fontWeight: 700, color: 'var(--text-primary)', fontSize: '16px',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            lineHeight: 1.2,
          }}>
            {route.name}
          </span>
        </div>
      </div>

      {/* ── RIGHT: Icons, rating, sent ── */}
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'flex-end',
        justifyContent: 'space-between', flexShrink: 0, gap: '6px',
      }}>
        {/* Top-right: indicators + sent */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {hasVideo && (
            <span title="Has beta video" style={{ fontSize: '12px', opacity: 0.45 }}>🎥</span>
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

        {/* Bottom-right: star rating */}
        <div
          style={{ display: 'flex', gap: '1px' }}
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
                color: star <= rating ? '#FFE800' : 'rgba(26,10,0,0.15)',
                textShadow: star <= rating ? '0 1px 3px rgba(26,10,0,0.15)' : 'none',
                transition: 'color 0.1s, transform 0.1s',
              }}
              onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.25)'; }}
              onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; }}
            >
              {star <= rating ? '★' : '☆'}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
