import { useMemo } from 'react';
import { useLocalStorage } from './useLocalStorage';
import holdsData from '../data/holds.json';

/**
 * Manages hold data across three layers:
 *   1. Base holds from holds.json (static, auto-detected)
 *   2. Overrides — edits to position/size of existing holds (stored in localStorage)
 *   3. Custom holds — fully user-created holds (stored in localStorage)
 *
 * Exposes a merged `allHolds` array and mutation helpers.
 */
export function useCustomHolds() {
  const [customHolds,   setCustomHolds]   = useLocalStorage('barnboard_custom_holds',   []);
  const [holdOverrides, setHoldOverrides] = useLocalStorage('barnboard_hold_overrides', {});

  const allHolds = useMemo(() => {
    const base = holdsData.holds
      .filter(h => !holdOverrides[h.id]?.hidden)
      .map(h => ({ ...h, ...(holdOverrides[h.id] || {}) }));
    return [...base, ...customHolds];
  }, [customHolds, holdOverrides]);

  const addHold = (holdData) => {
    const id = `custom_${Date.now()}`;
    const newHold = { color: 'black', size: 'medium', area: 0, notes: '', verified: true, ...holdData, id, custom: true };
    setCustomHolds(prev => [...prev, newHold]);
    return id;
  };

  const updateHold = (holdId, updates) => {
    if (String(holdId).startsWith('custom_')) {
      setCustomHolds(prev => prev.map(h => h.id === holdId ? { ...h, ...updates } : h));
    } else {
      setHoldOverrides(prev => ({ ...prev, [holdId]: { ...(prev[holdId] || {}), ...updates } }));
    }
  };

  const deleteHold = (holdId) => {
    if (String(holdId).startsWith('custom_')) {
      setCustomHolds(prev => prev.filter(h => h.id !== holdId));
    } else {
      // Can't remove a JSON hold — mark it hidden via overrides
      setHoldOverrides(prev => ({ ...prev, [holdId]: { ...(prev[holdId] || {}), hidden: true } }));
    }
  };

  const resetAllOverrides = () => {
    setHoldOverrides({});
    setCustomHolds([]);
  };

  return { allHolds, customHolds, holdOverrides, addHold, updateHold, deleteHold, resetAllOverrides };
}
