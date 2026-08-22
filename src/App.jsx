import { useState, useCallback, useEffect, useRef, useMemo, lazy, Suspense } from 'react';
import BoardView from './components/BoardView';
import ModeSelector from './components/ModeSelector';
import Icon from './components/Icon';
import SentCycleButton from './components/SentCycleButton';
import RouteViewCard from './components/RouteViewCard';
import ErrorScreen from './components/ErrorScreen';

const BoardSetupView = lazy(() => import('./components/BoardSetupView'));
const RouteForm = lazy(() => import('./components/RouteForm'));
const RouteList = lazy(() => import('./components/RouteList'));
const Settings = lazy(() => import('./components/Settings'));
const HoldEditorView = lazy(() => import('./components/HoldEditorView'));
const SessionSummary = lazy(() => import('./components/SessionSummary'));
const SessionsView = lazy(() => import('./components/SessionsView'));
const AuthView = lazy(() => import('./components/AuthView'));
const WallsSettings = lazy(() => import('./components/WallsSettings'));
const BoardImageUpdateView = lazy(() => import('./components/BoardImageUpdateView'));
const SessionEditView = lazy(() => import('./components/SessionEditView'));
import { useLocalStorage } from './hooks/useLocalStorage';
import { useCustomHolds } from './hooks/useCustomHolds';
import holdsData from './data/holds.json';
import { supabase, ADMIN_EMAIL } from './lib/supabase';
import * as db from './lib/db';
import { V_GRADES, FONT_GRADES, V_GRADE_INDEX, FONT_GRADE_INDEX, SELECTION_MODES, MODE_COLORS, MODE_LABELS, BOARD_SPECS, HOLD_COLOR_DOT, HOLD_TYPE_SINGULAR_TO_PLURAL, convertGrade, displayGrade, getYouTubeId, getYouTubeThumbnail, DEFAULT_BOARD_IMAGE, DEFAULT_BOARD_SRCSET, DEFAULT_BOARD_SIZES } from './utils/constants';
import { enqueueRoute, dequeueRoute, recordFailure, getPendingRoutes } from './utils/pendingRouteSync';
import { enqueueSession, dequeueSession, recordFailure as recordSessionFailure, getPendingSessions, getPendingSessionIds } from './utils/pendingSessionSync';

// Strip per-user fields before writing to the shared routes table
function stripPerUserFields(route) {
  const { sent, rating, boardId, ...clean } = route;
  if (clean.angleGrades) {
    clean.angleGrades = clean.angleGrades.map(({ sent: _s, ...ag }) => ag);
  }
  return clean;
}

// Union `additions` into `existing` without removing anything or duplicating.
function unionArrays(existing, additions) {
  if (!additions || additions.length === 0) return existing || [];
  const set = new Set(existing || []);
  additions.forEach(v => set.add(v));
  return [...set];
}

// Derive, from a saved session, the per-route angle/boolean state that should be
// additively forward-merged into lifetime userRouteData when a past session is
// edited. Mirrors the read-side derivation in SessionRoutesCard.jsx /
// SessionEditView.jsx (STATE_RANK ordering, legacy flashedRouteIds fallback) so
// all three stay consistent. One deliberate difference: those two map a
// null-angle send onto the route's headline angle for display; here a
// null-angle send is skipped for the angle arrays (no guessing an angle for
// lifetime per-angle data) but still counts toward the route-level `sent` /
// `flashed` booleans.
function deriveSessionRouteState(session) {
  const result = {};
  if (!session) return result;

  const attemptedIds  = session.routesAttempted || [];
  const sentIds       = session.routesSent || [];
  const flashedIds    = new Set(session.flashedRouteIds || []);
  const angleAttempts = session.angleAttempts || [];
  const sends         = session.sends || [];

  const loggedIds = new Set([
    ...attemptedIds,
    ...sentIds,
    ...flashedIds,
    ...angleAttempts.map(a => a.routeId),
    ...sends.map(s => s.routeId),
  ]);

  loggedIds.forEach(routeId => {
    const routeSends = sends.filter(s => s.routeId === routeId);

    // Legacy back-compat: old sessions recorded flash at the route level
    // (flashedRouteIds) before flash was tracked per-send.
    const legacyFlash = flashedIds.has(routeId) && !routeSends.some(s => s.flash === true);

    const sendAngleSet  = new Set();
    const flashAngleSet = new Set();
    routeSends.forEach(send => {
      if (send.angle == null) return; // route-level send — no angle to union in
      sendAngleSet.add(send.angle);
      if (send.flash === true || legacyFlash) flashAngleSet.add(send.angle);
    });

    const attemptAngleSet = new Set(sendAngleSet);
    const attemptsEntry = angleAttempts.find(a => a.routeId === routeId);
    (attemptsEntry?.angles || []).forEach(angle => attemptAngleSet.add(angle));

    const flashed = flashAngleSet.size > 0 || legacyFlash;
    // A null-angle send still counts toward `sent` even though it contributes
    // no angle to sendAngles; flash always implies sent.
    const sent = routeSends.length > 0 || flashed;

    result[routeId] = {
      attemptAngles: [...attemptAngleSet],
      sendAngles: [...sendAngleSet],
      flashAngles: [...flashAngleSet],
      attempted: true,
      sent,
      flashed,
    };
  });

  return result;
}

export default function App() {
  // ─── Auth ────────────────────────────────────────────────────────
  const [user, setUser]           = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [dataReady, setDataReady] = useState(false);
  const [boardsResolved, setBoardsResolved] = useState(false); // initial wall-resolve done (gates onboarding vs splash)
  // Set when the boot sequence (resolving the active wall + loading its data)
  // fails or times out — e.g. the backend is unreachable. Lets us show a
  // friendly retry screen instead of stranding the user on the splash forever.
  const [bootError, setBootError] = useState(null);

  // ─── Active wall (multi-wall, Phase 2a) ───────────────────────────
  // Which board the user is on. 2a has one wall (The Barn); the switcher and
  // additional walls land in 2b. Resolved on login by resolveActiveBoard().
  // Not yet used to filter reads/writes (single wall + DB default handle that) —
  // it's the foundation the 2b switcher builds on.
  const [activeBoardId, setActiveBoardId] = useState(null);
  const [myBoards, setMyBoards] = useState([]); // [{ id, name, slug, visibility, role }]
  const activeBoardIdRef = useRef(null);
  activeBoardIdRef.current = activeBoardId;
  // Admin OF THE ACTIVE WALL (per-wall role) — gates Hold Manager / image wizard /
  // the climber⇄admin toggle. Separate from the global `isAdmin` (comment moderation).
  const activeBoard = myBoards.find(b => b.id === activeBoardId);
  const isActiveBoardAdmin = activeBoard?.role === 'admin';
  // boardRegion (the board area inside the photo) is per-wall, stored in
  // boards.specs (multi-wall 2b-ii). Fall back to holds.json for The Barn and
  // before specs has loaded, so the board area is always defined.
  const activeBoardRegion = activeBoard?.specs?.boardRegion || holdsData.boardRegion;
  // Physical specs (width/height/angle range) are per-wall too. Merge the wall's
  // stored specs over the global BOARD_SPECS defaults, so a wall that hasn't had
  // its specs filled in yet falls back to The Barn's numbers until an admin sets them.
  const activeBoardSpecs = { ...BOARD_SPECS, ...(activeBoard?.specs || {}) };
  // Default board-image base name for a wall with no image config yet — namespaced
  // by the wall so a fresh wall can never publish under (and clobber) another
  // wall's bucket filename. Walls with a config use their stored (already
  // namespaced) imageName; autoIncrementName bumps the trailing _V<n>.
  const activeBoardImageDefault =
    `${(activeBoard?.name || 'Board').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'Board'}_Set_01_V0`;
  // DB column helper for a route/session row: returns { board_id } for the row's
  // own wall (falling back to the active wall), or {} so the column DEFAULT applies
  // if we somehow don't know the wall yet.
  const boardCol = (item) => {
    const b = item?.boardId || activeBoardIdRef.current;
    return b ? { board_id: b } : {};
  };

  // ─── Profiles ─────────────────────────────────────────────────────
  const [displayName, setDisplayName]       = useState('');
  const [profilesById, setProfilesById]     = useState({}); // { [user_id]: { display_name, is_admin } }

  // isAdmin: prefer DB flag (once profiles are loaded), fall back to ADMIN_EMAIL env var.
  // Defaults to FALSE when no DB flag and no ADMIN_EMAIL (2c) — must not fail open.
  const isAdmin = profilesById[user?.id]?.is_admin === true
    || (ADMIN_EMAIL ? user?.email === ADMIN_EMAIL : false);

  // ─── Persistent state ─────────────────────────────────────────────
  const [routes, setRoutes]       = useState([]);
  // All routes across every wall the user can read — used only by the Sessions tab
  // to resolve route metadata for cross-board stats (board-scoped `routes` stays
  // the source for the board view + routes list).
  const [allRoutes, setAllRoutes] = useState([]);
  const [sessions, setSessions]   = useState([]);
  const [playlists, setPlaylists] = useState([]);
  const [userRouteData, setUserRouteData] = useState({}); // { [routeId]: { sent, flashed, rating, angleSends, gradeSuggestions, attempted } }
  const [communityRatings, setCommunityRatings] = useState({}); // { [routeId]: { avg, count } }
  // Raw grade-suggestion rows keyed by routeId then userId — community consensus is derived
  // from this via useMemo so it re-normalises whenever the user changes their grade system.
  const [gradeRowsByRoute, setGradeRowsByRoute] = useState({}); // { [routeId]: { [userId]: { headline?, angles? } } }
  const [boardImageConfig, setBoardImageConfig] = useLocalStorage('barnboard_board_image_config', null);
  const [settings, setSettings] = useLocalStorage('barnboard_settings', { gradeSystem: 'V', adminMode: 'climber' });

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
  // Per-board holds: load the active wall's set; The Barn (slug 'the-barn') keeps
  // a legacy-rebuild safety net if its blob is ever missing (see useCustomHolds).
  const { allHolds, addHold, updateHold, deleteHold, saveAllHolds } = useCustomHolds(user, activeBoardId, activeBoard?.slug === 'the-barn');

  // ─── Auth effect — listen for login/logout ─────────────────────────
  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      // Dev-only autologin: lets Claude run UI tests against a real Supabase session
      // without manually typing credentials. Only active when VITE_DEV_AUTOLOGIN=true
      // in .env.local; production builds short-circuit on import.meta.env.DEV.
      if (!session && import.meta.env.DEV && import.meta.env.VITE_DEV_AUTOLOGIN === 'true') {
        const email = import.meta.env.VITE_DEV_AUTOLOGIN_EMAIL;
        const password = import.meta.env.VITE_DEV_AUTOLOGIN_PASSWORD;
        if (email && password) {
          const { error } = await supabase.auth.signInWithPassword({ email, password });
          if (error) console.warn('[dev autologin] failed:', error.message);
          // onAuthStateChange below will pick up the new session and setUser.
          setAuthLoading(false);
          return;
        }
        console.warn('[dev autologin] VITE_DEV_AUTOLOGIN=true but email/password env vars missing');
      }
      setUser(session?.user ?? null);
      setAuthLoading(false);
    }).catch((err) => {
      // getSession() itself rejecting (e.g. unreachable backend) must not strand
      // the app on the auth splash forever — fall through to the auth screen.
      console.error('[auth] getSession failed:', err);
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

  const loadDataFromSupabase = useCallback(async (userId, isFirstLoad, boardId) => {
    // Fire all queries in parallel — biggest startup speedup.
    // Routes + sessions are scoped to the active wall (boardId); the rest are user/global.
    const [routeResult, urdResult, ratingResult, gradeResult, sessionResult, plResult, imgConfigResult, profilesResult] = await Promise.all([
      db.fetchRoutes(boardId),
      db.fetchUserRouteData(userId),
      db.fetchAllRatings(),
      db.fetchAllGradeSuggestions(),
      // Sessions are a personal, cross-board log — fetch ALL walls (each row carries
      // board_id so the Sessions tab can filter/tag by wall). Not scoped to boardId.
      db.fetchSessions(userId),
      db.getBoardSetting(`playlists_${userId}`),
      db.getBoardImageConfig(boardId),
      db.fetchProfiles(),
    ]);
    // NOTE: the cross-wall allRoutes fetch (every route on every wall, for the
    // Sessions-tab stats) used to live here — it's a big query that gated first
    // paint for everyone, including users who never open the (beta) Sessions tab.
    // It's now lazy-loaded on demand when the Sessions view opens (see effect below).

    // a) Routes
    // Routes are scoped to the active wall (boardId). An EMPTY result is a real
    // answer — a fresh wall genuinely has no routes — so we must always re-derive
    // the routes list from the cloud rows, never leave the previous wall's routes
    // in state. (The old `length > 0` guard left stale routes when switching to an
    // empty wall, because a board switch is not isFirstLoad.)
    const routeRows = routeResult.data || [];
    if (routeRows.length === 0 && isFirstLoad) {
      // First login — migrate any localStorage routes (sequential, runs once ever)
      const local = JSON.parse(localStorage.getItem('barnboard_routes') || '[]');
      if (local.length > 0) {
        const withCreator = local.map(r => ({ ...r, creatorId: r.creatorId || userId }));
        setRoutes(withCreator);
        await db.insertRoutes(withCreator.map(r => ({ id: r.id, user_id: userId, data: stripPerUserFields(r) })));
        for (const r of local) {
          if (r.sent || r.rating) {
            const angleSends = (r.angleGrades || []).filter(ag => ag.sent).map(ag => ag.angle);
            await db.upsertUserRouteData(userId, r.id, {
              sent: !!r.sent, flashed: r.flashed || false, rating: r.rating || 0, angle_sends: angleSends, angle_flashes: [], angle_attempts: angleSends, attempted: r.attempted || false,
            });
          }
        }
      }
    } else {
      const cloudRoutes = routeRows.map(r => ({
        ...r.data,
        creatorId: r.data.creatorId || r.user_id,
        boardId: r.board_id,
      }));
      // Merge in any locally-pending routes the cloud doesn't know about yet.
      // Without this, a refetch (e.g. tab-visibility on flaky cellular) would wipe
      // a freshly-created route whose upsert hadn't landed — the bug we're fixing.
      // Scope to THIS wall so a pending route from another wall doesn't leak in.
      const cloudIds = new Set(cloudRoutes.map(r => r.id));
      const pending = getPendingRoutes();
      const orphaned = Object.values(pending)
        .map(entry => entry.route)
        .filter(r => r && !cloudIds.has(r.id) && (!boardId || r.boardId === boardId));
      if (orphaned.length > 0) {
        console.log('[pendingSync] preserving', orphaned.length, 'unsynced route(s) across refetch');
      }
      setRoutes([...orphaned, ...cloudRoutes]);
      // Drop any pending entries the cloud now confirms (a successful flush
      // from another device, or our own retry that we never saw the response for).
      const confirmedIds = Object.keys(pending).filter(id => cloudIds.has(id));
      for (const id of confirmedIds) dequeueRoute(id);
    }

    // b) User's per-route data
    const urdMap = {};
    if (urdResult.data) {
      for (const row of urdResult.data) {
        urdMap[row.route_id] = { sent: row.sent, flashed: row.flashed || false, rating: row.rating, angleSends: row.angle_sends || [], angleFlashes: row.angle_flashes || [], angleAttempts: row.angle_attempts || [], gradeSuggestions: row.grade_suggestions || {}, attempted: row.attempted || false };
      }
    }
    setUserRouteData(urdMap);

    // c) Community ratings
    const ratingsMap = {};
    if (ratingResult.data) {
      for (const row of ratingResult.data) {
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

    // d) Community grade suggestion rows — store raw, derive consensus reactively
    const rowsByRoute = {};
    if (gradeResult.data) {
      for (const row of gradeResult.data) {
        const gs = row.grade_suggestions || {};
        if (!gs.headline && !(gs.angles && Object.keys(gs.angles).length)) continue;
        if (!rowsByRoute[row.route_id]) rowsByRoute[row.route_id] = {};
        rowsByRoute[row.route_id][row.user_id] = gs;
      }
    }
    setGradeRowsByRoute(rowsByRoute);

    // e) Sessions — a personal, cross-board log (fetched for ALL walls above), so
    // the pending-session merge below is intentionally NOT scoped to boardId.
    const sessionRows = sessionResult.data || [];
    if (sessionRows.length === 0 && isFirstLoad) {
      // First login — migrate any localStorage sessions (legacy one-way, runs once ever)
      const local = JSON.parse(localStorage.getItem('barnboard_sessions') || '[]');
      if (local.length > 0) {
        setSessions(local);
        await db.insertSessions(local.map(s => ({ id: s.id, user_id: userId, data: s })));
      }
    } else {
      const cloudSessions = sessionRows.map(r => ({ ...r.data, boardId: r.board_id }));
      // Merge in any locally-pending sessions the cloud doesn't know about yet.
      // Mirrors the pending-route merge above — a session whose upload failed must
      // still be visible in the Sessions tab, not silently dropped from state.
      const cloudSessionIds = new Set(cloudSessions.map(s => s.id));
      const pendingSessions = getPendingSessions();
      const orphanedSessions = Object.values(pendingSessions)
        .map(entry => entry.session)
        .filter(s => s && !cloudSessionIds.has(s.id));
      if (orphanedSessions.length > 0) {
        console.log('[pendingSessionSync] preserving', orphanedSessions.length, 'unsynced session(s) across refetch');
      }
      setSessions([...orphanedSessions, ...cloudSessions]);
      // Drop any pending entries the cloud now confirms.
      const confirmedSessionIds = Object.keys(pendingSessions).filter(id => cloudSessionIds.has(id));
      for (const id of confirmedSessionIds) dequeueSession(id);
    }

    // f) Playlists
    const plData = plResult.data;
    if (plData) {
      setPlaylists(plData.data || []);
    } else if (isFirstLoad) {
      const local = JSON.parse(localStorage.getItem('barnboard_playlists') || '[]');
      if (local.length > 0) {
        setPlaylists(local);
        await db.setBoardSetting(`playlists_${userId}`, local);
      }
    }

    // g) Board image config (per-board, multi-wall 2b-ii)
    if (imgConfigResult.data) {
      setBoardImageConfig(imgConfigResult.data.data);
    } else if (!imgConfigResult.error) {
      // No per-board image. Fall back to the legacy GLOBAL key as a safety net for
      // The Barn (deploy window before the migration). A fresh wall genuinely has
      // none → null, so the app shows the bundled default until its image is set.
      const legacy = await db.getBoardSetting('board_image_config');
      if (legacy.data) setBoardImageConfig(legacy.data.data);
      else if (!legacy.error) setBoardImageConfig(null);
    }

    // h) Profiles — build lookup map and set own display name
    if (profilesResult.data) {
      const map = {};
      for (const row of profilesResult.data) {
        map[row.user_id] = { display_name: row.display_name, is_admin: row.is_admin };
      }
      setProfilesById(map);
      const own = map[userId];
      if (own?.display_name) setDisplayName(own.display_name);
    }

    setDataReady(true);
  }, [setRoutes, setSessions, setPlaylists, setBoardImageConfig]);

  // Resolve the active wall on login. 2a: use the user's membership, falling back
  // to (and joining) The Barn for any account that has none yet (e.g. a brand-new
  // signup after the migration). Persists the choice so the 2b switcher can restore
  // it. Runs alongside the data load — 2a reads aren't board-filtered yet, so order
  // doesn't matter.
  const resolveActiveBoard = useCallback(async (userId) => {
    const [{ data: memberships, error: membershipsError }, { data: allBoards, error: boardsError }] = await Promise.all([
      db.fetchMyMemberships(userId),
      db.fetchBoards(),
    ]);
    // supabase-js RESOLVES on a network failure and hands the problem back as
    // `error` rather than rejecting. Without this check an unreachable server is
    // indistinguishable from "this account belongs to no walls", and the user is
    // dumped on the join-a-wall onboarding screen as though their walls had
    // vanished. Throw instead, so the boot shows the offline notice.
    if (membershipsError || boardsError) throw (membershipsError || boardsError);
    const roleByBoard = {};
    (memberships || []).forEach(m => { roleByBoard[m.board_id] = m.role; });
    const mine = (allBoards || []).filter(b => roleByBoard[b.id]).map(b => ({ ...b, role: roleByBoard[b.id] }));
    // 2c: no auto-join. A brand-new (or wall-less) account lands on the onboarding
    // screen to pick a wall — joining the (now-private-by-default) Barn silently is
    // both a lockout risk under tenant-isolation RLS and the wrong multi-wall default.
    setMyBoards(mine);
    let boardId = null;
    if (mine.length > 0) {
      const stored = localStorage.getItem('barnboard_active_board');
      boardId = stored && mine.some(b => b.id === stored) ? stored : mine[0].id;
    }
    if (boardId) {
      activeBoardIdRef.current = boardId;
      setActiveBoardId(boardId);
      localStorage.setItem('barnboard_active_board', boardId);
    }
    return boardId;
  }, []);

  // Switch the active wall: persist, return to the board view, reload that wall's data.
  const switchBoard = useCallback((boardId) => {
    if (!user || boardId === activeBoardIdRef.current) return;
    activeBoardIdRef.current = boardId;
    setActiveBoardId(boardId);
    localStorage.setItem('barnboard_active_board', boardId);
    setViewingRoute(null);
    setHoldSelection({});
    setView('board');
    loadDataFromSupabase(user.id, false, boardId);
  }, [user, loadDataFromSupabase]);

  // ── Membership changes (2b-iv) ──────────────────────────────────────
  // Join/leave re-resolve myBoards then land on a wall (with its data loaded);
  // role/visibility changes refresh myBoards silently so the user stays in Settings.
  // resolveActiveBoard throws if the server is unreachable. These three are
  // user-initiated (not the boot path), so a failure here shouldn't blow up as an
  // unhandled rejection — log it and carry on with whatever walls we already know.
  const onWallJoined = useCallback(async (boardId) => {
    if (!user) return;
    try {
      await resolveActiveBoard(user.id);   // myBoards now includes the joined wall
    } catch (err) {
      console.error('[walls] could not refresh walls after joining:', err);
    }
    // Land on + load the joined wall unconditionally. (From the no-wall onboarding
    // state, resolveActiveBoard already set it active, which would make switchBoard
    // a no-op — so we set + load directly here instead of via switchBoard.)
    activeBoardIdRef.current = boardId;
    setActiveBoardId(boardId);
    localStorage.setItem('barnboard_active_board', boardId);
    setViewingRoute(null);
    setHoldSelection({});
    setView('board');
    loadDataFromSupabase(user.id, false, boardId);
  }, [user, resolveActiveBoard, loadDataFromSupabase]);

  const onWallLeft = useCallback(async () => {
    if (!user) return;
    try {
      await resolveActiveBoard(user.id);   // drops the left wall; activeBoardId → a remaining one
    } catch (err) {
      console.error('[walls] could not refresh walls after leaving:', err);
    }
    const next = activeBoardIdRef.current;
    if (next) { setView('board'); loadDataFromSupabase(user.id, false, next); }
  }, [user, resolveActiveBoard, loadDataFromSupabase]);

  const refreshMyBoards = useCallback(async () => {
    if (!user) return;
    try {
      await resolveActiveBoard(user.id);   // refresh roles/visibility; no nav
    } catch (err) {
      console.error('[walls] could not refresh walls:', err);
    }
  }, [user, resolveActiveBoard]);

  // Save the active wall's physical specs (admin/owner). Merge over the wall's
  // existing specs so boardRegion is preserved, then re-resolve so the new values
  // show immediately. Throws on RLS/db error so Settings can surface it.
  const onSaveBoardSpecs = useCallback(async (dims) => {
    if (!user || !activeBoardIdRef.current) return;
    const current = myBoards.find(b => b.id === activeBoardIdRef.current)?.specs || {};
    const { error } = await db.updateBoardSpecs(activeBoardIdRef.current, { ...current, ...dims });
    if (error) throw error;
    await resolveActiveBoard(user.id);
  }, [user, myBoards, resolveActiveBoard]);

  // Initial load on login. The naive order is serial — resolve the wall (boards +
  // board_members, ~1 round trip) THEN load that wall's data (~1 round trip) — which
  // stacks two latency hits back to back. But the last active wall is cached in
  // localStorage, so for a returning user we can OPTIMISTICALLY start the data load
  // for the cached wall in PARALLEL with the authoritative resolve. If resolve later
  // disagrees (membership changed, cache stale), we reload the correct wall — a rare
  // path. This overlaps the two round trips and roughly halves time-to-data.
  useEffect(() => {
    if (!user) return;
    setDataReady(false);
    setBoardsResolved(false);
    setBootError(null);
    hasLoadedOnce.current = false;
    let cancelled = false;
    let timeoutId;
    // Only the WALL RESOLVE is raced against a timeout, because it's the step
    // that gates the splash — a hanging (rather than rejecting) network must not
    // strand the user on it forever. The data load that follows is deliberately
    // NOT raced: once the walls are known the board is usable, and a slow or
    // failed data load is recovered by the visibility refetch and the pending
    // sync queues. Yanking a working board away to show an error screen would be
    // worse than letting the data arrive late.
    const RESOLVE_TIMEOUT_MS = 12000;
    const withTimeout = (promise) => Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`Timed out reaching the server after ${RESOLVE_TIMEOUT_MS / 1000}s`)),
          RESOLVE_TIMEOUT_MS,
        );
      }),
    ]);

    (async () => {
      const cachedBoardId = localStorage.getItem('barnboard_active_board');
      // Kick the cached wall's data load off in parallel with the authoritative
      // resolve (see the note above). Its own failure is non-fatal, so keep the
      // rejection handled here rather than letting it surface unhandled.
      const optimisticLoad = cachedBoardId
        ? loadDataFromSupabase(user.id, true, cachedBoardId)
            .catch(err => { console.error('[boot] optimistic data load failed:', err); })
        : null;

      let boardId = null;
      try {
        boardId = await withTimeout(resolveActiveBoard(user.id));
      } catch (err) {
        console.error('[boot] could not resolve the active wall:', err);
        if (!cancelled) setBootError(err);
        return;
      } finally {
        clearTimeout(timeoutId);
        // Unstick the splash as soon as the walls are known (or known to have
        // failed) — the data load below must never gate it, or every startup
        // waits on a full round trip of route/session data.
        if (!cancelled) setBoardsResolved(true);
      }

      try {
        if (boardId && boardId !== cachedBoardId) {
          // Cache was stale/invalid (or first ever load) → load the real wall.
          await loadDataFromSupabase(user.id, true, boardId);
        } else if (optimisticLoad) {
          await optimisticLoad; // cache was correct — the parallel load already ran
        }
        // (boardId null → no wall → onboarding screen, nothing to load)
      } catch (err) {
        // Non-fatal: the wall resolved, so the app is usable and the visibility
        // refetch / pending queues will catch up.
        console.error('[boot] data load failed (recoverable):', err);
      } finally {
        hasLoadedOnce.current = true;
      }
    })();

    return () => { cancelled = true; clearTimeout(timeoutId); };
  }, [user?.id, loadDataFromSupabase, resolveActiveBoard]);

  // Latest retryPendingSessions, set once it's defined further below (it depends on
  // flushSessionsToSupabase, which isn't declared yet at this point in the file) —
  // a ref avoids a forward-reference/TDZ issue while still letting this earlier
  // tab-visibility handler trigger a pending-session retry.
  const retryPendingSessionsRef = useRef(() => {});

  // Re-fetch from Supabase when tab becomes visible (switching devices/tabs)
  useEffect(() => {
    if (!user) return;
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && hasLoadedOnce.current) {
        console.log('[Sync] Tab visible — refreshing from Supabase');
        loadDataFromSupabase(user.id, false, activeBoardIdRef.current);
        retryPendingSessionsRef.current();
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
          // Ignore realtime events for other walls.
          const evtBoard = payload.new?.board_id ?? payload.old?.board_id;
          if (evtBoard && activeBoardIdRef.current && evtBoard !== activeBoardIdRef.current) return;

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

  // Immediate flush — only syncs routes this user created, stripped of per-user fields.
  // `pendingIds` is the set of route IDs that were enqueued for this flush; on success
  // they're dequeued, on failure their attempt count is bumped and they remain queued.
  const flushRoutesToSupabase = useCallback(async (routesToSync, pendingIds = null) => {
    const r = routesToSync || routesRef.current;
    if (!user) return;
    const myRoutes = r.filter(rt => rt.creatorId === user.id || !rt.creatorId);
    if (myRoutes.length === 0) return;
    clearTimeout(routesSyncTimer.current); // cancel pending debounce
    const { error } = await db.upsertRoutes(
      myRoutes.map(rt => ({ id: rt.id, user_id: user.id, data: stripPerUserFields(rt), ...boardCol(rt) }))
    );
    if (error) {
      if (pendingIds) {
        for (const id of pendingIds) recordFailure(id, error);
      }
    } else if (pendingIds) {
      for (const id of pendingIds) dequeueRoute(id);
    }
  }, [user]);

  // Re-attempt every entry sitting in the localStorage pending queue. Called on:
  // initial load, tab visibility change, network 'online' event. Routes that have
  // since been edited locally are flushed using the latest in-memory copy; routes
  // that exist only in the queue (e.g. saved while offline, then app killed) are
  // re-added to local state so they're visible while we retry.
  const flushPendingRoutes = useCallback(async () => {
    if (!user) return;
    const queue = getPendingRoutes();
    const ids = Object.keys(queue);
    if (ids.length === 0) return;
    // Prefer the live in-memory route (may include later edits) over the queued snapshot.
    const liveById = new Map(routesRef.current.map(r => [r.id, r]));
    const toFlush = ids
      .map(id => liveById.get(id) || queue[id].route)
      .filter(Boolean);
    if (toFlush.length === 0) return;
    console.log('[pendingSync] retrying', toFlush.length, 'pending route(s)');
    await flushRoutesToSupabase(toFlush, ids);
  }, [user, flushRoutesToSupabase]);

  // ─── Pending-route retry triggers ─────────────────────────────────
  // After every successful load, retry anything still stuck in the queue.
  useEffect(() => {
    if (!user || !dataReady) return;
    flushPendingRoutes();
  }, [user?.id, dataReady, flushPendingRoutes]);

  // When the device regains network, immediately retry. This catches the
  // common case: route saved on cellular while signal dropped, then wifi
  // reconnects — we don't have to wait for the next visibility event.
  useEffect(() => {
    if (!user) return;
    const handleOnline = () => {
      console.log('[pendingSync] online — retrying pending routes');
      flushPendingRoutes();
    };
    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, [user?.id, flushPendingRoutes]);

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
      await db.upsertRoutes(myRoutes.map(r => ({ id: r.id, user_id: user.id, data: stripPerUserFields(r), ...boardCol(r) })));
    }, 1500);
    return () => clearTimeout(routesSyncTimer.current);
  }, [routes, user, dataReady]);

  // ─── Sessions sync — upsert to Supabase whenever sessions change ──
  const sessionsSyncTimer = useRef(null);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  // Reconciles against the localStorage durability queue: any of the sessions we
  // just tried to write that are sitting in the pending queue get dequeued on
  // success, or have their failure recorded (and stay queued) on failure. This
  // covers the immediate flush after endSession, the debounced sync below (which
  // now routes through this same function), and the retry loop — whichever call
  // happens to succeed first clears the queue entry, and a failure is never silent.
  const flushSessionsToSupabase = useCallback(async (sessionsToSync) => {
    const s = sessionsToSync || sessionsRef.current;
    if (!user || s.length === 0) return;
    clearTimeout(sessionsSyncTimer.current);
    const { error } = await db.upsertSessions(s.map(ss => ({ id: ss.id, user_id: user.id, data: ss, ...boardCol(ss) })));
    const queuedIds = s.map(ss => ss.id).filter(id => getPendingSessionIds().includes(id));
    if (error) {
      for (const id of queuedIds) recordSessionFailure(id, error);
    } else {
      for (const id of queuedIds) dequeueSession(id);
    }
  }, [user]);

  useEffect(() => {
    if (!user || !dataReady) return;
    clearTimeout(sessionsSyncTimer.current);
    sessionsSyncTimer.current = setTimeout(async () => {
      if (sessions.length === 0) return;
      console.log('[Sync] Debounced upsert:', sessions.length, 'sessions');
      await flushSessionsToSupabase(sessions);
    }, 1500);
    return () => clearTimeout(sessionsSyncTimer.current);
  }, [sessions, user, dataReady, flushSessionsToSupabase]);

  // Re-attempt every entry sitting in the localStorage pending-session queue. Called
  // on: initial load, tab visibility change, network 'online' event. Mirrors
  // flushPendingRoutes. Prefers the live in-memory session (may include later edits)
  // over the queued snapshot.
  const retryPendingSessions = useCallback(async () => {
    if (!user) return;
    const queue = getPendingSessions();
    const ids = Object.keys(queue);
    if (ids.length === 0) return;
    const liveById = new Map(sessionsRef.current.map(s => [s.id, s]));
    const toFlush = ids
      .map(id => liveById.get(id) || queue[id].session)
      .filter(Boolean);
    if (toFlush.length === 0) return;
    console.log('[pendingSessionSync] retrying', toFlush.length, 'pending session(s)');
    await flushSessionsToSupabase(toFlush);
  }, [user, flushSessionsToSupabase]);
  retryPendingSessionsRef.current = retryPendingSessions;

  // ─── Pending-session retry triggers ────────────────────────────────
  // After every successful load, retry anything still stuck in the queue.
  useEffect(() => {
    if (!user || !dataReady) return;
    retryPendingSessions();
  }, [user?.id, dataReady, retryPendingSessions]);

  // When the device regains network, immediately retry.
  useEffect(() => {
    if (!user) return;
    const handleOnline = () => {
      console.log('[pendingSessionSync] online — retrying pending sessions');
      retryPendingSessions();
    };
    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, [user?.id, retryPendingSessions]);

  // ─── Playlists sync ───────────────────────────────────────────────
  const playlistsSyncTimer = useRef(null);
  const flushPlaylistsToSupabase = useCallback(async (pl) => {
    if (!user) return;
    clearTimeout(playlistsSyncTimer.current);
    await db.setBoardSetting(`playlists_${user.id}`, pl);
  }, [user]);

  useEffect(() => {
    if (!user || !dataReady) return;
    clearTimeout(playlistsSyncTimer.current);
    playlistsSyncTimer.current = setTimeout(async () => {
      await db.setBoardSetting(`playlists_${user.id}`, playlists);
      // Keep shared_playlists in sync for any shared playlists
      const sharedOnes = playlists.filter(pl => pl.shared);
      for (const pl of sharedOnes) {
        await db.upsertSharedPlaylist({
          id: pl.id, user_id: user.id, name: pl.name,
          creator_name: user.email.split('@')[0], route_ids: pl.routeIds,
        });
      }
    }, 1500);
    return () => clearTimeout(playlistsSyncTimer.current);
  }, [playlists, user, dataReady]);

  // ─── Shared playlists callbacks ───────────────────────────────────
  const fetchSharedPlaylists = useCallback(async () => {
    return db.fetchSharedPlaylists();
  }, []);

  const togglePlaylistShared = useCallback(async (plId, shared) => {
    let targetPl = null;
    setPlaylists(prev => {
      targetPl = prev.find(p => p.id === plId);
      return prev.map(pl => pl.id === plId ? { ...pl, shared } : pl);
    });
    if (!user) return;
    if (shared && targetPl) {
      await db.upsertSharedPlaylist({
        id: targetPl.id, user_id: user.id, name: targetPl.name,
        creator_name: user.email.split('@')[0], route_ids: targetPl.routeIds,
      });
    } else if (!shared) {
      await db.deleteSharedPlaylist(plId);
    }
  }, [user]);

  // ─── Display Name / Profiles ──────────────────────────────────────
  const saveDisplayName = useCallback(async (newName) => {
    if (!user) return;
    const { error } = await db.upsertProfile(user.id, { display_name: newName });
    if (error) throw error;
    setDisplayName(newName);
    setProfilesById(prev => ({
      ...prev,
      [user.id]: { ...(prev[user.id] || {}), display_name: newName },
    }));
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

  // ─── Session edit handlers ─────────────────────────────────────────
  const handleEditSession = useCallback((session, source = 'settings') => {
    editSessionSourceRef.current = source;
    setEditSessionSource(source);
    setEditingSession(session);
    setView('sessionEdit');
  }, []);

  const updateSession = useCallback((updatedSession) => {
    let updated;
    setSessions(prev => {
      updated = prev.map(s => s.id === updatedSession.id ? updatedSession : s);
      return updated;
    });
    // Flush immediately — don't wait for debounce
    if (updated) flushSessionsToSupabase(updated);

    // Additively forward the edited session's per-angle state into lifetime
    // userRouteData. This is the only place a past-session edit can affect
    // lifetime data, and it must never subtract: another session (or a direct
    // route-card edit) may have contributed the same angle independently.
    // Only routes whose merged record actually changes get a Supabase write —
    // an unchanged session save must produce zero writes.
    if (user) {
      const sessionDelta = deriveSessionRouteState(updatedSession);
      setUserRouteData(prev => {
        let next = prev;
        for (const [routeId, delta] of Object.entries(sessionDelta)) {
          const current = prev[routeId] || {
            sent: false, flashed: false, attempted: false, rating: 0,
            angleSends: [], angleFlashes: [], angleAttempts: [], gradeSuggestions: {},
          };

          const angleAttempts = unionArrays(current.angleAttempts, delta.attemptAngles);
          const angleSends    = unionArrays(current.angleSends, delta.sendAngles);
          const angleFlashes  = unionArrays(current.angleFlashes, delta.flashAngles);
          const attempted = !!current.attempted || delta.attempted;
          const sent      = !!current.sent || delta.sent;
          const flashed   = !!current.flashed || delta.flashed;

          const changed =
            attempted !== !!current.attempted ||
            sent      !== !!current.sent ||
            flashed   !== !!current.flashed ||
            angleAttempts.length !== (current.angleAttempts || []).length ||
            angleSends.length    !== (current.angleSends || []).length ||
            angleFlashes.length  !== (current.angleFlashes || []).length;

          if (!changed) continue;

          const merged = { ...current, attempted, sent, flashed, angleAttempts, angleSends, angleFlashes };

          db.upsertUserRouteData(user.id, routeId, {
            sent: merged.sent, flashed: merged.flashed, rating: merged.rating,
            angle_sends: merged.angleSends, angle_flashes: merged.angleFlashes, angle_attempts: merged.angleAttempts,
            grade_suggestions: merged.gradeSuggestions || {}, attempted: merged.attempted,
          });

          if (next === prev) next = { ...prev };
          next[routeId] = merged;
        }
        return next;
      });
    }

    setEditingSession(null);
    const returnTo = editSessionSourceRef.current;
    editSessionSourceRef.current = 'settings';
    setEditSessionSource('settings');
    setView(returnTo === 'sessions' ? 'sessions' : 'settings');
  }, [user, setSessions, flushSessionsToSupabase, setUserRouteData]);

  // UI state
  // view: board | create | routes | sessions | settings | viewRoute | addHold | editHold | setupBoard | sessionSummary | sessionEdit
  const [view, setView]                 = useState('board');
  const [editingSession, setEditingSession] = useState(null);
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
  const [viewRouteOrder, setViewRouteOrder] = useState([]); // ordered route IDs matching active filter/sort when route was opened
  const [isBoardZoomed, setIsBoardZoomed]   = useState(false);
  const swipeRef = useRef({ startX: 0, startY: 0, dx: 0, engaged: false, active: false });
  const [swipeDx, setSwipeDx] = useState(0);
  const [transitionMode, setTransitionMode] = useState('snap'); // 'none' | 'snap' | 'slide'
  const [carouselActive, setCarouselActive] = useState(false); // true when neighbour cards should be mounted

  // Lifted period state for Sessions tab — persists across navigation
  const [sessionsPeriod, setSessionsPeriod] = useState(null);

  // Lazy cross-wall route fetch for the Sessions tab. The Sessions stats resolve
  // route metadata (grade/holdTypes/styles/holds) across EVERY wall, but that's a
  // big query we don't want on the first-paint critical path — so we fetch it only
  // when the Sessions view actually opens, and refresh it each time it does (the
  // realtime/visibility sync only updates the current wall's `routes`, so allRoutes
  // would otherwise go stale). SessionsView falls back to the current-wall `routes`
  // for the brief moment before this lands. (Declared here, after `view`, so the
  // dependency array doesn't reference `view` in its temporal dead zone.)
  useEffect(() => {
    if (view !== 'sessions' || !user) return;
    let cancelled = false;
    db.fetchRoutes().then(({ data }) => {
      if (cancelled || !data) return;
      setAllRoutes(data.map(r => ({
        ...r.data,
        creatorId: r.data.creatorId || r.user_id,
        boardId: r.board_id,
      })));
    });
    return () => { cancelled = true; };
  }, [view, user?.id]);

  // Back-nav sources — track where viewRoute / sessionEdit were launched from
  const [viewRouteSource, setViewRouteSource] = useState('routes'); // 'routes' | 'sessions'
  const viewRouteSourceRef = useRef('routes');
  const [editSessionSource, setEditSessionSource] = useState('settings'); // 'settings' | 'sessions'
  const editSessionSourceRef = useRef('settings');

  // Route form state
  const [routeName, setRouteName]   = useState('');
  const [routeGrade, setRouteGrade] = useState('V3');
  const [routeAngle, setRouteAngle] = useState(30);
  const [holdTypes, setHoldTypes]   = useState([]);
  const [techniques, setTechniques] = useState([]);
  const [styles, setStyles]         = useState([]);
  const [setter, setSetter]         = useState('');
  const [description, setDescription] = useState('');
  const [youtubeUrl, setYoutubeUrl] = useState('');

  const grades = settings.gradeSystem === 'V' ? V_GRADES : FONT_GRADES;
  const gradeIndex = settings.gradeSystem === 'font' ? FONT_GRADE_INDEX : V_GRADE_INDEX;

  // Derive community grade consensus from raw rows. Recomputes whenever the user
  // changes their grade system so every vote is normalised into the active system
  // (e.g. V3 + 6A votes merge into one bucket) before consensus is picked.
  const communityGrades = useMemo(() => {
    const result = {};
    for (const [routeId, byUser] of Object.entries(gradeRowsByRoute)) {
      const headlineVotes = {};
      const anglesVotes = {};
      for (const gs of Object.values(byUser)) {
        if (gs?.headline) {
          const g = displayGrade(gs.headline, settings.gradeSystem);
          headlineVotes[g] = (headlineVotes[g] || 0) + 1;
        }
        if (gs?.angles) {
          for (const [angle, grade] of Object.entries(gs.angles)) {
            if (!grade) continue;
            if (!anglesVotes[angle]) anglesVotes[angle] = {};
            const g = displayGrade(grade, settings.gradeSystem);
            anglesVotes[angle][g] = (anglesVotes[angle][g] || 0) + 1;
          }
        }
      }
      const consensusFrom = (votes) => {
        const entries = Object.entries(votes);
        if (entries.length === 0) return null;
        const total = entries.reduce((s, [, n]) => s + n, 0);
        const sorted = entries.sort((a, b) =>
          b[1] !== a[1] ? b[1] - a[1] : (gradeIndex[b[0]] ?? -1) - (gradeIndex[a[0]] ?? -1)
        );
        return { consensus: sorted[0][0], votes, count: total };
      };
      const headline = consensusFrom(headlineVotes);
      const angles = {};
      for (const [angle, votes] of Object.entries(anglesVotes)) {
        const c = consensusFrom(votes);
        if (c) angles[angle] = c;
      }
      if (headline || Object.keys(angles).length) {
        result[routeId] = { headline, angles };
      }
    }
    return result;
  }, [gradeRowsByRoute, settings.gradeSystem, gradeIndex]);

  // Board image — derive URLs from config (loaded in loadDataFromSupabase), fall back to static defaults
  // Append ?v=<cacheVersion> when present so browsers re-fetch after an image replace
  const _imgCacheParam = boardImageConfig?.cacheVersion ? `?v=${boardImageConfig.cacheVersion}` : '';
  const imgSrc = boardImageConfig
    ? `${boardImageConfig.baseUrl}/${boardImageConfig.imageName}.jpg${_imgCacheParam}`
    : DEFAULT_BOARD_IMAGE;
  const imgSrcSet = boardImageConfig
    ? `${boardImageConfig.baseUrl}/${boardImageConfig.imageName}-800w.jpg${_imgCacheParam} 800w, ${boardImageConfig.baseUrl}/${boardImageConfig.imageName}-1200w.jpg${_imgCacheParam} 1200w, ${boardImageConfig.baseUrl}/${boardImageConfig.imageName}-2000w.jpg${_imgCacheParam} 2000w`
    : DEFAULT_BOARD_SRCSET;
  const imgSizes = DEFAULT_BOARD_SIZES;

  const resetCreate = useCallback(() => {
    setHoldSelection({});
    setRouteName('');
    setRouteGrade(settings.gradeSystem === 'V' ? 'V3' : '6A');
    setRouteAngle(30);
    setHoldTypes([]);
    setTechniques([]);
    setStyles([]);
    setSetter('');
    setDescription('');
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
      boardId: activeBoardIdRef.current,
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
    // activeSession.sends is authoritative: logRouteSent is idempotent per
    // (routeId, angle) and unlogRouteAngle / cycleSentState remove entries when a
    // state is cycled back down, so un-sent routes are already gone. It must NOT be
    // rebuilt from lifetime userRouteData — that would drop each send's `flash` flag
    // and its real timestamp, and would fabricate sends from OTHER sessions (a route
    // merely tried today but sent at 30° last month would gain a bogus 30° send here).
    const finalSends = (activeSession.sends || []).filter(s =>
      routesRef.current.some(r => r.id === s.routeId)
    );
    const finalRoutesSent = [...new Set(finalSends.map(s => s.routeId))];
    const finalFlashedRouteIds = [...new Set(finalSends.filter(s => s.flash).map(s => s.routeId))];

    const finished = {
      ...activeSession,
      endTime: new Date().toISOString(),
      routesSent: finalRoutesSent,
      sends: finalSends,
    };
    if (finalFlashedRouteIds.length > 0) finished.flashedRouteIds = finalFlashedRouteIds;
    else delete finished.flashedRouteIds;
    // Durably enqueue BEFORE anything else — localStorage writes are synchronous, so
    // this guarantees a persisted copy exists at the moment `barnboard_active_session`
    // (the only other durable copy) is cleared below. If the upload that follows
    // fails, the session survives in the pending queue and stays visible (merged
    // into `sessions` on next load) instead of vanishing.
    enqueueSession(finished);
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

  // markAttempted — unified entry point for deliberate user interaction with a route.
  // Sets the lifetime per-user `attempted` flag and also logs to the active session.
  const markAttempted = useCallback((routeId) => {
    if (!user) return;
    setUserRouteData(prev => {
      const current = prev[routeId] || { sent: false, flashed: false, rating: 0, angleSends: [], angleFlashes: [], angleAttempts: [], gradeSuggestions: {}, attempted: false };
      if (current.attempted) return prev; // already set — idempotent
      db.upsertUserRouteData(user.id, routeId, {
        sent: current.sent, flashed: current.flashed || false, rating: current.rating,
        angle_sends: current.angleSends, angle_flashes: current.angleFlashes || [], angle_attempts: current.angleAttempts || [],
        grade_suggestions: current.gradeSuggestions || {}, attempted: true,
      });
      return { ...prev, [routeId]: { ...current, attempted: true } };
    });
    logRouteAttempted(routeId);
  }, [user, logRouteAttempted]);

  // logRouteSent — idempotent per (routeId, angle): updates the existing sends[]
  // entry in place (e.g. sent → flash upgrade) instead of appending a duplicate.
  const logRouteSent = useCallback((routeId, angle, grade, isFlash = false) => {
    if (!activeSession) return;
    setActiveSession(prev => {
      if (!prev) return prev;
      const routesSent = prev.routesSent.includes(routeId)
        ? prev.routesSent
        : [...prev.routesSent, routeId];
      const sends = prev.sends || [];
      const existingIdx = sends.findIndex(s => s.routeId === routeId && s.angle === (angle || null));
      const newSend = { routeId, angle: angle || null, grade: grade || null, time: new Date().toISOString() };
      if (isFlash) newSend.flash = true;
      let newSends;
      if (existingIdx >= 0) {
        newSends = sends.slice();
        newSends[existingIdx] = newSend;
      } else {
        newSends = [...sends, newSend];
      }
      // flashedRouteIds is derived from sends[] with flash:true — recompute after every update.
      const flashedRouteIds = [...new Set(newSends.filter(s => s.flash).map(s => s.routeId))];
      const next = { ...prev, routesSent, sends: newSends };
      if (flashedRouteIds.length > 0) next.flashedRouteIds = flashedRouteIds;
      else delete next.flashedRouteIds;
      return next;
    });
  }, [activeSession, setActiveSession]);

  // logAngleAttempted — records an attempt at a specific angle for a route in the
  // active session (angleAttempts: [{routeId, angles: []}]). No-op without an angle.
  const logAngleAttempted = useCallback((routeId, angle) => {
    if (!activeSession || angle == null) return;
    setActiveSession(prev => {
      if (!prev) return prev;
      const attempts = prev.angleAttempts || [];
      const idx = attempts.findIndex(a => a.routeId === routeId);
      let newAttempts;
      if (idx >= 0) {
        if (attempts[idx].angles.includes(angle)) return prev; // already recorded
        newAttempts = attempts.slice();
        newAttempts[idx] = { ...attempts[idx], angles: [...attempts[idx].angles, angle] };
      } else {
        newAttempts = [...attempts, { routeId, angles: [angle] }];
      }
      return { ...prev, angleAttempts: newAttempts };
    });
  }, [activeSession, setActiveSession]);

  // unlogRouteAngle — reverse of logRouteSent + logAngleAttempted for one angle:
  // removes the angle's sends[] entry and angleAttempts entry, then recomputes
  // routesSent / flashedRouteIds / routesAttempted from what remains.
  const unlogRouteAngle = useCallback((routeId, angle) => {
    if (!activeSession) return;
    setActiveSession(prev => {
      if (!prev) return prev;
      const normAngle = angle || null;

      const sends = (prev.sends || []).filter(s => !(s.routeId === routeId && s.angle === normAngle));
      const routesSent = sends.some(s => s.routeId === routeId)
        ? prev.routesSent
        : prev.routesSent.filter(id => id !== routeId);
      const flashedRouteIds = [...new Set(sends.filter(s => s.flash).map(s => s.routeId))];

      const attempts = prev.angleAttempts || [];
      const idx = attempts.findIndex(a => a.routeId === routeId);
      let newAttempts = attempts;
      if (idx >= 0) {
        const remainingAngles = attempts[idx].angles.filter(a => a !== angle);
        newAttempts = remainingAngles.length > 0
          ? [...attempts.slice(0, idx), { ...attempts[idx], angles: remainingAngles }, ...attempts.slice(idx + 1)]
          : [...attempts.slice(0, idx), ...attempts.slice(idx + 1)];
      }
      const remainingAttemptAngles = newAttempts.find(a => a.routeId === routeId)?.angles || [];
      const stillHasSend = sends.some(s => s.routeId === routeId);
      const routesAttempted = (!stillHasSend && remainingAttemptAngles.length === 0)
        ? prev.routesAttempted.filter(id => id !== routeId)
        : prev.routesAttempted;

      const next = { ...prev, sends, routesSent, routesAttempted };
      if (flashedRouteIds.length > 0) next.flashedRouteIds = flashedRouteIds;
      else delete next.flashedRouteIds;
      if (newAttempts.length > 0) next.angleAttempts = newAttempts;
      else delete next.angleAttempts;
      return next;
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
    let savedRouteId;
    let savedRouteSnapshot;
    localRouteChange.current = true;
    if (editingRouteId) {
      const updated = (rt) => ({
        ...rt,
        name: routeName.trim(),
        grade: routeGrade,
        angle: routeAngle,
        setter: setter.trim(),
        description: description.trim() || undefined,
        youtubeUrl: youtubeUrl.trim() || undefined,
        holds: currentHolds,
        holdSnapshots,
        holdTypes, techniques, styles,
        updatedAt: new Date().toISOString(),
      });
      setRoutes(prev => {
        savedRoutes = prev.map(r => {
          if (r.id !== editingRouteId) return r;
          savedRouteSnapshot = updated(r);
          return savedRouteSnapshot;
        });
        return savedRoutes;
      });
      savedRouteId = editingRouteId;
    } else {
      const newRoute = {
        id: Date.now().toString(),
        name: routeName.trim(),
        grade: routeGrade,
        angle: routeAngle,
        setter: setter.trim(),
        description: description.trim() || undefined,
        creatorId: user?.id,
        boardId: activeBoardIdRef.current,
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
      savedRouteId = newRoute.id;
      savedRouteSnapshot = newRoute;
      logRouteCreated(newRoute.id);
    }
    // Persist to localStorage queue BEFORE the network call. If the network fails
    // (or a tab-visibility refetch happens before the upsert lands), the queue
    // keeps the route alive so the next retry can save it.
    if (savedRouteSnapshot) {
      enqueueRoute(savedRouteSnapshot);
    }
    // Flush to Supabase immediately — don't wait for debounce
    if (savedRoutes) flushRoutesToSupabase(savedRoutes, savedRouteId ? [savedRouteId] : null);
    resetCreate();
    setView('routes');
  }, [routeName, routeGrade, routeAngle, setter, description, youtubeUrl, holdTypes, techniques, styles, setRoutes, resetCreate, editingRouteId, logRouteCreated, allHolds, flushRoutesToSupabase]);

  const viewRoute = useCallback((route, orderedIds) => {
    if (orderedIds !== undefined) setViewRouteOrder(orderedIds);
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
  }, [setRoutes, allHolds]);

  // Entry point from Sessions tab — sets back-nav source to 'sessions'
  const handleViewRouteFromSessions = useCallback((routeId) => {
    const route = routes.find(r => r.id === routeId);
    if (!route) return;
    viewRouteSourceRef.current = 'sessions';
    setViewRouteSource('sessions');
    viewRoute(route);
  }, [routes, viewRoute]);

  const commitNavigation = useCallback((direction) => {
    if (!viewingRoute || viewRouteOrder.length === 0) return;
    const idx = viewRouteOrder.indexOf(viewingRoute.id);
    if (idx === -1) return;
    const targetIdx = idx + (direction === 'next' ? 1 : -1);
    if (targetIdx < 0 || targetIdx >= viewRouteOrder.length) return;
    const target = routes.find(r => r.id === viewRouteOrder[targetIdx]);
    if (!target) return;

    const screenW = window.innerWidth;
    const gap = 40;
    const fullShift = (direction === 'next' ? -1 : 1) * (screenW + gap);

    // Mount neighbours and animate the track
    setCarouselActive(true);
    setTransitionMode('slide');
    setSwipeDx(fullShift);

    // After the 0.28s animation completes, swap the active route and instantly reset
    setTimeout(() => {
      // Switch to no-transition so the reset is invisible
      setTransitionMode('none');
      viewRoute(target, viewRouteOrder);
      setSwipeDx(0);
      // Double-rAF: ensure the browser commits translateX(0) with transition:none
      // BEFORE re-enabling the snap transition and unmounting neighbours.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setTransitionMode('snap');
          setCarouselActive(false);
        });
      });
    }, 280);
  }, [viewingRoute, viewRouteOrder, routes, viewRoute]);

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
      setDescription(r.description || '');
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
      const current = prev[routeId] || { sent: false, flashed: false, rating: 0, angleSends: [], angleFlashes: [], angleAttempts: [], gradeSuggestions: {}, attempted: false };
      const finalRating = current.rating === newRating ? 0 : newRating;
      db.upsertUserRouteData(user.id, routeId, {
        sent: current.sent, flashed: current.flashed || false, rating: finalRating,
        angle_sends: current.angleSends, angle_flashes: current.angleFlashes || [], angle_attempts: current.angleAttempts || [],
        grade_suggestions: current.gradeSuggestions || {}, attempted: current.attempted || false,
      });
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

  // cycleSentState — 4-state cycle: empty → tried → sent → flash → empty
  //   empty: sent=false, flashed=false, attempted=false
  //   tried: sent=false, flashed=false, attempted=true
  //   sent:  sent=true,  flashed=false, attempted=true
  //   flash: sent=true,  flashed=true,  attempted=true
  const cycleSentState = useCallback((routeId) => {
    if (!user) return;
    setUserRouteData(prev => {
      const current = prev[routeId] || { sent: false, flashed: false, rating: 0, angleSends: [], angleFlashes: [], angleAttempts: [], gradeSuggestions: {}, attempted: false };
      // Derive current state and next state
      const currentState = current.flashed ? 'flash' : current.sent ? 'sent' : current.attempted ? 'tried' : 'empty';
      const nextState = currentState === 'empty' ? 'tried'
                      : currentState === 'tried' ? 'sent'
                      : currentState === 'sent'  ? 'flash'
                      :                            'empty';
      const newSent      = nextState === 'sent'  || nextState === 'flash';
      const newFlashed   = nextState === 'flash';
      const newAttempted = nextState !== 'empty';
      db.upsertUserRouteData(user.id, routeId, {
        sent: newSent, flashed: newFlashed, rating: current.rating,
        angle_sends: current.angleSends, angle_flashes: current.angleFlashes || [], angle_attempts: current.angleAttempts || [],
        grade_suggestions: current.gradeSuggestions || {}, attempted: newAttempted,
      });
      if (nextState === 'sent') {
        // Freshly sent — log to session
        const route = routesRef.current.find(r => r.id === routeId);
        if (route) {
          logRouteSent(routeId, route.angle, route.grade, false);
          if (route.angle) logAngleClimbed(route.angle);
        }
      } else if (nextState === 'flash') {
        // Upgrade the existing sent entry to a flash (logRouteSent is idempotent per angle).
        const route = routesRef.current.find(r => r.id === routeId);
        if (route) {
          logRouteSent(routeId, route.angle, route.grade, true);
          if (route.angle) logAngleClimbed(route.angle);
        }
      } else if (nextState === 'empty' && current.attempted) {
        // Cycling back to empty from flash — strip this route's session log entries entirely
        // and drop it from the active session's attempted list.
        setActiveSession(prevSession => {
          if (!prevSession) return prevSession;
          const sends = (prevSession.sends || []).filter(s => s.routeId !== routeId);
          const flashedRouteIds = [...new Set(sends.filter(s => s.flash).map(s => s.routeId))];
          const next = {
            ...prevSession,
            sends,
            routesSent: prevSession.routesSent.filter(id => id !== routeId),
            routesAttempted: prevSession.routesAttempted.filter(id => id !== routeId),
          };
          if (flashedRouteIds.length > 0) next.flashedRouteIds = flashedRouteIds;
          else delete next.flashedRouteIds;
          return next;
        });
      }
      // Log attempt when moving away from empty (idempotent)
      if (newAttempted && !current.attempted) logRouteAttempted(routeId);
      return { ...prev, [routeId]: { ...current, sent: newSent, flashed: newFlashed, attempted: newAttempted } };
    });
  }, [user, logRouteSent, logAngleClimbed, logRouteAttempted]);

  const deleteRoute = useCallback((routeId) => {
    setRoutes(prev => prev.filter(r => r.id !== routeId));
    // Also remove from playlists
    setPlaylists(prev => prev.map(pl => ({
      ...pl, routeIds: pl.routeIds.filter(id => id !== routeId),
    })));
    // Drop from pending queue — otherwise a retry would re-create the deleted route.
    dequeueRoute(routeId);
    setHoldSelection({});
    setViewingRoute(null);
    setView('routes');
    // Delete from Supabase (must be explicit — upsert sync won't remove deleted rows)
    if (user) {
      db.deleteRoute(routeId).then(({ data, error }) => {
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

  // cycleAngleSentState — 4-state cycle on a single angle: empty → tried → sent → flash → empty.
  //   tried: angle ∈ angleAttempts only
  //   sent:  angle ∈ angleSends + angleAttempts
  //   flash: angle ∈ angleFlashes + angleSends + angleAttempts
  const cycleAngleSentState = useCallback((routeId, angle) => {
    if (!user) return;
    setUserRouteData(prev => {
      const current = prev[routeId] || { sent: false, flashed: false, rating: 0, angleSends: [], angleFlashes: [], angleAttempts: [], gradeSuggestions: {}, attempted: false };
      const sendsArr    = current.angleSends    || [];
      const flashesArr  = current.angleFlashes  || [];
      const attemptsArr = current.angleAttempts || [];
      const currentState = flashesArr.includes(angle) ? 'flash'
                         : sendsArr.includes(angle)   ? 'sent'
                         : attemptsArr.includes(angle) ? 'tried'
                         :                              'empty';
      const nextState = currentState === 'empty' ? 'tried'
                      : currentState === 'tried' ? 'sent'
                      : currentState === 'sent'  ? 'flash'
                      :                            'empty';

      const without = (arr, a) => arr.filter(x => x !== a);
      const withVal = (arr, a) => arr.includes(a) ? arr : [...arr, a];

      let newAttempts = attemptsArr;
      let newSends    = sendsArr;
      let newFlashes  = flashesArr;
      switch (nextState) {
        case 'tried':
          newAttempts = withVal(attemptsArr, angle);
          newSends    = without(sendsArr, angle);
          newFlashes  = without(flashesArr, angle);
          break;
        case 'sent':
          newAttempts = withVal(attemptsArr, angle);
          newSends    = withVal(sendsArr, angle);
          newFlashes  = without(flashesArr, angle);
          break;
        case 'flash':
          newAttempts = withVal(attemptsArr, angle);
          newSends    = withVal(sendsArr, angle);
          newFlashes  = withVal(flashesArr, angle);
          break;
        case 'empty':
        default:
          newAttempts = without(attemptsArr, angle);
          newSends    = without(sendsArr, angle);
          newFlashes  = without(flashesArr, angle);
      }

      const willBeAttempted = nextState !== 'empty' || current.attempted;
      db.upsertUserRouteData(user.id, routeId, {
        sent: current.sent, flashed: current.flashed || false, rating: current.rating,
        angle_sends: newSends, angle_flashes: newFlashes, angle_attempts: newAttempts,
        grade_suggestions: current.gradeSuggestions || {}, attempted: willBeAttempted,
      });

      // Session logging — one branch per target state.
      if (nextState === 'tried') {
        logAngleAttempted(routeId, angle);
        logRouteAttempted(routeId);
      } else if (nextState === 'sent' || nextState === 'flash') {
        const route = routesRef.current.find(r => r.id === routeId);
        const ag = (route?.angleGrades || []).find(a => a.angle === angle);
        logAngleAttempted(routeId, angle);
        logRouteSent(routeId, angle, ag?.grade || route?.grade, nextState === 'flash');
        logAngleClimbed(angle);
        logRouteAttempted(routeId);
      } else {
        unlogRouteAngle(routeId, angle);
      }

      return {
        ...prev,
        [routeId]: {
          ...current,
          angleSends: newSends, angleFlashes: newFlashes, angleAttempts: newAttempts,
          attempted: willBeAttempted,
        },
      };
    });
  }, [user, logRouteSent, logAngleClimbed, logRouteAttempted, logAngleAttempted, unlogRouteAngle]);

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

  // ─── Community grade suggestions ─────────────────────────────────
  const suggestGrade = useCallback((routeId, headline, angles) => {
    if (!user) return;

    setUserRouteData(prev => {
      const current = prev[routeId] || { sent: false, rating: 0, angleSends: [], angleFlashes: [], angleAttempts: [], attempted: false };
      const oldSuggestions = current.gradeSuggestions || {};
      const gradeSuggestions = { ...oldSuggestions };
      if (headline !== undefined) {
        if (headline === null) { delete gradeSuggestions.headline; } else { gradeSuggestions.headline = headline; }
      }
      if (angles !== undefined) {
        gradeSuggestions.angles = { ...(gradeSuggestions.angles || {}), ...angles };
        for (const [k, v] of Object.entries(gradeSuggestions.angles)) {
          if (v === null || v === '') delete gradeSuggestions.angles[k];
        }
      }
      db.upsertUserRouteData(user.id, routeId, {
        sent: current.sent, flashed: current.flashed || false, rating: current.rating,
        angle_sends: current.angleSends, angle_flashes: current.angleFlashes || [], angle_attempts: current.angleAttempts || [],
        grade_suggestions: gradeSuggestions, attempted: true,
      });

      // Optimistically update raw grade-suggestion rows. The communityGrades useMemo
      // re-derives consensus from this, so the UI updates immediately and respects
      // the user's current grade system.
      setGradeRowsByRoute(prevRows => {
        const next = { ...prevRows };
        const routeRows = { ...(next[routeId] || {}) };
        const hasContent = !!gradeSuggestions.headline || (gradeSuggestions.angles && Object.keys(gradeSuggestions.angles).length > 0);
        if (hasContent) routeRows[user.id] = gradeSuggestions;
        else delete routeRows[user.id];
        if (Object.keys(routeRows).length) next[routeId] = routeRows;
        else delete next[routeId];
        return next;
      });

      // Suggesting a grade counts as engagement — mark attempted
      logRouteAttempted(routeId);
      return { ...prev, [routeId]: { ...current, gradeSuggestions, attempted: true } };
    });
  }, [user, logRouteAttempted]);

  const acceptGradeSuggestion = useCallback((routeId, grade, angle) => {
    localRouteChange.current = true;
    if (angle !== undefined) {
      const updateAngleGrades = (angleGrades) => {
        const existing = (angleGrades || []).find(ag => ag.angle === angle);
        if (existing) {
          return angleGrades.map(ag => ag.angle === angle ? { ...ag, grade } : ag);
        }
        return [...(angleGrades || []), { angle, grade }];
      };
      setRoutes(prev => prev.map(r => {
        if (r.id !== routeId) return r;
        return { ...r, angleGrades: updateAngleGrades(r.angleGrades), updatedAt: new Date().toISOString() };
      }));
      setViewingRoute(prev => {
        if (!prev || prev.id !== routeId) return prev;
        return { ...prev, angleGrades: updateAngleGrades(prev.angleGrades) };
      });
    } else {
      setRoutes(prev => prev.map(r =>
        r.id === routeId ? { ...r, grade, updatedAt: new Date().toISOString() } : r
      ));
      setViewingRoute(prev => prev && prev.id === routeId ? { ...prev, grade } : prev);
    }
  }, []);

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

  const handleBoardImageSave = async ({ imageName, imageBlobs }) => {
    try {
      // 1. Upload all sizes (ensures the bucket exists; uploads 4 variants in parallel)
      const baseUrl = db.BOARD_IMAGES_BASE_URL;
      const results = await db.uploadBoardImage(imageName, imageBlobs);

      // Check for upload errors
      const errors = results.filter(r => r.error);
      if (errors.length > 0) {
        console.error('[BoardImage] Upload errors:', errors.map(r => r.error));
        const firstErr = errors[0].error;
        throw new Error(firstErr.message || firstErr.error || `Failed to upload ${errors.length} image(s)`);
      }

      // 3. Build config — include cacheVersion for cache-busting on this and future loads
      const config = {
        imageName,
        baseUrl,
        updatedAt: new Date().toISOString(),
        cacheVersion: Date.now(),
      };

      // Save config to board_settings (per-board, multi-wall 2b-ii)
      const { error: settingsError } = await db.setBoardImageConfig(activeBoardIdRef.current, config);
      if (settingsError) throw settingsError;

      // Update local state and return to settings
      setBoardImageConfig(config);
      setView('settings');
    } catch (err) {
      console.error('[BoardImage] Save failed:', err);
      // Re-throw so the wizard can catch it and show error state
      throw err;
    }
  };
  const handleSetupSave = async (newHolds) => {
    // Per-board model (multi-wall 2b-ii): hold IDs are preserved verbatim —
    // BoardSetupView keeps existing IDs and mints custom_<ts> only for genuinely
    // new holds — so saved routes (which reference holds by ID) stay valid with
    // no remap. Persist the wall's hold set, awaiting the write before nav.
    await saveAllHolds(newHolds);
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

  const isHoldEditor = view === 'addHold' || view === 'editHold' || view === 'holdSelect';
  const isHome       = view === 'board';

  // ─── Swipe navigation handlers (viewRoute) ────────────────────────
  const handleSwipeStart = (e) => {
    if (view !== 'viewRoute' || isBoardZoomed || viewRouteOrder.length === 0) return;
    if (e.touches.length !== 1) return;
    // transitionMode === 'slide' means a commit animation is in progress — ignore
    if (transitionMode === 'slide') return;
    // Don't engage swipe when touch starts on a slider or any element opted out via data-no-swipe.
    // This auto-covers all native range inputs (angle sliders, positivity, duration, etc.).
    if (e.target && e.target.closest && e.target.closest('input[type="range"], [data-no-swipe], [data-no-swipe] *')) return;
    swipeRef.current = {
      startX: e.touches[0].clientX,
      startY: e.touches[0].clientY,
      dx: 0,
      engaged: false,
      active: true,
    };
    setTransitionMode('none'); // follow finger 1:1 before engagement confirmed
  };

  const handleSwipeMove = (e) => {
    if (!swipeRef.current.active) return;
    // Second finger landed — user is pinching/zooming. Abandon swipe and snap back if engaged.
    if (e.touches.length > 1) {
      const wasEngaged = swipeRef.current.engaged;
      swipeRef.current.active = false;
      swipeRef.current.engaged = false;
      if (wasEngaged) {
        setTransitionMode('snap');
        setSwipeDx(0);
        setTimeout(() => setCarouselActive(false), 220);
      }
      return;
    }
    const t = e.touches[0];
    const dx = t.clientX - swipeRef.current.startX;
    const dy = t.clientY - swipeRef.current.startY;
    if (!swipeRef.current.engaged) {
      if (Math.abs(dx) < 12) return;
      if (Math.abs(dx) < Math.abs(dy) * 1.3) {
        // Vertical scroll intent — abandon swipe
        swipeRef.current.active = false;
        return;
      }
      swipeRef.current.engaged = true;
      setCarouselActive(true); // mount neighbours now that we know it's a horizontal swipe
    }
    // Rubber-band at edges
    const idx = viewRouteOrder.indexOf(viewingRoute?.id);
    const atStart = idx <= 0 && dx > 0;
    const atEnd = idx >= viewRouteOrder.length - 1 && dx < 0;
    const adjusted = (atStart || atEnd) ? dx * 0.3 : dx;
    swipeRef.current.dx = adjusted;
    setSwipeDx(adjusted);
    e.preventDefault();
  };

  const handleSwipeEnd = () => {
    if (!swipeRef.current.active) return;
    const dx = swipeRef.current.dx;
    swipeRef.current.active = false;
    swipeRef.current.engaged = false;

    if (Math.abs(dx) > window.innerWidth * 0.25) {
      const direction = dx < 0 ? 'next' : 'prev';
      const idx = viewRouteOrder.indexOf(viewingRoute?.id);
      const hasNeighbour =
        (direction === 'next' && idx >= 0 && idx < viewRouteOrder.length - 1) ||
        (direction === 'prev' && idx > 0);
      if (hasNeighbour) {
        commitNavigation(direction);
        return;
      }
    }
    // Not committed, or at edge — snap back to 0 with easing
    setTransitionMode('snap');
    setSwipeDx(0);
    // Unmount neighbours after the snap-back animation completes
    setTimeout(() => setCarouselActive(false), 220);
  };

  // Show auth screen until session resolves
  if (authLoading) return (
    <div style={{ minHeight: '100vh', background: '#FFAB94', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ fontFamily: "'Kodchasan', sans-serif", color: '#0047FF', fontWeight: 700, fontSize: 18 }}>BARN BOARD</div>
    </div>
  );
  if (!user) return (
    <Suspense fallback={<div style={{ minHeight: '100vh', background: '#FFAB94' }} />}>
      <AuthView />
    </Suspense>
  );
  // Boot failed (or timed out) trying to reach the server — e.g. the backend
  // is unreachable. Checked BEFORE the !boardsResolved splash below, since
  // boardsResolved is always forced true (see the boot effect's `finally`)
  // even on failure — without this check the app would just show a blank
  // board instead of explaining what happened.
  if (bootError) return (
    <ErrorScreen
      title="Can't reach the board"
      message="The app couldn't connect to the server just now. This is usually a passing network glitch — give it a moment and try again."
      retryLabel="Try again"
      onRetry={() => window.location.reload()}
      detail={bootError?.message || String(bootError)}
    />
  );
  // Logged in, still resolving which walls you belong to — brief splash so we don't
  // flash the onboarding screen (or an empty board) before myBoards is known.
  if (!boardsResolved) return (
    <div style={{ minHeight: '100vh', background: '#FFAB94', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ fontFamily: "'Kodchasan', sans-serif", color: '#0047FF', fontWeight: 700, fontSize: 18 }}>BARN BOARD</div>
    </div>
  );
  // No wall yet (2c dropped the silent Barn auto-join) — onboarding: join a public
  // wall or enter a code. Reuses the tested WallsSettings "Join a wall" UI.
  if (myBoards.length === 0) return (
    <Suspense fallback={<div style={{ minHeight: '100vh', background: '#FFAB94' }} />}>
      <div style={{ minHeight: '100vh', background: '#FFAB94', padding: '32px 16px', maxWidth: 480, margin: '0 auto' }}>
        <div style={{ fontFamily: "'Kodchasan', sans-serif", color: '#0047FF', fontWeight: 800, fontSize: 24, marginBottom: 6 }}>BARN BOARD</div>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>Join a wall to get started</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 20 }}>
          Pick a public wall below, or enter a join code for a private one. You can join more later in Settings.
        </div>
        <WallsSettings
          user={user}
          myBoards={myBoards}
          activeBoardId={activeBoardId}
          isAdmin={false}
          onboarding
          onWallJoined={onWallJoined}
        />
        <button
          onClick={() => supabase.auth.signOut()}
          style={{ width: '100%', padding: '11px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-secondary)', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
        >Sign out</button>
      </div>
    </Suspense>
  );

  return (
    <div
      onTouchStart={handleSwipeStart}
      onTouchMove={handleSwipeMove}
      onTouchEnd={handleSwipeEnd}
      onTouchCancel={handleSwipeEnd}
    >
      <div>
      {/* ── Header ── */}
      <header style={{
        padding: isHome ? '20px 16px 24px' : '10px 16px 8px',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
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
            margin: 0,
            fontSize: isHome ? '42px' : '18px',
            fontFamily: 'var(--font-heading)', fontWeight: 700,
            color: 'var(--accent)',
            letterSpacing: isHome ? '-1px' : '-0.3px',
            lineHeight: isHome ? 1.05 : 1,
          }}>
            {isHome ? <><span style={{ display: 'block' }}>BARN</span><span style={{ display: 'block' }}>BOARD</span></> : 'BARN BOARD'}
          </h1>
          <div style={{
            fontSize: isHome ? '10px' : '8px',
            color: 'var(--text-muted)',
            letterSpacing: isHome ? '3px' : '2px',
            marginTop: isHome ? '4px' : '1px',
            textTransform: 'uppercase',
            fontWeight: 600,
            display: 'flex', alignItems: 'center', gap: '6px',
          }}>
            <span>
              {view === 'addHold'    ? 'Add Hold'
                : view === 'editHold'   ? 'Edit Hold'
                : view === 'holdSelect' ? 'Select Hold'
                : view === 'sessionSummary' ? 'Session Summary'
                : 'Route Logger'}
            </span>
            {isActiveBoardAdmin && (settings.adminMode ?? 'climber') === 'admin' && (
              <Icon name="shield" size={isHome ? 14 : 11} style={{ color: 'var(--accent)', opacity: 0.7, flexShrink: 0 }} />
            )}
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
        <nav style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <NavButton
            active={view === 'routes'}
            onClick={() => { setHoldSelection({}); setViewingRoute(null); setShowRouteTags(false); setView('routes'); }}
            label="☰"
          />
          {settings.betaSessionLogger && (
            <NavButton
              active={view === 'sessions'}
              onClick={() => { setHoldSelection({}); setViewingRoute(null); setShowRouteTags(false); setView('sessions'); }}
              label={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="6" y="4" width="12" height="16" rx="2"/><path d="M9 4v-1a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1"/><path d="M9 10h6M9 14h6M9 18h3"/></svg>}
            />
          )}
          <NavButton
            active={view === 'settings' || isHoldEditor}
            onClick={() => { setEditingHold(null); setView('settings'); }}
            label={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>}
          />
        </nav>
      </header>

      {/* ── Board views (board + create modes only) ── */}
      {(view === 'board' || view === 'create') && (
        <BoardView
          holds={allHolds}
          selection={holdSelection}
          onHoldTap={view === 'create' ? handleHoldTap : undefined}
          onBoardClick={view === 'board' ? () => { resetCreate(); setView('create'); } : undefined}
          interactive={view === 'create'}
          dimBoard={false}
          imgSrc={imgSrc}
          imgSrcSet={imgSrcSet}
          imgSizes={imgSizes}
          holdSnapshots={null}
          onZoomChange={setIsBoardZoomed}
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
        </BoardView>
      )}

      {/* ── Carousel — viewRoute ── */}
      {view === 'viewRoute' && viewingRoute && (() => {
        const gap = 40;
        // Prev/next neighbours from the ordered list
        const currentIdx = viewRouteOrder.indexOf(viewingRoute.id);
        const prevRoute = currentIdx > 0
          ? routes.find(r => r.id === viewRouteOrder[currentIdx - 1])
          : null;
        const nextRoute = currentIdx >= 0 && currentIdx < viewRouteOrder.length - 1
          ? routes.find(r => r.id === viewRouteOrder[currentIdx + 1])
          : null;

        // Shared close handler — resets all viewRoute state
        const handleClose = () => {
          setHoldSelection({});
          setViewingRoute(null);
          setShowRouteTags(false);
          setHoldDataMode(false);
          setInspectedRouteHoldId(null);
          setIsBoardZoomed(false);
          setSwipeDx(0);
          setTransitionMode('snap');
          setCarouselActive(false);
          const returnTo = viewRouteSourceRef.current;
          viewRouteSourceRef.current = 'routes';
          setViewRouteSource('routes');
          setView(returnTo === 'sessions' ? 'sessions' : 'routes');
        };

        // Shared props passed to all RouteViewCard instances
        const sharedCardProps = {
          user, isAdmin, settings, grades, allHolds, playlists,
          imgSrc, imgSrcSet, imgSizes,
          userRouteData, communityRatings, communityGrades,
          profilesById, displayName,
          onClose: handleClose,
          onEdit: startEditRoute,
          onDelete: deleteRoute,
          onToggleSent: cycleSentState,
          onSuggestGrade: suggestGrade,
          onAcceptGrade: acceptGradeSuggestion,
          onAddAngleGrade: addAngleGrade,
          onRemoveAngleGrade: removeAngleGrade,
          onSetHeadline: setHeadlineAngleGrade,
          onToggleAngleSent: cycleAngleSentState,
          onAddToPlaylist: addRouteToPlaylist,
          onCreatePlaylist: createPlaylist,
          onMarkAttempted: markAttempted,
          onHoldTap: handleHoldTap,
          handleEditHold,
          setHoldEditorSource,
          hasChevronBar: viewRouteOrder.length > 0,
          minAngle: activeBoardSpecs.minAngle,
          maxAngle: activeBoardSpecs.maxAngle,
          ViewRouteHeader,
        };

        return (
          <div style={{ position: 'relative', overflow: 'hidden', width: '100%' }}>
            <div style={{
              position: 'relative',
              transform: `translateX(${swipeDx}px)`,
              transition:
                transitionMode === 'none'  ? 'none'
                : transitionMode === 'slide' ? 'transform 0.28s ease-out'
                                             : 'transform 0.2s ease-out',
              willChange: 'transform',
            }}>
              {/* Current card — always rendered, in document flow (drives wrapper height) */}
              <RouteViewCard
                route={viewingRoute}
                isInteractive={true}
                holdSelection={holdSelection}
                holdDataMode={holdDataMode}
                setHoldDataMode={setHoldDataMode}
                inspectedRouteHoldId={inspectedRouteHoldId}
                setInspectedRouteHoldId={setInspectedRouteHoldId}
                showRouteTags={showRouteTags}
                setShowRouteTags={setShowRouteTags}
                onZoomChange={setIsBoardZoomed}
                {...sharedCardProps}
              />

              {/* Prev card — absolutely positioned to the left */}
              {carouselActive && prevRoute && (
                <div style={{
                  position: 'absolute', top: 0, left: `calc(-100% - ${gap}px)`,
                  width: '100%',
                }}>
                  <RouteViewCard
                    route={prevRoute}
                    isInteractive={false}
                    holdSelection={prevRoute.holds || {}}
                    holdDataMode={false}
                    setHoldDataMode={() => {}}
                    inspectedRouteHoldId={null}
                    setInspectedRouteHoldId={() => {}}
                    showRouteTags={false}
                    setShowRouteTags={() => {}}
                    {...sharedCardProps}
                  />
                </div>
              )}

              {/* Next card — absolutely positioned to the right */}
              {carouselActive && nextRoute && (
                <div style={{
                  position: 'absolute', top: 0, left: `calc(100% + ${gap}px)`,
                  width: '100%',
                }}>
                  <RouteViewCard
                    route={nextRoute}
                    isInteractive={false}
                    holdSelection={nextRoute.holds || {}}
                    holdDataMode={false}
                    setHoldDataMode={() => {}}
                    inspectedRouteHoldId={null}
                    setInspectedRouteHoldId={() => {}}
                    showRouteTags={false}
                    setShowRouteTags={() => {}}
                    {...sharedCardProps}
                  />
                </div>
              )}
            </div>
          </div>
        );
      })()}

      <Suspense fallback={<div style={{ padding: '40px 16px', textAlign: 'center', color: '#1A0A00', opacity: 0.4, fontSize: 13 }}>Loading...</div>}>
      {/* ── Route form (below board in create mode) ── */}
      {view === 'create' && (
        <RouteForm
          name={routeName} setName={setRouteName}
          grade={routeGrade} setGrade={setRouteGrade}
          angle={routeAngle} setAngle={setRouteAngle}
          setter={setter} setSetter={setSetter}
          description={description} setDescription={setDescription}
          youtubeUrl={youtubeUrl} setYoutubeUrl={setYoutubeUrl}
          holdTypes={holdTypes} setHoldTypes={setHoldTypes}
          autoHoldTypes={autoHoldTypes}
          techniques={techniques} setTechniques={setTechniques}
          styles={styles} setStyles={setStyles}
          grades={grades}
          minAngle={activeBoardSpecs.minAngle}
          maxAngle={activeBoardSpecs.maxAngle}
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
          communityGrades={communityGrades}
          onViewRoute={viewRoute}
          onCreateNew={() => { resetCreate(); setView('create'); }}
          onRateRoute={rateRoute}
          onToggleSent={cycleSentState}
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

      {/* ── Sessions tab ── */}
      {view === 'sessions' && (
        <Suspense fallback={<div style={{ padding: '40px 16px', textAlign: 'center', color: '#1A0A00', opacity: 0.4, fontSize: 13 }}>Loading...</div>}>
          <SessionsView
            activeSession={activeSession}
            onStartSession={startSession}
            onEndSession={endSession}
            setSessionAngle={setSessionAngle}
            logAngleClimbed={logAngleClimbed}
            sessions={sessions}
            settings={settings}
            displayName={displayName}
            userRouteData={userRouteData}
            routes={routes}
            allRoutes={allRoutes}
            myBoards={myBoards}
            activeBoardId={activeBoardId}
            boardImageSrc={imgSrc}
            boardRegion={activeBoardRegion}
            allHolds={allHolds}
            profilesById={profilesById}
            onViewRoute={handleViewRouteFromSessions}
            onEditSession={(session) => handleEditSession(session, 'sessions')}
            period={sessionsPeriod}
            onChangePeriod={setSessionsPeriod}
          />
        </Suspense>
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
          isAdmin={isActiveBoardAdmin}
          user={user}
          myBoards={myBoards}
          activeBoardId={activeBoardId}
          onSwitchBoard={switchBoard}
          onWallJoined={onWallJoined}
          onWallLeft={onWallLeft}
          onRolesChanged={refreshMyBoards}
          onBrowseWalls={() => setView('joinWall')}
          boardSpecs={activeBoardSpecs}
          onSaveBoardSpecs={onSaveBoardSpecs}
          userEmail={user?.email}
          onSignOut={() => supabase.auth.signOut()}
          onViewSession={(session) => { setCompletedSession(session); setView('sessionSummary'); }}
          onEditSession={handleEditSession}
          onUpdateBoardImage={() => setView('updateBoardImage')}
          displayName={displayName}
          onSaveDisplayName={saveDisplayName}
        />
      )}

      {/* ── Join a wall (browse every joinable wall) ── */}
      {view === 'joinWall' && (
        <Suspense fallback={<div style={{ padding: '40px 16px', textAlign: 'center', color: '#1A0A00', opacity: 0.4, fontSize: 13 }}>Loading...</div>}>
          <div style={{ padding: '16px', maxWidth: 480, margin: '0 auto' }}>
            <button
              onClick={() => setView('settings')}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '6px 0', marginBottom: '12px', border: 'none', background: 'none', color: 'var(--accent)', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}
            >← Walls</button>
            <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--text-primary)', marginBottom: 4 }}>Join a wall</div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 20 }}>
              Pick a public wall, or enter a join code for a private one.
            </div>
            <WallsSettings
              user={user}
              myBoards={myBoards}
              activeBoardId={activeBoardId}
              isAdmin={false}
              onboarding
              onWallJoined={onWallJoined}
            />
          </div>
        </Suspense>
      )}

      {/* ── Session Edit ── */}
      {view === 'sessionEdit' && editingSession && (
        <Suspense fallback={<div style={{ padding: '40px 16px', textAlign: 'center', color: '#1A0A00', opacity: 0.4, fontSize: 13 }}>Loading...</div>}>
          <SessionEditView
            session={editingSession}
            allSessions={sessions}
            gradeSystem={settings.gradeSystem}
            routes={routes}
            playlists={playlists}
            onSave={updateSession}
            onCancel={() => {
              setEditingSession(null);
              const returnTo = editSessionSourceRef.current;
              editSessionSourceRef.current = 'settings';
              setEditSessionSource('settings');
              setView(returnTo === 'sessions' ? 'sessions' : 'settings');
            }}
          />
        </Suspense>
      )}

      {/* ── Update Board Image wizard ── */}
      {view === 'updateBoardImage' && (
        <BoardImageUpdateView
          currentImgSrc={imgSrc}
          currentImageName={boardImageConfig?.imageName || activeBoardImageDefault}
          currentImageUrl={boardImageConfig ? `${boardImageConfig.baseUrl}/${boardImageConfig.imageName}.jpg` : '/Barn_Set_01_V7.jpg'}
          holds={allHolds}
          boardRegion={activeBoardRegion}
          onSave={handleBoardImageSave}
          onCancel={() => setView('settings')}
        />
      )}

      {/* ── Hold Select — tap board to pick a hold for editing ── */}
      {view === 'holdSelect' && (
        <BoardView
          holds={allHolds}
          selection={{}}
          imgSrc={imgSrc}
          imgSrcSet={imgSrcSet}
          imgSizes={imgSizes}
          boardRegion={activeBoardRegion}
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
          imgSrcSet={imgSrcSet}
          imgSizes={imgSizes}
          boardRegion={activeBoardRegion}
          initialManagerMode={holdManagerMode}
          onManagerModeChange={setHoldManagerMode}
          onEditHold={(hold) => handleEditHold(hold, 'setupBoard')}
          routes={routes}
        />
      )}

      {/* ── Hold editor (add / edit) ── */}
      {(view === 'addHold' || view === 'editHold') && (
        <HoldEditorView
          mode={view === 'addHold' ? 'add' : 'edit'}
          hold={editingHold}
          allHolds={allHolds}
          imgSrc={imgSrc}
          imgSrcSet={imgSrcSet}
          imgSizes={imgSizes}
          boardRegion={activeBoardRegion}
          onSave={handleHoldEditorSave}
          onCancel={handleHoldEditorCancel}
          onDelete={view === 'editHold' ? () => {
            deleteHold(editingHold.id);
            setEditingHold(null);
            setView(holdEditorSource);
          } : undefined}
        />
      )}
      </Suspense>
      </div>

      {/* ── Route navigation chevron bar (fixed bottom) ── */}
      {view === 'viewRoute' && viewingRoute && viewRouteOrder.length > 0 && (() => {
        const idx = viewRouteOrder.indexOf(viewingRoute.id);
        const canPrev = idx > 0;
        const canNext = idx >= 0 && idx < viewRouteOrder.length - 1;
        return (
          <div style={{
            position: 'fixed', left: 0, right: 0, bottom: 0,
            display: 'flex', justifyContent: 'center', alignItems: 'center',
            gap: '16px', padding: '10px 16px calc(10px + env(safe-area-inset-bottom))',
            background: 'linear-gradient(to bottom, rgba(255,171,148,0) 0%, rgba(255,171,148,0.95) 30%, rgba(255,171,148,1) 100%)',
            pointerEvents: 'none', zIndex: 100,
          }}>
            <button
              onClick={() => commitNavigation('prev')}
              disabled={!canPrev}
              style={{
                pointerEvents: 'auto',
                width: '44px', height: '44px', borderRadius: '50%',
                border: 'none', cursor: canPrev ? 'pointer' : 'not-allowed',
                background: canPrev ? 'var(--bg-card)' : 'rgba(255,255,255,0.4)',
                color: canPrev ? 'var(--text-primary)' : 'rgba(26,10,0,0.3)',
                fontSize: '22px', fontWeight: 700, lineHeight: 1,
                boxShadow: canPrev ? '0 2px 8px rgba(26,10,0,0.15)' : 'none',
                fontFamily: 'var(--font-heading)',
              }}
              aria-label="Previous route"
            >‹</button>
            <div style={{
              pointerEvents: 'auto',
              fontSize: '12px', fontWeight: 700, fontFamily: 'var(--font-heading)',
              color: 'var(--text-secondary)', minWidth: '50px', textAlign: 'center',
            }}>
              {idx + 1} / {viewRouteOrder.length}
            </div>
            <button
              onClick={() => commitNavigation('next')}
              disabled={!canNext}
              style={{
                pointerEvents: 'auto',
                width: '44px', height: '44px', borderRadius: '50%',
                border: 'none', cursor: canNext ? 'pointer' : 'not-allowed',
                background: canNext ? 'var(--bg-card)' : 'rgba(255,255,255,0.4)',
                color: canNext ? 'var(--text-primary)' : 'rgba(26,10,0,0.3)',
                fontSize: '22px', fontWeight: 700, lineHeight: 1,
                boxShadow: canNext ? '0 2px 8px rgba(26,10,0,0.15)' : 'none',
                fontFamily: 'var(--font-heading)',
              }}
              aria-label="Next route"
            >›</button>
          </div>
        );
      })()}
    </div>
  );
}

// ─── New Angle Suggestion Row ────────────────────────────────────────
function NewAngleSuggestionRow({ grades, existingAngles, minAngle = BOARD_SPECS.minAngle, maxAngle = BOARD_SPECS.maxAngle, onSuggest }) {
  const [open, setOpen] = useState(false);
  const [angle, setAngle] = useState('');
  const [grade, setGrade] = useState('');

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{
          marginTop: '6px', padding: '4px 10px', borderRadius: '6px',
          border: '1px dashed rgba(26,10,0,0.15)', background: 'transparent',
          color: 'var(--text-muted)', fontSize: '11px', fontWeight: 600,
          cursor: 'pointer', width: '100%', textAlign: 'left',
        }}
      >
        + Suggest angle grade
      </button>
    );
  }

  return (
    <div style={{
      marginTop: '6px', display: 'flex', alignItems: 'center', gap: '6px',
      padding: '6px 8px', borderRadius: '6px',
      border: '1px solid rgba(26,10,0,0.1)', background: 'rgba(26,10,0,0.02)',
    }}>
      <input
        type="number"
        placeholder="Angle"
        value={angle}
        onChange={(e) => setAngle(e.target.value)}
        style={{
          width: '50px', padding: '3px 6px', borderRadius: '4px',
          border: '1px solid rgba(26,10,0,0.15)', background: 'var(--bg-input)',
          fontSize: '11px', fontFamily: 'var(--font-heading)', fontWeight: 700,
        }}
      />
      <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>°</span>
      <select
        value={grade}
        onChange={(e) => setGrade(e.target.value)}
        style={{
          padding: '3px 6px', borderRadius: '4px',
          border: '1px solid rgba(26,10,0,0.15)', background: 'var(--bg-input)',
          fontSize: '11px', fontFamily: 'var(--font-heading)', fontWeight: 700,
        }}
      >
        <option value="">Grade</option>
        {grades.map(g => <option key={g} value={g}>{g}</option>)}
      </select>
      <button
        onClick={() => {
          const a = Number(angle);
          if (a && grade && !existingAngles.includes(a)) {
            onSuggest(a, grade);
            setOpen(false);
            setAngle('');
            setGrade('');
          }
        }}
        disabled={!angle || !grade}
        style={{
          padding: '3px 8px', borderRadius: '4px', border: 'none',
          background: angle && grade ? 'var(--accent)' : 'rgba(26,10,0,0.1)',
          color: angle && grade ? '#fff' : 'var(--text-dim)',
          fontSize: '11px', fontWeight: 700, cursor: angle && grade ? 'pointer' : 'default',
        }}
      >
        ✓
      </button>
      <button
        onClick={() => { setOpen(false); setAngle(''); setGrade(''); }}
        style={{
          padding: '3px 6px', borderRadius: '4px', border: 'none',
          background: 'transparent', color: 'var(--text-muted)',
          fontSize: '11px', cursor: 'pointer',
        }}
      >
        ✕
      </button>
    </div>
  );
}

// ─── View Route Header with Angle-Grade Management ──────────────────
function ViewRouteHeader({ route, sent, flashed, attempted, angleSends, angleFlashes, angleAttempts, isCreator, canEdit, grades, gradeSystem, playlists, settings, allHolds, communityGrades, myGradeSuggestions, minAngle = BOARD_SPECS.minAngle, maxAngle = BOARD_SPECS.maxAngle, onSuggestGrade, onAcceptGrade, onEdit, onClose, onDelete, onToggleSent, onAddAngleGrade, onRemoveAngleGrade, onSetHeadline, onToggleAngleSent, onAddToPlaylist, onCreatePlaylist }) {
  const headlineState = flashed ? 'flash' : sent ? 'sent' : attempted ? 'tried' : 'empty';
  const sendsArr    = angleSends    || [];
  const flashesArr  = angleFlashes  || [];
  const attemptsArr = angleAttempts || [];
  const angleStateOf = (a) =>
    flashesArr.includes(a) ? 'flash'
    : sendsArr.includes(a) ? 'sent'
    : attemptsArr.includes(a) ? 'tried'
    : 'empty';
  const [nameExpanded, setNameExpanded] = useState(false);
  const [showAnglePanel, setShowAnglePanel] = useState(false);
  const [showPlaylistPanel, setShowPlaylistPanel] = useState(false);
  const [showGradePanel, setShowGradePanel] = useState(false);
  const [showAngleSuggest, setShowAngleSuggest] = useState(null); // angle number of expanded row
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [newAngle, setNewAngle] = useState(route.angle || 30);
  const [newGrade, setNewGrade] = useState(route.grade || grades[4]);
  const [showAddAngleInputs, setShowAddAngleInputs] = useState(false);
  const angleGrades = route.angleGrades || [];
  const hasVideo = !!getYouTubeId(route.youtubeUrl);
  const showVideoThumbnail = settings?.betaVideoThumbnail;

  // Missing hold detection
  const holdIdSet = new Set((allHolds || []).map(h => h.id));
  const missingHoldIds = Object.keys(route.holds || {}).filter(id => !holdIdSet.has(id));
  const missingCount = missingHoldIds.length;

  // Build unified angle list: official + community-only, sorted by angle
  const officialAngles = new Set(angleGrades.map(ag => String(ag.angle)));
  const communityOnlyAngles = Object.entries(communityGrades?.angles || {})
    .filter(([angle]) => !officialAngles.has(angle))
    .map(([angle, data]) => ({ angle: Number(angle), consensus: data.consensus, votes: data.votes, count: data.count }))
    .sort((a, b) => a.angle - b.angle);
  const unifiedAngleRows = [
    ...angleGrades.map(ag => ({ angle: ag.angle, grade: ag.grade, type: 'official' })),
    ...communityOnlyAngles.map(ca => ({ angle: ca.angle, grade: ca.consensus, type: 'community', count: ca.count })),
  ].sort((a, b) => a.angle - b.angle);

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
        {(() => {
          const hasHeadlineSuggestions = !!communityGrades?.headline;
          const consensusDiffers = hasHeadlineSuggestions && communityGrades.headline.consensus !== route.grade;
          if (isCreator && !consensusDiffers) return null;
          return (
            <button
              onClick={() => setShowGradePanel(prev => !prev)}
              style={{
                background: showGradePanel ? 'var(--accent-dim)' : 'none',
                border: showGradePanel ? '1.5px solid var(--accent)' : '1.5px solid rgba(26,10,0,0.12)',
                borderRadius: '8px', cursor: 'pointer', padding: '3px 7px',
                display: 'flex', alignItems: 'center', gap: '3px', flexShrink: 0,
              }}
            >
              <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', fontFamily: 'var(--font-heading)' }}>
                {hasHeadlineSuggestions ? communityGrades.headline.consensus : `${route.grade}?`}
              </span>
            </button>
          );
        })()}
        <div style={{
          flex: 1, minWidth: 0, display: 'flex', alignItems: 'flex-start', gap: '6px',
        }}>
          <span
            onClick={() => setNameExpanded(prev => !prev)}
            style={{
              fontWeight: 700, fontSize: '20px', lineHeight: 1.2, cursor: 'pointer',
              ...(nameExpanded
                ? { whiteSpace: 'normal', wordBreak: 'break-word' }
                : { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }),
            }}
          >
            {route.name}
          </span>
          {hasVideo && (
            <a href={route.youtubeUrl} target="_blank" rel="noopener noreferrer"
              onClick={e => e.stopPropagation()}
              style={{ flexShrink: 0, display: 'flex', alignItems: 'center', textDecoration: 'none', opacity: 0.45, marginTop: '2px' }}
            >
              <Icon name="video" size={16}/>
            </a>
          )}
        </div>
        {/* 4-state cycle: empty → tried → sent → flash → empty (label sits to the left of the box) */}
        <SentCycleButton state={headlineState} onClick={onToggleSent} labelPosition="left" />
        <button onClick={onClose} style={{
          padding: '5px 10px', borderRadius: '8px', flexShrink: 0,
          border: '1px solid rgba(26,10,0,0.15)', background: 'rgba(26,10,0,0.06)',
          color: 'var(--text-muted)', fontSize: '13px', cursor: 'pointer', lineHeight: 1,
        }}>
          ✕
        </button>
      </div>

      {/* ── Grade Suggestion Panel ── */}
      {showGradePanel && (
        <div style={{
          marginTop: '6px', marginBottom: '8px', padding: '10px 12px', borderRadius: '10px',
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          boxShadow: '0 2px 8px rgba(26,10,0,0.06)',
        }}>
          <div style={{
            fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)',
            letterSpacing: '1px', textTransform: 'uppercase', marginBottom: '8px',
          }}>
            Grade Suggestions
          </div>
          {communityGrades?.headline && Object.entries(communityGrades.headline.votes)
            .sort(([, a], [, b]) => b - a)
            .map(([grade, count]) => {
              const pct = Math.round(count / communityGrades.headline.count * 100);
              return (
                <div key={grade} style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                  <span style={{ fontSize: '12px', fontWeight: 700, fontFamily: 'var(--font-heading)', minWidth: '28px' }}>
                    {grade}
                  </span>
                  <div style={{ flex: 1, height: '14px', borderRadius: '4px', background: 'rgba(26,10,0,0.06)', overflow: 'hidden' }}>
                    <div style={{ width: `${pct}%`, height: '100%', borderRadius: '4px', background: 'var(--accent)', minWidth: pct > 0 ? '4px' : 0 }} />
                  </div>
                  <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', minWidth: '16px', textAlign: 'right' }}>
                    {count}
                  </span>
                </div>
              );
            })
          }
          <div style={{ marginTop: communityGrades?.headline ? '10px' : 0, paddingTop: communityGrades?.headline ? '8px' : 0, borderTop: communityGrades?.headline ? '1px solid var(--border)' : 'none' }}>
            {!isCreator && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>
                  {myGradeSuggestions?.headline ? 'Your suggestion:' : 'Suggest a grade:'}
                </span>
                <select
                  value={displayGrade(myGradeSuggestions?.headline, gradeSystem) || ''}
                  onChange={(e) => onSuggestGrade(e.target.value || null, undefined)}
                  style={{
                    padding: '4px 8px', borderRadius: '6px',
                    border: '1.5px solid rgba(26,10,0,0.15)', background: 'var(--bg-input)',
                    fontSize: '12px', fontFamily: 'var(--font-heading)', fontWeight: 700,
                  }}
                >
                  <option value="">—</option>
                  {grades.map(g => <option key={g} value={g}>{g}</option>)}
                </select>
              </div>
            )}
            {canEdit && communityGrades?.headline?.consensus !== route.grade && (
              <button
                onClick={() => { onAcceptGrade(communityGrades.headline.consensus); setShowGradePanel(false); }}
                style={{
                  padding: '6px 14px', borderRadius: '8px', border: 'none',
                  background: 'var(--accent)', color: '#fff',
                  fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                }}
              >
                Accept {communityGrades.headline.consensus}
              </button>
            )}
          </div>
        </div>
      )}

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
        {route.description && <span style={{ fontStyle: 'italic' }}>— {route.description}</span>}
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
            {canEdit && (
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
        {canEdit && (
          <button onClick={onEdit} style={actionBtn(false)}>
            ✏ Edit
          </button>
        )}
        <button
          onClick={() => { setShowAnglePanel(prev => !prev); setShowPlaylistPanel(false); setShowAddAngleInputs(false); }}
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
        {canEdit && (!confirmDelete ? (
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
          {/* Add new angle/grade — only for users who can edit */}
          {canEdit && <div style={{ marginBottom: angleGrades.length > 0 ? '40px' : 0 }}>
            {!showAddAngleInputs ? (
              <button
                onClick={() => setShowAddAngleInputs(true)}
                style={{
                  padding: '6px 12px', borderRadius: '8px', border: 'none',
                  background: 'var(--accent)', color: '#fff',
                  fontSize: '11px', fontWeight: 700, cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                + Add
              </button>
            ) : (
              <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '10px', color: 'var(--text-dim)', marginBottom: '3px' }}>Angle</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <input
                      type="range"
                      min={minAngle} max={maxAngle}
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
                  onClick={() => { onAddAngleGrade(newAngle, newGrade); setShowAddAngleInputs(false); }}
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
            )}
          </div>}

          {/* ── Unified angle/grade table ── */}
          {(unifiedAngleRows.length > 0 || !isCreator) && (
            <div>
              {unifiedAngleRows.length > 0 && (
                <div style={{
                  display: 'grid', gridTemplateColumns: '4px 50px 1fr 56px auto auto',
                  gap: '0', fontSize: '12px', borderRadius: '8px', overflow: 'hidden',
                  border: '1px solid rgba(26,10,0,0.08)',
                }}>
                  {/* Header */}
                  <div style={{ background: 'transparent', borderBottom: '1px solid rgba(26,10,0,0.08)' }} />
                  <div style={agHeaderCell}>Angle</div>
                  <div style={agHeaderCell}>Grade</div>
                  <div style={{ ...agHeaderCell, textAlign: 'center', fontSize: '9px' }}>Status</div>
                  <div style={agHeaderCell}></div>
                  <div style={agHeaderCell}></div>

                  {unifiedAngleRows.map((row, i) => {
                    const isOfficial = row.type === 'official';
                    const isCommunity = row.type === 'community';
                    const angleKey = String(row.angle);
                    const angleCommunity = communityGrades?.angles?.[angleKey] || null;
                    const myAngleSuggestion = displayGrade(myGradeSuggestions?.angles?.[angleKey], gradeSystem) || '';
                    const baseBg = i % 2 === 0 ? 'rgba(26,10,0,0.02)' : 'transparent';
                    const communityBg = i % 2 === 0 ? 'rgba(0,71,255,0.05)' : 'rgba(0,71,255,0.03)';
                    const bg = isCommunity ? communityBg : baseBg;
                    const expanded = showAngleSuggest === row.angle;
                    const inlineBtnStyle = (border) => ({
                      background: 'none', border, borderRadius: '4px',
                      cursor: 'pointer', padding: '1px 5px', lineHeight: 1,
                    });
                    return [
                      /* Color bar */
                      <div key={`bar${i}`} style={{ background: isOfficial ? 'var(--yellow)' : 'rgba(0,71,255,0.3)' }} />,
                      /* Angle */
                      <div key={`a${i}`} style={{ ...agCell, background: bg, fontFamily: 'var(--font-heading)', fontWeight: 700, color: isCommunity ? 'var(--text-muted)' : 'inherit' }}>
                        {row.angle}°
                      </div>,
                      /* Grade — with inline suggest/accept */
                      <div key={`g${i}`} style={{ ...agCell, background: bg, fontWeight: 700, color: isCommunity ? 'var(--text-muted)' : 'inherit', display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
                        {isOfficial && (
                          <>
                            {row.grade}
                            {/* Inline consensus button — collapsed */}
                            {angleCommunity && angleCommunity.consensus !== row.grade && !expanded && (
                              <button onClick={() => setShowAngleSuggest(row.angle)} style={inlineBtnStyle('1px solid rgba(26,10,0,0.12)')}>
                                <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', fontFamily: 'var(--font-heading)' }}>
                                  {!isCreator && !myAngleSuggestion ? `${angleCommunity.consensus}?` : angleCommunity.consensus}
                                </span>
                              </button>
                            )}
                            {/* No-suggestion prompt for non-creator — collapsed */}
                            {!isCreator && !angleCommunity && !expanded && (
                              <button onClick={() => setShowAngleSuggest(row.angle)} style={inlineBtnStyle('1px solid rgba(26,10,0,0.12)')}>
                                <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', fontFamily: 'var(--font-heading)' }}>{row.grade}?</span>
                              </button>
                            )}
                            {/* Expanded */}
                            {expanded && (
                              <>
                                {canEdit && angleCommunity && angleCommunity.consensus !== row.grade && (
                                  <button onClick={() => { onAcceptGrade(angleCommunity.consensus, row.angle); setShowAngleSuggest(null); }}
                                    style={{ padding: '2px 8px', borderRadius: '4px', fontSize: '10px', border: 'none', background: 'var(--accent)', color: '#fff', cursor: 'pointer', fontWeight: 700, whiteSpace: 'nowrap' }}
                                  >
                                    Accept {angleCommunity.consensus}
                                  </button>
                                )}
                                {!isCreator && (
                                  <select autoFocus value={myAngleSuggestion}
                                    onChange={(e) => { onSuggestGrade(undefined, { [row.angle]: e.target.value || null }); setShowAngleSuggest(null); }}
                                    onBlur={() => setShowAngleSuggest(null)}
                                    style={{ padding: '2px 4px', borderRadius: '4px', fontSize: '10px', border: '1px solid rgba(26,10,0,0.1)', background: 'var(--bg-input)', fontFamily: 'var(--font-heading)', fontWeight: 600, width: '56px' }}
                                  >
                                    <option value="">—</option>
                                    {grades.map(g => <option key={g} value={g}>{g}</option>)}
                                  </select>
                                )}
                                <button onClick={() => setShowAngleSuggest(null)}
                                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '1px 4px', fontSize: '10px', color: 'var(--text-muted)' }}
                                >✕</button>
                              </>
                            )}
                          </>
                        )}
                        {isCommunity && (
                          <>
                            {/* Collapsed — whole grade is a button */}
                            {!expanded && (
                              <button onClick={() => setShowAngleSuggest(row.angle)} style={inlineBtnStyle('1px solid rgba(0,71,255,0.2)')}>
                                <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', fontFamily: 'var(--font-heading)' }}>
                                  {!isCreator && !myAngleSuggestion ? `${row.grade}?` : row.grade}
                                </span>
                              </button>
                            )}
                            {/* Expanded */}
                            {expanded && (
                              <>
                                <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', fontFamily: 'var(--font-heading)' }}>{row.grade}</span>
                                {canEdit && (
                                  <button onClick={() => { onAcceptGrade(row.grade, row.angle); setShowAngleSuggest(null); }}
                                    style={{ padding: '2px 8px', borderRadius: '4px', fontSize: '10px', border: 'none', background: 'var(--accent)', color: '#fff', cursor: 'pointer', fontWeight: 700, whiteSpace: 'nowrap' }}
                                  >
                                    Accept {row.grade}
                                  </button>
                                )}
                                {!isCreator && (
                                  <select autoFocus value={myAngleSuggestion}
                                    onChange={(e) => { onSuggestGrade(undefined, { [row.angle]: e.target.value || null }); setShowAngleSuggest(null); }}
                                    onBlur={() => setShowAngleSuggest(null)}
                                    style={{ padding: '2px 4px', borderRadius: '4px', fontSize: '10px', border: '1px solid rgba(26,10,0,0.1)', background: 'var(--bg-input)', fontFamily: 'var(--font-heading)', fontWeight: 600, width: '56px' }}
                                  >
                                    <option value="">—</option>
                                    {grades.map(g => <option key={g} value={g}>{g}</option>)}
                                  </select>
                                )}
                                <button onClick={() => setShowAngleSuggest(null)}
                                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '1px 4px', fontSize: '10px', color: 'var(--text-muted)' }}
                                >✕</button>
                              </>
                            )}
                          </>
                        )}
                      </div>,
                      /* Status — 4-state cycle box with label below */
                      <div key={`t${i}`} style={{ ...agCell, background: bg, justifyContent: 'center' }}>
                        <SentCycleButton
                          state={angleStateOf(row.angle)}
                          onClick={() => onToggleAngleSent(row.angle)}
                          labelPosition="below"
                        />
                      </div>,
                      /* Set Main (official + creator only) */
                      <div key={`s${i}`} style={{ ...agCell, background: bg, textAlign: 'center' }}>
                        {isOfficial && canEdit && (
                          <button
                            onClick={() => onSetHeadline(row.angle, row.grade)}
                            title="Set as headline"
                            style={{
                              padding: '2px 8px', borderRadius: '6px', fontSize: '9px',
                              border: '1px solid var(--accent)', background: 'transparent',
                              color: 'var(--accent)', cursor: 'pointer', fontWeight: 700,
                            }}
                          >
                            Set Main
                          </button>
                        )}
                      </div>,
                      /* Delete / Remove suggestion — far right */
                      <div key={`d${i}`} style={{ ...agCell, background: bg, textAlign: 'center' }}>
                        {isOfficial && canEdit && (
                          <button onClick={() => onRemoveAngleGrade(row.angle)}
                            style={{ padding: '2px 6px', borderRadius: '4px', fontSize: '10px', border: '1px solid rgba(255,82,82,0.3)', background: 'rgba(255,82,82,0.06)', color: '#FF5252', cursor: 'pointer' }}
                          >✕</button>
                        )}
                        {isCommunity && !!myAngleSuggestion && (
                          <button onClick={() => onSuggestGrade(undefined, { [row.angle]: null })} title="Remove your suggestion"
                            style={{ padding: '2px 6px', borderRadius: '4px', fontSize: '10px', border: '1px solid rgba(255,82,82,0.3)', background: 'rgba(255,82,82,0.06)', color: '#FF5252', cursor: 'pointer' }}
                          >✕</button>
                        )}
                      </div>,
                    ];
                  })}
                </div>
              )}
              {!isCreator && (
                <NewAngleSuggestionRow
                  grades={grades}
                  existingAngles={unifiedAngleRows.map(r => r.angle)}
                  minAngle={minAngle}
                  maxAngle={maxAngle}
                  onSuggest={(angle, grade) => onSuggestGrade(undefined, { [angle]: grade })}
                />
              )}
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

// Wall switcher — only renders when you belong to 2+ walls (single-wall users see
// nothing change). Self-contained so it's easy to remove if multi-wall is dropped.

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
