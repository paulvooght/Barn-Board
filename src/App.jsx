import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import BoardView from './components/BoardView';
import BoardSetupView from './components/BoardSetupView';
import ModeSelector from './components/ModeSelector';
import RouteForm from './components/RouteForm';
import RouteList from './components/RouteList';
import Settings from './components/Settings';
import HoldEditorView from './components/HoldEditorView';
import SessionSummary from './components/SessionSummary';
import AuthView from './components/AuthView';
import { useLocalStorage } from './hooks/useLocalStorage';
import { useCustomHolds } from './hooks/useCustomHolds';
import { supabase, ADMIN_EMAIL } from './lib/supabase';
import { V_GRADES, FONT_GRADES, SELECTION_MODES, MODE_COLORS, MODE_LABELS, BOARD_SPECS, HOLD_COLOR_DOT, HOLD_TYPE_SINGULAR_TO_PLURAL, convertGrade, getYouTubeId, getYouTubeThumbnail } from './utils/constants';

const DEFAULT_BOARD_IMAGE = '/Barn_Set_01_V3A.JPG';

// Strip per-user fields before writing to the shared routes table
function stripPerUserFields(route) {
  const { sent, rating, ...clean } = route;
  if (clean.angleGrades) {
    clean.angleGrades = clean.angleGrades.map(({ sent: _s, ...ag }) => ag);
  }
  return clean;
}

export default function App() {
  // ─── Auth ────────────────────────────────────────────────────────
  const [user, setUser]           = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [dataReady, setDataReady] = useState(false);
  const isAdmin = ADMIN_EMAIL ? user?.email === ADMIN_EMAIL : true;

  // ─── Persistent state ─────────────────────────────────────────────
  const [routes, setRoutes]       = useState([]);
  const [sessions, setSessions]   = useState([]);
  const [playlists, setPlaylists] = useState([]);
  const [userRouteData, setUserRouteData] = useState({}); // { [routeId]: { sent, rating, angleSends } }
  const [communityRatings, setCommunityRatings] = useState({}); // { [routeId]: { avg, count } }
  const [settings, setSettings] = useLocalStorage('barnboard_settings', { gradeSystem: 'V' });

  // Active session state (persisted so it survives page reload)
  const [activeSession, setActiveSession] = useLocalStorage('barnboard_active_session', null);
  const [completedSession, setCompletedSession] = useState(null); // for summary screen

  // Session timer display
  const [timerDisplay, setTimerDisplay] = useState('');
  const timerRef = useRef(null);
  const sessionStartTime = activeSession?.startTime || null;

  // Timer tick — only re-runs when session start time string changes (not object ref)
  useEffect(() => {
    if (sessionStartTime) {
      const tick = () => {
        const elapsed = Date.now() - new Date(sessionStartTime).getTime();
        const totalSec = Math.floor(elapsed / 1000);
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        setTimerDisplay(
          h > 0
            ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
            : `${m}:${String(s).padStart(2, '0')}`
        );
      };
      tick();
      timerRef.current = setInterval(tick, 1000);
      return () => clearInterval(timerRef.current);
    } else {
      setTimerDisplay('');
    }
  }, [sessionStartTime]);

  // Hold management (auto-detected + custom + overrides)
  const { allHolds, addHold, updateHold, deleteHold, replaceAllHolds } = useCustomHolds(user);

  // ─── Auth effect — listen for login/logout ─────────────────────────
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      setAuthLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      if (!session) { setRoutes([]); setSessions([]); setDataReady(false); }
    });
    return () => subscription.unsubscribe();
  }, []);

  // ─── Data load — fetch routes + sessions + playlists from Supabase ──
  const hasLoadedOnce = useRef(false);

  const loadDataFromSupabase = useCallback(async (userId, isFirstLoad) => {
    // a) Load ALL routes (shared — every user sees every route)
    const { data: routeRows } = await supabase.from('routes').select('id, user_id, data').order('created_at', { ascending: false });
    if (routeRows && routeRows.length > 0) {
      const allRoutes = routeRows.map(r => ({
        ...r.data,
        creatorId: r.data.creatorId || r.user_id, // backfill for old routes
      }));
      setRoutes(allRoutes);
    } else if (isFirstLoad) {
      // First login — migrate any localStorage routes
      const local = JSON.parse(localStorage.getItem('barnboard_routes') || '[]');
      if (local.length > 0) {
        const withCreator = local.map(r => ({ ...r, creatorId: r.creatorId || userId }));
        setRoutes(withCreator);
        await supabase.from('routes').insert(withCreator.map(r => ({ id: r.id, user_id: userId, data: stripPerUserFields(r) })));
        // Migrate per-user sent/rating to user_route_data
        for (const r of local) {
          if (r.sent || r.rating) {
            const angleSends = (r.angleGrades || []).filter(ag => ag.sent).map(ag => ag.angle);
            await supabase.from('user_route_data').upsert({
              user_id: userId, route_id: r.id,
              sent: !!r.sent, rating: r.rating || 0, angle_sends: angleSends,
            }, { onConflict: 'user_id,route_id' })
              .then(({ error }) => { if (error) console.error('[Supabase] user_route_data sync error:', error); });
          }
        }
      }
    }
    // b) Load current user's per-route data
    const { data: urdRows } = await supabase.from('user_route_data').select('route_id, sent, rating, angle_sends').eq('user_id', userId);
    const urdMap = {};
    if (urdRows) {
      for (const row of urdRows) {
        urdMap[row.route_id] = { sent: row.sent, rating: row.rating, angleSends: row.angle_sends || [] };
      }
    }
    setUserRouteData(urdMap);
    // c) Load ALL ratings for community averages
    const { data: ratingRows } = await supabase.from('user_route_data').select('route_id, rating').gt('rating', 0);
    const ratingsMap = {};
    if (ratingRows) {
      for (const row of ratingRows) {
        if (!ratingsMap[row.route_id]) ratingsMap[row.route_id] = { total: 0, count: 0 };
        ratingsMap[row.route_id].total += row.rating;
        ratingsMap[row.route_id].count += 1;
      }
    }
    const avgMap = {};
    for (const [rid, { total, count }] of Object.entries(ratingsMap)) {
      avgMap[rid] = { avg: Math.round((total / count) * 10) / 10, count };
    }
    setCommunityRatings(avgMap);
    // Sessions
    const { data: sessionRows } = await supabase.from('sessions').select('data').eq('user_id', userId).order('created_at', { ascending: false });
    if (sessionRows && sessionRows.length > 0) {
      setSessions(sessionRows.map(r => r.data));
    } else if (isFirstLoad) {
      const local = JSON.parse(localStorage.getItem('barnboard_sessions') || '[]');
      if (local.length > 0) {
        setSessions(local);
        await supabase.from('sessions').insert(local.map(s => ({ id: s.id, user_id: userId, data: s })));
      }
    }
    // Playlists
    const { data: plData } = await supabase.from('board_settings').select('data').eq('key', `playlists_${userId}`).maybeSingle();
    if (plData) {
      setPlaylists(plData.data || []);
    } else if (isFirstLoad) {
      const local = JSON.parse(localStorage.getItem('barnboard_playlists') || '[]');
      if (local.length > 0) {
        setPlaylists(local);
        await supabase.from('board_settings').upsert({ key: `playlists_${userId}`, data: local });
      }
    }
    setDataReady(true);
  }, [setRoutes, setSessions, setPlaylists]);

  // Initial load on login
  useEffect(() => {
    if (!user) return;
    setDataReady(false);
    hasLoadedOnce.current = false;
    loadDataFromSupabase(user.id, true).then(() => { hasLoadedOnce.current = true; });
  }, [user?.id, loadDataFromSupabase]);

  // Re-fetch from Supabase when tab becomes visible (switching devices/tabs)
  useEffect(() => {
    if (!user) return;
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && hasLoadedOnce.current) {
        console.log('[Sync] Tab visible — refreshing from Supabase');
        loadDataFromSupabase(user.id, false);
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [user?.id, loadDataFromSupabase]);

  // ─── Realtime subscription — instant sync across devices ──────────
  useEffect(() => {
    if (!user) return;

    const channel = supabase.channel('routes-realtime')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'routes' },
        (payload) => {
          console.log('[Realtime] routes change:', payload.eventType, payload.new?.id || payload.old?.id);

          if (payload.eventType === 'INSERT') {
            const newRoute = {
              ...payload.new.data,
              creatorId: payload.new.data.creatorId || payload.new.user_id,
            };
            // Only add if we don't already have it (avoid duplicating our own inserts)
            setRoutes(prev => {
              if (prev.some(r => r.id === newRoute.id)) return prev;
              return [newRoute, ...prev];
            });
          }

          if (payload.eventType === 'UPDATE') {
            const updatedRoute = {
              ...payload.new.data,
              creatorId: payload.new.data.creatorId || payload.new.user_id,
            };
            setRoutes(prev => prev.map(r =>
              r.id === updatedRoute.id ? updatedRoute : r
            ));
          }

          if (payload.eventType === 'DELETE') {
            const deletedId = payload.old.id;
            setRoutes(prev => prev.filter(r => r.id !== deletedId));
          }
        }
      )
      .subscribe((status) => {
        console.log('[Realtime] subscription status:', status);
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user?.id]);

  // ─── Routes sync — upsert to Supabase whenever routes change ──────
  const routesSyncTimer = useRef(null);
  const localRouteChange = useRef(false);
  const routesRef = useRef(routes);
  routesRef.current = routes;
  const userRouteDataRef = useRef(userRouteData);
  userRouteDataRef.current = userRouteData;

  // Immediate flush — only syncs routes this user created, stripped of per-user fields
  const flushRoutesToSupabase = useCallback(async (routesToSync) => {
    const r = routesToSync || routesRef.current;
    if (!user) return;
    const myRoutes = r.filter(rt => rt.creatorId === user.id || !rt.creatorId);
    if (myRoutes.length === 0) return;
    clearTimeout(routesSyncTimer.current); // cancel pending debounce
    const { error } = await supabase.from('routes').upsert(
      myRoutes.map(rt => ({ id: rt.id, user_id: user.id, data: stripPerUserFields(rt), updated_at: new Date().toISOString() })),
      { onConflict: 'id' }
    );
    if (error) console.error('[Supabase] routes flush error:', error);
  }, [user]);

  useEffect(() => {
    if (!user || !dataReady) return;
    // Only sync when the change originated locally (user created/edited a route).
    // Skip if routes changed due to Supabase load or Realtime event — those come
    // FROM Supabase and must not be written back (would re-insert deleted rows).
    if (!localRouteChange.current) return;
    localRouteChange.current = false;

    clearTimeout(routesSyncTimer.current);
    routesSyncTimer.current = setTimeout(async () => {
      // Use ref for latest routes (avoids stale closure if state changed during timeout)
      const myRoutes = routesRef.current.filter(r => r.creatorId === user.id || !r.creatorId);
      if (myRoutes.length === 0) return;
      console.log('[Sync] Debounced upsert:', myRoutes.length, 'routes');
      const { error } = await supabase.from('routes').upsert(
        myRoutes.map(r => ({ id: r.id, user_id: user.id, data: stripPerUserFields(r), updated_at: new Date().toISOString() })),
        { onConflict: 'id' }
      );
      if (error) console.error('[Supabase] routes sync error:', error);
    }, 1500);
    return () => clearTimeout(routesSyncTimer.current);
  }, [routes, user, dataReady]);

  // ─── Sessions sync — upsert to Supabase whenever sessions change ──
  const sessionsSyncTimer = useRef(null);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const flushSessionsToSupabase = useCallback(async (sessionsToSync) => {
    const s = sessionsToSync || sessionsRef.current;
    if (!user || s.length === 0) return;
    clearTimeout(sessionsSyncTimer.current);
    const { error } = await supabase.from('sessions').upsert(
      s.map(ss => ({ id: ss.id, user_id: user.id, data: ss, updated_at: new Date().toISOString() })),
      { onConflict: 'id' }
    );
    if (error) console.error('[Supabase] sessions flush error:', error);
  }, [user]);

  useEffect(() => {
    if (!user || !dataReady) return;
    clearTimeout(sessionsSyncTimer.current);
    sessionsSyncTimer.current = setTimeout(async () => {
      if (sessions.length === 0) return;
      const { error } = await supabase.from('sessions').upsert(
        sessions.map(s => ({ id: s.id, user_id: user.id, data: s, updated_at: new Date().toISOString() })),
        { onConflict: 'id' }
      );
      if (error) console.error('[Supabase] sessions sync error:', error);
    }, 1500);
    return () => clearTimeout(sessionsSyncTimer.current);
  }, [sessions, user, dataReady]);

  // ─── Playlists sync ───────────────────────────────────────────────
  const playlistsSyncTimer = useRef(null);
  const flushPlaylistsToSupabase = useCallback(async (pl) => {
    if (!user) return;
    clearTimeout(playlistsSyncTimer.current);
    const { error } = await supabase.from('board_settings').upsert(
      { key: `playlists_${user.id}`, data: pl, updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    );
    if (error) console.error('[Supabase] playlists flush error:', error);
  }, [user]);

  useEffect(() => {
    if (!user || !dataReady) return;
    clearTimeout(playlistsSyncTimer.current);
    playlistsSyncTimer.current = setTimeout(async () => {
      const { error } = await supabase.from('board_settings').upsert(
        { key: `playlists_${user.id}`, data: playlists, updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );
      if (error) console.error('[Supabase] playlists sync error:', error);
      // Keep shared_playlists in sync for any shared playlists
      const sharedOnes = playlists.filter(pl => pl.shared);
      for (const pl of sharedOnes) {
        const { error: spErr } = await supabase.from('shared_playlists').upsert({
          id: pl.id, user_id: user.id, name: pl.name,
          creator_name: user.email.split('@')[0],
          route_ids: pl.routeIds, updated_at: new Date().toISOString(),
        }, { onConflict: 'id' });
        if (spErr) console.error('[Supabase] shared_playlists sync error:', spErr);
      }
    }, 1500);
    return () => clearTimeout(playlistsSyncTimer.current);
  }, [playlists, user, dataReady]);

  // ─── Shared playlists callbacks ───────────────────────────────────
  const fetchSharedPlaylists = useCallback(async () => {
    const { data } = await supabase.from('shared_playlists').select('*');
    return data || [];
  }, []);

  const togglePlaylistShared = useCallback(async (plId, shared) => {
    let targetPl = null;
    setPlaylists(prev => {
      targetPl = prev.find(p => p.id === plId);
      return prev.map(pl => pl.id === plId ? { ...pl, shared } : pl);
    });
    if (!user) return;
    if (shared && targetPl) {
      await supabase.from('shared_playlists').upsert({
        id: targetPl.id, user_id: user.id, name: targetPl.name,
        creator_name: user.email.split('@')[0],
        route_ids: targetPl.routeIds, updated_at: new Date().toISOString(),
      }, { onConflict: 'id' });
    } else if (!shared) {
      await supabase.from('shared_playlists').delete().eq('id', plId);
    }
  }, [user]);

  const addSharedPlaylist = useCallback((sharedPl) => {
    const newPl = {
      id: Date.now().toString(),
      name: sharedPl.name,
      routeIds: sharedPl.route_ids,
      createdAt: new Date().toISOString(),
      shared: false,
      subscribedFrom: sharedPl.id,
    };
    setPlaylists(prev => [...prev, newPl]);
  }, []);

  // UI state
  // view: board | create | routes | settings | viewRoute | addHold | editHold | setupBoard | sessionSummary
  const [view, setView]                 = useState('board');
  const [selectionMode, setSelectionMode] = useState(SELECTION_MODES.HAND);
  const [holdSelection, setHoldSelection] = useState({});
  const holdSelectionRef = useRef(holdSelection);
  // Keep ref in sync — guarantees saveRoute always reads the latest holds
  holdSelectionRef.current = holdSelection;
  const [viewingRoute, setViewingRoute]   = useState(null);
  const [editingHold, setEditingHold]     = useState(null);
  const [editingRouteId, setEditingRouteId] = useState(null);
  const [showRouteTags, setShowRouteTags]   = useState(false);
  const [holdDataMode, setHoldDataMode]     = useState(false);  // route view: tap holds to see metadata
  const [inspectedRouteHoldId, setInspectedRouteHoldId] = useState(null);

  // Route form state
  const [routeName, setRouteName]   = useState('');
  const [routeGrade, setRouteGrade] = useState('V3');
  const [routeAngle, setRouteAngle] = useState(30);
  const [holdTypes, setHoldTypes]   = useState([]);
  const [techniques, setTechniques] = useState([]);
  const [styles, setStyles]         = useState([]);
  const [setter, setSetter]         = useState('');
  const [youtubeUrl, setYoutubeUrl] = useState('');

  const grades = settings.gradeSystem === 'V' ? V_GRADES : FONT_GRADES;
  const imgSrc = settings.boardImage || DEFAULT_BOARD_IMAGE;

  const resetCreate = useCallback(() => {
    setHoldSelection({});
    setRouteName('');
    setRouteGrade(settings.gradeSystem === 'V' ? 'V3' : '6A');
    setRouteAngle(30);
    setHoldTypes([]);
    setTechniques([]);
    setStyles([]);
    setSetter('');
    setYoutubeUrl('');
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

  // ─── Session management ─────────────────────────────────────────
  const startSession = useCallback(() => {
    const s = {
      id: Date.now().toString(),
      startTime: new Date().toISOString(),
      endTime: null,
      routesSent: [],
      sends: [],
      routesAttempted: [],
      routesCreated: [],
      boardAngle: 30,
      anglesClimbed: [],
    };
    setActiveSession(s);
  }, [setActiveSession]);

  const setSessionAngle = useCallback((angle) => {
    setActiveSession(prev => {
      if (!prev) return prev;
      return { ...prev, boardAngle: angle };
    });
  }, [setActiveSession]);

  const logAngleClimbed = useCallback((angle) => {
    setActiveSession(prev => {
      if (!prev) return prev;
      const angles = prev.anglesClimbed || [];
      if (angles.includes(angle)) return prev;
      return { ...prev, anglesClimbed: [...angles, angle].sort((a, b) => a - b) };
    });
  }, [setActiveSession]);

  const endSession = useCallback(() => {
    if (!activeSession) return;
    // Snapshot actual sent state at session end — avoids double-counting if user un-sent then re-sent.
    // Only routes currently marked sent (route.sent or angleGrade.sent) count.
    const sessionRouteIds = new Set([
      ...activeSession.routesSent,
      ...activeSession.routesAttempted,
    ]);
    const finalRoutesSent = [];
    const finalSends = [];
    for (const routeId of sessionRouteIds) {
      const route = routesRef.current.find(r => r.id === routeId);
      if (!route) continue;
      const urd = userRouteDataRef.current[routeId] || {};
      // Prefer angle sends (more specific); fall back to main sent flag.
      const angleSends = urd.angleSends || [];
      if (angleSends.length > 0) {
        for (const angle of angleSends) {
          const ag = (route.angleGrades || []).find(a => a.angle === angle);
          finalSends.push({ routeId, angle, grade: ag?.grade || route.grade, time: new Date().toISOString() });
        }
        if (!finalRoutesSent.includes(routeId)) finalRoutesSent.push(routeId);
      } else if (urd.sent) {
        finalRoutesSent.push(routeId);
        finalSends.push({ routeId, angle: route.angle || null, grade: route.grade || null, time: new Date().toISOString() });
      }
    }
    const finished = {
      ...activeSession,
      endTime: new Date().toISOString(),
      routesSent: finalRoutesSent,
      sends: finalSends,
    };
    let savedSessions;
    setSessions(prev => {
      savedSessions = [finished, ...prev];
      return savedSessions;
    });
    // Flush session to Supabase immediately
    if (savedSessions) flushSessionsToSupabase(savedSessions);
    setCompletedSession(finished);
    setActiveSession(null);
    setView('sessionSummary');
  }, [activeSession, routes, setSessions, setActiveSession, flushSessionsToSupabase]);

  const logRouteAttempted = useCallback((routeId) => {
    if (!activeSession) return;
    setActiveSession(prev => {
      if (!prev || prev.routesAttempted.includes(routeId)) return prev;
      return { ...prev, routesAttempted: [...prev.routesAttempted, routeId] };
    });
  }, [activeSession, setActiveSession]);

  const logRouteSent = useCallback((routeId, angle, grade) => {
    if (!activeSession) return;
    setActiveSession(prev => {
      if (!prev) return prev;
      const routesSent = prev.routesSent.includes(routeId)
        ? prev.routesSent
        : [...prev.routesSent, routeId];
      // Also log detailed send info (angle + grade)
      const sends = prev.sends || [];
      const newSend = { routeId, angle: angle || null, grade: grade || null, time: new Date().toISOString() };
      return { ...prev, routesSent: routesSent, sends: [...sends, newSend] };
    });
  }, [activeSession, setActiveSession]);

  const logRouteCreated = useCallback((routeId) => {
    if (!activeSession) return;
    setActiveSession(prev => {
      if (!prev || prev.routesCreated?.includes(routeId)) return prev;
      return { ...prev, routesCreated: [...(prev.routesCreated || []), routeId] };
    });
  }, [activeSession, setActiveSession]);

  const saveRoute = useCallback(() => {
    // Read holds from ref — immune to stale closures
    const rawHolds = { ...holdSelectionRef.current };
    // Strip holds that no longer exist on the board (ghost references from deleted holds)
    const holdIdSetNow = new Set(allHolds.map(h => h.id));
    const currentHolds = {};
    for (const [id, type] of Object.entries(rawHolds)) {
      if (holdIdSetNow.has(id)) currentHolds[id] = type;
    }
    if (!routeName.trim() || Object.keys(currentHolds).length === 0) {
      console.warn('[saveRoute] Blocked: no holds selected', Object.keys(currentHolds).length);
      return;
    }
    console.log('[saveRoute] Saving with', Object.keys(currentHolds).length, 'holds:', currentHolds);
    // Snapshot hold geometry so ghost outlines survive hold deletion
    const holdSnapshots = {};
    for (const holdId of Object.keys(currentHolds)) {
      const h = allHolds.find(hh => hh.id === holdId);
      if (h) {
        holdSnapshots[holdId] = { cx: h.cx, cy: h.cy, polygon: h.polygon || null, w_pct: h.w_pct, h_pct: h.h_pct, r: h.r, color: h.color, holdTypes: h.holdTypes };
      }
    }
    let savedRoutes;
    localRouteChange.current = true;
    if (editingRouteId) {
      setRoutes(prev => {
        savedRoutes = prev.map(r => r.id === editingRouteId ? {
          ...r,
          name: routeName.trim(),
          grade: routeGrade,
          angle: routeAngle,
          setter: setter.trim(),
          youtubeUrl: youtubeUrl.trim() || undefined,
          holds: currentHolds,
          holdSnapshots,
          holdTypes, techniques, styles,
          updatedAt: new Date().toISOString(),
        } : r);
        return savedRoutes;
      });
    } else {
      const newRoute = {
        id: Date.now().toString(),
        name: routeName.trim(),
        grade: routeGrade,
        angle: routeAngle,
        setter: setter.trim(),
        creatorId: user?.id,
        youtubeUrl: youtubeUrl.trim() || undefined,
        holds: currentHolds,
        holdSnapshots,
        holdTypes, techniques, styles,
        createdAt: new Date().toISOString(),
      };
      setRoutes(prev => {
        savedRoutes = [newRoute, ...prev];
        return savedRoutes;
      });
      logRouteCreated(newRoute.id);
    }
    // Flush to Supabase immediately — don't wait for debounce
    if (savedRoutes) flushRoutesToSupabase(savedRoutes);
    resetCreate();
    setView('routes');
  }, [routeName, routeGrade, routeAngle, setter, holdTypes, techniques, styles, setRoutes, resetCreate, editingRouteId, logRouteCreated, allHolds, flushRoutesToSupabase]);

  const viewRoute = useCallback((route) => {
    // Defensive: always read the latest version of this route from localStorage
    // to guard against stale route objects passed from list
    setRoutes(prev => {
      const fresh = prev.find(r => r.id === route.id);
      const routeToView = fresh || route;
      const holds = routeToView.holds && Object.keys(routeToView.holds).length > 0
        ? routeToView.holds
        : route.holds || {};

      // Backfill holdSnapshots for routes created before the snapshot feature
      let updated = routeToView;
      let didBackfill = false;
      if (!routeToView.holdSnapshots && Object.keys(holds).length > 0) {
        const holdSnapshots = {};
        for (const holdId of Object.keys(holds)) {
          const h = allHolds.find(hh => hh.id === holdId);
          if (h) {
            holdSnapshots[holdId] = { cx: h.cx, cy: h.cy, polygon: h.polygon || null, w_pct: h.w_pct, h_pct: h.h_pct, r: h.r, color: h.color, holdTypes: h.holdTypes };
          }
        }
        if (Object.keys(holdSnapshots).length > 0) {
          updated = { ...routeToView, holdSnapshots };
          didBackfill = true;
        }
      }

      setViewingRoute(updated);
      setHoldSelection(holds);
      if (Object.keys(holds).length === 0) {
        console.warn('[viewRoute] Route has no holds:', routeToView.name, routeToView.id);
      }
      // Persist the backfill so ghost outlines survive future sessions
      if (didBackfill) localRouteChange.current = true;
      return didBackfill ? prev.map(r => r.id === updated.id ? updated : r) : prev;
    });
    setView('viewRoute');
    logRouteAttempted(route.id);
  }, [logRouteAttempted, setRoutes, allHolds]);

  const startEditRoute = useCallback((route) => {
    // Read fresh route from state to ensure holds are current
    setRoutes(prev => {
      const fresh = prev.find(r => r.id === route.id);
      const r = fresh || route;
      setRouteName(r.name);
      setRouteGrade(r.grade);
      setRouteAngle(r.angle);
      setHoldTypes(r.holdTypes || []);
      setTechniques(r.techniques || []);
      setStyles(r.styles || []);
      setSetter(r.setter || '');
      setYoutubeUrl(r.youtubeUrl || '');
      setHoldSelection({ ...(r.holds || {}) });
      setSelectionMode(SELECTION_MODES.HAND);
      setEditingRouteId(r.id);
      setViewingRoute(null);
      setView('create');
      return prev; // no mutation
    });
  }, [setRoutes]);

  const updateSettings = useCallback((key, val) => {
    setSettings(prev => {
      const next = { ...prev, [key]: val };
      // When grade system changes, convert all existing route grades
      if (key === 'gradeSystem' && val !== prev.gradeSystem) {
        const oldSystem = prev.gradeSystem;
        localRouteChange.current = true;
        setRoutes(prevRoutes => prevRoutes.map(r => ({
          ...r,
          grade: convertGrade(r.grade, oldSystem, val),
          // Convert angle-specific grades too
          angleGrades: r.angleGrades
            ? r.angleGrades.map(ag => ({ ...ag, grade: convertGrade(ag.grade, oldSystem, val) }))
            : undefined,
        })));
      }
      return next;
    });
  }, [setSettings, setRoutes]);

  const rateRoute = useCallback((routeId, newRating) => {
    if (!user) return;
    setUserRouteData(prev => {
      const current = prev[routeId] || { sent: false, rating: 0, angleSends: [] };
      const finalRating = current.rating === newRating ? 0 : newRating;
      supabase.from('user_route_data').upsert({
        user_id: user.id, route_id: routeId,
        sent: current.sent, rating: finalRating, angle_sends: current.angleSends,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,route_id' })
        .then(({ error }) => { if (error) console.error('[Supabase] user_route_data sync error:', error); });
      // Optimistically update community average
      setCommunityRatings(prevR => {
        const old = prevR[routeId] || { avg: 0, count: 0 };
        const oldTotal = old.avg * old.count;
        const wasRated = current.rating > 0;
        const isRated = finalRating > 0;
        let newTotal, newCount;
        if (wasRated && isRated)       { newTotal = oldTotal - current.rating + finalRating; newCount = old.count; }
        else if (!wasRated && isRated) { newTotal = oldTotal + finalRating; newCount = old.count + 1; }
        else if (wasRated && !isRated) { newTotal = oldTotal - current.rating; newCount = old.count - 1; }
        else { return prevR; }
        return { ...prevR, [routeId]: { avg: newCount > 0 ? Math.round((newTotal / newCount) * 10) / 10 : 0, count: newCount } };
      });
      return { ...prev, [routeId]: { ...current, rating: finalRating } };
    });
  }, [user]);

  const toggleSent = useCallback((routeId) => {
    if (!user) return;
    setUserRouteData(prev => {
      const current = prev[routeId] || { sent: false, rating: 0, angleSends: [] };
      const newSent = !current.sent;
      supabase.from('user_route_data').upsert({
        user_id: user.id, route_id: routeId,
        sent: newSent, rating: current.rating, angle_sends: current.angleSends,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,route_id' })
        .then(({ error }) => { if (error) console.error('[Supabase] user_route_data sync error:', error); });
      if (newSent) {
        const route = routesRef.current.find(r => r.id === routeId);
        if (route) {
          logRouteSent(routeId, route.angle, route.grade);
          if (route.angle) logAngleClimbed(route.angle);
        }
      }
      return { ...prev, [routeId]: { ...current, sent: newSent } };
    });
  }, [user, logRouteSent, logAngleClimbed]);

  const deleteRoute = useCallback((routeId) => {
    setRoutes(prev => prev.filter(r => r.id !== routeId));
    // Also remove from playlists
    setPlaylists(prev => prev.map(pl => ({
      ...pl, routeIds: pl.routeIds.filter(id => id !== routeId),
    })));
    setHoldSelection({});
    setViewingRoute(null);
    setView('routes');
    // Delete from Supabase (must be explicit — upsert sync won't remove deleted rows)
    if (user) {
      supabase.from('routes').delete().eq('id', routeId).select().then(({ data, error }) => {
        if (error) console.error('[Supabase] delete route error:', error);
        else if (!data || data.length === 0) console.warn('[Supabase] delete route: 0 rows affected — RLS may have blocked deletion for route', routeId);
        else console.log('[Supabase] delete route OK:', routeId, data);
      });
    }
  }, [setRoutes, setPlaylists, user]);

  const updateRouteYoutubeUrl = useCallback((routeId, url) => {
    localRouteChange.current = true;
    setRoutes(prev => prev.map(r =>
      r.id === routeId ? { ...r, youtubeUrl: url.trim() || undefined, updatedAt: new Date().toISOString() } : r
    ));
    // Sync viewingRoute if viewing this route
    setViewingRoute(prev => {
      if (!prev || prev.id !== routeId) return prev;
      return { ...prev, youtubeUrl: url.trim() || undefined };
    });
  }, [setRoutes]);

  // ─── Playlist management ──────────────────────────────────────────
  const createPlaylist = useCallback((name) => {
    const pl = { id: Date.now().toString(), name: name.trim(), routeIds: [], createdAt: new Date().toISOString() };
    setPlaylists(prev => [...prev, pl]);
    return pl.id;
  }, [setPlaylists]);

  const deletePlaylist = useCallback((plId) => {
    setPlaylists(prev => prev.filter(pl => pl.id !== plId));
  }, [setPlaylists]);

  const renamePlaylist = useCallback((plId, newName) => {
    setPlaylists(prev => prev.map(pl =>
      pl.id === plId ? { ...pl, name: newName.trim() } : pl
    ));
  }, [setPlaylists]);

  const addRouteToPlaylist = useCallback((routeId, plId) => {
    setPlaylists(prev => prev.map(pl => {
      if (pl.id !== plId) return pl;
      if (pl.routeIds.includes(routeId)) return pl;
      return { ...pl, routeIds: [...pl.routeIds, routeId] };
    }));
  }, [setPlaylists]);

  const removeRouteFromPlaylist = useCallback((routeId, plId) => {
    setPlaylists(prev => prev.map(pl => {
      if (pl.id !== plId) return pl;
      return { ...pl, routeIds: pl.routeIds.filter(id => id !== routeId) };
    }));
  }, [setPlaylists]);

  // ─── Angle-grade management ───────────────────────────────────────
  const addAngleGrade = useCallback((routeId, angle, grade) => {
    localRouteChange.current = true;
    setRoutes(prev => prev.map(r => {
      if (r.id !== routeId) return r;
      const existing = r.angleGrades || [];
      // Replace if same angle exists, otherwise add
      const idx = existing.findIndex(ag => ag.angle === angle);
      const updated = idx >= 0
        ? existing.map((ag, i) => i === idx ? { angle, grade } : ag)
        : [...existing, { angle, grade }];
      // Sort by angle
      updated.sort((a, b) => a.angle - b.angle);
      return { ...r, angleGrades: updated, updatedAt: new Date().toISOString() };
    }));
    // Also update viewingRoute if we're viewing it
    setViewingRoute(prev => {
      if (!prev || prev.id !== routeId) return prev;
      const existing = prev.angleGrades || [];
      const idx = existing.findIndex(ag => ag.angle === angle);
      const updated = idx >= 0
        ? existing.map((ag, i) => i === idx ? { angle, grade } : ag)
        : [...existing, { angle, grade }];
      updated.sort((a, b) => a.angle - b.angle);
      return { ...prev, angleGrades: updated };
    });
  }, [setRoutes]);

  const removeAngleGrade = useCallback((routeId, angle) => {
    localRouteChange.current = true;
    setRoutes(prev => prev.map(r => {
      if (r.id !== routeId) return r;
      return { ...r, angleGrades: (r.angleGrades || []).filter(ag => ag.angle !== angle) };
    }));
    setViewingRoute(prev => {
      if (!prev || prev.id !== routeId) return prev;
      return { ...prev, angleGrades: (prev.angleGrades || []).filter(ag => ag.angle !== angle) };
    });
  }, [setRoutes]);

  const toggleAngleSent = useCallback((routeId, angle) => {
    if (!user) return;
    setUserRouteData(prev => {
      const current = prev[routeId] || { sent: false, rating: 0, angleSends: [] };
      const wasSent = current.angleSends.includes(angle);
      const angleSends = wasSent
        ? current.angleSends.filter(a => a !== angle)
        : [...current.angleSends, angle];
      supabase.from('user_route_data').upsert({
        user_id: user.id, route_id: routeId,
        sent: current.sent, rating: current.rating, angle_sends: angleSends,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,route_id' })
        .then(({ error }) => { if (error) console.error('[Supabase] user_route_data sync error:', error); });
      if (!wasSent) {
        const route = routesRef.current.find(r => r.id === routeId);
        const ag = (route?.angleGrades || []).find(a => a.angle === angle);
        logRouteSent(routeId, angle, ag?.grade || route?.grade);
        logAngleClimbed(angle);
      }
      return { ...prev, [routeId]: { ...current, angleSends } };
    });
  }, [user, logRouteSent, logAngleClimbed]);

  const setHeadlineAngleGrade = useCallback((routeId, newAngle, newGrade) => {
    const applyHeadlineSwap = (r) => {
      if (r.id !== routeId) return r;

      const oldAngle = r.angle;
      const oldGrade = r.grade;
      const angleGrades = [...(r.angleGrades || [])];

      // Remove the promoted entry from angleGrades (it becomes the headline)
      const filtered = angleGrades.filter(ag => ag.angle !== newAngle);

      // Demote the old headline into the angle grades list (if not already there)
      const oldExists = filtered.some(ag => ag.angle === oldAngle);
      if (!oldExists && oldAngle !== undefined) {
        filtered.push({ angle: oldAngle, grade: oldGrade });
      }

      // Sort by angle
      filtered.sort((a, b) => a.angle - b.angle);

      return {
        ...r,
        angle: newAngle,
        grade: newGrade,
        angleGrades: filtered,
        updatedAt: new Date().toISOString(),
      };
    };

    localRouteChange.current = true;
    setRoutes(prev => prev.map(applyHeadlineSwap));
    setViewingRoute(prev => {
      if (!prev || prev.id !== routeId) return prev;
      return applyHeadlineSwap(prev);
    });
  }, [setRoutes]);

  // ─── Hold editor callbacks ───────────────────────────────────────────
  // Track where to return after editing (settings list or board select)
  const [holdEditorSource, setHoldEditorSource] = useState('settings');
  const [holdManagerMode, setHoldManagerMode] = useState('boundaries'); // persists across edit round-trips

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

  const handleSetupBoard = () => setView('setupBoard');
  const handleSetupSave = async (newHolds) => {
    // Build a map of old hold IDs → new hold IDs so we can update routes
    const idMap = {};
    for (const h of newHolds) {
      const newId = h.id.startsWith('custom_') ? h.id : `custom_${h.id}`;
      if (newId !== h.id) {
        idMap[h.id] = newId;
      }
    }

    // Await hold data write to Supabase before continuing
    await replaceAllHolds(newHolds);

    // Remap hold IDs in all saved routes so highlights survive
    let remappedRoutes = null;
    if (Object.keys(idMap).length > 0) {
      localRouteChange.current = true;
      setRoutes(prev => {
        remappedRoutes = prev.map(route => {
          const oldHolds = route.holds || {};
          const newHolds2 = {};
          let changed = false;
          for (const [holdId, selType] of Object.entries(oldHolds)) {
            const mappedId = idMap[holdId] || holdId;
            newHolds2[mappedId] = selType;
            if (mappedId !== holdId) changed = true;
          }
          return changed ? { ...route, holds: newHolds2 } : route;
        });
        return remappedRoutes;
      });
      console.log('[handleSetupSave] Remapped hold IDs in routes:', idMap);
      // Flush remapped routes to Supabase immediately
      if (remappedRoutes) await flushRoutesToSupabase(remappedRoutes);
    }

    setView('board');
  };
  const handleSetupCancel = () => setView('settings');

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
  const holdIdSet      = new Set(allHolds.map(h => h.id));
  const selectedCount  = Object.keys(holdSelection).length;
  const startCount     = Object.values(holdSelection).filter(t => t === 'start').length;
  const finishCount    = Object.values(holdSelection).filter(t => t === 'finish').length;
  const footCount      = Object.values(holdSelection).filter(t => t === 'foot').length;
  const handOnlyCount  = Object.values(holdSelection).filter(t => t === 'handOnly').length;
  // Missing holds in current selection (deleted from board but still referenced)
  const editingRoute = editingRouteId ? routes.find(r => r.id === editingRouteId) : null;
  const editSnapshots = editingRoute?.holdSnapshots || {};
  const missingHoldsInEdit = Object.entries(holdSelection)
    .filter(([id]) => !holdIdSet.has(id))
    .map(([id, type]) => ({ id, type, color: editSnapshots[id]?.color }));

  // Auto-collect hold types from selected holds' metadata
  const autoHoldTypes = useMemo(() => {
    const types = new Set();
    for (const holdId of Object.keys(holdSelection)) {
      const hold = allHolds.find(h => h.id === holdId);
      if (hold?.holdTypes) {
        for (const ht of hold.holdTypes) {
          const plural = HOLD_TYPE_SINGULAR_TO_PLURAL[ht];
          if (plural) types.add(plural);
        }
      }
    }
    return [...types];
  }, [holdSelection, allHolds]);

  const isBoard      = view === 'board' || view === 'create' || view === 'viewRoute';
  const isHoldEditor = view === 'addHold' || view === 'editHold' || view === 'holdSelect';

  // Show auth screen until session resolves
  if (authLoading) return (
    <div style={{ minHeight: '100vh', background: '#FFAB94', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ fontFamily: "'Space Mono', monospace", color: '#0047FF', fontWeight: 700, fontSize: 18 }}>BARN BOARD</div>
    </div>
  );
  if (!user) return <AuthView />;

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
        <div
          onClick={() => { resetCreate(); setHoldSelection({}); setViewingRoute(null); setView('board'); }}
          style={{ cursor: 'pointer' }}
        >
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
              : view === 'sessionSummary' ? 'Session Summary'
              : 'Route Logger'}
          </div>
          {/* Session timer in header */}
          {activeSession && (
            <div
              onClick={(e) => { e.stopPropagation(); endSession(); }}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '6px',
                marginTop: '4px', padding: '4px 12px', borderRadius: '10px',
                background: 'rgba(125,211,232,0.15)', border: '1px solid rgba(125,211,232,0.4)',
                cursor: 'pointer',
              }}
            >
              <span style={{
                width: '6px', height: '6px', borderRadius: '50%',
                background: '#FF2D78', display: 'inline-block',
                animation: 'pulse 2s infinite',
              }} />
              <span style={{
                fontSize: '12px', fontFamily: 'var(--font-heading)', fontWeight: 700,
                color: '#3BA8C4',
              }}>
                {timerDisplay}
              </span>
              {activeSession.routesSent.length > 0 && (
                <span style={{
                  fontSize: '10px', fontWeight: 700, color: '#3BA8C4',
                  background: 'rgba(125,211,232,0.15)', padding: '1px 6px', borderRadius: '6px',
                }}>
                  {activeSession.routesSent.length} sent
                </span>
              )}
              {activeSession.routesCreated?.length > 0 && (
                <span style={{
                  fontSize: '10px', fontWeight: 700, color: '#3BA8C4',
                  background: 'rgba(125,211,232,0.15)', padding: '1px 6px', borderRadius: '6px',
                }}>
                  {activeSession.routesCreated.length} new
                </span>
              )}
            </div>
          )}
        </div>
        <nav style={{ display: 'flex', gap: '6px' }}>
          <NavButton
            active={isBoard}
            onClick={() => { resetCreate(); setViewingRoute(null); setView('board'); }}
            label="◈"
          />
          <NavButton
            active={view === 'routes'}
            onClick={() => { setHoldSelection({}); setViewingRoute(null); setShowRouteTags(false); setView('routes'); }}
            label="☰"
          />
          <NavButton
            active={view === 'settings' || isHoldEditor}
            onClick={() => { setEditingHold(null); setView('settings'); }}
            label={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>}
          />
        </nav>
      </header>

      {/* ── Board views ── */}
      {isBoard && (
        <BoardView
          holds={allHolds}
          selection={holdSelection}
          onHoldTap={view === 'create' ? handleHoldTap : (holdDataMode && view === 'viewRoute') ? (id) => {
            // Only allow tapping holds that are in the route
            if (viewingRoute?.holds?.[id]) setInspectedRouteHoldId(prev => prev === id ? null : id);
          } : undefined}
          interactive={view === 'create' || (view === 'viewRoute' && holdDataMode)}
          dimBoard={view === 'viewRoute'}
          imgSrc={imgSrc}
          holdSnapshots={view === 'viewRoute' && viewingRoute ? viewingRoute.holdSnapshots : null}
        >
          {/* Create mode: mode selector + hold counts */}
          {view === 'create' && (
            <div style={{ marginBottom: '10px' }}>
              {/* Missing holds banner — shown when editing a route with deleted holds */}
              {missingHoldsInEdit.length > 0 && (
                <div style={{
                  padding: '8px 10px', borderRadius: '8px', marginBottom: '10px',
                  background: 'rgba(255,20,147,0.08)', border: '1.5px solid rgba(255,20,147,0.4)',
                }}>
                  <div style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    marginBottom: '6px',
                  }}>
                    <span style={{ fontSize: '11px', fontWeight: 800, color: '#FF1493' }}>
                      ⚠ {missingHoldsInEdit.length} deleted hold{missingHoldsInEdit.length > 1 ? 's' : ''} in route
                    </span>
                    <button
                      onClick={() => {
                        setHoldSelection(prev => {
                          const next = { ...prev };
                          missingHoldsInEdit.forEach(({ id }) => delete next[id]);
                          return next;
                        });
                      }}
                      style={{
                        padding: '3px 8px', borderRadius: '5px', fontSize: '10px', fontWeight: 700,
                        cursor: 'pointer', border: '1px solid #FF1493',
                        background: '#FF1493', color: '#fff',
                      }}
                    >
                      Remove all
                    </button>
                  </div>
                  {missingHoldsInEdit.map(({ id, type, color }) => (
                    <div key={id} style={{
                      display: 'flex', alignItems: 'center', gap: '6px',
                      padding: '3px 0',
                    }}>
                      <span style={{
                        width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0,
                        background: color ? (HOLD_COLOR_DOT[color] || '#888') : (MODE_COLORS[type] || '#999'),
                      }} />
                      <span style={{ fontSize: '11px', fontWeight: 600, color: '#FF1493', flex: 1 }}>
                        {MODE_LABELS[type] || type} hold{color ? ` (${color})` : ''} — no longer on board
                      </span>
                      <button
                        onClick={() => {
                          setHoldSelection(prev => {
                            const next = { ...prev };
                            delete next[id];
                            return next;
                          });
                        }}
                        style={{
                          padding: '2px 6px', borderRadius: '4px', fontSize: '9px', fontWeight: 700,
                          cursor: 'pointer', border: '1px solid rgba(255,20,147,0.4)',
                          background: 'transparent', color: '#FF1493',
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}
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
            <ViewRouteHeader
              route={viewingRoute}
              sent={userRouteData[viewingRoute.id]?.sent || false}
              angleSends={userRouteData[viewingRoute.id]?.angleSends || []}
              isCreator={viewingRoute.creatorId === user?.id || isAdmin}
              grades={grades}
              gradeSystem={settings.gradeSystem}
              playlists={playlists}
              settings={settings}
              allHolds={allHolds}
              onEdit={() => startEditRoute(viewingRoute)}
              onClose={() => { setHoldSelection({}); setViewingRoute(null); setShowRouteTags(false); setHoldDataMode(false); setInspectedRouteHoldId(null); setView('routes'); }}
              onDelete={() => deleteRoute(viewingRoute.id)}
              onToggleSent={() => toggleSent(viewingRoute.id)}
              onAddAngleGrade={(angle, grade) => addAngleGrade(viewingRoute.id, angle, grade)}
              onRemoveAngleGrade={(angle) => removeAngleGrade(viewingRoute.id, angle)}
              onSetHeadline={(angle, grade) => setHeadlineAngleGrade(viewingRoute.id, angle, grade)}
              onToggleAngleSent={(angle) => toggleAngleSent(viewingRoute.id, angle)}
              onAddToPlaylist={(plId) => addRouteToPlaylist(viewingRoute.id, plId)}
              onCreatePlaylist={createPlaylist}
              showTagsBelow={false}
            />
          )}

        </BoardView>
      )}

      {/* Hold Info toggle + Show more row + info card — below board when viewing a route */}
      {view === 'viewRoute' && viewingRoute && (() => {
        const routeHoldIds = Object.keys(viewingRoute.holds || {});
        const inspectedHold = inspectedRouteHoldId ? allHolds.find(h => h.id === inspectedRouteHoldId) : null;
        const hasTagData = viewingRoute.holdTypes?.length > 0 || viewingRoute.techniques?.length > 0 || viewingRoute.styles?.length > 0;
        const toggleBtnStyle = (active) => ({
          padding: '5px 10px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
          cursor: 'pointer', lineHeight: 1, whiteSpace: 'nowrap',
          border: active ? '1.5px solid var(--accent)' : '1.5px solid rgba(26,10,0,0.12)',
          background: active ? 'var(--accent-dim)' : 'rgba(255,255,255,0.6)',
          color: active ? 'var(--accent)' : 'var(--text-secondary)',
        });
        return (
          <div style={{ padding: '0 12px 4px' }}>
            {/* Toggle row — Show more (left) + Hold Info (right) */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: inspectedHold ? '8px' : '0' }}>
              {hasTagData ? (
                <button onClick={() => setShowRouteTags(prev => !prev)} style={toggleBtnStyle(showRouteTags)}>
                  {showRouteTags ? '▾ Show less' : '▸ Show more'}
                </button>
              ) : <div />}
              <button
                onClick={() => { setHoldDataMode(prev => !prev); setInspectedRouteHoldId(null); }}
                style={toggleBtnStyle(holdDataMode)}
              >
                Hold Info
              </button>
            </div>
            {/* Info card when a hold is tapped */}
            {holdDataMode && inspectedHold && (() => {
              const holdColor = HOLD_COLOR_DOT[inspectedHold.color] || '#888';
              const types = inspectedHold.holdTypes?.length > 0 ? inspectedHold.holdTypes.join(' · ') : 'No types set';
              const pos = inspectedHold.positivity || 0;
              const posLabel = pos === 0 ? 'Neutral' : pos > 0 ? `+${pos} Positive` : `${pos} Slopey`;
              return (
                <div style={{
                  padding: '10px 12px', borderRadius: '10px', marginBottom: '4px',
                  background: 'var(--bg-card)', border: '1px solid var(--border)',
                  boxShadow: '0 2px 8px rgba(26,10,0,0.06)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                    <span style={{
                      width: '12px', height: '12px', borderRadius: '50%', flexShrink: 0,
                      background: holdColor, border: '1.5px solid rgba(26,10,0,0.15)',
                    }} />
                    <span style={{ fontWeight: 700, fontSize: '13px', flex: 1 }}>
                      {inspectedHold.name || `Hold ${inspectedHold.id}`}
                    </span>
                    <button onClick={() => setInspectedRouteHoldId(null)} style={{
                      background: 'none', border: 'none', cursor: 'pointer',
                      color: 'var(--text-muted)', fontSize: '16px', padding: '0 2px', lineHeight: 1,
                    }}>✕</button>
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '8px' }}>
                    <span>{types}</span>
                    <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{posLabel}</span>
                    {inspectedHold.color && <span style={{ textTransform: 'capitalize' }}>{inspectedHold.color}</span>}
                    {inspectedHold.material && <span>{inspectedHold.material}</span>}
                  </div>
                  <button
                    onClick={() => {
                      setHoldEditorSource('viewRoute');
                      handleEditHold(inspectedHold, 'viewRoute');
                    }}
                    style={{
                      padding: '5px 14px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
                      cursor: 'pointer', border: 'none',
                      background: 'var(--accent)', color: '#fff',
                    }}
                  >
                    Edit Hold
                  </button>
                </div>
              );
            })()}
            {holdDataMode && !inspectedHold && (
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontStyle: 'italic', padding: '2px 0 4px' }}>
                Tap a hold to view its data
              </div>
            )}
            {/* Expandable tag data — shown when Show more is active */}
            {hasTagData && showRouteTags && (
              <div style={{ paddingTop: '6px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {viewingRoute.holdTypes?.length > 0 && (
                  <div>
                    <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }}>Hold Types</div>
                    <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
                      {viewingRoute.holdTypes.map(tag => (
                        <span key={tag} style={{ padding: '3px 10px', borderRadius: '8px', background: 'rgba(26,10,0,0.06)', border: '1px solid rgba(26,10,0,0.08)', fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 500 }}>{tag}</span>
                      ))}
                    </div>
                  </div>
                )}
                {viewingRoute.techniques?.length > 0 && (
                  <div>
                    <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }}>Techniques</div>
                    <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
                      {viewingRoute.techniques.map(tag => (
                        <span key={tag} style={{ padding: '3px 10px', borderRadius: '8px', background: 'rgba(26,10,0,0.06)', border: '1px solid rgba(26,10,0,0.08)', fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 500 }}>{tag}</span>
                      ))}
                    </div>
                  </div>
                )}
                {viewingRoute.styles?.length > 0 && (
                  <div>
                    <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }}>Style</div>
                    <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
                      {viewingRoute.styles.map(tag => (
                        <span key={tag} style={{ padding: '3px 10px', borderRadius: '8px', background: 'rgba(26,10,0,0.06)', border: '1px solid rgba(26,10,0,0.08)', fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 500 }}>{tag}</span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {/* Board view CTA — below the board image */}
      {view === 'board' && (
        <div style={{ textAlign: 'center', padding: '16px 12px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px' }}>
          <button
            onClick={() => { resetCreate(); setView('create'); }}
            style={{
              padding: '14px 48px', borderRadius: '24px', border: 'none',
              background: 'var(--accent)', color: '#fff',
              fontSize: '14px', fontWeight: 700, cursor: 'pointer', letterSpacing: '0.5px',
            }}
          >
            + CREATE ROUTE
          </button>
          {!activeSession && (
            <button
              onClick={startSession}
              style={{
                padding: '12px 24px', borderRadius: '24px',
                border: '2px solid rgba(125,211,232,0.5)',
                background: 'var(--bg-card)', color: '#3BA8C4',
                fontSize: '13px', fontWeight: 800, cursor: 'pointer',
                letterSpacing: '0.5px',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
              }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg> Start Session
            </button>
          )}
          {/* Stop session button */}
          {activeSession && (
            <button
              onClick={endSession}
              style={{
                padding: '12px 24px', borderRadius: '24px',
                border: '2px solid rgba(255,82,82,0.4)',
                background: 'rgba(255,82,82,0.1)', color: '#FF5252',
                fontSize: '13px', fontWeight: 800, cursor: 'pointer',
                letterSpacing: '0.5px',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
              }}
            >
              <span style={{ fontSize: '10px' }}>■</span> Stop Session
            </button>
          )}
          {/* Board angle slider — beta feature, controlled by settings.betaAngleLogger */}
          {activeSession && settings.betaAngleLogger && (
            <div style={{
              width: '100%', maxWidth: '340px', padding: '12px 16px',
              borderRadius: '12px', background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              boxShadow: '0 2px 8px rgba(26,10,0,0.06)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '1px', textTransform: 'uppercase' }}>Board Angle</span>
                <span style={{ fontSize: '16px', fontWeight: 800, fontFamily: 'var(--font-heading)', color: '#7DD3E8' }}>{activeSession.boardAngle}°</span>
              </div>
              <input type="range" min="18" max="55" value={activeSession.boardAngle || 30}
                onChange={(e) => setSessionAngle(parseInt(e.target.value))}
                style={{ width: '100%', accentColor: '#7DD3E8', cursor: 'pointer' }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '9px', color: 'var(--text-dim)', fontWeight: 600, marginTop: '2px' }}>
                <span>18° slab</span><span>55° steep</span>
              </div>
              <button onClick={() => logAngleClimbed(activeSession.boardAngle || 30)} style={{
                marginTop: '8px', width: '100%', padding: '8px', borderRadius: '8px',
                border: '1.5px solid rgba(125,211,232,0.4)',
                background: (activeSession.anglesClimbed || []).includes(activeSession.boardAngle || 30) ? 'rgba(125,211,232,0.15)' : 'transparent',
                color: '#3BA8C4', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
              }}>
                {(activeSession.anglesClimbed || []).includes(activeSession.boardAngle || 30)
                  ? `✓ ${activeSession.boardAngle}° logged` : `Log ${activeSession.boardAngle}° as climbed`}
              </button>
              {(activeSession.anglesClimbed || []).length > 0 && (
                <div style={{ marginTop: '6px', fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, textAlign: 'center' }}>
                  Angles this session: {(activeSession.anglesClimbed || []).map(a => `${a}°`).join(', ')}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Route form (below board in create mode) ── */}
      {view === 'create' && (
        <RouteForm
          name={routeName} setName={setRouteName}
          grade={routeGrade} setGrade={setRouteGrade}
          angle={routeAngle} setAngle={setRouteAngle}
          setter={setter} setSetter={setSetter}
          youtubeUrl={youtubeUrl} setYoutubeUrl={setYoutubeUrl}
          holdTypes={holdTypes} setHoldTypes={setHoldTypes}
          autoHoldTypes={autoHoldTypes}
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
          grades={grades}
          gradeSystem={settings.gradeSystem}
          playlists={playlists}
          allHolds={allHolds}
          userRouteData={userRouteData}
          communityRatings={communityRatings}
          onViewRoute={viewRoute}
          onCreateNew={() => { resetCreate(); setView('create'); }}
          onRateRoute={rateRoute}
          onToggleSent={toggleSent}
          onCreatePlaylist={createPlaylist}
          onDeletePlaylist={deletePlaylist}
          onRenamePlaylist={renamePlaylist}
          onRemoveRouteFromPlaylist={removeRouteFromPlaylist}
          onFetchSharedPlaylists={fetchSharedPlaylists}
          onTogglePlaylistShared={togglePlaylistShared}
          onAddSharedPlaylist={addSharedPlaylist}
          userId={user?.id}
        />
      )}

      {/* ── Session Summary ── */}
      {view === 'sessionSummary' && completedSession && (
        <SessionSummary
          session={completedSession}
          routes={routes}
          grades={grades}
          allSessions={sessions}
          onClose={() => { setCompletedSession(null); setView('board'); }}
        />
      )}

      {/* ── Settings ── */}
      {view === 'settings' && (
        <Settings
          settings={settings}
          updateSettings={updateSettings}
          allHolds={allHolds}
          onSetupBoard={handleSetupBoard}
          sessions={sessions}
          routes={routes}
          isAdmin={isAdmin}
          userEmail={user?.email}
          onSignOut={() => supabase.auth.signOut()}
          onViewSession={(session) => { setCompletedSession(session); setView('sessionSummary'); }}
        />
      )}

      {/* ── Hold Select — tap board to pick a hold for editing ── */}
      {view === 'holdSelect' && (
        <BoardView
          holds={allHolds}
          selection={{}}
          imgSrc={imgSrc}
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
                border: '1px solid rgba(26,10,0,0.15)', background: 'rgba(26,10,0,0.06)',
                color: 'var(--text-secondary)',
              }}
            >
              ← Back
            </button>
          </div>
        </BoardView>
      )}

      {/* ── Board Setup editor ── */}
      {view === 'setupBoard' && (
        <BoardSetupView
          initialHolds={allHolds}
          onSave={handleSetupSave}
          onCancel={handleSetupCancel}
          imgSrc={imgSrc}
          initialManagerMode={holdManagerMode}
          onManagerModeChange={setHoldManagerMode}
          onEditHold={(hold) => handleEditHold(hold, 'setupBoard')}
        />
      )}

      {/* ── Hold editor (add / edit) ── */}
      {(view === 'addHold' || view === 'editHold') && (
        <HoldEditorView
          mode={view === 'addHold' ? 'add' : 'edit'}
          hold={editingHold}
          allHolds={allHolds}
          imgSrc={imgSrc}
          onSave={handleHoldEditorSave}
          onCancel={handleHoldEditorCancel}
          onDelete={view === 'editHold' ? () => {
            deleteHold(editingHold.id);
            setEditingHold(null);
            setView(holdEditorSource);
          } : undefined}
        />
      )}
    </>
  );
}

// ─── View Route Header with Angle-Grade Management ──────────────────
function ViewRouteHeader({ route, sent, angleSends, isCreator, grades, gradeSystem, playlists, settings, allHolds, onEdit, onClose, onDelete, onToggleSent, onAddAngleGrade, onRemoveAngleGrade, onSetHeadline, onToggleAngleSent, onAddToPlaylist, onCreatePlaylist }) {
  const [showAnglePanel, setShowAnglePanel] = useState(false);
  const [showPlaylistPanel, setShowPlaylistPanel] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [newAngle, setNewAngle] = useState(route.angle || 30);
  const [newGrade, setNewGrade] = useState(route.grade || grades[4]);
  const angleGrades = route.angleGrades || [];
  const hasVideo = !!getYouTubeId(route.youtubeUrl);
  const showVideoThumbnail = settings?.betaVideoThumbnail;

  // Missing hold detection
  const holdIdSet = new Set((allHolds || []).map(h => h.id));
  const missingHoldIds = Object.keys(route.holds || {}).filter(id => !holdIdSet.has(id));
  const missingCount = missingHoldIds.length;

  // Small action button style
  const actionBtn = (active) => ({
    padding: '5px 10px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
    cursor: 'pointer', lineHeight: 1, whiteSpace: 'nowrap',
    border: active ? '1.5px solid var(--accent)' : '1.5px solid rgba(26,10,0,0.12)',
    background: active ? 'var(--accent-dim)' : 'rgba(255,255,255,0.6)',
    color: active ? 'var(--accent)' : 'var(--text-secondary)',
  });

  return (
    <div style={{ marginBottom: '10px' }}>
      {/* ── Row 1: Grade + Name + video icon (left) | Sent + Close (right) ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
        <span style={{
          background: 'var(--yellow)', color: 'var(--text-primary)',
          fontWeight: 800, fontFamily: 'var(--font-heading)',
          fontSize: '18px', padding: '7px 18px', borderRadius: '10px', flexShrink: 0,
          lineHeight: 1.1,
        }}>
          {route.grade}
        </span>
        <div style={{
          flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: '6px',
        }}>
          <span style={{
            fontWeight: 700, fontSize: '20px', lineHeight: 1.2,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {route.name}
          </span>
          {hasVideo && (
            <a href={route.youtubeUrl} target="_blank" rel="noopener noreferrer"
              onClick={e => e.stopPropagation()}
              style={{ flexShrink: 0, display: 'flex', alignItems: 'center', textDecoration: 'none', fontSize: '16px', opacity: 0.45 }}
            >
              🎥
            </a>
          )}
        </div>
        {/* Sent checkbox */}
        <button
          onClick={onToggleSent}
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
        <button onClick={onClose} style={{
          padding: '5px 10px', borderRadius: '8px', flexShrink: 0,
          border: '1px solid rgba(26,10,0,0.15)', background: 'rgba(26,10,0,0.06)',
          color: 'var(--text-muted)', fontSize: '13px', cursor: 'pointer', lineHeight: 1,
        }}>
          ✕
        </button>
      </div>

      {/* ── Row 2: Metadata — angle centered under grade pill ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px',
        fontSize: '11px', color: 'var(--text-muted)',
      }}>
        <span style={{
          fontWeight: 700, fontFamily: 'var(--font-heading)', color: 'var(--accent)', fontSize: '12px',
          width: 'calc(7px + 18px + 7px + 18px)', textAlign: 'center', flexShrink: 0,
        }}>
          {route.angle}°
        </span>
        {route.setter && <span>by {route.setter}</span>}
      </div>

      {/* ── Missing holds warning ── */}
      {missingCount > 0 && (
        <div style={{
          padding: '8px 10px', borderRadius: '8px', marginBottom: '8px',
          background: 'rgba(255,20,147,0.08)', border: '1.5px solid rgba(255,20,147,0.4)',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px',
          }}>
            <span style={{ fontSize: '13px', color: '#FF1493', fontWeight: 900 }}>⚠</span>
            <span style={{ fontSize: '11px', fontWeight: 800, color: '#FF1493', flex: 1 }}>
              {missingCount} hold{missingCount > 1 ? 's' : ''} removed
            </span>
            {isCreator && (
              <button
                onClick={onEdit}
                style={{
                  padding: '4px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 800,
                  cursor: 'pointer', border: '1.5px solid #FF1493',
                  background: '#FF1493', color: '#fff', flexShrink: 0,
                }}
              >
                Fix Route
              </button>
            )}
          </div>
          {missingHoldIds.map(id => {
            const type = route.holds[id];
            const snap = route.holdSnapshots?.[id];
            const dotColor = snap?.color ? (HOLD_COLOR_DOT[snap.color] || '#888') : (MODE_COLORS[type] || '#999');
            return (
              <div key={id} style={{
                display: 'flex', alignItems: 'center', gap: '6px', padding: '2px 0',
              }}>
                <span style={{
                  width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0,
                  background: dotColor,
                }} />
                <span style={{ fontSize: '10px', fontWeight: 600, color: '#FF1493' }}>
                  {MODE_LABELS[type] || type}
                  {snap?.color && <span style={{ fontWeight: 400, fontStyle: 'italic' }}> ({snap.color})</span>}
                </span>
                {!snap && (
                  <span style={{ fontSize: '9px', color: 'rgba(255,20,147,0.6)', fontStyle: 'italic' }}>
                    — position unknown
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Row 3: Action buttons — all same weight ── */}
      <div style={{
        display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap',
      }}>
        {isCreator && (
          <button onClick={onEdit} style={actionBtn(false)}>
            ✏ Edit
          </button>
        )}
        <button
          onClick={() => { setShowAnglePanel(prev => !prev); setShowPlaylistPanel(false); }}
          style={actionBtn(showAnglePanel)}
        >
          {showAnglePanel ? '▾' : '▸'} Angles
          {angleGrades.length > 0 && (
            <span style={{
              marginLeft: '5px', background: 'var(--accent)', color: '#fff',
              padding: '1px 6px', borderRadius: '8px', fontSize: '10px',
            }}>
              {angleGrades.length}
            </span>
          )}
        </button>
        <button
          onClick={() => { setShowPlaylistPanel(prev => !prev); setShowAnglePanel(false); }}
          style={actionBtn(showPlaylistPanel)}
        >
          Playlist
        </button>
        {isCreator && (!confirmDelete ? (
          <button
            onClick={() => setConfirmDelete(true)}
            style={{
              padding: '5px 10px', borderRadius: '8px', marginLeft: 'auto',
              border: '1px solid rgba(255,82,82,0.3)', background: 'rgba(255,82,82,0.06)',
              color: '#FF5252', fontSize: '13px', cursor: 'pointer', lineHeight: 1,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#FF5252" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 4h12M5.33 4V2.67a1.33 1.33 0 011.34-1.34h2.66a1.33 1.33 0 011.34 1.34V4M13.33 4v9.33a1.33 1.33 0 01-1.33 1.34H4a1.33 1.33 0 01-1.33-1.34V4" />
            </svg>
          </button>
        ) : (
          <div style={{ display: 'flex', gap: '4px', marginLeft: 'auto' }}>
            <button
              onClick={onDelete}
              style={{
                padding: '5px 12px', borderRadius: '8px', border: 'none',
                background: '#FF5252', color: '#fff',
                fontSize: '11px', fontWeight: 700, cursor: 'pointer',
              }}
            >
              Confirm
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              style={{
                padding: '5px 8px', borderRadius: '8px',
                border: '1px solid rgba(26,10,0,0.15)', background: 'rgba(26,10,0,0.06)',
                color: 'var(--text-muted)', fontSize: '11px', cursor: 'pointer',
              }}
            >
              Cancel
            </button>
          </div>
        ))}
      </div>

      {/* Video thumbnail — only if beta toggle is on */}
      {hasVideo && showVideoThumbnail && getYouTubeThumbnail(route.youtubeUrl) && (
        <a
          href={route.youtubeUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'block', borderRadius: '8px', overflow: 'hidden',
            position: 'relative', textDecoration: 'none', marginTop: '8px',
          }}
        >
          <img
            src={getYouTubeThumbnail(route.youtubeUrl)}
            alt="Beta"
            style={{ width: '100%', height: '80px', objectFit: 'cover', display: 'block', borderRadius: '8px' }}
          />
          <div style={{
            position: 'absolute', top: '50%', left: '50%',
            transform: 'translate(-50%, -50%)',
            width: '32px', height: '32px', borderRadius: '50%',
            background: 'rgba(26,10,0,0.6)', display: 'flex',
            alignItems: 'center', justifyContent: 'center',
          }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="#fff" style={{ marginLeft: 2 }}><polygon points="5,3 19,12 5,21"/></svg>
          </div>
        </a>
      )}

      {/* Angle/Grade panel */}
      {showAnglePanel && (
        <div style={{
          marginTop: '8px', padding: '12px', borderRadius: '12px',
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          boxShadow: '0 2px 8px rgba(26,10,0,0.06)',
        }}>
          {/* Add new angle/grade */}
          <div style={{ marginBottom: angleGrades.length > 0 ? '12px' : 0 }}>
            <div style={{
              fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)',
              letterSpacing: '1px', textTransform: 'uppercase', marginBottom: '8px',
            }}>
              Add Grade at Angle
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '10px', color: 'var(--text-dim)', marginBottom: '3px' }}>Angle</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <input
                    type="range"
                    min={BOARD_SPECS.minAngle} max={BOARD_SPECS.maxAngle}
                    value={newAngle}
                    onChange={e => setNewAngle(Number(e.target.value))}
                    style={{ flex: 1, accentColor: 'var(--accent)' }}
                  />
                  <span style={{
                    fontFamily: 'var(--font-heading)', fontWeight: 700,
                    fontSize: '13px', color: 'var(--accent)', minWidth: '28px', textAlign: 'right',
                  }}>
                    {newAngle}°
                  </span>
                </div>
              </div>
              <div style={{ width: '80px' }}>
                <div style={{ fontSize: '10px', color: 'var(--text-dim)', marginBottom: '3px' }}>Grade</div>
                <select
                  value={newGrade}
                  onChange={e => setNewGrade(e.target.value)}
                  style={{
                    width: '100%', padding: '6px 8px', borderRadius: '6px',
                    border: '1.5px solid rgba(26,10,0,0.15)', background: 'var(--bg-input)',
                    fontSize: '13px', fontFamily: 'var(--font-heading)', fontWeight: 700,
                  }}
                >
                  {grades.map(g => <option key={g} value={g}>{g}</option>)}
                </select>
              </div>
              <button
                onClick={() => onAddAngleGrade(newAngle, newGrade)}
                style={{
                  padding: '6px 12px', borderRadius: '8px', border: 'none',
                  background: 'var(--accent)', color: '#fff',
                  fontSize: '11px', fontWeight: 700, cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                + Add
              </button>
            </div>
          </div>

          {/* Existing angle/grade table */}
          {angleGrades.length > 0 && (
            <div>
              <div style={{
                fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)',
                letterSpacing: '1px', textTransform: 'uppercase', marginBottom: '6px',
              }}>
                Logged Grades
              </div>
              <div style={{
                display: 'grid', gridTemplateColumns: '50px 1fr 36px auto auto',
                gap: '0', fontSize: '12px', borderRadius: '8px', overflow: 'hidden',
                border: '1px solid rgba(26,10,0,0.08)',
              }}>
                {/* Header */}
                <div style={agHeaderCell}>Angle</div>
                <div style={agHeaderCell}>Grade</div>
                <div style={{ ...agHeaderCell, textAlign: 'center', fontSize: '9px' }}>Sent</div>
                <div style={agHeaderCell}></div>
                <div style={agHeaderCell}></div>

                {angleGrades.map((ag, i) => {
                  const bg = i % 2 === 0 ? 'rgba(26,10,0,0.02)' : 'transparent';
                  return [
                    <div key={`a${i}`} style={{ ...agCell, background: bg, fontFamily: 'var(--font-heading)', fontWeight: 700 }}>
                      {ag.angle}°
                    </div>,
                    <div key={`g${i}`} style={{ ...agCell, background: bg, fontWeight: 700 }}>
                      {ag.grade}
                    </div>,
                    <div key={`t${i}`} style={{ ...agCell, background: bg, textAlign: 'center' }}>
                      <button
                        onClick={() => onToggleAngleSent(ag.angle)}
                        style={{
                          width: '24px', height: '24px', borderRadius: '6px',
                          border: (angleSends || []).includes(ag.angle) ? '2px solid #7DD3E8' : '2px solid rgba(26,10,0,0.2)',
                          background: (angleSends || []).includes(ag.angle) ? '#7DD3E8' : 'transparent',
                          color: '#fff', cursor: 'pointer', fontSize: '13px', fontWeight: 900,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          padding: 0,
                        }}
                      >
                        {(angleSends || []).includes(ag.angle) ? '✓' : ''}
                      </button>
                    </div>,
                    <div key={`s${i}`} style={{ ...agCell, background: bg, textAlign: 'center' }}>
                      <button
                        onClick={() => onSetHeadline(ag.angle, ag.grade)}
                        title="Set as headline"
                        style={{
                          padding: '2px 8px', borderRadius: '6px', fontSize: '9px',
                          border: '1px solid var(--accent)', background: 'transparent',
                          color: 'var(--accent)', cursor: 'pointer', fontWeight: 700,
                        }}
                      >
                        Set Main
                      </button>
                    </div>,
                    <div key={`d${i}`} style={{ ...agCell, background: bg, textAlign: 'center' }}>
                      <button
                        onClick={() => onRemoveAngleGrade(ag.angle)}
                        style={{
                          padding: '2px 6px', borderRadius: '4px', fontSize: '10px',
                          border: '1px solid rgba(255,82,82,0.3)', background: 'rgba(255,82,82,0.06)',
                          color: '#FF5252', cursor: 'pointer',
                        }}
                      >
                        ✕
                      </button>
                    </div>,
                  ];
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Playlist panel */}
      {showPlaylistPanel && (
        <div style={{
          marginTop: '8px', padding: '12px', borderRadius: '12px',
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          boxShadow: '0 2px 8px rgba(26,10,0,0.06)',
        }}>
          <div style={{
            fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)',
            letterSpacing: '1px', textTransform: 'uppercase', marginBottom: '8px',
          }}>
            Add to Playlist
          </div>

          {playlists.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '10px' }}>
              {playlists.map(pl => {
                const alreadyIn = pl.routeIds.includes(route.id);
                return (
                  <button
                    key={pl.id}
                    onClick={() => { if (!alreadyIn) onAddToPlaylist(pl.id); }}
                    style={{
                      padding: '8px 12px', borderRadius: '8px', textAlign: 'left',
                      border: alreadyIn ? '1.5px solid var(--start)' : '1.5px solid rgba(26,10,0,0.1)',
                      background: alreadyIn ? 'rgba(34,168,112,0.08)' : 'transparent',
                      color: alreadyIn ? 'var(--start)' : 'var(--text-primary)',
                      fontSize: '13px', fontWeight: 600, cursor: alreadyIn ? 'default' : 'pointer',
                    }}
                  >
                    {pl.name}
                    {alreadyIn && <span style={{ marginLeft: '8px', fontSize: '10px', fontWeight: 800 }}>✓ Added</span>}
                    {!alreadyIn && <span style={{ marginLeft: '8px', fontSize: '10px', color: 'var(--text-dim)' }}>{pl.routeIds.length} routes</span>}
                  </button>
                );
              })}
            </div>
          )}

          <div style={{ display: 'flex', gap: '6px' }}>
            <input
              type="text"
              value={newPlaylistName}
              onChange={e => setNewPlaylistName(e.target.value)}
              placeholder="New playlist name"
              style={{
                flex: 1, padding: '6px 10px', borderRadius: '8px',
                border: '1.5px solid rgba(26,10,0,0.15)', background: 'var(--bg-input)',
                color: 'var(--text-primary)', fontSize: '12px',
              }}
            />
            <button
              onClick={() => {
                if (newPlaylistName.trim()) {
                  const plId = onCreatePlaylist(newPlaylistName);
                  onAddToPlaylist(plId);
                  setNewPlaylistName('');
                }
              }}
              disabled={!newPlaylistName.trim()}
              style={{
                padding: '6px 12px', borderRadius: '8px', border: 'none',
                background: newPlaylistName.trim() ? 'var(--accent)' : 'rgba(26,10,0,0.1)',
                color: newPlaylistName.trim() ? '#fff' : 'var(--text-dim)',
                fontSize: '11px', fontWeight: 700, cursor: newPlaylistName.trim() ? 'pointer' : 'default',
                whiteSpace: 'nowrap',
              }}
            >
              + Create & Add
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const agHeaderCell = {
  padding: '4px 8px', fontSize: '9px', fontWeight: 800,
  color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px',
  background: 'rgba(26,10,0,0.04)', borderBottom: '1px solid rgba(26,10,0,0.08)',
};

const agCell = {
  padding: '6px 8px', borderBottom: '1px solid rgba(26,10,0,0.04)',
  display: 'flex', alignItems: 'center',
};

function NavButton({ active, onClick, label }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '6px 12px', borderRadius: '8px',
        border:      active ? '1.5px solid rgba(0,71,255,0.4)' : '1.5px solid var(--border)',
        background:  active ? 'var(--accent-dim)' : 'rgba(26,10,0,0.08)',
        color:       active ? 'var(--accent)'     : 'var(--text-secondary)',
        fontSize: '16px', cursor: 'pointer', transition: 'all 0.15s', lineHeight: 1,
      }}
    >
      {label}
    </button>
  );
}
