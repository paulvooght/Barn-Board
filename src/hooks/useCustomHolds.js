import { useState, useEffect, useRef } from 'react';
import holdsData from '../data/holds.json';
import * as db from '../lib/db';

/**
 * Per-board hold data (multi-wall 2b-ii).
 *
 * Each wall owns its FULL hold array under board_settings['holds_<boardId>'].
 * That single array is the effective hold set — there's no base/override/custom
 * merge at runtime any more (the old three-layer model collapsed into one blob
 * per board when The Barn was migrated; see 005_holds_per_board.sql).
 *
 *  • `boardId`         — the active wall; switching walls reloads that wall's holds.
 *  • `seedFromLegacy`  — true ONLY for The Barn. If its per-board blob is somehow
 *                        absent (deploy window before the migration, or a manual
 *                        revert that deleted the blob), rebuild the effective set
 *                        from the legacy GLOBAL keys (holds.json + hold_overrides
 *                        + custom_holds) so the wall never renders empty. A fresh
 *                        non-Barn wall with no blob legitimately starts empty.
 *
 * localStorage caches each wall's holds under `barnboard_holds_<boardId>` for
 * instant paint + offline within a session. Supabase is the source of truth.
 *
 * Hold IDs are preserved verbatim on every write — routes reference holds by ID.
 */
export function useCustomHolds(user, boardId, seedFromLegacy = false) {
  const [holds, setHolds] = useState([]);
  // Guard so we load once per (user, board) pair and don't re-clobber edits.
  const loadedFor = useRef(null);

  const cacheKey = boardId ? `barnboard_holds_${boardId}` : null;

  // ─── Load this wall's holds when the user or active wall changes ───
  useEffect(() => {
    if (!user || !boardId) return;
    const token = `${user.id}:${boardId}`;
    if (loadedFor.current === token) return;
    loadedFor.current = token;

    // Instant paint from cache; clear stale holds from the previous wall otherwise.
    try {
      const cached = JSON.parse(localStorage.getItem(`barnboard_holds_${boardId}`) || 'null');
      setHolds(Array.isArray(cached) ? cached : []);
    } catch { setHolds([]); }

    (async () => {
      const { data, error } = await db.getBoardHolds(boardId);
      if (error) { console.error('[Supabase] holds load error:', error); return; }

      if (data?.data) {
        setHolds(data.data);
        localStorage.setItem(`barnboard_holds_${boardId}`, JSON.stringify(data.data));
        return;
      }

      if (seedFromLegacy) {
        // The Barn safety net: rebuild the effective set the old hook would have
        // produced. Read-only — does NOT write the blob (the migration owns
        // seeding; the next edit will persist it).
        const { data: legacy } = await db.getBoardSettingsIn(['hold_overrides', 'custom_holds']);
        const overrides = legacy?.find(r => r.key === 'hold_overrides')?.data || {};
        const customs   = legacy?.find(r => r.key === 'custom_holds')?.data || [];
        const base = holdsData.holds
          .filter(h => !overrides[h.id]?.hidden)
          .map(h => ({ ...h, ...(overrides[h.id] || {}) }));
        const rebuilt = [...base, ...customs];
        setHolds(rebuilt);
        localStorage.setItem(`barnboard_holds_${boardId}`, JSON.stringify(rebuilt));
      } else {
        setHolds([]); // fresh wall — no holds yet
      }
    })();
  }, [user?.id, boardId, seedFromLegacy]);

  const allHolds = holds;

  // ─── Persist the wall's hold set (cache + Supabase). No setState here —
  //     callers update React state via setHolds, mirroring the old pattern. ───
  const persist = (next) => {
    if (cacheKey) localStorage.setItem(cacheKey, JSON.stringify(next));
    if (user && boardId) return db.setBoardHolds(boardId, next);
    return Promise.resolve();
  };

  // ─── Mutations (operate on the single per-board array) ─────────────
  const addHold = (holdData) => {
    const id = `custom_${Date.now()}`;
    const newHold = { color: 'black', size: 'medium', area: 0, notes: '', verified: true, ...holdData, id, custom: true };
    setHolds(prev => { const next = [...prev, newHold]; persist(next); return next; });
    return id;
  };

  const updateHold = (holdId, updates) => {
    setHolds(prev => { const next = prev.map(h => h.id === holdId ? { ...h, ...updates } : h); persist(next); return next; });
  };

  const deleteHold = (holdId) => {
    setHolds(prev => { const next = prev.filter(h => h.id !== holdId); persist(next); return next; });
  };

  // Bulk save from the Hold Manager. IDs are preserved verbatim (BoardSetupView
  // keeps existing IDs and mints custom_<ts> only for genuinely new holds), so
  // routes stay valid with no ID remap. Awaited so the write lands before nav.
  const saveAllHolds = async (newHolds) => {
    setHolds(newHolds);
    await persist(newHolds);
  };

  return { allHolds, addHold, updateHold, deleteHold, saveAllHolds };
}
