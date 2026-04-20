import { useState, useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';
import CommentItem from './CommentItem';

/**
 * CommentsSection — collapsible comment thread for a route.
 *
 * Props:
 *   routeId                  – string ID of the route
 *   routeCreatorId           – user_id of the route creator (for "setter" badge)
 *   currentUserId            – UUID of the logged-in user (null when logged out)
 *   currentUserDisplayName   – display name for the current user (null if not set)
 *   profilesById             – { [user_id]: { display_name } } map
 *   isAdmin                  – bool
 */
export default function CommentsSection({
  routeId,
  routeCreatorId,
  currentUserId,
  currentUserDisplayName,
  profilesById,
  isAdmin,
}) {
  const [expanded, setExpanded]       = useState(false);
  const [comments, setComments]       = useState([]);
  const [loading, setLoading]         = useState(true);
  const [composeText, setComposeText] = useState('');
  const [posting, setPosting]         = useState(false);
  const [error, setError]             = useState('');
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  // Eagerly fetch comments on mount (table will be small per route)
  useEffect(() => {
    if (!routeId) return;
    let cancelled = false;

    async function fetchComments() {
      setLoading(true);
      const { data, error: fetchErr } = await supabase
        .from('route_comments')
        .select('*')
        .eq('route_id', routeId)
        .order('created_at', { ascending: true });

      if (cancelled) return;
      if (fetchErr) {
        console.error('CommentsSection fetch error:', fetchErr);
      } else {
        setComments(data || []);
      }
      setLoading(false);
    }

    fetchComments();
    return () => { cancelled = true; };
  }, [routeId]);

  // Tab-visibility refetch for multi-device sync (only when expanded)
  useEffect(() => {
    function handleVisibility() {
      if (document.visibilityState === 'visible' && expandedRef.current && routeId) {
        supabase
          .from('route_comments')
          .select('*')
          .eq('route_id', routeId)
          .order('created_at', { ascending: true })
          .then(({ data, error: fetchErr }) => {
            if (fetchErr) {
              console.error('CommentsSection visibility refetch error:', fetchErr);
            } else {
              setComments(data || []);
            }
          });
      }
    }
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [routeId]);

  async function handlePost() {
    const body = composeText.trim();
    if (!body || !currentUserId || !currentUserDisplayName || posting) return;

    setError('');
    setPosting(true);
    const { data, error: postErr } = await supabase
      .from('route_comments')
      .insert({ route_id: routeId, user_id: currentUserId, body })
      .select()
      .single();

    if (postErr) {
      console.error('CommentsSection post error:', postErr);
      setError('Failed to post comment. Please try again.');
    } else {
      setComments(prev => [...prev, data]);
      setComposeText('');
    }
    setPosting(false);
  }

  async function handleLike(commentId) {
    if (!currentUserId) return;
    const comment = comments.find(c => c.id === commentId);
    if (!comment) return;

    const already = comment.likes.includes(currentUserId);
    const newLikes = already
      ? comment.likes.filter(id => id !== currentUserId)
      : [...comment.likes, currentUserId];

    // Optimistic update
    setComments(prev => prev.map(c => c.id === commentId ? { ...c, likes: newLikes } : c));

    const { error } = await supabase
      .from('route_comments')
      .update({ likes: newLikes })
      .eq('id', commentId);

    if (error) {
      console.error('CommentsSection like error:', error);
      // Rollback
      setComments(prev => prev.map(c => c.id === commentId ? { ...c, likes: comment.likes } : c));
    }
  }

  async function handleFlag(commentId) {
    if (!currentUserId) return;
    const comment = comments.find(c => c.id === commentId);
    if (!comment) return;

    const already = comment.flags.includes(currentUserId);
    const newFlags = already
      ? comment.flags.filter(id => id !== currentUserId)
      : [...comment.flags, currentUserId];

    // Optimistic update
    setComments(prev => prev.map(c => c.id === commentId ? { ...c, flags: newFlags } : c));

    const { error } = await supabase
      .from('route_comments')
      .update({ flags: newFlags })
      .eq('id', commentId);

    if (error) {
      console.error('CommentsSection flag error:', error);
      // Rollback
      setComments(prev => prev.map(c => c.id === commentId ? { ...c, flags: comment.flags } : c));
    }
  }

  async function handleDelete(commentId) {
    setError('');
    const { error: deleteErr } = await supabase
      .from('route_comments')
      .delete()
      .eq('id', commentId);

    if (deleteErr) {
      console.error('CommentsSection delete error:', deleteErr);
      setError('Failed to delete comment.');
    } else {
      setComments(prev => prev.filter(c => c.id !== commentId));
    }
  }

  const count = loading ? '…' : comments.length;
  const charCount = composeText.length;
  const showCounter = charCount > 400;
  const canPost = composeText.trim().length > 0 && !!currentUserDisplayName && !posting;

  return (
    <div style={{ padding: '0 12px 16px' }}>
      {/* Collapse/expand toggle */}
      <button
        onClick={() => setExpanded(prev => !prev)}
        style={{
          display: 'flex', alignItems: 'center', gap: '6px',
          padding: '7px 12px', borderRadius: '8px',
          border: '1.5px solid rgba(26,10,0,0.12)',
          background: expanded ? 'rgba(0,71,255,0.06)' : 'rgba(255,255,255,0.6)',
          color: expanded ? '#0047FF' : 'rgba(26,10,0,0.6)',
          fontSize: '12px', fontWeight: 700,
          cursor: 'pointer', width: '100%', textAlign: 'left',
        }}
      >
        <span>{expanded ? '▾' : '▸'}</span>
        <span>Comments ({count})</span>
      </button>

      {expanded && (
        <div style={{ marginTop: '10px' }}>
          {/* Comment list */}
          {loading ? (
            <div style={{ fontSize: '12px', color: 'rgba(26,10,0,0.4)', padding: '8px 0' }}>
              Loading…
            </div>
          ) : comments.length === 0 ? (
            <div style={{ fontSize: '12px', color: 'rgba(26,10,0,0.4)', fontStyle: 'italic', padding: '8px 0' }}>
              No comments yet — be the first.
            </div>
          ) : (
            comments.map(comment => {
              const profile = profilesById[comment.user_id];
              const name = profile?.display_name || 'Unknown';
              return (
                <CommentItem
                  key={comment.id}
                  comment={comment}
                  displayName={name}
                  isCreator={comment.user_id === routeCreatorId}
                  isMine={comment.user_id === currentUserId}
                  isAdmin={isAdmin}
                  showFlagBadge={isAdmin}
                  currentUserId={currentUserId}
                  onLike={handleLike}
                  onFlag={handleFlag}
                  onDelete={handleDelete}
                />
              );
            })
          )}

          {/* Compose area */}
          <div style={{ marginTop: '8px' }}>
            {!currentUserDisplayName ? (
              <div style={{
                fontSize: '12px', color: 'rgba(26,10,0,0.5)',
                fontStyle: 'italic', padding: '8px 0',
              }}>
                Set a display name in Settings to comment.
              </div>
            ) : (
              <>
                <div style={{ position: 'relative' }}>
                  <textarea
                    value={composeText}
                    onChange={e => { setComposeText(e.target.value.slice(0, 500)); setError(''); }}
                    placeholder="Add a comment…"
                    rows={2}
                    maxLength={500}
                    style={{
                      width: '100%',
                      padding: '8px 10px',
                      borderRadius: '8px',
                      border: '1.5px solid rgba(26,10,0,0.15)',
                      background: '#fff',
                      fontSize: '13px',
                      color: '#1A0A00',
                      resize: 'vertical',
                      fontFamily: 'inherit',
                      boxSizing: 'border-box',
                      outline: 'none',
                    }}
                  />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '6px' }}>
                  {showCounter ? (
                    <span style={{
                      fontSize: '10px',
                      color: charCount >= 490 ? '#e74c3c' : 'rgba(26,10,0,0.4)',
                    }}>
                      {charCount}/500
                    </span>
                  ) : <div />}
                  <button
                    onClick={handlePost}
                    disabled={!canPost}
                    style={{
                      padding: '7px 18px', borderRadius: '8px',
                      border: 'none',
                      background: canPost ? '#0047FF' : 'rgba(26,10,0,0.1)',
                      color: canPost ? '#fff' : 'rgba(26,10,0,0.3)',
                      fontSize: '12px', fontWeight: 700,
                      cursor: canPost ? 'pointer' : 'default',
                    }}
                  >
                    {posting ? 'Posting…' : 'Post'}
                  </button>
                </div>
                {error && (
                  <div style={{ fontSize: '11px', color: '#e74c3c', marginTop: '4px' }}>
                    {error}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
