import RouteCard from './RouteCard';

export default function RouteList({ routes, onViewRoute, onCreateNew, onRateRoute }) {
  return (
    <div style={{ padding: '16px 12px' }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '16px',
      }}>
        <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
          Routes
          <span style={{
            background: 'var(--yellow)', color: 'var(--peach)', fontWeight: 800,
            fontSize: '13px', padding: '2px 10px', borderRadius: '10px',
            fontFamily: 'var(--font-heading)',
          }}>
            {routes.length}
          </span>
        </h2>
        <button
          onClick={onCreateNew}
          style={{
            padding: '6px 16px',
            borderRadius: '16px',
            border: 'none',
            background: 'var(--accent)',
            color: '#ffffff',
            fontSize: '12px',
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          + New
        </button>
      </div>

      {routes.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-dim)' }}>
          <div style={{ fontSize: '40px', marginBottom: '12px', color: 'var(--yellow)', opacity: 0.4 }}>◇</div>
          <div style={{ fontSize: '14px', fontWeight: 500, color: 'var(--text-muted)' }}>
            No routes yet
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-dim)', marginTop: '4px' }}>
            Create your first route on the board
          </div>
        </div>
      ) : (
        routes.map(route => (
          <RouteCard
            key={route.id}
            route={route}
            onView={() => onViewRoute(route)}
            onRate={(rating) => onRateRoute(route.id, rating)}
          />
        ))
      )}
    </div>
  );
}
