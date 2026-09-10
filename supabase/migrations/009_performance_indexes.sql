-- 009_performance_indexes.sql
--
-- WHY: prod has no indexes on the columns we filter by every single page load, so
-- routine queries fall back to sequential scans. On top of that, the 2c RLS policies
-- (`app_is_member` / `app_is_admin`, and user_route_data's read policy) run a
-- membership lookup PER ROW — each of those was also a scan. Small tables hid the
-- cost until Disk IO budget exhaustion made the instance unresponsive (2026-09-10).
--
-- Tables are tiny (38 routes / 27 sessions / 56 user_route_data), so every index
-- below builds in milliseconds. Safe to run on a live database.
--
-- Idempotent: re-running is a no-op.

-- ── routes ────────────────────────────────────────────────────────────────────
-- Every route fetch filters by board_id; the RLS policy re-checks it per row.
CREATE INDEX IF NOT EXISTS idx_routes_board_id ON public.routes (board_id);
-- Creator checks ("can this user edit?") and per-setter filtering.
CREATE INDEX IF NOT EXISTS idx_routes_user_id  ON public.routes (user_id);

-- ── sessions ──────────────────────────────────────────────────────────────────
-- Sessions are owner-private: every read filters user_id, usually with board_id.
CREATE INDEX IF NOT EXISTS idx_sessions_user_board ON public.sessions (user_id, board_id);

-- ── user_route_data ───────────────────────────────────────────────────────────
-- PK is (user_id, route_id), so user-first lookups are already covered.
-- Route-first is NOT: community average rating and consensus grade fan out by route.
CREATE INDEX IF NOT EXISTS idx_urd_route_id ON public.user_route_data (route_id);

-- ── board_members ─────────────────────────────────────────────────────────────
-- PK is (board_id, user_id), so board-first is covered.
-- The RLS helpers look up BY USER ("which walls am I in?") — that direction was a
-- scan, executed per row of every routes/user_route_data read. This is the single
-- most valuable index here.
CREATE INDEX IF NOT EXISTS idx_board_members_user_id ON public.board_members (user_id);

-- ── route_comments ────────────────────────────────────────────────────────────
-- Comment threads are always fetched by route.
CREATE INDEX IF NOT EXISTS idx_route_comments_route_id ON public.route_comments (route_id);

-- ── shared_playlists ──────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_shared_playlists_user_id ON public.shared_playlists (user_id);

-- ── boards ────────────────────────────────────────────────────────────────────
-- Slug lookups (scripts resolve --board <slug>; public wall discovery).
CREATE INDEX IF NOT EXISTS idx_boards_slug ON public.boards (slug);

-- Refresh planner stats so the new indexes get used immediately.
ANALYZE public.routes;
ANALYZE public.sessions;
ANALYZE public.user_route_data;
ANALYZE public.board_members;
ANALYZE public.route_comments;
ANALYZE public.shared_playlists;
ANALYZE public.boards;

-- Verify (expect one row per index above):
--   SELECT tablename, indexname FROM pg_indexes
--    WHERE schemaname='public' AND indexname LIKE 'idx_%' ORDER BY tablename;
