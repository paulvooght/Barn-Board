/**
 * BoardFilter — the cross-board wall selector for the Sessions tab.
 * 'all' (All Boards) plus one option per wall the user belongs to. The Sessions
 * tab is a cross-board personal log; this scopes the stats/history to one wall
 * or shows everything. Rendered only when the user has more than one wall.
 */
export default function BoardFilter({ boards = [], value, onChange }) {
  return (
    <div style={wrap}>
      <span style={label}>Wall</span>
      <div style={selectWrap}>
        <select
          value={value}
          onChange={(e) => onChange?.(e.target.value)}
          style={select}
        >
          <option value="all">All Boards</option>
          {boards.map(b => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>
        <span style={chevron}>▾</span>
      </div>
    </div>
  );
}

const wrap = {
  display: 'flex', alignItems: 'center', gap: '10px',
  marginBottom: '12px',
};
const label = {
  fontSize: '10px', fontWeight: 800, color: 'var(--text-muted)',
  letterSpacing: '1px', textTransform: 'uppercase', flexShrink: 0,
};
const selectWrap = { position: 'relative', flex: 1 };
const select = {
  width: '100%', appearance: 'none', WebkitAppearance: 'none', MozAppearance: 'none',
  padding: '10px 32px 10px 14px', borderRadius: '10px',
  border: '1.5px solid var(--border)', background: 'var(--bg-card)',
  color: 'var(--text-primary)', fontSize: '14px', fontWeight: 700,
  fontFamily: 'var(--font-heading)', cursor: 'pointer', outline: 'none',
  boxShadow: '0 2px 8px rgba(26,10,0,0.06)',
};
const chevron = {
  position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)',
  fontSize: '11px', color: 'var(--text-dim)', pointerEvents: 'none',
};
