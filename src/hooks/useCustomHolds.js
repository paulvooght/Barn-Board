import { useMemo, useEffect, useRef } from 'react';
import { useLocalStorage } from './useLocalStorage';
import holdsData from '../data/holds.json';
import { supabase } from '../lib/supabase';

/**
 * Manages hold data across three layers:
 *   1. Base holds from holds.json (static, auto-detected)
 *   2. Overrides — edits to position/size of existing holds (stored in Supabase / localStorage)
 *   3. Custom holds — fully user-created holds (stored in Supabase / localStorage)
 *
 * Supabase board_settings table stores hold data as shared board config.
 * localStorage acts as local cache so the app works offline within a session.
 */
export function useCustomHolds(user) {
  const [customHolds,   setCustomHolds]   = useLocalStorage('barnboard_custom_holds',   []);
  const [holdOverrides, setHoldOverrides] = useLocalStorage('barnboard_hold_overrides', {});

  // Track whether we've loaded from Supabase for this user (prevents circular sync)
  const loadedForUser = useRef(null);

  const allHolds = useMemo(() => {
    const base = holdsData.holds
      .filter(h => !holdOverrides[h.id]?.hidden)
      .map(h => ({ ...h, ...(holdOverrides[h.id] || {}) }));
    return [...base, ...customHolds];
  }, [customHolds, holdOverrides]);

  // ─── Load hold data from Supabase when user logs in ───────────────
  useEffect(() => {
    if (!user || loadedForUser.current === user.id) return;
    loadedForUser.current = user.id;

    const load = async () => {
      const { data, error } = await supabase.from('board_settings').select('key, data');
      if (error) { console.error('[Supabase] board_settings load error:', error); return; }

      const overridesRow = data?.find(r => r.key === 'hold_overrides');
      const customsRow   = data?.find(r => r.key === 'custom_holds');

      if (overridesRow) {
        setHoldOverrides(overridesRow.data);
      } else {
        // First time — migrate localStorage overrides to Supabase
        const local = JSON.parse(localStorage.getItem('barnboard_hold_overrides') || '{}');
        if (Object.keys(local).length > 0) {
          await supabase.from('board_settings').upsert({ key: 'hold_overrides', data: local });
        }
      }

      if (customsRow) {
        setCustomHolds(customsRow.data);
      } else {
        const local = JSON.parse(localStorage.getItem('barnboard_custom_holds') || '[]');
        if (local.length > 0) {
          await supabase.from('board_settings').upsert({ key: 'custom_holds', data: local });
        }
      }
    };
    load();
  }, [user?.id]);

  // ─── Sync helpers (called by mutations below) ─────────────────────
  // Returns a promise so callers can await critical writes
  const syncOverrides = (overrides) => {
    if (!user) return Promise.resolve();
    return supabase.from('board_settings')
      .upsert({ key: 'hold_overrides', data: overrides, updated_at: new Date().toISOString() })
      .then(({ error }) => { if (error) console.error('[Supabase] hold_overrides sync:', error); });
  };

  const syncCustoms = (customs) => {
    if (!user) return Promise.resolve();
    return supabase.from('board_settings')
      .upsert({ key: 'custom_holds', data: customs, updated_at: new Date().toISOString() })
      .then(({ error }) => { if (error) console.error('[Supabase] custom_holds sync:', error); });
  };

  // ─── Mutations ────────────────────────────────────────────────────
  const addHold = (holdData) => {
    const id = `custom_${Date.now()}`;
    const newHold = { color: 'black', size: 'medium', area: 0, notes: '', verified: true, ...holdData, id, custom: true };
    setCustomHolds(prev => {
      const next = [...prev, newHold];
      syncCustoms(next);
      return next;
    });
    return id;
  };

  const updateHold = (holdId, updates) => {
    if (String(holdId).startsWith('custom_')) {
      setCustomHolds(prev => {
        const next = prev.map(h => h.id === holdId ? { ...h, ...updates } : h);
        syncCustoms(next);
        return next;
      });
    } else {
      setHoldOverrides(prev => {
        const next = { ...prev, [holdId]: { ...(prev[holdId] || {}), ...updates } };
        syncOverrides(next);
        return next;
      });
    }
  };

  const deleteHold = (holdId) => {
    if (String(holdId).startsWith('custom_')) {
      setCustomHolds(prev => {
        const next = prev.filter(h => h.id !== holdId);
        syncCustoms(next);
        return next;
      });
    } else {
      setHoldOverrides(prev => {
        const next = { ...prev, [holdId]: { ...(prev[holdId] || {}), hidden: true } };
        syncOverrides(next);
        return next;
      });
    }
  };

  const resetAllOverrides = () => {
    setHoldOverrides({});
    setCustomHolds([]);
    syncOverrides({});
    syncCustoms([]);
  };

  const replaceAllHolds = async (newHolds) => {
    const hideAll = {};
    for (const h of holdsData.holds) {
      hideAll[h.id] = { hidden: true };
    }
    setHoldOverrides(hideAll);
    const customs = newHolds.map(h => ({
      ...h,
      custom: true,
      id: h.id.startsWith('custom_') ? h.id : `custom_${h.id}`,
    }));
    setCustomHolds(customs);
    // Await both writes so data is in Supabase before navigation
    await Promise.all([syncOverrides(hideAll), syncCustoms(customs)]);
  };

  return { allHolds, customHolds, holdOverrides, addHold, updateHold, deleteHold, resetAllOverrides, replaceAllHolds };
}
