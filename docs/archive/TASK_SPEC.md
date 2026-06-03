# TASK_SPEC.md — Angle Grade Table: Inline Suggest/Accept in Grade Cell

## Overview
Simplify the angle-grade table by moving all suggest/accept interaction into the Grade cell itself — matching the headline grade UX pattern. Remove the dedicated suggest/accept column entirely.

Three changes:
1. **Inline suggest/accept in Grade cell** — consensus shown as tappable inline element, expands to reveal accept (creator) or suggest dropdown (non-creator)
2. **Remove the suggest/accept column** — grid drops from 7 data columns to 6
3. **Move Delete ✕ to far right** (from previous spec, still needed)
4. **Remove "Your: V6" labelling** (from previous spec, still needed)

## No data model or logic changes — purely UI

## File to Modify
- `src/App.jsx` — ViewRouteHeader angle-grade grid only

---

## New Grid Layout

### Current columns
```
4px bar | Angle | Grade | Sent | Set Main | Delete | Suggest/Accept
```

### New columns
```
4px bar | Angle | Grade (with inline suggest/accept) | Sent | Set Main | Delete
```

```jsx
gridTemplateColumns: '4px 50px 1fr 36px auto auto'
```

Header row: remove the last (7th) header cell.

---

## Grade Cell Logic (Col 2)

The Grade cell now handles display AND interaction. Use existing `showAngleSuggest` state to track which row is expanded (one at a time).

### Official rows

**Display (collapsed):**
```jsx
<div key={`g${i}`} style={{ ...agCell, background: bg, fontWeight: 700, display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
  {row.grade}
  {/* Inline consensus — only when suggestions exist and differ */}
  {angleCommunity && angleCommunity.consensus !== row.grade && showAngleSuggest !== row.angle && (
    <button
      onClick={() => setShowAngleSuggest(row.angle)}
      style={{
        background: 'none',
        border: '1px solid rgba(26,10,0,0.12)',
        borderRadius: '4px',
        cursor: 'pointer',
        padding: '1px 5px',
        lineHeight: 1,
      }}
    >
      <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', fontFamily: 'var(--font-heading)' }}>
        {!isCreator && !myAngleSuggestion ? `${angleCommunity.consensus}?` : angleCommunity.consensus}
      </span>
    </button>
  )}
  {/* Non-creator, no suggestions yet — show "V4?" prompt */}
  {!isCreator && !angleCommunity && showAngleSuggest !== row.angle && (
    <button
      onClick={() => setShowAngleSuggest(row.angle)}
      style={{
        background: 'none',
        border: '1px solid rgba(26,10,0,0.12)',
        borderRadius: '4px',
        cursor: 'pointer',
        padding: '1px 5px',
        lineHeight: 1,
      }}
    >
      <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', fontFamily: 'var(--font-heading)' }}>
        {row.grade}?
      </span>
    </button>
  )}
  {/* Creator, no suggestions or consensus matches — show nothing extra */}

  {/* Expanded state */}
  {showAngleSuggest === row.angle && (
    <>
      {/* Creator: Accept button */}
      {isCreator && angleCommunity && angleCommunity.consensus !== row.grade && (
        <button
          onClick={() => { onAcceptGrade(angleCommunity.consensus, row.angle); setShowAngleSuggest(null); }}
          style={{
            padding: '2px 8px', borderRadius: '4px', fontSize: '10px',
            border: 'none', background: 'var(--accent)',
            color: '#fff', cursor: 'pointer', fontWeight: 700,
            whiteSpace: 'nowrap',
          }}
        >
          Accept {angleCommunity.consensus}
        </button>
      )}
      {/* Non-creator: suggest dropdown */}
      {!isCreator && (
        <select
          autoFocus
          value={myAngleSuggestion}
          onChange={(e) => {
            onSuggestGrade(undefined, { [row.angle]: e.target.value || null });
            setShowAngleSuggest(null);
          }}
          onBlur={() => setShowAngleSuggest(null)}
          style={{
            padding: '2px 4px', borderRadius: '4px', fontSize: '10px',
            border: '1px solid rgba(26,10,0,0.1)', background: 'var(--bg-input)',
            fontFamily: 'var(--font-heading)', fontWeight: 600, width: '56px',
          }}
        >
          <option value="">—</option>
          {grades.map(g => <option key={g} value={g}>{g}</option>)}
        </select>
      )}
      {/* Dismiss button (tap to collapse) */}
      <button
        onClick={() => setShowAngleSuggest(null)}
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          padding: '1px 4px', fontSize: '10px', color: 'var(--text-muted)',
        }}
      >
        ✕
      </button>
    </>
  )}
</div>
```

### Community rows

Same pattern but the consensus IS the grade — no "official grade" shown first.

**Display (collapsed):**
```jsx
<div key={`g${i}`} style={{
  ...agCell, background: bg, fontWeight: 700,
  color: 'var(--text-muted)',
  display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap',
}}>
  {showAngleSuggest !== row.angle && (
    <button
      onClick={() => setShowAngleSuggest(row.angle)}
      style={{
        background: 'none',
        border: '1px solid rgba(0,71,255,0.2)',
        borderRadius: '4px',
        cursor: 'pointer',
        padding: '1px 5px',
        lineHeight: 1,
      }}
    >
      <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', fontFamily: 'var(--font-heading)' }}>
        {!isCreator && !myAngleSuggestion ? `${row.grade}?` : row.grade}
      </span>
    </button>
  )}

  {/* Expanded state */}
  {showAngleSuggest === row.angle && (
    <>
      <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', fontFamily: 'var(--font-heading)' }}>
        {row.grade}
      </span>
      {/* Creator: Accept button */}
      {isCreator && (
        <button
          onClick={() => { onAcceptGrade(row.grade, row.angle); setShowAngleSuggest(null); }}
          style={{
            padding: '2px 8px', borderRadius: '4px', fontSize: '10px',
            border: 'none', background: 'var(--accent)',
            color: '#fff', cursor: 'pointer', fontWeight: 700,
            whiteSpace: 'nowrap',
          }}
        >
          Accept {row.grade}
        </button>
      )}
      {/* Non-creator: suggest dropdown pre-filled */}
      {!isCreator && (
        <select
          autoFocus
          value={myAngleSuggestion}
          onChange={(e) => {
            onSuggestGrade(undefined, { [row.angle]: e.target.value || null });
            setShowAngleSuggest(null);
          }}
          onBlur={() => setShowAngleSuggest(null)}
          style={{
            padding: '2px 4px', borderRadius: '4px', fontSize: '10px',
            border: '1px solid rgba(26,10,0,0.1)', background: 'var(--bg-input)',
            fontFamily: 'var(--font-heading)', fontWeight: 600, width: '56px',
          }}
        >
          <option value="">—</option>
          {grades.map(g => <option key={g} value={g}>{g}</option>)}
        </select>
      )}
      {/* Dismiss */}
      <button
        onClick={() => setShowAngleSuggest(null)}
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          padding: '1px 4px', fontSize: '10px', color: 'var(--text-muted)',
        }}
      >
        ✕
      </button>
    </>
  )}
</div>
```

---

## Delete Column (now last)

Stays the same logic, just rendered as the final column:
- Official + creator → red ✕ (delete angle grade)
- Community + user has suggestion (`!!myAngleSuggestion`) → red ✕ (remove own suggestion via `onSuggestGrade(undefined, { [row.angle]: null })`)
- Otherwise → empty cell

---

## Set Main Column

Only shows for creator on official rows (unchanged). For non-creators and community rows: empty cell.

---

## Summary of Interaction by Role

| Row type | Creator (collapsed) | Creator (tapped) | Non-creator (collapsed) | Non-creator (tapped) |
|----------|-------------------|-----------------|----------------------|-------------------|
| Official, no suggestions | `V4` (nothing extra) | n/a | `V4 (V4?)` | dropdown pre-filled |
| Official, consensus differs | `V4 (V5)` | `V4 [Accept V5] ✕` | `V4 (V5?)` or `V4 (V5)` if already suggested | dropdown pre-filled |
| Official, consensus matches | `V4` (nothing extra) | n/a | `V4` (nothing extra — consensus matches) | n/a |
| Community | `(V6)` | `V6 [Accept V6] ✕` | `(V6?)` or `(V6)` if already suggested | dropdown pre-filled |

Note: Non-creators who have already suggested see the consensus without `?` (they've already contributed). Non-creators who haven't suggested see `?` suffix as a prompt.

---

## What NOT to Change
- Headline grade suggestion UI (already working correctly)
- Data model, loading, consensus computation
- `suggestGrade` / `acceptGradeSuggestion` callbacks
- `NewAngleSuggestionRow` component
- Color coding (yellow/blue bars)
- RouteCard display
- Anything outside ViewRouteHeader angle-grade grid

## Acceptance Criteria
- [ ] No dedicated suggest/accept column — grid has 6 columns: bar, angle, grade, sent, set main, delete
- [ ] Delete ✕ is the rightmost column
- [ ] Official row + consensus differs: inline consensus shown as tappable button in grade cell
- [ ] Creator taps consensus → Accept button appears inline, tap accepts and collapses
- [ ] Non-creator taps consensus → dropdown appears inline, pre-filled with their suggestion
- [ ] Community row: consensus grade is the tappable element (whole grade is a button)
- [ ] Creator sees nothing extra on rows with no suggestions
- [ ] Non-creator who hasn't suggested sees `?` suffix; non-creator who has suggested sees plain consensus
- [ ] Only one row can be expanded at a time (`showAngleSuggest` state)
- [ ] `npm run build` passes

## Builder Rules (always apply)
1. Read CLAUDE.md before starting any work
2. Do not broaden scope — implement exactly what's specified
3. Do not refactor unrelated code
4. Keep edits surgical — prefer minimal diffs
5. Test build passes before considering task complete
6. After completing and verifying `npm run build`, commit and push to `main`
