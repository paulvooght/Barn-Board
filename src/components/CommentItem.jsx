import { useState } from 'react';

/**
 * Returns a relative time string for a given ISO timestamp.
 * Falls back to a short absolute date for anything older than ~8 weeks.
 */
function relativeTime(isoString) {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60)  return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60)  return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24)   return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 14)  return `${diffDay}d ago`;
  const diffWk = Math.floor(diffDay / 7);
  if (diffWk < 8)    return `${diffWk}w ago`;
  // Older than ~8 weeks — short absolute date
  return new Date(isoString).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * CommentItem — single comment row in a route's comment thread.
 *
 * Props:
 *   comment         – { id, user_id, body, likes, flags, created_at }
 *   displayName     – resolved display name for the comment author
 *   isCreator       – true when the comment author is the route creator
 *   isMine          – true when currentUserId === comment.user_id
 *   isAdmin         – true when the viewing user is an admin
 *   showFlagBadge   – admin sees flag count badge when true
 *   currentUserId   – UUID of the currently logged-in user
 *   onLike(id)      – toggle like for this comment
 *   onFlag(id)      – toggle flag for this comment
 *   onDelete(id)    – hard-delete this comment (admin only)
 */
export default function CommentItem({
  comment,
  displayName,
  isCreator,
  isMine,
  isAdmin,
  showFlagBadge,
  currentUserId,
  onLike,
  onFlag,
  onDelete,
}) {
  const liked  = currentUserId && comment.likes.includes(currentUserId);
  const flagged = currentUserId && comment.flags.includes(currentUserId);
  const flagCount = comment.flags.length;

  function handleDelete() {
    if (window.confirm('Delete this comment?')) {
      onDelete(comment.id);
    }
  }

  return (
    <div style={{
      padding: '10px 12px',
      borderRadius: '10px',
      background: '#fff',
      border: '1px solid rgba(26,10,0,0.08)',
      marginBottom: '6px',
    }}>
      {/* Author row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
        <span style={{
          fontWeight: 700,
          fontSize: '12px',
          color: isCreator ? '#fbbf24' : '#1A0A00',
        }}>
          {displayName || 'Unknown'}
        </span>
        {isCreator && (
          <span style={{
            display: 'inline-block',
            padding: '1px 6px',
            borderRadius: '99px',
            background: '#fbbf24',
            color: '#1A0A00',
            fontSize: '9px',
            fontWeight: 700,
            letterSpacing: '0.3px',
            lineHeight: '1.5',
          }}>
            setter
          </span>
        )}
      </div>

      {/* Body */}
      <div style={{
        fontSize: '13px',
        color: '#1A0A00',
        lineHeight: 1.45,
        marginBottom: '8px',
        wordBreak: 'break-word',
      }}>
        {comment.body}
      </div>

      {/* Footer row: timestamp + actions */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        flexWrap: 'wrap',
      }}>
        {/* Timestamp */}
        <span
          title={new Date(comment.created_at).toLocaleString()}
          style={{ fontSize: '10px', color: 'rgba(26,10,0,0.4)', flex: 1, cursor: 'default' }}
        >
          {relativeTime(comment.created_at)}
        </span>

        {/* Flag badge (admin) */}
        {showFlagBadge && flagCount > 0 && (
          <span style={{
            fontSize: '10px',
            fontWeight: 700,
            color: '#e67e22',
            background: 'rgba(230,126,34,0.12)',
            padding: '2px 6px',
            borderRadius: '6px',
          }}>
            ⚑ {flagCount}
          </span>
        )}

        {/* Like button */}
        <button
          onClick={() => onLike(comment.id)}
          style={{
            display: 'flex', alignItems: 'center', gap: '3px',
            padding: '4px 8px', borderRadius: '6px',
            border: liked ? '1px solid rgba(0,71,255,0.35)' : '1px solid rgba(26,10,0,0.1)',
            background: liked ? 'rgba(0,71,255,0.08)' : 'transparent',
            color: liked ? '#0047FF' : 'rgba(26,10,0,0.45)',
            fontSize: '11px', fontWeight: 600, cursor: 'pointer',
            minHeight: '28px', minWidth: '36px',
          }}
        >
          <span style={{ fontSize: '12px' }}>👍</span>
          <span>{comment.likes.length}</span>
        </button>

        {/* Flag button — hidden for own comments */}
        {!isMine && (
          <button
            onClick={() => onFlag(comment.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: '3px',
              padding: '4px 8px', borderRadius: '6px',
              border: flagged ? '1px solid rgba(230,126,34,0.4)' : '1px solid rgba(26,10,0,0.1)',
              background: flagged ? 'rgba(230,126,34,0.1)' : 'transparent',
              color: flagged ? '#e67e22' : 'rgba(26,10,0,0.35)',
              fontSize: '10px', fontWeight: 600, cursor: 'pointer',
              minHeight: '28px',
            }}
          >
            ⚑ Neg
          </button>
        )}

        {/* Delete button — admin only */}
        {isAdmin && (
          <button
            onClick={handleDelete}
            style={{
              padding: '4px 8px', borderRadius: '6px',
              border: '1px solid rgba(255,20,147,0.25)',
              background: 'transparent',
              color: '#FF1493',
              fontSize: '11px', cursor: 'pointer',
              minHeight: '28px',
            }}
          >
            🗑
          </button>
        )}
      </div>
    </div>
  );
}
