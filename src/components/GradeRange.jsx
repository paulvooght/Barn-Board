/**
 * GradeRange — one bar, two handles, for the route list's grade filter.
 *   labels   – the stops, easiest to hardest (one string per stop)
 *   lo, hi   – the two handles, as indexes into labels (lo <= hi)
 *   onChange – onChange(lo, hi) with the new indexes
 *
 * Two native range inputs sit on top of each other; the CSS (.grade-range in
 * App.css) lets touches pass through the inputs and land only on the two thumbs.
 */
export default function GradeRange({ labels, lo, hi, onChange }) {
  const max = labels.length - 1;
  // Long lists (Font) label every second stop so they fit a phone; the first and last always show.
  const step = labels.length > 12 ? 2 : 1;
  const showLabel = (i) => i === max || (i % step === 0 && (step === 1 || i < max - 1));
  return (
    <div className="grade-range" style={{ '--a': lo / max, '--b': hi / max }}>
      <div className="grade-range-bar">
        <div className="grade-range-track" />
        <div className="grade-range-fill" />
        {/* Handles can sit on the same stop, and then only the top one can be grabbed.
            Upper half: easiest on top (it can move left). Lower half: hardest on top
            (it can move right). So neither end is ever a dead end. */}
        <input type="range" min="0" max={max} step="1" value={lo} aria-label="Easiest grade" aria-valuetext={labels[lo]}
          style={{ zIndex: lo > max / 2 ? 3 : 1 }}
          onChange={(e) => onChange(Math.min(Number(e.target.value), hi), hi)} />
        <input type="range" min="0" max={max} step="1" value={hi} aria-label="Hardest grade" aria-valuetext={labels[hi]}
          style={{ zIndex: 2 }}
          onChange={(e) => onChange(lo, Math.max(Number(e.target.value), lo))} />
      </div>
      <div className="grade-range-ticks" aria-hidden="true">
        {labels.map((label, i) => (
          <span key={label} className={i >= lo && i <= hi ? 'in' : ''}>{showLabel(i) ? label : ''}</span>
        ))}
      </div>
    </div>
  );
}
