import { useState, useCallback, useRef } from 'react';

const MAX_UNDO = 50;

/**
 * Generic undo/redo hook using state snapshots.
 *
 * Usage:
 *   const { state, setState, undo, redo, canUndo, canRedo, reset, beginCoalesce, endCoalesce } = useUndoRedo(initialState);
 *
 *   // To make an undoable change:
 *   setState(newValue);        // pushes current state to undo stack
 *   setState(prev => ...);     // functional form also supported
 *
 *   // To coalesce a continuous gesture (e.g. drag) into one undo entry:
 *   beginCoalesce();           // call at gesture start
 *   setState(...);             // first call pushes pre-gesture state; subsequent calls update silently
 *   endCoalesce();             // call at gesture end; returns to normal behaviour
 */
export function useUndoRedo(initialState) {
  const [state, setStateRaw] = useState(initialState);
  const undoStack = useRef([]);
  const redoStack = useRef([]);
  const [version, setVersion] = useState(0); // triggers re-render for canUndo/canRedo

  // Coalesce refs: while active, only the first setState pushes to the undo stack
  const isCoalescingRef = useRef(false);
  const coalesceFirstSnapshotRef = useRef(false); // true once we've pushed within this window

  const setState = useCallback((valueOrFn) => {
    setStateRaw(prev => {
      const next = typeof valueOrFn === 'function' ? valueOrFn(prev) : valueOrFn;
      const shouldPush = !isCoalescingRef.current || !coalesceFirstSnapshotRef.current;
      if (shouldPush) {
        // Push current state to undo stack
        undoStack.current = [...undoStack.current.slice(-(MAX_UNDO - 1)), prev];
        redoStack.current = [];
        setVersion(v => v + 1);
        if (isCoalescingRef.current) {
          coalesceFirstSnapshotRef.current = true;
        }
      }
      return next;
    });
  }, []);

  const undo = useCallback(() => {
    // Defensively end any in-flight coalesce (e.g. Cmd+Z during a drag)
    isCoalescingRef.current = false;
    coalesceFirstSnapshotRef.current = false;
    if (undoStack.current.length === 0) return;
    setStateRaw(prev => {
      const restored = undoStack.current[undoStack.current.length - 1];
      undoStack.current = undoStack.current.slice(0, -1);
      redoStack.current = [...redoStack.current, prev];
      setVersion(v => v + 1);
      return restored;
    });
  }, []);

  const redo = useCallback(() => {
    // Defensively end any in-flight coalesce
    isCoalescingRef.current = false;
    coalesceFirstSnapshotRef.current = false;
    if (redoStack.current.length === 0) return;
    setStateRaw(prev => {
      const restored = redoStack.current[redoStack.current.length - 1];
      redoStack.current = redoStack.current.slice(0, -1);
      undoStack.current = [...undoStack.current, prev];
      setVersion(v => v + 1);
      return restored;
    });
  }, []);

  const reset = useCallback((newState) => {
    // Defensively end any in-flight coalesce
    isCoalescingRef.current = false;
    coalesceFirstSnapshotRef.current = false;
    setStateRaw(newState);
    undoStack.current = [];
    redoStack.current = [];
    setVersion(v => v + 1);
  }, []);

  const beginCoalesce = useCallback(() => {
    isCoalescingRef.current = true;
    coalesceFirstSnapshotRef.current = false;
  }, []);

  const endCoalesce = useCallback(() => {
    isCoalescingRef.current = false;
    coalesceFirstSnapshotRef.current = false;
  }, []);

  return {
    state,
    setState,
    undo,
    redo,
    canUndo: undoStack.current.length > 0,
    canRedo: redoStack.current.length > 0,
    reset,
    beginCoalesce,
    endCoalesce,
  };
}
