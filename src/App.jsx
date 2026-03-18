import { useState, useCallback } from 'react';
import BoardView from './components/BoardView';
import ModeSelector from './components/ModeSelector';
import RouteForm from './components/RouteForm';
import RouteList from './components/RouteList';
import Settings from './components/Settings';
import HoldEditorView from './components/HoldEditorView';
import { useLocalStorage } from './hooks/useLocalStorage';
import { useCustomHolds } from './hooks/useCustomHolds';
import { V_GRADES, FONT_GRADES, SELECTION_MODES, MODE_COLORS } from './utils/constants';

const IMG_SRC = '/Board background.jpg';

export default function App() {
  // Persistent state
  const [routes, setRoutes] = useLocalStorage('barnboard_routes', []);
  const [settings, setSettings] = useLocalStorage('barnboard_settings', { gradeSystem: 'V' });

  // Hold management (auto-detected + custom + overrides)
  const { allHolds, addHold, updateHold, deleteHold } = useCustomHolds();

  // UI state
  // view: board | create | routes | settings | viewRoute | addHold | editHold
  const [view, setView]                 = useState('board');
  const [selectionMode, setSelectionMode] = useState(SELECTION_MODES.HAND);
  const [holdSelection, setHoldSelection] = useState({});
  const [viewingRoute, setViewingRoute]   = useState(null);
  const [editingHold, setEditingHold]     = useState(null);
  const [editingRouteId, setEditingRouteId] = useState(null);

  // Route form state
  const [routeName, setRouteName]   = useState('');
  const [routeGrade, setRouteGrade] = useState('V3');
  const [routeAngle, setRouteAngle] = useState(30);
  const [holdTypes, setHoldTypes]   = useState([]);
  const [techniques, setTechniques] = useState([]);
  const [styles, setStyles]         = useState([]);

  const grades = settings.gradeSystem === 'V' ? V_GRADES : FONT_GRADES;

  const resetCreate = useCallback(() => {
    setHoldSelection({});
    setRouteName('');
    setRouteGrade(settings.gradeSystem === 'V' ? 'V3' : '6A');
    setRouteAngle(30);
    setHoldTypes([]);
    setTechniques([]);
    setStyles([]);
    setSelectionMode(SELECTION_MODES.HAND);
    setEditingRouteId(null);
  }, [settings.gradeSystem]);

  const handleHoldTap = useCallback((holdId) => {
    setHoldSelection(prev => {
      const next = { ...prev };
      if (next[holdId] === selectionMode) {
        delete next[holdId];
      } else {
        next[holdId] = selectionMode;
      }
      return next;
    });
  }, [selectionMode]);

  const saveRoute = useCallback(() => {
    if (!routeName.trim() || Object.keys(holdSelection).length === 0) return;
    if (editingRouteId) {
      setRoutes(prev => prev.map(r => r.id === editingRouteId ? {
        ...r,
        name: routeName.trim(),
        grade: routeGrade,
        angle: routeAngle,
        holds: { ...holdSelection },
        holdTypes, techniques, styles,
        updatedAt: new Date().toISOString(),
      } : r));
    } else {
      const newRoute = {
        id: Date.now().toString(),
        name: routeName.trim(),
        grade: routeGrade,
        angle: routeAngle,
        holds: { ...holdSelection },
        holdTypes, techniques, styles,
        createdAt: new Date().toISOString(),
      };
      setRoutes(prev => [newRoute, ...prev]);
    }
    resetCreate();
    setView('routes');
  }, [routeName, routeGrade, routeAngle, holdSelection, holdTypes, techniques, styles, setRoutes, resetCreate, editingRouteId]);

  const viewRoute = useCallback((route) => {
    setViewingRoute(route);
    setHoldSelection(route.holds);
    setView('viewRoute');
  }, []);

  const startEditRoute = useCallback((route) => {
    setRouteName(route.name);
    setRouteGrade(route.grade);
    setRouteAngle(route.angle);
    setHoldTypes(route.holdTypes || []);
    setTechniques(route.techniques || []);
    setStyles(route.styles || []);
    setHoldSelection({ ...route.holds });
    setSelectionMode(SELECTION_MODES.HAND);
    setEditingRouteId(route.id);
    setViewingRoute(null);
    setView('create');
  }, []);

  const updateSettings = useCallback((key, val) => {
    setSettings(prev => ({ ...prev, [key]: val }));
  }, [setSettings]);

  const rateRoute = useCallback((routeId, rating) => {
    setRoutes(prev => prev.map(r =>
      r.id === routeId ? { ...r, rating: r.rating === rating ? 0 : rating } : r
    ));
  }, [setRoutes]);

  // ─── Hold editor callbacks ───────────────────────────────────────────
  // Track where to return after editing (settings list or board select)
  const [holdEditorSource, setHoldEditorSource] = useState('settings');

  const handleAddHold = () => {
    setEditingHold(null);
    setHoldEditorSource('settings');
    setView('addHold');
  };

  const handleEditHold = (hold, source = 'settings') => {
    setEditingHold(hold);
    setHoldEditorSource(source);
    setView('editHold');
  };

  const handleGoToHoldSelect = () => setView('holdSelect');

  const handleHoldEditorSave = (holdData) => {
    if (view === 'addHold') {
      addHold(holdData);
    } else {
      updateHold(holdData.id, holdData);
    }
    setEditingHold(null);
    setView(holdEditorSource);
  };

  const handleHoldEditorCancel = () => {
    setEditingHold(null);
    setView(holdEditorSource);
  };

  // ─── Derived counts ──────────────────────────────────────────────────
  const selectedCount  = Object.keys(holdSelection).length;
  const startCount     = Object.values(holdSelection).filter(t => t === 'start').length;
  const finishCount    = Object.values(holdSelection).filter(t => t === 'finish').length;
  const footCount      = Object.values(holdSelection).filter(t => t === 'foot').length;
  const handOnlyCount  = Object.values(holdSelection).filter(t => t === 'handOnly').length;

  const isBoard      = view === 'board' || view === 'create' || view === 'viewRoute';
  const isHoldEditor = view === 'addHold' || view === 'editHold' || view === 'holdSelect';

  return (
    <>
      {/* ── Header ── */}
      <header style={{
        padding: '14px 16px 10px',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        background: 'var(--bg-primary)',
        position: 'sticky',
        top: 0,
        zIndex: 100,
      }}>
        <div>
          <h1 style={{
            margin: 0, fontSize: '20px',
            fontFamily: 'var(--font-heading)', fontWeight: 700,
            color: 'var(--accent)', letterSpacing: '-0.5px',
          }}>
            BARN BOARD
          </h1>
          <div style={{
            fontSize: '9px', color: 'var(--text-muted)',
            letterSpacing: '2.5px', marginTop: '2px', textTransform: 'uppercase',
            fontWeight: 600,
          }}>
            {view === 'addHold'    ? 'Add Hold'
              : view === 'editHold'   ? 'Edit Hold'
              : view === 'holdSelect' ? 'Select Hold'
              : 'Route Logger'}
          </div>
        </div>
        <nav style={{ display: 'flex', gap: '6px' }}>
          <NavButton
            active={isBoard}
            onClick={() => { resetCreate(); setViewingRoute(null); setView('board'); }}
            label="◈"
          />
          <NavButton
            active={view === 'routes'}
            onClick={() => { setHoldSelection({}); setViewingRoute(null); setView('routes'); }}
            label="☰"
          />
          <NavButton
            active={view === 'settings' || isHoldEditor}
            onClick={() => { setEditingHold(null); setView('settings'); }}
            label="⚙"
          />
        </nav>
      </header>

      {/* ── Board views ── */}
      {isBoard && (
        <BoardView
          holds={allHolds}
          selection={holdSelection}
          onHoldTap={handleHoldTap}
          interactive={view === 'create'}
        >
          {/* Create mode: mode selector + hold counts */}
          {view === 'create' && (
            <div style={{ marginBottom: '10px' }}>
              <div style={{
                fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px',
                letterSpacing: '1px', textTransform: 'uppercase',
              }}>
                Tap Mode
              </div>
              <ModeSelector mode={selectionMode} setMode={setSelectionMode} />
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '8px' }}>
                <span style={{ color: selectedCount > 0 ? 'var(--accent)' : 'var(--text-dim)', fontWeight: selectedCount > 0 ? 700 : 400 }}>
                  {selectedCount} holds selected
                </span>
                {startCount    > 0 && <span style={{ color: MODE_COLORS.start    }}> · {startCount} start</span>}
                {finishCount   > 0 && <span style={{ color: MODE_COLORS.finish   }}> · {finishCount} finish</span>}
                {footCount     > 0 && <span style={{ color: MODE_COLORS.foot     }}> · {footCount} foot</span>}
                {handOnlyCount > 0 && <span style={{ color: MODE_COLORS.handOnly }}> · {handOnlyCount} hand only</span>}
              </div>
            </div>
          )}

          {/* View route header */}
          {view === 'viewRoute' && viewingRoute && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: '18px' }}>{viewingRoute.name}</div>
                <div style={{ fontSize: '12px', marginTop: '2px', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                  <span style={{
                    background: 'var(--yellow)', color: 'var(--peach)',
                    fontWeight: 800, fontFamily: 'var(--font-heading)',
                    fontSize: '13px', padding: '3px 11px', borderRadius: '8px',
                  }}>
                    {viewingRoute.grade}
                  </span>
                  <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
                    {viewingRoute.angle}°
                    {viewingRoute.styles?.length > 0 && ` · ${viewingRoute.styles.join(', ')}`}
                  </span>
                </div>
                {(viewingRoute.holdTypes?.length > 0 || viewingRoute.techniques?.length > 0) && (
                  <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '6px' }}>
                    {[...(viewingRoute.holdTypes || []), ...(viewingRoute.techniques || [])].map(tag => (
                      <span key={tag} style={{
                        padding: '2px 8px', borderRadius: '8px',
                        background: 'rgba(0,0,0,0.08)', border: '1px solid rgba(0,0,0,0.1)',
                        fontSize: '10px', color: 'var(--text-muted)',
                      }}>
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: '6px' }}>
                <button
                  onClick={() => startEditRoute(viewingRoute)}
                  style={{
                    padding: '6px 14px', borderRadius: '8px',
                    border: '1px solid rgba(0,71,255,0.3)', background: 'rgba(0,71,255,0.08)',
                    color: 'var(--accent)', fontSize: '12px', cursor: 'pointer', fontWeight: 600,
                  }}
                >
                  ✏ Edit
                </button>
                <button
                  onClick={() => { setHoldSelection({}); setViewingRoute(null); setView('routes'); }}
                  style={{
                    padding: '6px 14px', borderRadius: '8px',
                    border: '1px solid rgba(0,0,0,0.15)', background: 'rgba(0,0,0,0.08)',
                    color: 'var(--text-secondary)', fontSize: '12px', cursor: 'pointer',
                  }}
                >
                  ✕ Close
                </button>
              </div>
            </div>
          )}

          {/* Board view CTA */}
          {view === 'board' && (
            <div style={{ textAlign: 'center' }}>
              <button
                onClick={() => { resetCreate(); setView('create'); }}
                style={{
                  padding: '12px 40px', borderRadius: '24px', border: 'none',
                  background: 'var(--accent)', color: '#fff',
                  fontSize: '14px', fontWeight: 700, cursor: 'pointer', letterSpacing: '0.5px',
                }}
              >
                + CREATE ROUTE
              </button>
            </div>
          )}
        </BoardView>
      )}

      {/* ── Route form (below board in create mode) ── */}
      {view === 'create' && (
        <RouteForm
          name={routeName} setName={setRouteName}
          grade={routeGrade} setGrade={setRouteGrade}
          angle={routeAngle} setAngle={setRouteAngle}
          holdTypes={holdTypes} setHoldTypes={setHoldTypes}
          techniques={techniques} setTechniques={setTechniques}
          styles={styles} setStyles={setStyles}
          grades={grades}
          selectedCount={selectedCount}
          isEditing={!!editingRouteId}
          onSave={saveRoute}
          onCancel={() => { resetCreate(); setView('board'); }}
        />
      )}

      {/* ── Routes list ── */}
      {view === 'routes' && (
        <RouteList
          routes={routes}
          onViewRoute={viewRoute}
          onCreateNew={() => { resetCreate(); setView('create'); }}
          onRateRoute={rateRoute}
        />
      )}

      {/* ── Settings ── */}
      {view === 'settings' && (
        <Settings
          settings={settings}
          updateSettings={updateSettings}
          allHolds={allHolds}
          onAddHold={handleAddHold}
          onEditHold={handleEditHold}
          onDeleteHold={deleteHold}
          onSelectOnBoard={handleGoToHoldSelect}
        />
      )}

      {/* ── Hold Select — tap board to pick a hold for editing ── */}
      {view === 'holdSelect' && (
        <BoardView
          holds={allHolds}
          selection={{}}
          onHoldTap={(holdId) => {
            const h = allHolds.find(h => h.id === holdId);
            if (h) handleEditHold(h, 'holdSelect');
          }}
          interactive={true}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{
              fontSize: '11px', color: 'var(--text-muted)',
              letterSpacing: '1px', textTransform: 'uppercase',
            }}>
              Tap a hold on the board to edit it
            </span>
            <button
              onClick={() => setView('settings')}
              style={{
                padding: '5px 12px', borderRadius: '8px', fontSize: '11px', cursor: 'pointer',
                border: '1px solid rgba(0,0,0,0.15)', background: 'rgba(0,0,0,0.06)',
                color: 'var(--text-secondary)',
              }}
            >
              ← Back
            </button>
          </div>
        </BoardView>
      )}

      {/* ── Hold editor (add / edit) ── */}
      {(view === 'addHold' || view === 'editHold') && (
        <HoldEditorView
          mode={view === 'addHold' ? 'add' : 'edit'}
          hold={editingHold}
          allHolds={allHolds}
          imgSrc={IMG_SRC}
          onSave={handleHoldEditorSave}
          onCancel={handleHoldEditorCancel}
          onDelete={view === 'editHold' ? () => {
            deleteHold(editingHold.id);
            setEditingHold(null);
            setView('settings');
          } : undefined}
        />
      )}
    </>
  );
}

function NavButton({ active, onClick, label }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '6px 12px', borderRadius: '8px',
        border:      active ? '1.5px solid rgba(0,71,255,0.4)' : '1.5px solid var(--border)',
        background:  active ? 'var(--accent-dim)' : 'rgba(0,0,0,0.08)',
        color:       active ? 'var(--accent)'     : 'var(--text-secondary)',
        fontSize: '16px', cursor: 'pointer', transition: 'all 0.15s', lineHeight: 1,
      }}
    >
      {label}
    </button>
  );
}
