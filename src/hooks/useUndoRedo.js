import { useState, useCallback, useRef } from 'react';

const MAX_UNDO = 50;

/**
 * Generic undo/redo hook using state snapshots.
 *
 * Usage:
 *   const { state, setState, undo, redo, canUndo, canRedo, reset } = useUndoRedo(initialState);
 *
 *   // To make an undoable change:
 *   setState(newValue);        // pushes current state to undo stack
 *   setState(prev => ...);     // functional form also supported
 */
export function useUndoRedo(initialState) {
  const [state, setStateRaw] = useState(initialState);
  const undoStack = useRef([]);
  const redoStack = useRef([]);
  const [version, setVersion] = useState(0); // triggers re-render for canUndo/canRedo

  const setState = useCallback((valueOrFn) => {
    setStateRaw(prev => {
      const next = typeof valueOrFn === 'function' ? valueOrFn(prev) : valueOrFn;
      // Push current state to undo stack
      undoStack.current = [...undoStack.current.slice(-(MAX_UNDO - 1)), prev];
      redoStack.current = [];
      setVersion(v => v + 1);
      return next;
    });
  }, []);

  const undo = useCallback(() => {
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
    setStateRaw(newState);
    undoStack.current = [];
    redoStack.current = [];
    setVersion(v => v + 1);
  }, []);

  return {
    state,
    setState,
    undo,
    redo,
    canUndo: undoStack.current.length > 0,
    canRedo: redoStack.current.length > 0,
    reset,
  };
}
