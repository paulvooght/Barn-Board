import { useState, useMemo, useEffect } from 'react';
import RouteCard from './RouteCard';
import Icon from './Icon';
import VideoBadge from './VideoBadge';
import GradeRange from './GradeRange';
import { HOLD_TYPES, STYLES, V_GRADE_INDEX, FONT_GRADE_INDEX, displayGrade, getYouTubeId } from '../utils/constants';

const SORT_OPTIONS = [
  { key: 'date',   label: 'Date' },
  { key: 'grade',  label: 'Grade' },
  { key: 'rating', label: 'Rating' },
];

// Sentinel for activePlaylist: the "Recent" tile (routes from the last session).
// Not a real playlist, so playlists.find(...) on it returns undefined.
const RECENT_ID = '__recent__';

function getMissingHoldCount(route, holdIdSet) {
  return Object.keys(route.holds || {}).filter(id => !holdIdSet.has(id)).length;
}

export default function RouteList({
  routes, grades, gradeSystem, playlists, allHolds,
  userRouteData, communityRatings, communityGrades,
  onViewRoute, onCreateNew, onRateRoute, onToggleSent,
  onCreatePlaylist, onDeletePlaylist, onRenamePlaylist, onRemoveRouteFromPlaylist,
  onFetchSharedPlaylists, onTogglePlaylistShared, onAddSharedPlaylist, userId,
  recentSession, showRecentTile,
  // Video icons + filters. routeVideoFlags is { [routeId]: { private, public } }, or null
  // until the first fetch lands (null is "not loaded", never "no videos").
  isVideoAdmin, routeVideoFlags, videoFlagsFailed, onRetryVideoFlags,
  // A ref owned by App: where the filters are kept while a route is open (see below).
  filterMemory,
}) {
  const urd = userRouteData || {};
  const cr = communityRatings || {};
  const cg = communityGrades || {};
  // This list unmounts whenever a route is opened, which would reset every filter on the way back
  // (an admin reviewing private videos would have to set the Private filter again after each one).
  // So the filters are saved into filterMemory as they change and read back here on mount.
  // The panel being open, the sort and the active playlist are deliberately NOT remembered.
  const [saved] = useState(() => filterMemory?.current || {});
  const [showFilters, setShowFilters] = useState(false);
  // Open straight away when an Advanced filter is active, so none is ever hidden.
  const [showAdvanced, setShowAdvanced] = useState(
    () => !!saved.filterSetter?.trim() || !!saved.filterRatings?.length || !!saved.filterHoldTypes?.length || !!saved.filterStyles?.length
  );
  const [showSortMenu, setShowSortMenu] = useState(false);
  const [activePlaylist, setActivePlaylist] = useState(null);
  const [showNewPlaylist, setShowNewPlaylist] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [confirmDeletePlaylist, setConfirmDeletePlaylist] = useState(null);
  const [renamingPlaylist, setRenamingPlaylist] = useState(null); // playlist id
  const [renameValue, setRenameValue] = useState('');

  // Browse shared playlists
  const [showBrowse, setShowBrowse] = useState(false);
  const [sharedPlaylists, setSharedPlaylists] = useState([]);
  const [browseSearch, setBrowseSearch] = useState('');
  const [browseLoading, setBrowseLoading] = useState(false);
  const [addedIds, setAddedIds] = useState({}); // plId → true (for "Added ✓" feedback)

  // Sort state — key + ascending flag. Tap same key to flip direction.
  const [sortKey, setSortKey] = useState('date');
  const [sortAsc, setSortAsc] = useState(false); // date defaults newest-first

  // Hold ID set for missing hold detection
  const holdIdSet = useMemo(() => new Set((allHolds || []).map(h => h.id)), [allHolds]);

  // Hide sends toggle (top-level, not inside filter panel)
  const [hideSent, setHideSent] = useState(saved.hideSent ?? false);

  // Show hidden angle grades in filter results
  const [showHiddenAngles, setShowHiddenAngles] = useState(saved.showHiddenAngles ?? false);

  // Filter state. A grade of '' means no limit at that end of the slider.
  const [filterGradeFrom, setFilterGradeFrom] = useState(saved.filterGradeFrom ?? '');
  const [filterGradeTo, setFilterGradeTo] = useState(saved.filterGradeTo ?? '');
  const [filterRatings, setFilterRatings] = useState(saved.filterRatings ?? []); // star counts, any mix
  const [filterHoldTypes, setFilterHoldTypes] = useState(saved.filterHoldTypes ?? []);
  const [filterStyles, setFilterStyles] = useState(saved.filterStyles ?? []);
  const [filterSetter, setFilterSetter] = useState(saved.filterSetter ?? '');
  // Video filter: an admin has Private / Public, a climber has one "Has a video" switch.
  // Each mode ignores the other's states (the mode can change in Settings while one is remembered).
  const [filterVideoPrivate, setFilterVideoPrivate] = useState(saved.filterVideoPrivate ?? false);
  const [filterVideoPublic, setFilterVideoPublic] = useState(saved.filterVideoPublic ?? false);
  const [filterVideoAny, setFilterVideoAny] = useState(saved.filterVideoAny ?? false);

  useEffect(() => {
    if (!filterMemory) return;
    filterMemory.current = {
      hideSent, showHiddenAngles, filterGradeFrom, filterGradeTo, filterRatings,
      filterHoldTypes, filterStyles, filterSetter,
      filterVideoPrivate, filterVideoPublic, filterVideoAny,
    };
  }, [filterMemory, hideSent, showHiddenAngles, filterGradeFrom, filterGradeTo, filterRatings,
    filterHoldTypes, filterStyles, filterSetter, filterVideoPrivate, filterVideoPublic, filterVideoAny]);

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

  const gradeIndex = gradeSystem === 'Font' ? FONT_GRADE_INDEX : V_GRADE_INDEX;
  // A route is saved with the grade its setter chose, in either system. App passes routes
  // already converted for the viewer, so converting again here is harmless and keeps
  // grade comparisons right if a raw grade ever reaches this screen.
  const gradeRank = (grade) => gradeIndex[displayGrade(grade, gradeSystem)] ?? -1;

  // A remembered grade from the other grade system (the owner can switch V/Font in Settings)
  // isn't on this slider, so it counts as no limit.
  const activeFrom = gradeIndex[filterGradeFrom] != null ? filterGradeFrom : '';
  const activeTo = gradeIndex[filterGradeTo] != null ? filterGradeTo : '';
  // Slider stops run up to V10 (or its Font equivalent). The top stop means "that grade
  // and harder": few routes go higher, and more stops wouldn't fit a phone.
  const sliderTop = gradeIndex[displayGrade('V10', gradeSystem)] ?? grades.length - 1;
  const sliderGrades = grades.slice(0, sliderTop + 1);
  const sliderLabels = sliderGrades.map((g, i) => (i === sliderTop ? (g.endsWith('+') ? `${g}↑` : `${g}+`) : g));
  const sliderLo = activeFrom ? gradeIndex[activeFrom] : 0;
  const sliderHi = activeTo ? gradeIndex[activeTo] : sliderTop;

  // A YouTube link is public by nature, so it counts as a public video.
  const videoFlagsOf = (route) => {
    const f = routeVideoFlags?.[route.id];
    return { private: !!f?.private, public: !!f?.public || !!getYouTubeId(route.youtubeUrl) };
  };
  // The icon on a card. Private wins on a route with both, so anything still to be reviewed stands out.
  const videoStateOf = (route) => {
    const f = videoFlagsOf(route);
    return f.private ? 'private' : f.public ? 'public' : null;
  };
  const videoFilterOn = isVideoAdmin ? (filterVideoPrivate || filterVideoPublic) : filterVideoAny;

  // Get routes for current view (all or playlist)
  const isRecent = activePlaylist === RECENT_ID;
  let baseRoutes = routes;
  if (isRecent) {
    // Guard: recentSession can be null (e.g. after switching wall) while Recent is selected
    baseRoutes = (recentSession?.routeIds || []).map(id => routes.find(r => r.id === id)).filter(Boolean);
  } else if (activePlaylist) {
    const pl = playlists.find(p => p.id === activePlaylist);
    if (pl) {
      baseRoutes = routes.filter(r => pl.routeIds.includes(r.id));
    }
  }

  // Apply hide-sent toggle
  let filtered = hideSent ? baseRoutes.filter(r => !urd[r.id]?.sent) : baseRoutes;

  // Grade range filter — the headline grade, and optionally the angle grades too
  if (activeFrom || activeTo) {
    const lo = activeFrom ? gradeIndex[activeFrom] : 0;
    const hi = activeTo ? gradeIndex[activeTo] : Infinity; // no upper limit at the slider's top stop
    const inRange = (g) => {
      const i = gradeRank(g);
      return i >= 0 && i >= lo && i <= hi;
    };
    filtered = filtered.filter(r => inRange(r.grade) || (showHiddenAngles && (r.angleGrades || []).some(ag => inRange(ag.grade))));
  }

  // Rounded the same way the card rounds its stars, so a route showing 4 stars matches 4★.
  // Unrated routes round to 0, which no button matches.
  if (filterRatings.length > 0) filtered = filtered.filter(r => filterRatings.includes(Math.round(cr[r.id]?.avg || 0)));
  if (filterHoldTypes.length > 0) filtered = filtered.filter(r =>
    filterHoldTypes.every(ht => r.holdTypes?.includes(ht))
  );
  if (filterStyles.length > 0) filtered = filtered.filter(r =>
    filterStyles.every(s => r.styles?.includes(s))
  );
  if (filterSetter.trim()) {
    const q = filterSetter.trim().toLowerCase();
    filtered = filtered.filter(r => r.setter && r.setter.toLowerCase().includes(q));
  }
  // Video filter. Skipped until the video list has loaded; the list area says "Loading videos…" meanwhile.
  if (videoFilterOn && routeVideoFlags) {
    filtered = filtered.filter(r => {
      const f = videoFlagsOf(r);
      return isVideoAdmin
        ? (filterVideoPrivate && f.private) || (filterVideoPublic && f.public)
        : f.private || f.public;
    });
  }

  // Sort (in Recent view, "date" means the order the routes were logged)
  const recentOrder = isRecent ? (recentSession?.routeIds || []) : null;
  const sorted = [...filtered].sort((a, b) => {
    let cmp = 0;
    if (sortKey === 'date' && recentOrder) {
      cmp = recentOrder.indexOf(a.id) - recentOrder.indexOf(b.id);
    } else if (sortKey === 'date') {
      cmp = new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
    } else if (sortKey === 'grade') {
      cmp = gradeRank(a.grade) - gradeRank(b.grade);
    } else if (sortKey === 'rating') {
      cmp = (cr[a.id]?.avg || 0) - (cr[b.id]?.avg || 0);
    }
    return sortAsc ? cmp : -cmp;
  });

  const hasActiveFilters = activeFrom || activeTo || filterRatings.length > 0 || filterHoldTypes.length > 0 || filterStyles.length > 0 || showHiddenAngles || filterSetter.trim() || videoFilterOn;
  // Setter, hold types and style live in the Advanced section: flag it when one of them is on
  const advancedActive = !!filterSetter.trim() || filterRatings.length > 0 || filterHoldTypes.length > 0 || filterStyles.length > 0;
  // Video filter on but the video list hasn't loaded: the list can't be filtered honestly yet
  const videoUnloaded = videoFilterOn && routeVideoFlags === null;
  // How many routes in the current view have each kind of video (admin buttons)
  const videoCounts = showFilters && isVideoAdmin && routeVideoFlags
    ? baseRoutes.reduce((acc, r) => {
        const f = videoFlagsOf(r);
        if (f.private) acc.private++;
        if (f.public) acc.public++;
        return acc;
      }, { private: 0, public: 0 })
    : null;

  const clearFilters = () => {
    setFilterGradeFrom(''); setFilterGradeTo(''); setFilterRatings([]);
    setFilterHoldTypes([]); setFilterStyles([]); setShowHiddenAngles(false);
    setFilterSetter('');
    setFilterVideoPrivate(false); setFilterVideoPublic(false); setFilterVideoAny(false);
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

  const handleOpenBrowse = async () => {
    setShowBrowse(true);
    setBrowseSearch('');
    setBrowseLoading(true);
    const data = await onFetchSharedPlaylists();
    setSharedPlaylists(data);
    setBrowseLoading(false);
  };

  const handleAddSharedPlaylist = (pl) => {
    onAddSharedPlaylist(pl);
    setAddedIds(prev => ({ ...prev, [pl.id]: true }));
    setTimeout(() => setAddedIds(prev => { const n = { ...prev }; delete n[pl.id]; return n; }), 2000);
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
          onClick={() => { setActivePlaylist(null); setShowBrowse(false); }}
          style={{
            ...playlistTileStyle,
            border: !activePlaylist && !showBrowse ? '2px solid var(--accent)' : '1.5px solid var(--border)',
            background: !activePlaylist && !showBrowse ? 'var(--accent-dim)' : 'var(--bg-card)',
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

        {/* "Recent" tile — routes from the last session on this wall */}
        {showRecentTile && (() => {
          const isActive = isRecent && !showBrowse;
          return (
            <button
              onClick={() => { setActivePlaylist(isRecent ? null : RECENT_ID); setShowBrowse(false); }}
              style={{
                ...playlistTileStyle,
                border: isActive ? '2px solid var(--accent)' : '1.5px solid var(--border)',
                background: isActive ? 'var(--accent-dim)' : 'var(--bg-card)',
              }}
            >
              <div style={{ fontSize: '20px', marginBottom: '2px' }}>↺</div>
              <div style={{
                fontSize: '10px', fontWeight: 700,
                color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
              }}>Recent</div>
              <div style={{
                fontSize: '9px', fontFamily: 'var(--font-heading)',
                color: recentSession?.live ? 'var(--accent)' : 'var(--text-dim)',
                fontWeight: recentSession?.live ? 700 : 400,
              }}>
                {recentSession?.live
                  ? 'Live'
                  : `${recentSession?.routeIds.length || 0} route${recentSession?.routeIds.length === 1 ? '' : 's'}`}
              </div>
            </button>
          );
        })()}

        {/* Playlist tiles */}
        {playlists.map(pl => {
          const count = routes.filter(r => pl.routeIds.includes(r.id)).length;
          const isActive = activePlaylist === pl.id;
          return (
            <button
              key={pl.id}
              onClick={() => { setActivePlaylist(isActive ? null : pl.id); setShowBrowse(false); }}
              onContextMenu={(e) => { e.preventDefault(); setConfirmDeletePlaylist(pl.id); }}
              style={{
                ...playlistTileStyle, position: 'relative',
                border: isActive ? '2px solid var(--accent)' : '1.5px solid var(--border)',
                background: isActive ? 'var(--accent-dim)' : 'var(--bg-card)',
              }}
            >
              {pl.shared && (
                <div style={{
                  position: 'absolute', top: '4px', right: '4px',
                  width: '7px', height: '7px', borderRadius: '50%',
                  background: '#4ade80',
                }} title="Shared publicly" />
              )}
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

        {/* Browse shared playlists button */}
        <button
          onClick={handleOpenBrowse}
          style={{
            ...playlistTileStyle,
            border: showBrowse ? '2px solid var(--accent)' : '1.5px dashed var(--border)',
            background: showBrowse ? 'var(--accent-dim)' : 'transparent',
          }}
        >
          <div style={{ lineHeight: 1, color: showBrowse ? 'var(--accent)' : 'var(--text-dim)' }}><Icon name="search" size={18}/></div>
          <div style={{ fontSize: '9px', fontWeight: 600, color: showBrowse ? 'var(--accent)' : 'var(--text-dim)', marginTop: '2px' }}>Browse</div>
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

      {/* Recent (last session) header — no rename/share/delete */}
      {isRecent && (
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          marginBottom: '10px', padding: '6px 0', gap: '8px',
        }}>
          <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', flex: 1 }}>
            {recentSession?.live ? 'Session in progress' : 'Last session'}
            {recentSession && (
              <span style={{ marginLeft: '6px', fontSize: '11px', color: 'var(--text-dim)', fontWeight: 500 }}>
                {new Date(recentSession.startTime).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}
                {' · '}{baseRoutes.length} route{baseRoutes.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Active playlist header */}
      {activePlaylist && !isRecent && (() => {
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
                <span style={{ marginLeft: '4px', color: 'var(--text-dim)' }}><Icon name="pencil" size={10}/></span>
                <span style={{
                  marginLeft: '6px', fontSize: '11px', color: 'var(--text-dim)', fontWeight: 500,
                }}>
                  {baseRoutes.length} route{baseRoutes.length !== 1 ? 's' : ''}
                </span>
              </div>
            )}
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexShrink: 0 }}>
              {/* Share toggle — only for playlists the user created (not subscribed copies) */}
              {!pl.subscribedFrom && onTogglePlaylistShared && (
                <button
                  onClick={() => onTogglePlaylistShared(pl.id, !pl.shared)}
                  title={pl.shared ? 'Make private' : 'Share publicly'}
                  style={{
                    padding: '4px 8px', borderRadius: '6px', border: 'none', cursor: 'pointer',
                    background: pl.shared ? 'rgba(74,222,128,0.15)' : 'rgba(26,10,0,0.06)',
                    color: pl.shared ? '#16a34a' : 'var(--text-muted)',
                    fontSize: '11px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '3px',
                  }}
                >
                  <Icon name={pl.shared ? 'link' : 'lock'} size={12}/>
                  <span>{pl.shared ? 'Public' : 'Private'}</span>
                </button>
              )}
              <button
                onClick={() => setConfirmDeletePlaylist(pl.id)}
                style={{
                  padding: '4px 10px', borderRadius: '6px', border: '1px solid rgba(255,82,82,0.3)',
                  background: 'rgba(255,82,82,0.06)', color: '#FF5252',
                  fontSize: '10px', fontWeight: 700, cursor: 'pointer',
                }}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="#FF5252" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 4h12M5.33 4V2.67a1.33 1.33 0 011.34-1.34h2.66a1.33 1.33 0 011.34 1.34V4M13.33 4v9.33a1.33 1.33 0 01-1.33 1.34H4a1.33 1.33 0 01-1.33-1.34V4" />
                </svg>
              </button>
            </div>
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
          {/* Grade range filter — two handles on one bar. '' = no limit at that end. */}
          <div style={{ marginBottom: '10px' }}>
            <div style={filterLabelStyle}>Grade {sliderLabels[sliderLo]} – {sliderLabels[sliderHi]}</div>
            <GradeRange
              labels={sliderLabels}
              lo={sliderLo}
              hi={sliderHi}
              onChange={(lo, hi) => {
                setFilterGradeFrom(lo === 0 ? '' : sliderGrades[lo]);
                setFilterGradeTo(hi === sliderTop ? '' : sliderGrades[hi]);
              }}
            />
          </div>

          {/* One row: include angle grades, then the video filter
              (admin: Private / Public with counts; climber: "Has a video") */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '10px' }}>
            <button
              type="button" aria-pressed={showHiddenAngles} onClick={() => setShowHiddenAngles(prev => !prev)}
              title="Also match routes where an angle-grade entry fits the grade range"
              style={{ ...videoToggleStyle(showHiddenAngles), ...filterRowItem, lineHeight: 1.15 }}
            >
              Include angle grades
            </button>
            {isVideoAdmin ? (
              [
                { key: 'private', label: 'Private', on: filterVideoPrivate, toggle: () => setFilterVideoPrivate(prev => !prev) },
                { key: 'public', label: 'Public', on: filterVideoPublic, toggle: () => setFilterVideoPublic(prev => !prev) },
              ].map(({ key, label, on, toggle }) => (
                <button
                  key={key} type="button" aria-pressed={on} onClick={toggle}
                  style={{ ...videoToggleStyle(on), ...filterRowItem }}
                >
                  <span aria-hidden="true" style={{ display: 'inline-flex' }}><VideoBadge state={key} size={20} /></span>
                  <span>{label}</span>
                  {videoCounts && (
                    <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 800 }}>{videoCounts[key]}</span>
                  )}
                </button>
              ))
            ) : (
              <button
                type="button" aria-pressed={filterVideoAny} onClick={() => setFilterVideoAny(prev => !prev)}
                style={{ ...videoToggleStyle(filterVideoAny), ...filterRowItem }}
              >
                <Icon name="video" size={16} />
                <span>Has a video</span>
              </button>
            )}
          </div>

          {/* Advanced on the left, Clear filters on the right */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
            <button
              type="button" aria-expanded={showAdvanced} onClick={() => setShowAdvanced(prev => !prev)}
              style={{
                ...filterPill,
                border: showAdvanced || advancedActive ? '1.5px solid var(--accent)' : '1.5px solid rgba(26,10,0,0.15)',
                background: showAdvanced || advancedActive ? 'var(--accent-dim)' : 'transparent',
                color: showAdvanced || advancedActive ? 'var(--accent)' : 'var(--text-secondary)',
              }}
            >
              {showAdvanced ? '▾' : '▸'} Advanced{!showAdvanced && advancedActive ? ' ●' : ''}
            </button>
            {hasActiveFilters && (
              <button
                type="button" onClick={clearFilters}
                style={{ ...filterPill, border: '1.5px solid rgba(255,82,82,0.3)', background: 'rgba(255,82,82,0.06)', color: '#FF5252' }}
              >
                ✕ Clear filters
              </button>
            )}
          </div>

          {showAdvanced && (
            <>
              {/* Setter filter */}
              <div style={{ marginTop: '12px', marginBottom: '10px' }}>
                <div style={filterLabelStyle}>Setter</div>
                <input
                  type="text"
                  value={filterSetter}
                  onChange={e => setFilterSetter(e.target.value)}
                  placeholder="Search setter name..."
                  style={{
                    width: '100%', padding: '7px 10px', borderRadius: '8px', boxSizing: 'border-box',
                    border: filterSetter.trim()
                      ? '1.5px solid var(--accent)'
                      : '1.5px solid rgba(26,10,0,0.15)',
                    background: filterSetter.trim() ? 'var(--accent-dim)' : 'var(--bg-input)',
                    color: 'var(--text-primary)', fontSize: '12px',
                  }}
                />
              </div>

              {/* Rating filter — any mix, e.g. 3, 4 and 5 stars */}
              <div style={{ marginBottom: '10px' }}>
                <div style={filterLabelStyle}>Rating</div>
                <div style={{ display: 'flex', gap: '4px' }}>
                  {[1, 2, 3, 4, 5].map(r => {
                    const on = filterRatings.includes(r);
                    return (
                      <button
                        key={r} type="button" aria-pressed={on} aria-label={`${r} star${r > 1 ? 's' : ''}`}
                        onClick={() => toggleFilter(filterRatings, setFilterRatings, r)}
                        style={{
                          flex: 1, minHeight: '44px', borderRadius: '8px', fontSize: '12px',
                          border: on ? '1.5px solid var(--accent)' : '1.5px solid rgba(26,10,0,0.1)',
                          background: on ? 'var(--accent-dim)' : 'transparent',
                          color: on ? 'var(--accent)' : 'var(--text-muted)',
                          cursor: 'pointer', fontWeight: 600,
                        }}
                      >
                        {r}★
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Hold type filter */}
              <div style={{ marginBottom: '10px' }}>
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

        </div>
      )}

      {/* Filtered/sorted count (not while the video list is missing: the number would be wrong) */}
      {(hasActiveFilters || hideSent) && !videoUnloaded && (
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '8px', fontWeight: 600 }}>
          Showing {sorted.length} of {baseRoutes.length} routes
        </div>
      )}

      {/* A refresh of the video list failed: the list below is the last good one */}
      {!showBrowse && videoFilterOn && routeVideoFlags !== null && videoFlagsFailed && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
          fontSize: '11px', color: 'var(--text-muted)', marginBottom: '8px', fontWeight: 600,
        }}>
          <span>Couldn't refresh videos.</span>
          <button type="button" onClick={onRetryVideoFlags} style={videoRetryStyle}>Retry</button>
        </div>
      )}

      {/* Browse panel — replaces route list when active */}
      {showBrowse ? (
        <div>
          {/* Header */}
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            marginBottom: '10px',
          }}>
            <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>
              Browse Shared Playlists
            </span>
            <button
              onClick={() => setShowBrowse(false)}
              style={{
                padding: '2px 8px', borderRadius: '6px', border: '1px solid var(--border)',
                background: 'transparent', color: 'var(--text-muted)',
                fontSize: '12px', cursor: 'pointer',
              }}
            >✕</button>
          </div>
          {/* Search */}
          <input
            type="text"
            value={browseSearch}
            onChange={e => setBrowseSearch(e.target.value)}
            placeholder="Search playlists or creator..."
            style={{
              width: '100%', padding: '7px 10px', borderRadius: '8px', boxSizing: 'border-box',
              border: '1.5px solid rgba(26,10,0,0.15)', background: 'var(--bg-input)',
              color: 'var(--text-primary)', fontSize: '13px', marginBottom: '10px',
            }}
          />
          {/* Results */}
          {browseLoading ? (
            <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-dim)', fontSize: '12px' }}>
              Loading...
            </div>
          ) : (() => {
            const q = browseSearch.trim().toLowerCase();
            const results = sharedPlaylists.filter(p => {
              if (p.user_id === userId) return false; // hide own
              if (!q) return true;
              return p.name.toLowerCase().includes(q) || p.creator_name.toLowerCase().includes(q);
            });
            if (results.length === 0) {
              return (
                <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-dim)', fontSize: '12px' }}>
                  No playlists found
                </div>
              );
            }
            return results.map(p => (
              <div key={p.id} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '10px 12px', borderRadius: '10px', marginBottom: '6px',
                background: 'var(--bg-card)', border: '1px solid var(--border)',
              }}>
                <div style={{ flex: 1, minWidth: 0, marginRight: '10px' }}>
                  <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {p.name}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: '2px' }}>
                    by {p.creator_name} · {(p.route_ids || []).length} route{(p.route_ids || []).length !== 1 ? 's' : ''}
                  </div>
                </div>
                <button
                  onClick={() => handleAddSharedPlaylist(p)}
                  disabled={!!addedIds[p.id]}
                  style={{
                    padding: '5px 12px', borderRadius: '8px', border: 'none', flexShrink: 0,
                    background: addedIds[p.id] ? '#4ade80' : 'var(--accent)',
                    color: '#fff', fontSize: '11px', fontWeight: 700,
                    cursor: addedIds[p.id] ? 'default' : 'pointer',
                    transition: 'background 0.2s',
                  }}
                >
                  {addedIds[p.id] ? 'Added ✓' : 'Add'}
                </button>
              </div>
            ));
          })()}
        </div>
      ) : videoUnloaded ? (
        /* Video filter is on but the video list isn't here yet (or failed): never show "no videos" */
        <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-dim)' }}>
          <div style={{ fontSize: '14px', fontWeight: 500, color: 'var(--text-muted)' }}>
            {videoFlagsFailed ? "Couldn't load videos." : 'Loading videos…'}
          </div>
          {videoFlagsFailed && (
            <button type="button" onClick={onRetryVideoFlags} style={{ ...videoRetryStyle, marginTop: '10px' }}>Retry</button>
          )}
        </div>
      ) : (
        /* Route cards */
        baseRoutes.length === 0 && isRecent ? (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-dim)' }}>
            <div style={{ fontSize: '14px', fontWeight: 500, color: 'var(--text-muted)' }}>
              No session yet
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-dim)', marginTop: '4px' }}>
              Press Start Session in the Sessions tab, then log tries and sends
            </div>
          </div>
        ) : baseRoutes.length === 0 && !activePlaylist ? (
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
              flashed={urd[route.id]?.flashed || false}
              attempted={urd[route.id]?.attempted || false}
              communityRating={cr[route.id]?.avg || 0}
              ratingCount={cr[route.id]?.count || 0}
              communityGrade={cg[route.id]?.headline?.consensus || null}
              videoState={videoStateOf(route)}
              onView={() => onViewRoute(route, sorted.map(r => r.id))}
              onRate={(rating) => onRateRoute(route.id, rating)}
              onToggleSent={() => onToggleSent(route.id)}
              missingHoldCount={getMissingHoldCount(route, holdIdSet)}
              onRemoveFromPlaylist={activePlaylist && !isRecent ? () => onRemoveRouteFromPlaylist(route.id, activePlaylist) : null}
            />
          ))
        )
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

// One button in the "Include angle grades + video" row: an equal share of the row,
// wrapping to a second line only on the narrowest phones.
const filterRowItem = { flex: '1 1 84px', minWidth: 0, padding: '0 6px', fontSize: '11px', textAlign: 'center' };

const filterPill = {
  minHeight: '40px', padding: '0 14px', borderRadius: '20px', fontSize: '12px', fontWeight: 700,
  cursor: 'pointer', whiteSpace: 'nowrap',
};

const filterLabelStyle = {
  fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)',
  letterSpacing: '1px', textTransform: 'uppercase', marginBottom: '6px',
};

// A video-filter toggle: at least 44px tall; "on" matches the other filter buttons
const videoToggleStyle = (on) => ({
  minHeight: '44px', padding: '0 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
  border: on ? '1.5px solid var(--accent)' : '1.5px solid rgba(26,10,0,0.1)',
  background: on ? 'var(--accent-dim)' : 'transparent',
  color: on ? 'var(--accent)' : 'var(--text-muted)',
});

const videoRetryStyle = {
  minHeight: '44px', padding: '0 16px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
  cursor: 'pointer', border: '1.5px solid var(--accent)', background: 'var(--accent-dim)', color: 'var(--accent)',
};
