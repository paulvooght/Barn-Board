export default function RouteCard({ route, onView, onRate }) {
  const holdCount = Object.keys(route.holds).length;
  const rating    = route.rating || 0;

  return (
    <div
      onClick={onView}
      style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: '12px',
        padding: '14px 16px',
        cursor: 'pointer',
        transition: 'border-color 0.15s, box-shadow 0.15s',
        marginBottom: '8px',
        boxShadow: '0 2px 6px rgba(0,0,0,0.06)',
      }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(0,71,255,0.4)'; e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,71,255,0.12)'; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.boxShadow = '0 2px 6px rgba(0,0,0,0.06)'; }}
    >
      {/* Title + Grade */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
        <span style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: '15px' }}>
          {route.name}
        </span>
        <span style={{
          background: 'var(--yellow)', color: 'var(--peach)',
          padding: '4px 13px', borderRadius: '12px',
          fontSize: '14px', fontWeight: 800, fontFamily: 'var(--font-heading)',
        }}>
          {route.grade}
        </span>
      </div>

      {/* Meta line */}
      <div style={{ display: 'flex', gap: '12px', fontSize: '11px', color: 'var(--text-muted)' }}>
        <span>{route.angle}°</span>
        <span>{holdCount} holds</span>
        {route.styles?.length > 0 && <span>{route.styles[0]}</span>}
      </div>

      {/* Star rating */}
      <div
        style={{ display: 'flex', gap: '3px', marginTop: '8px' }}
        onClick={e => e.stopPropagation()}
      >
        {[1, 2, 3, 4, 5].map(star => (
          <button
            key={star}
            onClick={() => onRate(star)}
            title={`Rate ${star} star${star > 1 ? 's' : ''}`}
            style={{
              background: 'none', border: 'none', padding: '2px 1px',
              cursor: 'pointer', fontSize: '18px', lineHeight: 1,
              color: star <= rating ? '#FFE800' : 'rgba(0,0,0,0.18)',
              textShadow: star <= rating ? '0 1px 3px rgba(0,0,0,0.15)' : 'none',
              transition: 'color 0.1s, transform 0.1s',
            }}
            onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.25)'; }}
            onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; }}
          >
            {star <= rating ? '★' : '☆'}
          </button>
        ))}
        {rating > 0 && (
          <span style={{ fontSize: '10px', color: 'var(--text-dim)', alignSelf: 'center', marginLeft: '3px' }}>
            {rating}/5
          </span>
        )}
      </div>

      {/* Tags preview */}
      {(route.holdTypes?.length > 0 || route.techniques?.length > 0) && (
        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '8px' }}>
          {[...(route.holdTypes || []), ...(route.techniques || [])].slice(0, 5).map(tag => (
            <span key={tag} style={{
              padding: '2px 7px', borderRadius: '8px',
              background: 'rgba(0,0,0,0.06)', border: '1px solid rgba(0,0,0,0.1)',
              fontSize: '10px', color: 'var(--text-muted)',
            }}>
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
