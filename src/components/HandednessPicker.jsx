import { useRef } from 'react';

// Floating [ L ] [ R ] (+ ✕ to clear) pill picker, opened by long-pressing a hold
// in route create/edit mode. A full-viewport transparent backdrop catches outside
// taps (→ onClose) so they never fall through to the board underneath.
//
// Props:
//   x, y     client coords of the press
//   current  'L' | 'R' | undefined — the hold's present mark
//   color    the hold's role colour (from MODE_COLORS)
//   onPick   (side: 'L' | 'R' | null) — null means "clear"
//   onClose  dismiss without changing anything

const PILL = 48;          // pill width/height (≥ 44px touch target)
const CLEAR_W = 36;       // smaller ✕ pill
const GAP = 8;
const EDGE = 16;          // min distance from viewport left/right edge
const ABOVE = 70;         // how far above the press to float the row
const BELOW = 60;         // …or below, if there's no room above
const TOP_MARGIN = 12;
const IGNORE_MS = 400;    // swallow the synthesized click that follows the long-press lift

export default function HandednessPicker({ x, y, current, color, onPick, onClose }) {
  const openedAtRef = useRef(Date.now());
  const justOpened = () => Date.now() - openedAtRef.current < IGNORE_MS;

  const vw = typeof window !== 'undefined' ? window.innerWidth : 400;
  const rowW = PILL * 2 + GAP + (current ? GAP + CLEAR_W : 0);
  const left = Math.min(Math.max(x, EDGE + rowW / 2), Math.max(vw - EDGE - rowW / 2, EDGE + rowW / 2));
  const wantTop = y - ABOVE - PILL / 2;
  const top = wantTop < TOP_MARGIN ? y + BELOW - PILL / 2 : wantTop;

  const pill = (side) => {
    const active = current === side;
    return (
      <button
        key={side}
        type="button"
        aria-label={side === 'L' ? 'Left hand only' : 'Right hand only'}
        onClick={(e) => {
          e.stopPropagation();
          if (justOpened()) return;
          if (active) onClose(); else onPick(side);
        }}
        style={{
          width: PILL, height: PILL, minWidth: 44, minHeight: 44,
          borderRadius: 22,
          border: `2px solid ${color}`,
          background: active ? color : '#fff',
          color: active ? '#fff' : color,
          fontFamily: 'var(--font-heading)',
          fontSize: 20, fontWeight: 800, lineHeight: 1,
          boxShadow: '0 4px 14px rgba(26,10,0,0.28)',
          cursor: 'pointer',
          padding: 0,
          touchAction: 'manipulation',
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        {side}
      </button>
    );
  };

  return (
    <div
      onClick={() => { if (!justOpened()) onClose(); }}
      onContextMenu={(e) => { e.preventDefault(); if (!justOpened()) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'transparent',
        touchAction: 'none',
        userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none',
      }}
    >
      <style>{`@keyframes hand-picker-pop { from { opacity: 0; transform: translateX(-50%) scale(0.85); } to { opacity: 1; transform: translateX(-50%) scale(1); } }`}</style>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute', left, top,
          transform: 'translateX(-50%)',
          display: 'flex', gap: GAP, alignItems: 'center',
          animation: 'hand-picker-pop 120ms ease-out',
        }}
      >
        {pill('L')}
        {pill('R')}
        {current && (
          <button
            type="button"
            aria-label="Clear left/right mark"
            onClick={(e) => {
              e.stopPropagation();
              if (justOpened()) return;
              onPick(null);
            }}
            style={{
              width: CLEAR_W, height: CLEAR_W, minWidth: 36, minHeight: 36,
              borderRadius: 18,
              border: '2px solid rgba(26,10,0,0.35)',
              background: '#fff',
              color: 'var(--text-secondary)',
              fontSize: 14, fontWeight: 800, lineHeight: 1,
              boxShadow: '0 4px 14px rgba(26,10,0,0.28)',
              cursor: 'pointer', padding: 0,
              touchAction: 'manipulation',
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}
