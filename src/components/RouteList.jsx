import { useState, useMemo } from 'react';
import RouteCard from './RouteCard';
import { HOLD_TYPES, STYLES } from '../utils/constants';

const SORT_OPTIONS = [
  { key: 'date',   label: 'Date' },
  { key: 'grade',  label: 'Grade' },
  { key: 'rating', label: 'Rating' },
];

function getMissingHoldCount(route, holdIdSet) {
  return Object.keys(route.holds || {}).filter(id => !holdIdSet.has(id)).length;
}

export default function RouteList({
  routes, grades, gradeSystem, playlists, allHolds,
  userRouteData, communityRatings,
  onViewRoute, onCreateNew, onRateRoute, onToggleSent,
  onCreatePlaylist, onDeletePlaylist, onRenamePlaylist, onRemoveRouteFromPlaylist,
}) {
  const urd = userRouteData || {};
  const cr = communityRatings || {};
  const [showFilters, setShowFilters] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showSortMenu, setShowSortMenu] = useState(false);
  const [activePlaylist, setActivePlaylist] = useState(null);
  const [showNewPlaylist, setShowNewPlaylist] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [confirmDeletePlaylist, setConfirmDeletePlaylist] = useState(null);
  const [renamingPlaylist, setRenamingPlaylist] = useState(null); // playlist id
  const [renameValue, setRenameValue] = useState('');

  // Sort state — key + ascending flag. Tap same key to flip direction.
  const [sortKey, setSortKey] = useState('date');
  const [sortAsc, setSortAsc] = useState(false); // date defaults newest-first

  // Hold ID set for missing hold detection
  const holdIdSet = useMemo(() => new Set((allHolds || []).map(h => h.id)), [allHolds]);

  // Hide sends toggle (top-level, not inside filter panel)
  const [hideSent, setHideSent] = useState(false);

  // Show hidden angle grades in filter results
  const [showHiddenAngles, setShowHiddenAngles] = useState(false);

  // Filter state
  const [filterGradeFrom, setFilterGradeFrom] = useState('');
  const [filterGradeTo, setFilterGradeTo] = useState('');
  const [filterRating, setFilterRating] = useState(0);
  const [filterHoldTypes, setFilterHoldTypes] = useState([]);
  const [filterStyles, setFilterStyles] = useState([]);

  const toggleFilter = (list, setter, val) => {
    setter(prev => prev.includes(val) ? prev.filter(v => v !== val) : [...prev, val]);
  };

  const handleSortSelect = (key) => {
    if (sortKey === key) {
      setSortAsc(prev => !prev); // flip direction
    } else {
      setSortKey(key);
      // sensible defaults: date → newest first, grade → easiest first, rating → highest first
      setSortAsc(key === 'grade');
    }
    setShowSortMenu(false);
  };

  // Get routes for current view (all or playlist)
  let baseRoutes = routes;
  if (activePlaylist) {
    const pl = playlists.find(p => p.id === activePlaylist);
    if (pl) {
      baseRoutes = routes.filter(r => pl.routeIds.includes(r.id));
    }
  }

  // Apply hide-sent toggle
  let filtered = hideSent ? baseRoutes.filter(r => !urd[r.id]?.sent) : baseRoutes;

  // Grade range filter — optionally checks angleGrades too
  if (filterGradeFrom || filterGradeTo) {
    const fromIdx = filterGradeFrom ? grades.indexOf(filterGradeFrom) : 0;
    const toIdx = filterGradeTo ? grades.indexOf(filterGradeTo) : grades.length - 1;
    const lo = Math.min(fromIdx, toIdx);
    const hi = Math.max(fromIdx, toIdx);
    const validGrades = grades.slice(lo, hi + 1);
    filtered = filtered.filter(r => {
      // Always match headline grade
      if (validGrades.includes(r.grade)) return true;
      // If toggle is on, also check hidden angle grades
      if (showHiddenAngles && r.angleGrades?.length > 0) {
        return r.angleGrades.some(ag => validGrades.includes(ag.grade));
      }
      return false;
    });
  }

  if (filterRating > 0) filtered = filtered.filter(r => (cr[r.id]?.avg || 0) >= filterRating);
  if (filterHoldTypes.length > 0) filtered = filtered.filter(r =>
    filterHoldTypes.every(ht => r.holdTypes?.includes(ht))
  );
  if (filterStyles.length > 0) filtered = filtered.filter(r =>
    filterStyles.every(s => r.styles?.includes(s))
  );

  // Sort
  const sorted = [...filtered].sort((a, b) => {
    let cmp = 0;
    if (sortKey === 'date') {
      cmp = new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
    } else if (sortKey === 'grade') {
      cmp = grades.indexOf(a.grade) - grades.indexOf(b.grade);
    } else if (sortKey === 'rating') {
      cmp = (cr[a.id]?.avg || 0) - (cr[b.id]?.avg || 0);
    }
    return sortAsc ? cmp : -cmp;
  });

  const hasActiveFilters = filterGradeFrom || filterGradeTo || filterRating > 0 || filterHoldTypes.length > 0 || filterStyles.length > 0 || showHiddenAngles;

  const clearFilters = () => {
    setFilterGradeFrom(''); setFilterGradeTo(''); setFilterRating(0);
    setFilterHoldTypes([]); setFilterStyles([]); setShowHiddenAngles(false);
  };

  const handleCreatePlaylist = () => {
    if (!newPlaylistName.trim()) return;
    onCreatePlaylist(newPlaylistName.trim());
    setNewPlaylistName('');
    setShowNewPlaylist(false);
  };

  const handleDeletePlaylist = (plId) => {
    onDeletePlaylist(plId);
    if (activePlaylist === plId) setActivePlaylist(null);
    setConfirmDeletePlaylist(null);
  };

  const sortLabel = SORT_OPTIONS.find(o => o.key === sortKey)?.label || 'Date';
  const sortArrow = sortAsc ? '↑' : '↓';
  const sentCount = baseRoutes.filter(r => urd[r.id]?.sent).length;

  return (
    <div style={{ padding: '16px 12px' }}>
      {/* Header */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: '12px',
      }}>
        <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
          Routes
          <span style={{
            background: 'var(--yellow)', color: 'var(--text-primary)', fontWeight: 800,
            fontSize: '13px', padding: '2px 10px', borderRadius: '10px',
            fontFamily: 'var(--font-heading)',
          }}>
            {routes.length}
          </span>
        </h2>
        <div style={{ display: 'flex', gap: '6px' }}>
          <button
            onClick={onCreateNew}
            style={{
              padding: '6px 16px', borderRadius: '16px', border: 'none',
              background: 'var(--accent)', color: '#ffffff',
              fontSize: '12px', fontWeight: 700, cursor: 'pointer',
            }}
          >
            + New
          </button>
        </div>
      </div>

      {/* ── Control bar: Filter / Sort / Hide Sent ── */}
      <div style={{
        display: 'flex', gap: '6px', marginBottom: '12px', alignItems: 'center',
        flexWrap: 'wrap',
      }}>
        {/* Filter button */}
        <button
          onClick={() => { setShowFilters(prev => !prev); setShowSortMenu(false); }}
          style={{
            padding: '6px 12px', borderRadius: '16px', fontSize: '11px',
            fontWeight: 700, cursor: 'pointer',
            border: showFilters || hasActiveFilters ? '1.5px solid var(--accent)' : '1.5px solid rgba(26,10,0,0.15)',
            background: showFilters ? 'var(--accent-dim)' : hasActiveFilters ? 'var(--accent-dim)' : 'transparent',
            color: showFilters || hasActiveFilters ? 'var(--accent)' : 'var(--text-secondary)',
          }}
        >
          ⊞ Filter{hasActiveFilters ? ' ●' : ''}
        </button>

        {/* Sort button */}
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => { setShowSortMenu(prev => !prev); setShowFilters(false); }}
            style={{
              padding: '6px 12px', borderRadius: '16px', fontSize: '11px',
              fontWeight: 700, cursor: 'pointer',
              border: showSortMenu ? '1.5px solid var(--accent)' : '1.5px solid rgba(26,10,0,0.15)',
              background: showSortMenu ? 'var(--accent-dim)' : 'transparent',
              color: showSortMenu ? 'var(--accent)' : 'var(--text-secondary)',
            }}
          >
            {sortArrow} {sortLabel}
          </button>

          {/* Sort dropdown */}
          {showSortMenu && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, marginTop: '4px',
              background: 'var(--bg-card)', border: '1px solid var(--border)',
              borderRadius: '10px', boxShadow: '0 4px 16px rgba(26,10,0,0.12)',
              zIndex: 10, overflow: 'hidden', minWidth: '120px',
            }}>
              {SORT_OPTIONS.map(opt => {
                const isActive = sortKey === opt.key;
                return (
                  <button
                    key={opt.key}
                    onClick={() => handleSortSelect(opt.key)}
                    style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      width: '100%', padding: '10px 14px', border: 'none',
                      background: isActive ? 'var(--accent-dim)' : 'transparent',
                      color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
                      fontSize: '12px', fontWeight: isActive ? 700 : 500,
                      cursor: 'pointer', textAlign: 'left',
                    }}
                  >
                    <span>{opt.label}</span>
                    {isActive && (
                      <span style={{ fontSize: '11px', opacity: 0.7 }}>
                        {sortAsc ? '↑' : '↓'}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Hide Sent toggle */}
        <button
          onClick={() => setHideSent(prev => !prev)}
          style={{
            padding: '5px 10px', borderRadius: '16px', fontSize: '11px',
            fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px',
            border: hideSent ? '1.5px solid #7DD3E8' : '1.5px solid rgba(26,10,0,0.15)',
            background: hideSent ? 'rgba(125,211,232,0.12)' : 'transparent',
            color: hideSent ? '#3BA8C4' : 'var(--text-secondary)',
          }}
        >
          <div style={{
            width: '28px', height: '16px', borderRadius: '8px', position: 'relative',
            background: hideSent ? '#7DD3E8' : 'rgba(26,10,0,0.15)',
            transition: 'background 0.2s', flexShrink: 0,
          }}>
            <div style={{
              width: '12px', height: '12px', borderRadius: '50%', background: '#fff',
              position: 'absolute', top: '2px',
              left: hideSent ? '14px' : '2px',
              transition: 'left 0.2s',
              boxShadow: '0 1px 2px rgba(26,10,0,0.2)',
            }} />
          </div>
          {hideSent ? 'Show sent' : 'Hide sent'}
        </button>
      </div>

      {/* ── Playlist tiles ── */}
      <div style={{
        display: 'flex', gap: '8px', overflowX: 'auto',
        paddingBottom: '12px', marginBottom: '4px',
        WebkitOverflowScrolling: 'touch',
      }}>
        {/* "All" tile */}
        <button
          onClick={() => setActivePlaylist(null)}
          style={{
            ...playlistTileStyle,
            border: !activePlaylist ? '2px solid var(--accent)' : '1.5px solid var(--border)',
            background: !activePlaylist ? 'var(--accent-dim)' : 'var(--bg-card)',
          }}
        >
          <div style={{ fontSize: '20px', marginBottom: '2px' }}>◇</div>
          <div style={{
            fontSize: '10px', fontWeight: 700,
            color: !activePlaylist ? 'var(--accent)' : 'var(--text-secondary)',
          }}>All</div>
          <div style={{ fontSize: '9px', color: 'var(--text-dim)', fontFamily: 'var(--font-heading)' }}>
            {routes.length}
          </div>
        </button>

        {/* Playlist tiles */}
        {playlists.map(pl => {
          const count = routes.filter(r => pl.routeIds.includes(r.id)).length;
          const isActive = activePlaylist === pl.id;
          return (
            <button
              key={pl.id}
              onClick={() => setActivePlaylist(isActive ? null : pl.id)}
              onContextMenu={(e) => { e.preventDefault(); setConfirmDeletePlaylist(pl.id); }}
              style={{
                ...playlistTileStyle,
                border: isActive ? '2px solid var(--accent)' : '1.5px solid var(--border)',
                background: isActive ? 'var(--accent-dim)' : 'var(--bg-card)',
              }}
            >
              <div style={{
                fontSize: '11px', fontWeight: 700,
                color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
                textAlign: 'center', wordBreak: 'break-word', lineHeight: 1.2,
                display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                overflow: 'hidden', width: '100%',
              }}>{pl.name}</div>
              <div style={{ fontSize: '9px', color: 'var(--text-dim)', fontFamily: 'var(--font-heading)', marginTop: '3px' }}>
                {count} route{count !== 1 ? 's' : ''}
              </div>
            </button>
          );
        })}

        {/* New playlist button */}
        <button
          onClick={() => setShowNewPlaylist(true)}
          style={{
            ...playlistTileStyle,
            border: '1.5px dashed var(--border)',
            background: 'transparent',
          }}
        >
          <div style={{ fontSize: '18px', color: 'var(--text-dim)', lineHeight: 1 }}>+</div>
          <div style={{ fontSize: '9px', fontWeight: 600, color: 'var(--text-dim)', marginTop: '2px' }}>New</div>
        </button>
      </div>

      {/* New playlist input */}
      {showNewPlaylist && (
        <div style={{
          display: 'flex', gap: '6px', marginBottom: '12px', alignItems: 'center',
        }}>
          <input
            type="text"
            value={newPlaylistName}
            onChange={e => setNewPlaylistName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreatePlaylist()}
            placeholder="Playlist name..."
            autoFocus
            style={{
              flex: 1, padding: '8px 10px', borderRadius: '8px',
              border: '1.5px solid rgba(26,10,0,0.15)', background: 'var(--bg-input)',
              color: 'var(--text-primary)', fontSize: '13px',
            }}
          />
          <button onClick={handleCreatePlaylist} style={{
            padding: '8px 14px', borderRadius: '8px', border: 'none',
            background: 'var(--accent)', color: '#fff', fontSize: '12px',
            fontWeight: 700, cursor: 'pointer',
          }}>Create</button>
          <button onClick={() => { setShowNewPlaylist(false); setNewPlaylistName(''); }} style={{
            padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border)',
            background: 'transparent', color: 'var(--text-muted)', fontSize: '12px',
            fontWeight: 600, cursor: 'pointer',
          }}>✕</button>
        </div>
      )}

      {/* Delete playlist confirmation */}
      {confirmDeletePlaylist && (() => {
        const pl = playlists.find(p => p.id === confirmDeletePlaylist);
        return pl ? (
          <div style={{
            padding: '10px 12px', borderRadius: '10px', marginBottom: '12px',
            background: 'rgba(255,82,82,0.06)', border: '1px solid rgba(255,82,82,0.3)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <span style={{ fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 600 }}>
              Delete "{pl.name}"?
            </span>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button onClick={() => handleDeletePlaylist(pl.id)} style={{
                padding: '4px 12px', borderRadius: '6px', border: 'none',
                background: '#FF5252', color: '#fff', fontSize: '11px',
                fontWeight: 700, cursor: 'pointer',
              }}>Delete</button>
              <button onClick={() => setConfirmDeletePlaylist(null)} style={{
                padding: '4px 10px', borderRadius: '6px', border: '1px solid var(--border)',
                background: 'transparent', color: 'var(--text-muted)', fontSize: '11px',
                fontWeight: 600, cursor: 'pointer',
              }}>Cancel</button>
            </div>
          </div>
        ) : null;
      })()}

      {/* Active playlist header */}
      {activePlaylist && (() => {
        const pl = playlists.find(p => p.id === activePlaylist);
        const isRenaming = renamingPlaylist === pl?.id;
        return pl ? (
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            marginBottom: '10px', padding: '6px 0', gap: '8px',
          }}>
            {isRenaming ? (
              <div style={{ display: 'flex', gap: '6px', flex: 1, alignItems: 'center' }}>
                <input
                  type="text"
                  value={renameValue}
                  onChange={e => setRenameValue(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && renameValue.trim()) {
                      onRenamePlaylist(pl.id, renameValue);
                      setRenamingPlaylist(null);
                    } else if (e.key === 'Escape') {
                      setRenamingPlaylist(null);
                    }
                  }}
                  autoFocus
                  style={{
                    flex: 1, padding: '4px 8px', borderRadius: '6px',
                    border: '1.5px solid var(--accent)', background: 'var(--bg-input)',
                    color: 'var(--text-primary)', fontSize: '14px', fontWeight: 700,
                  }}
                />
                <button
                  onClick={() => {
                    if (renameValue.trim()) {
                      onRenamePlaylist(pl.id, renameValue);
                      setRenamingPlaylist(null);
                    }
                  }}
                  style={{
                    padding: '4px 10px', borderRadius: '6px', border: 'none',
                    background: 'var(--accent)', color: '#fff',
                    fontSize: '11px', fontWeight: 700, cursor: 'pointer',
                  }}
                >
                  Save
                </button>
                <button
                  onClick={() => setRenamingPlaylist(null)}
                  style={{
                    padding: '4px 8px', borderRadius: '6px',
                    border: '1px solid var(--border)', background: 'transparent',
                    color: 'var(--text-muted)', fontSize: '11px', cursor: 'pointer',
                  }}
                >
                  ✕
                </button>
              </div>
            ) : (
              <div
                onClick={() => { setRenamingPlaylist(pl.id); setRenameValue(pl.name); }}
                style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', cursor: 'pointer', flex: 1 }}
                title="Tap to rename"
              >
                {pl.name}
                <span style={{ marginLeft: '4px', fontSize: '10px', color: 'var(--text-dim)' }}>✏</span>
                <span style={{
                  marginLeft: '6px', fontSize: '11px', color: 'var(--text-dim)', fontWeight: 500,
                }}>
                  {baseRoutes.length} route{baseRoutes.length !== 1 ? 's' : ''}
                </span>
              </div>
            )}
            <button
              onClick={() => setConfirmDeletePlaylist(pl.id)}
              style={{
                padding: '4px 10px', borderRadius: '6px', border: '1px solid rgba(255,82,82,0.3)',
                background: 'rgba(255,82,82,0.06)', color: '#FF5252',
                fontSize: '10px', fontWeight: 700, cursor: 'pointer', flexShrink: 0,
              }}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="#FF5252" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 4h12M5.33 4V2.67a1.33 1.33 0 011.34-1.34h2.66a1.33 1.33 0 011.34 1.34V4M13.33 4v9.33a1.33 1.33 0 01-1.33 1.34H4a1.33 1.33 0 01-1.33-1.34V4" />
              </svg>
            </button>
          </div>
        ) : null;
      })()}

      {/* Filter panel */}
      {showFilters && (
        <div style={{
          padding: '12px', borderRadius: '12px', marginBottom: '12px',
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          boxShadow: '0 2px 8px rgba(26,10,0,0.06)',
        }}>
          {/* Grade range filter */}
          <div style={{ marginBottom: '10px' }}>
            <div style={filterLabelStyle}>Grade Range</div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <select
                value={filterGradeFrom}
                onChange={e => setFilterGradeFrom(e.target.value)}
                style={{ ...filterSelectStyle, flex: 1 }}
              >
                <option value="">From</option>
                {grades.map(g => <option key={g} value={g}>{g}</option>)}
              </select>
              <span style={{ fontSize: '12px', color: 'var(--text-dim)', fontWeight: 700 }}>→</span>
              <select
                value={filterGradeTo}
                onChange={e => setFilterGradeTo(e.target.value)}
                style={{ ...filterSelectStyle, flex: 1 }}
              >
                <option value="">To</option>
                {grades.map(g => <option key={g} value={g}>{g}</option>)}
              </select>
            </div>
          </div>

          {/* Show Hidden Angles toggle */}
          <div style={{ marginBottom: '10px' }}>
            <button
              onClick={() => setShowHiddenAngles(prev => !prev)}
              style={{
                padding: '6px 12px', borderRadius: '8px', fontSize: '11px',
                fontWeight: 700, cursor: 'pointer', width: '100%', textAlign: 'left',
                border: showHiddenAngles ? '1.5px solid var(--accent)' : '1.5px solid rgba(26,10,0,0.1)',
                background: showHiddenAngles ? 'var(--accent-dim)' : 'transparent',
                color: showHiddenAngles ? 'var(--accent)' : 'var(--text-muted)',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}
            >
              <span>Include Hidden Angle Grades</span>
              <span style={{
                width: '16px', height: '16px', borderRadius: '4px',
                border: showHiddenAngles ? '2px solid var(--accent)' : '2px solid rgba(26,10,0,0.2)',
                background: showHiddenAngles ? 'var(--accent)' : 'transparent',
                color: '#fff', fontSize: '10px', fontWeight: 900,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {showHiddenAngles ? '✓' : ''}
              </span>
            </button>
            <div style={{ fontSize: '9px', color: 'var(--text-dim)', marginTop: '3px', paddingLeft: '2px' }}>
              Also match routes where an angle-grade entry fits the grade range
            </div>
          </div>

          {/* Rating filter */}
          <div style={{ marginBottom: showAdvanced ? '10px' : 0 }}>
            <div style={filterLabelStyle}>Min Rating</div>
            <div style={{ display: 'flex', gap: '4px' }}>
              {[0, 1, 2, 3, 4, 5].map(r => (
                <button key={r} onClick={() => setFilterRating(r)}
                  style={{
                    padding: '4px 10px', borderRadius: '8px', fontSize: '12px',
                    border: filterRating === r ? '1.5px solid var(--accent)' : '1.5px solid rgba(26,10,0,0.1)',
                    background: filterRating === r ? 'var(--accent-dim)' : 'transparent',
                    color: filterRating === r ? 'var(--accent)' : 'var(--text-muted)',
                    cursor: 'pointer', fontWeight: 600,
                  }}
                >
                  {r === 0 ? 'Any' : `${r}★+`}
                </button>
              ))}
            </div>
          </div>

          {/* Advanced toggle */}
          <button
            onClick={() => setShowAdvanced(prev => !prev)}
            style={{
              marginTop: '8px', padding: '4px 0', border: 'none', background: 'none',
              color: 'var(--accent)', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
            }}
          >
            {showAdvanced ? '▾ Hide advanced' : '▸ Advanced filters'}
          </button>

          {showAdvanced && (
            <>
              {/* Hold type filter */}
              <div style={{ marginTop: '8px', marginBottom: '10px' }}>
                <div style={filterLabelStyle}>Hold Types</div>
                <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                  {HOLD_TYPES.map(ht => {
                    const on = filterHoldTypes.includes(ht);
                    return (
                      <button key={ht} onClick={() => toggleFilter(filterHoldTypes, setFilterHoldTypes, ht)}
                        style={{
                          padding: '3px 8px', borderRadius: '8px', fontSize: '10px',
                          border: on ? '1.5px solid var(--accent)' : '1.5px solid rgba(26,10,0,0.1)',
                          background: on ? 'var(--accent-dim)' : 'transparent',
                          color: on ? 'var(--accent)' : 'var(--text-muted)',
                          cursor: 'pointer', fontWeight: 500,
                        }}
                      >
                        {ht}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Style filter */}
              <div>
                <div style={filterLabelStyle}>Style</div>
                <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                  {STYLES.map(s => {
                    const on = filterStyles.includes(s);
                    return (
                      <button key={s} onClick={() => toggleFilter(filterStyles, setFilterStyles, s)}
                        style={{
                          padding: '3px 8px', borderRadius: '8px', fontSize: '10px',
                          border: on ? '1.5px solid var(--accent)' : '1.5px solid rgba(26,10,0,0.1)',
                          background: on ? 'var(--accent-dim)' : 'transparent',
                          color: on ? 'var(--accent)' : 'var(--text-muted)',
                          cursor: 'pointer', fontWeight: 500,
                        }}
                      >
                        {s}
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          {/* Clear filters */}
          {hasActiveFilters && (
            <button
              onClick={clearFilters}
              style={{
                marginTop: '10px', padding: '6px 14px', borderRadius: '8px',
                border: '1px solid rgba(255,82,82,0.3)', background: 'rgba(255,82,82,0.06)',
                color: '#FF5252', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
              }}
            >
              ✕ Clear all filters
            </button>
          )}
        </div>
      )}

      {/* Filtered/sorted count */}
      {(hasActiveFilters || hideSent) && (
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '8px', fontWeight: 600 }}>
          Showing {sorted.length} of {baseRoutes.length} routes
        </div>
      )}

      {/* Route cards */}
      {baseRoutes.length === 0 && !activePlaylist ? (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-dim)' }}>
          <div style={{ fontSize: '40px', marginBottom: '12px', color: 'var(--yellow)', opacity: 0.4 }}>◇</div>
          <div style={{ fontSize: '14px', fontWeight: 500, color: 'var(--text-muted)' }}>
            No routes yet
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-dim)', marginTop: '4px' }}>
            Create your first route on the board
          </div>
        </div>
      ) : baseRoutes.length === 0 && activePlaylist ? (
        <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-dim)' }}>
          <div style={{ fontSize: '14px', fontWeight: 500, color: 'var(--text-muted)' }}>
            No routes in this playlist
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-dim)', marginTop: '4px' }}>
            Add routes from the route detail page
          </div>
        </div>
      ) : sorted.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-dim)' }}>
          <div style={{ fontSize: '14px', fontWeight: 500, color: 'var(--text-muted)' }}>
            No routes match filters
          </div>
        </div>
      ) : (
        sorted.map(route => (
          <RouteCard
            key={route.id}
            route={route}
            sent={urd[route.id]?.sent || false}
            communityRating={cr[route.id]?.avg || 0}
            ratingCount={cr[route.id]?.count || 0}
            onView={() => onViewRoute(route)}
            onRate={(rating) => onRateRoute(route.id, rating)}
            onToggleSent={() => onToggleSent(route.id)}
            missingHoldCount={getMissingHoldCount(route, holdIdSet)}
          />
        ))
      )}
    </div>
  );
}

const playlistTileStyle = {
  width: '80px', minWidth: '80px', height: '60px',
  borderRadius: '12px', padding: '6px 8px',
  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
  cursor: 'pointer', flexShrink: 0,
  boxShadow: '0 2px 6px rgba(26,10,0,0.06)',
};

const filterLabelStyle = {
  fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)',
  letterSpacing: '1px', textTransform: 'uppercase', marginBottom: '6px',
};

const filterSelectStyle = {
  padding: '6px 10px', borderRadius: '8px',
  border: '1.5px solid rgba(26,10,0,0.15)', background: 'var(--bg-input)',
  color: 'var(--text-primary)', fontSize: '13px', fontFamily: 'var(--font-heading)',
};
