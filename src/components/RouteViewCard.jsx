import { Suspense, lazy } from 'react';
import BoardView from './BoardView';
import { HOLD_COLOR_DOT } from '../utils/constants';

// Lazy-loaded so it doesn't inflate the initial bundle (same as App.jsx)
const CommentsSection = lazy(() => import('./CommentsSection'));

/**
 * RouteViewCard — renders the full viewRoute presentation for one route.
 *
 * Used by the carousel: the active card is interactive; neighbour cards have
 * isInteractive=false so taps don't accidentally fire on them during a drag.
 *
 * The component returns a fragment — App.jsx provides the carousel wrapper.
 */
export default function RouteViewCard({
  route,
  isInteractive,
  // Shared app data
  user,
  isAdmin,
  settings,
  grades,
  allHolds,
  playlists,
  imgSrc,
  imgSrcSet,
  imgSizes,
  userRouteData,
  communityRatings,
  communityGrades,
  profilesById,
  displayName,
  // Per-instance UI state
  holdSelection,
  holdDataMode,
  setHoldDataMode,
  inspectedRouteHoldId,
  setInspectedRouteHoldId,
  showRouteTags,
  setShowRouteTags,
  // Handlers
  onClose,
  onEdit,
  onDelete,
  onToggleSent,
  onSuggestGrade,
  onAcceptGrade,
  onAddAngleGrade,
  onRemoveAngleGrade,
  onSetHeadline,
  onToggleAngleSent,
  onAddToPlaylist,
  onCreatePlaylist,
  onMarkAttempted,
  onHoldTap,
  handleEditHold,
  setHoldEditorSource,
  onZoomChange,
  // From App: viewRouteOrder length to determine if chevron padding is needed
  hasChevronBar,
  // Per-wall angle range (from the active board's specs) for the angle slider
  minAngle,
  maxAngle,
  // ViewRouteHeader is defined in App.jsx — passed as a prop so RouteViewCard
  // doesn't need to re-define or import it.
  ViewRouteHeader,
}) {
  // Resolve per-user and community data for this specific route
  const urd = userRouteData[route.id] || {};
  const cr = communityRatings[route.id] || null;
  const cg = communityGrades[route.id] || null;

  const isCreator = route.creatorId === user?.id;
  const canEdit = route.creatorId === user?.id ||
    (isAdmin && (settings.adminMode ?? 'climber') === 'admin');

  // Hold info toggle state derived values
  const routeHoldIds = Object.keys(route.holds || {});
  const inspectedHold = inspectedRouteHoldId
    ? allHolds.find(h => h.id === inspectedRouteHoldId)
    : null;
  const hasTagData =
    route.holdTypes?.length > 0 ||
    route.techniques?.length > 0 ||
    route.styles?.length > 0;

  const toggleBtnStyle = (active) => ({
    padding: '5px 10px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
    cursor: 'pointer', lineHeight: 1, whiteSpace: 'nowrap',
    border: active ? '1.5px solid var(--accent)' : '1.5px solid rgba(26,10,0,0.12)',
    background: active ? 'var(--accent-dim)' : 'rgba(255,255,255,0.6)',
    color: active ? 'var(--accent)' : 'var(--text-secondary)',
  });

  const wrapperStyle = isInteractive ? {} : { pointerEvents: 'none' };

  return (
    <div style={wrapperStyle}>
      {/* 1. BoardView with ViewRouteHeader child */}
      <BoardView
        holds={allHolds}
        selection={holdSelection}
        onHoldTap={isInteractive && holdDataMode ? (id) => {
          if (route.holds?.[id]) {
            setInspectedRouteHoldId(prev => prev === id ? null : id);
          }
        } : undefined}
        interactive={isInteractive && holdDataMode}
        dimBoard={true}
        imgSrc={imgSrc}
        imgSrcSet={imgSrcSet}
        imgSizes={imgSizes}
        holdSnapshots={route.holdSnapshots || null}
        onZoomChange={isInteractive ? onZoomChange : undefined}
      >
        {ViewRouteHeader && (
          <ViewRouteHeader
            route={route}
            sent={urd.sent || false}
            flashed={urd.flashed || false}
            attempted={urd.attempted || false}
            angleSends={urd.angleSends || []}
            angleFlashes={urd.angleFlashes || []}
            angleAttempts={urd.angleAttempts || []}
            isCreator={isCreator}
            canEdit={canEdit}
            grades={grades}
            gradeSystem={settings.gradeSystem}
            playlists={playlists}
            settings={settings}
            allHolds={allHolds}
            communityGrades={cg}
            myGradeSuggestions={urd.gradeSuggestions || {}}
            minAngle={minAngle}
            maxAngle={maxAngle}
            onSuggestGrade={(headline, angles) => onSuggestGrade(route.id, headline, angles)}
            onAcceptGrade={(grade, angle) => onAcceptGrade(route.id, grade, angle)}
            onEdit={() => onEdit(route)}
            onClose={onClose}
            onDelete={() => onDelete(route.id)}
            onToggleSent={() => onToggleSent(route.id)}
            onAddAngleGrade={(angle, grade) => onAddAngleGrade(route.id, angle, grade)}
            onRemoveAngleGrade={(angle) => onRemoveAngleGrade(route.id, angle)}
            onSetHeadline={(angle, grade) => onSetHeadline(route.id, angle, grade)}
            onToggleAngleSent={(angle) => onToggleAngleSent(route.id, angle)}
            onAddToPlaylist={(plId) => onAddToPlaylist(route.id, plId)}
            onCreatePlaylist={onCreatePlaylist}
            showTagsBelow={false}
          />
        )}
      </BoardView>

      {/* 2. Hold Info toggle + info card + tag data block */}
      {(() => {
        return (
          <div style={{ padding: '0 12px 4px' }}>
            {/* Toggle row — Show more (left) + Hold Info (right) */}
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              marginBottom: inspectedHold ? '8px' : '0',
            }}>
              {hasTagData ? (
                <button
                  onClick={() => setShowRouteTags(prev => !prev)}
                  style={toggleBtnStyle(showRouteTags)}
                >
                  {showRouteTags ? '▾ Show less' : '▸ Show more'}
                </button>
              ) : <div />}
              <button
                onClick={() => { setHoldDataMode(prev => !prev); setInspectedRouteHoldId(null); }}
                style={toggleBtnStyle(holdDataMode)}
              >
                Hold Info
              </button>
            </div>

            {/* Info card when a hold is tapped */}
            {holdDataMode && inspectedHold && (() => {
              const holdColor = HOLD_COLOR_DOT[inspectedHold.color] || '#888';
              const types = inspectedHold.holdTypes?.length > 0
                ? inspectedHold.holdTypes.join(' · ')
                : 'No types set';
              const pos = inspectedHold.positivity || 0;
              const posLabel = pos === 0 ? 'Neutral' : pos > 0 ? `+${pos} Positive` : `${pos} Slopey`;
              return (
                <div style={{
                  padding: '10px 12px', borderRadius: '10px', marginBottom: '4px',
                  background: 'var(--bg-card)', border: '1px solid var(--border)',
                  boxShadow: '0 2px 8px rgba(26,10,0,0.06)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                    <span style={{
                      width: '12px', height: '12px', borderRadius: '50%', flexShrink: 0,
                      background: holdColor, border: '1.5px solid rgba(26,10,0,0.15)',
                    }} />
                    <span style={{ fontWeight: 700, fontSize: '13px', flex: 1 }}>
                      {inspectedHold.name || `Hold ${inspectedHold.id}`}
                    </span>
                    <button
                      onClick={() => setInspectedRouteHoldId(null)}
                      style={{
                        background: 'none', border: 'none', cursor: 'pointer',
                        color: 'var(--text-muted)', fontSize: '16px', padding: '0 2px', lineHeight: 1,
                      }}
                    >✕</button>
                  </div>
                  <div style={{
                    fontSize: '11px', color: 'var(--text-muted)',
                    display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '8px',
                  }}>
                    <span>{types}</span>
                    <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{posLabel}</span>
                    {inspectedHold.color && <span style={{ textTransform: 'capitalize' }}>{inspectedHold.color}</span>}
                    {inspectedHold.material && <span>{inspectedHold.material}</span>}
                  </div>
                  <button
                    onClick={() => {
                      if (setHoldEditorSource) setHoldEditorSource('viewRoute');
                      if (handleEditHold) handleEditHold(inspectedHold, 'viewRoute');
                    }}
                    style={{
                      padding: '5px 14px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
                      cursor: 'pointer', border: 'none',
                      background: 'var(--accent)', color: '#fff',
                    }}
                  >
                    Edit Hold
                  </button>
                </div>
              );
            })()}

            {holdDataMode && !inspectedHold && (
              <div style={{
                fontSize: '11px', color: 'var(--text-muted)',
                fontStyle: 'italic', padding: '2px 0 4px',
              }}>
                Tap a hold to view its data
              </div>
            )}

            {/* Expandable tag data — shown when Show more is active */}
            {hasTagData && showRouteTags && (
              <div style={{ paddingTop: '6px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {route.holdTypes?.length > 0 && (
                  <div>
                    <div style={{
                      fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)',
                      textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px',
                    }}>Hold Types</div>
                    <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
                      {route.holdTypes.map(tag => (
                        <span key={tag} style={{
                          padding: '3px 10px', borderRadius: '8px',
                          background: 'rgba(26,10,0,0.06)', border: '1px solid rgba(26,10,0,0.08)',
                          fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 500,
                        }}>{tag}</span>
                      ))}
                    </div>
                  </div>
                )}
                {route.techniques?.length > 0 && (
                  <div>
                    <div style={{
                      fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)',
                      textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px',
                    }}>Techniques</div>
                    <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
                      {route.techniques.map(tag => (
                        <span key={tag} style={{
                          padding: '3px 10px', borderRadius: '8px',
                          background: 'rgba(26,10,0,0.06)', border: '1px solid rgba(26,10,0,0.08)',
                          fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 500,
                        }}>{tag}</span>
                      ))}
                    </div>
                  </div>
                )}
                {route.styles?.length > 0 && (
                  <div>
                    <div style={{
                      fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)',
                      textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px',
                    }}>Style</div>
                    <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
                      {route.styles.map(tag => (
                        <span key={tag} style={{
                          padding: '3px 10px', borderRadius: '8px',
                          background: 'rgba(26,10,0,0.06)', border: '1px solid rgba(26,10,0,0.08)',
                          fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 500,
                        }}>{tag}</span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {/* 3. Comments section */}
      <Suspense fallback={
        <div style={{ padding: '12px', fontSize: 12, color: 'rgba(26,10,0,0.4)' }}>
          Loading comments…
        </div>
      }>
        <div style={{ paddingBottom: hasChevronBar ? '80px' : '0px' }}>
          <CommentsSection
            routeId={route.id}
            routeCreatorId={route.creatorId}
            currentUserId={user?.id}
            currentUserDisplayName={displayName}
            profilesById={profilesById}
            isAdmin={isAdmin}
            onMarkAttempted={() => onMarkAttempted(route.id)}
          />
        </div>
      </Suspense>
    </div>
  );
}
