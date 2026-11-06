import Icon from './Icon';

/**
 * VideoBadge — a small rounded square holding the video glyph.
 *   state: 'private' (yellow, someone's video still to be reviewed) | 'public' (blue)
 *   size : the square's side in px; the glyph is about two thirds of it
 *
 * It is a filled badge, not a bare icon, because a thin yellow icon can't be seen
 * on a white route card. Used on route cards and on the video filter buttons.
 */
export default function VideoBadge({ state, size = 22 }) {
  const isPrivate = state === 'private';
  const text = isPrivate ? 'Has a private video' : 'Has a public video';
  return (
    <span
      title={text}
      aria-label={text}
      role="img"
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: `${size}px`, height: `${size}px`, borderRadius: '6px', flexShrink: 0,
        background: isPrivate ? 'var(--yellow)' : 'var(--accent)',
        color: isPrivate ? '#1A0A00' : '#fff',
      }}
    >
      <Icon name="video" size={Math.round(size * 0.64)} />
    </span>
  );
}
