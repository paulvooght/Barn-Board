import { useState } from 'react';
import { BOARD_SPECS, GRADE_CONVERSION } from '../utils/constants';
import holdsData from '../data/holds.json';

/**
 * Props:
 *   settings, updateSettings — grade system etc.
 *   allHolds                 — merged hold array from useCustomHolds
 *   onSetupBoard()           — open the Hold Manager
 */
export default function Settings({ settings, updateSettings, allHolds, onSetupBoard, sessions = [], routes = [], onViewSession }) {
  const totalHolds    = allHolds.length;
  const customCount   = allHolds.filter(h => h.custom).length;
  const verifiedCount = allHolds.filter(h => h.verified).length;
  const [showChart, setShowChart] = useState(false);
  const [showSessions, setShowSessions] = useState(false);
  const [showBeta, setShowBeta] = useState(false);

  // Board image state
  const currentImage = settings.boardImage || '/Barn_Board_Reset_02_C.jpg';
  const currentFilename = currentImage.replace(/^\//, '');
  const [showImageInput, setShowImageInput] = useState(false);
  const [imageInput, setImageInput] = useState(currentFilename);
  const [imageError, setImageError] = useState('');
  const [imageSuccess, setImageSuccess] = useState(false);

  const handleSetImage = () => {
    const filename = imageInput.trim();
    if (!filename) return;
    const path = filename.startsWith('/') ? filename : `/${filename}`;
    setImageError('');
    setImageSuccess(false);
    const img = new Image();
    img.onload = () => {
      updateSettings('boardImage', path);
      setImageSuccess(true);
      setImageError('');
      setTimeout(() => setImageSuccess(false), 2000);
    };
    img.onerror = () => {
      setImageError(`Could not load "${filename}" — check the filename and that it's in the public folder`);
    };
    img.src = path;
  };

  return (
    <div style={{ padding: '16px 12px' }}>
      <h2 style={{ margin: '0 0 20px', fontSize: '18px', fontWeight: 700 }}>
        Settings
      </h2>

      {/* ── Grading System ── */}
      <div style={{ marginBottom: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
          <label style={{ ...labelStyle, margin: 0 }}>Grading System</label>
          <button
            onClick={() => setShowChart(prev => !prev)}
            style={{
              padding: '3px 10px', borderRadius: '8px', fontSize: '10px', fontWeight: 700,
              border: '1px solid var(--accent)', background: showChart ? 'var(--accent)' : 'transparent',
              color: showChart ? '#fff' : 'var(--accent)', cursor: 'pointer',
              letterSpacing: '0.5px', textTransform: 'uppercase',
            }}
          >
            {showChart ? '✕ Close' : '⊞ Grade Chart'}
          </button>
        </div>

        <div style={{ display: 'flex', gap: '8px' }}>
          {[
            { val: 'V',    label: 'V-Grade', example: 'V0, V1, V2...' },
            { val: 'Font', label: 'Font',    example: '6A, 6B, 6C...' },
          ].map(({ val, label, example }) => (
            <button
              key={val}
              onClick={() => updateSettings('gradeSystem', val)}
              style={{
                flex: 1, padding: '12px', borderRadius: '10px', cursor: 'pointer',
                border:     settings.gradeSystem === val ? '2px solid var(--accent)' : '2px solid rgba(26,10,0,0.12)',
                background: settings.gradeSystem === val ? 'var(--accent-dim)'       : 'rgba(255,255,255,0.5)',
                color:      settings.gradeSystem === val ? 'var(--accent)'            : 'var(--text-secondary)',
                fontSize: '14px', fontWeight: 600, textAlign: 'center',
              }}
            >
              {label}
              <div style={{ fontSize: '10px', marginTop: '3px', color: 'var(--text-muted)', fontWeight: 400 }}>
                {example}
              </div>
            </button>
          ))}
        </div>

        {/* ── Grade Conversion Chart ── */}
        {showChart && (
          <div style={{
            marginTop: '12px', borderRadius: '12px', overflow: 'hidden',
            border: '1px solid var(--border)', background: 'var(--bg-card)',
            boxShadow: '0 2px 8px rgba(26,10,0,0.06)',
          }}>
            <div style={{
              display: 'grid', gridTemplateColumns: '1fr 1fr',
              fontSize: '11px', fontWeight: 800, textTransform: 'uppercase',
              letterSpacing: '1px', color: 'var(--accent)',
              borderBottom: '2px solid var(--accent)',
            }}>
              <div style={{ padding: '8px 12px', textAlign: 'center' }}>V-Grade</div>
              <div style={{ padding: '8px 12px', textAlign: 'center' }}>Font</div>
            </div>
            {GRADE_CONVERSION.map(([font, v], i) => {
              // Check if this V-grade is same as next row (spans two Font grades)
              const prevSameV = i > 0 && GRADE_CONVERSION[i - 1][1] === v;
              return (
                <div key={i} style={{
                  display: 'grid', gridTemplateColumns: '1fr 1fr',
                  fontSize: '13px', fontFamily: 'var(--font-heading)',
                  borderBottom: i < GRADE_CONVERSION.length - 1 ? '1px solid rgba(26,10,0,0.06)' : 'none',
                  background: i % 2 === 0 ? 'rgba(26,10,0,0.02)' : 'transparent',
                }}>
                  <div style={{
                    padding: '6px 12px', textAlign: 'center',
                    fontWeight: 800,
                    color: prevSameV ? 'var(--text-muted)' : 'var(--accent)',
                  }}>
                    {prevSameV ? '↑' : v}
                  </div>
                  <div style={{
                    padding: '6px 12px', textAlign: 'center',
                    fontWeight: 700, color: 'var(--text-primary)',
                  }}>
                    {font}
                  </div>
                </div>
              );
            })}
            <div style={{
              padding: '6px', textAlign: 'center', fontSize: '9px',
              color: 'var(--text-dim)', borderTop: '1px solid rgba(26,10,0,0.06)',
            }}>
              Source: Rockfax Bouldering Grade Conversion
            </div>
          </div>
        )}
      </div>

      {/* ── Hold Manager ── */}
      <div style={{ marginBottom: '12px' }}>
        <button
          onClick={onSetupBoard}
          style={{
            width: '100%', padding: '12px', borderRadius: '10px', fontSize: '14px',
            fontWeight: 700, cursor: 'pointer', border: 'none',
            background: 'var(--accent)', color: '#fff',
            letterSpacing: '0.5px',
          }}
        >
          Hold Manager
        </button>
        <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: '6px', fontFamily: 'var(--font-heading)', textAlign: 'center' }}>
          {totalHolds} holds · Last detected: {holdsData.detectedAt}
        </div>
      </div>

      {/* ── Update Board Image ── */}
      <div style={{ marginBottom: '16px' }}>
        <button
          onClick={() => { setShowImageInput(prev => !prev); setImageError(''); setImageSuccess(false); setImageInput(currentFilename); }}
          style={{
            width: '100%', padding: '12px 16px', borderRadius: '12px',
            border: '1px solid var(--border)', background: 'var(--bg-card)',
            boxShadow: '0 2px 8px rgba(26,10,0,0.06)',
            cursor: 'pointer', display: 'flex', justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div>
            <span style={{
              fontSize: '11px', fontWeight: 800, color: 'var(--accent)',
              letterSpacing: '1.5px', textTransform: 'uppercase',
            }}>
              Update Board Image
            </span>
            <div style={{ fontSize: '10px', color: 'var(--text-dim)', marginTop: '2px', fontFamily: 'var(--font-heading)', textAlign: 'left' }}>
              {currentFilename}
            </div>
          </div>
          <span style={{ fontSize: '12px', color: 'var(--text-dim)' }}>
            {showImageInput ? '▾' : '▸'}
          </span>
        </button>

        {showImageInput && (
          <div style={{
            padding: '12px 14px', borderRadius: '0 0 12px 12px',
            border: '1px solid var(--border)', borderTop: 'none',
            background: 'var(--bg-card)',
          }}>
            <div style={{ display: 'flex', gap: '6px', marginBottom: '6px' }}>
              <input
                type="text"
                value={imageInput}
                onChange={e => { setImageInput(e.target.value); setImageError(''); setImageSuccess(false); }}
                placeholder="e.g. Barn_Board_Reset_03.jpg"
                style={{
                  flex: 1, padding: '8px 10px', borderRadius: '8px', fontSize: '12px',
                  border: '1.5px solid var(--border)', background: 'var(--bg-input)',
                  fontFamily: 'var(--font-heading)',
                }}
              />
              <button
                onClick={handleSetImage}
                style={{
                  padding: '8px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                  cursor: 'pointer', border: 'none',
                  background: 'var(--accent)', color: '#fff',
                }}
              >
                Set
              </button>
            </div>
            {imageError && (
              <div style={{ fontSize: '11px', color: '#DC2626', marginTop: '4px' }}>{imageError}</div>
            )}
            {imageSuccess && (
              <div style={{ fontSize: '11px', color: '#16A34A', marginTop: '4px' }}>Board image updated</div>
            )}
            <div style={{ fontSize: '10px', color: 'var(--text-dim)', marginTop: '6px' }}>
              Place your board photo in the public folder, then enter the filename.
            </div>
          </div>
        )}
      </div>

      {/* ── Session History ── */}
      <div style={{ marginBottom: '16px' }}>
        <button
          onClick={() => setShowSessions(prev => !prev)}
          style={{
            width: '100%', padding: '12px 16px', borderRadius: '12px',
            border: '1px solid var(--border)', background: 'var(--bg-card)',
            boxShadow: '0 2px 8px rgba(26,10,0,0.06)',
            cursor: 'pointer', display: 'flex', justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{
              fontSize: '11px', fontWeight: 800, color: 'var(--accent)',
              letterSpacing: '1.5px', textTransform: 'uppercase',
            }}>
              Session History
            </span>
            {sessions.length > 0 && (
              <span style={{
                background: 'rgba(212,112,90,0.2)', color: '#B85A48',
                fontWeight: 800, fontSize: '11px', padding: '2px 8px',
                borderRadius: '8px', fontFamily: 'var(--font-heading)',
              }}>
                {sessions.length}
              </span>
            )}
          </div>
          <span style={{ fontSize: '12px', color: 'var(--text-dim)' }}>
            {showSessions ? '▾' : '▸'}
          </span>
        </button>

        {showSessions && (
          <div style={{
            ...cardStyle, marginTop: '6px', borderTopLeftRadius: '8px', borderTopRightRadius: '8px',
          }}>
        {sessions.length === 0 ? (
          <div style={{ fontSize: '12px', color: 'var(--text-dim)', textAlign: 'center', padding: '12px 0' }}>
            No sessions yet — start one from the home screen
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {sessions.slice(0, 20).map(s => {
              const start = new Date(s.startTime);
              const duration = s.endTime ? new Date(s.endTime) - start : 0;
              const h = Math.floor(duration / 3600000);
              const m = Math.floor((duration % 3600000) / 60000);
              const durationStr = h > 0 ? `${h}h ${m}m` : `${m}m`;
              const sentCount = s.routesSent?.length || 0;
              const createdCount = s.routesCreated?.length || 0;
              const anglesClimbed = s.anglesClimbed || [];
              // Find hardest grade sent
              const sentRoutes = routes.filter(r => s.routesSent?.includes(r.id));
              const hardest = sentRoutes.length > 0
                ? sentRoutes.reduce((best, r) => {
                    const allGrades = settings.gradeSystem === 'V'
                      ? ['VB','V0-','V0','V0+','V1','V2','V3','V4','V5','V6','V7','V8','V9','V10','V11','V12','V13','V14','V15']
                      : ['3','3+','4','4+','5','5+','6A','6A+','6B','6B+','6C','6C+','7A','7A+','7B','7B+','7C','7C+','8A','8A+','8B','8B+','8C'];
                    return allGrades.indexOf(r.grade) > allGrades.indexOf(best.grade) ? r : best;
                  })
                : null;

              return (
                <button
                  key={s.id}
                  onClick={() => onViewSession && onViewSession(s)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '10px',
                    padding: '10px 12px', borderRadius: '10px',
                    border: '1px solid rgba(26,10,0,0.08)',
                    background: 'rgba(255,255,255,0.5)',
                    cursor: 'pointer', textAlign: 'left', width: '100%',
                  }}
                >
                  {/* Date */}
                  <div style={{ minWidth: '52px' }}>
                    <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>
                      {start.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                    </div>
                    <div style={{ fontSize: '9px', color: 'var(--text-dim)', fontFamily: 'var(--font-heading)' }}>
                      {start.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </div>

                  {/* Duration */}
                  <div style={{
                    fontSize: '14px', fontWeight: 800, fontFamily: 'var(--font-heading)',
                    color: '#B85A48', minWidth: '44px',
                  }}>
                    {durationStr}
                  </div>

                  {/* Stats */}
                  <div style={{ flex: 1, display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
                    {sentCount > 0 && (
                      <span style={{
                        fontSize: '10px', fontWeight: 700, color: '#B85A48',
                        background: 'rgba(212,112,90,0.15)', padding: '2px 7px', borderRadius: '6px',
                      }}>
                        {sentCount} sent
                      </span>
                    )}
                    {createdCount > 0 && (
                      <span style={{
                        fontSize: '10px', fontWeight: 700, color: 'var(--accent)',
                        background: 'rgba(0,71,255,0.08)', padding: '2px 7px', borderRadius: '6px',
                      }}>
                        {createdCount} new
                      </span>
                    )}
                    {hardest && (
                      <span style={{
                        fontSize: '10px', fontWeight: 800, fontFamily: 'var(--font-heading)',
                        color: 'var(--text-primary)', background: 'var(--yellow)',
                        padding: '2px 7px', borderRadius: '6px',
                      }}>
                        {hardest.grade}
                      </span>
                    )}
                    {anglesClimbed.length > 0 && (
                      <span style={{
                        fontSize: '9px', fontWeight: 600, color: 'var(--text-dim)',
                      }}>
                        {anglesClimbed.map(a => `${a}°`).join(', ')}
                      </span>
                    )}
                  </div>

                  {/* Arrow */}
                  <span style={{ fontSize: '12px', color: 'var(--text-dim)' }}>›</span>
                </button>
              );
            })}
            {sessions.length > 20 && (
              <div style={{ fontSize: '10px', color: 'var(--text-dim)', textAlign: 'center', padding: '4px' }}>
                Showing 20 of {sessions.length} sessions
              </div>
            )}
          </div>
        )}
          </div>
        )}
      </div>

      {/* ── Board Specs ── */}
      <div style={cardStyle}>
        <div style={sectionTitleStyle}>Board Specs</div>
        <div style={specGridStyle}>
          <SpecRow label="Width"       value={`${BOARD_SPECS.widthM}m`} />
          <SpecRow label="Height"      value={`${BOARD_SPECS.heightM}m`} />
          <SpecRow label="Angle range" value={`${BOARD_SPECS.minAngle}° – ${BOARD_SPECS.maxAngle}°`} />
          <SpecRow label="Holds (total)"    value={totalHolds} />
          <SpecRow label="Verified"         value={verifiedCount} />
          <SpecRow label="Custom"           value={customCount} />
        </div>
      </div>

      {/* ── Beta Features ── */}
      <div style={{ marginTop: '16px', marginBottom: '16px' }}>
        <button
          onClick={() => setShowBeta(prev => !prev)}
          style={{
            width: '100%', padding: '12px 16px', borderRadius: '12px',
            border: '1px solid var(--border)', background: 'var(--bg-card)',
            boxShadow: '0 2px 8px rgba(26,10,0,0.06)',
            cursor: 'pointer', display: 'flex', justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{
              fontSize: '11px', fontWeight: 800, color: '#FF2D78',
              letterSpacing: '1.5px', textTransform: 'uppercase',
            }}>
              Beta Features
            </span>
            <span style={{
              background: '#FF2D78', color: '#fff',
              fontWeight: 800, fontSize: '9px', padding: '2px 6px',
              borderRadius: '6px', letterSpacing: '0.5px',
            }}>
              BETA
            </span>
          </div>
          <span style={{ fontSize: '12px', color: 'var(--text-dim)' }}>
            {showBeta ? '▾' : '▸'}
          </span>
        </button>

        {showBeta && (
          <div style={{
            ...cardStyle, marginTop: '6px',
            borderTopLeftRadius: '8px', borderTopRightRadius: '8px',
          }}>
            {/* Angle Logger toggle */}
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '8px 0', borderBottom: '1px solid rgba(26,10,0,0.06)',
            }}>
              <div>
                <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
                  Session Angle Logger
                </div>
                <div style={{ fontSize: '10px', color: 'var(--text-dim)', marginTop: '2px' }}>
                  Log board angles during sessions. Shows angle slider on home screen and angles in session summary.
                </div>
              </div>
              <button
                onClick={() => updateSettings('betaAngleLogger', !settings.betaAngleLogger)}
                style={{
                  width: '44px', height: '24px', borderRadius: '12px',
                  border: 'none', cursor: 'pointer', flexShrink: 0, marginLeft: '12px',
                  background: settings.betaAngleLogger ? '#FF2D78' : 'rgba(26,10,0,0.15)',
                  position: 'relative', transition: 'background 0.2s',
                }}
              >
                <div style={{
                  width: '18px', height: '18px', borderRadius: '50%',
                  background: '#fff', position: 'absolute', top: '3px',
                  left: settings.betaAngleLogger ? '23px' : '3px',
                  transition: 'left 0.2s',
                  boxShadow: '0 1px 3px rgba(26,10,0,0.2)',
                }} />
              </button>
            </div>

            {/* Video Thumbnail toggle */}
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '8px 0',
            }}>
              <div>
                <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
                  Video Thumbnail Preview
                </div>
                <div style={{ fontSize: '10px', color: 'var(--text-dim)', marginTop: '2px' }}>
                  Show YouTube thumbnail in route info page. Camera icon always visible on route cards.
                </div>
              </div>
              <button
                onClick={() => updateSettings('betaVideoThumbnail', !settings.betaVideoThumbnail)}
                style={{
                  width: '44px', height: '24px', borderRadius: '12px',
                  border: 'none', cursor: 'pointer', flexShrink: 0, marginLeft: '12px',
                  background: settings.betaVideoThumbnail ? '#FF2D78' : 'rgba(26,10,0,0.15)',
                  position: 'relative', transition: 'background 0.2s',
                }}
              >
                <div style={{
                  width: '18px', height: '18px', borderRadius: '50%',
                  background: '#fff', position: 'absolute', top: '3px',
                  left: settings.betaVideoThumbnail ? '23px' : '3px',
                  transition: 'left 0.2s',
                  boxShadow: '0 1px 3px rgba(26,10,0,0.2)',
                }} />
              </button>
            </div>
          </div>
        )}
      </div>

      <div style={{ marginBottom: '32px' }} />
    </div>
  );
}

const COLOR_DOTS = {
  black: '#444', blue: '#0047FF', cyan: '#0047FF', purple: '#c084fc',
  green: '#22a870', orange: '#FF8C00', yellow: '#D4A000',
  pink: '#FF69B4', red: '#FF5252', white: '#888',
};

function HoldRow({ hold, onEdit, onDelete }) {
  const colorDot   = COLOR_DOTS[hold.color] ?? '#888';
  const displayName = hold.name || hold.id;
  const showId      = !!hold.name; // show ID as secondary only when a name is set

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '8px',
      padding: '6px 8px', borderRadius: '6px',
      background: 'rgba(255,255,255,0.6)', border: '1px solid rgba(26,10,0,0.1)',
    }}>
      <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: colorDot, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: '11px', fontWeight: hold.name ? 600 : 400,
          color: hold.verified ? 'var(--text-secondary)' : 'var(--yellow)',
          fontFamily: hold.name ? 'var(--font-body)' : 'var(--font-heading)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {displayName}{hold.custom ? ' ★' : ''}
        </div>
        <div style={{ fontSize: '10px', color: 'var(--text-dim)' }}>
          {showId ? `${hold.id} · ` : ''}{hold.color}
          {hold.holdTypes?.length > 0 ? ` · ${hold.holdTypes.slice(0,2).join(', ')}` : ''}
          {` · ${hold.cx}%, ${hold.cy}%`}
        </div>
      </div>
      <button onClick={onEdit}   style={rowBtnStyle('#0047FF')}>Edit</button>
      <button onClick={onDelete} style={rowBtnStyle('#FFAB94')}>✕</button>
    </div>
  );
}

function SpecRow({ label, value }) {
  return (
    <>
      <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ fontSize: '12px', color: 'var(--text-primary)', fontWeight: 600, textAlign: 'right', fontFamily: 'var(--font-heading)' }}>{value}</div>
    </>
  );
}

function rowBtnStyle(color) {
  return {
    padding: '3px 8px', borderRadius: '4px', fontSize: '10px', cursor: 'pointer',
    border: `1px solid ${color}55`, background: `${color}11`, color, flexShrink: 0,
  };
}

const sectionTitleStyle = {
  fontSize: '11px', fontWeight: 800, color: 'var(--accent)',
  letterSpacing: '1.5px', textTransform: 'uppercase', marginBottom: '10px',
  borderLeft: '3px solid var(--yellow)', paddingLeft: '8px',
};

const labelStyle = {
  fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '8px', display: 'block',
  fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase',
};

const cardStyle = {
  background: 'var(--bg-card)', borderRadius: '12px', padding: '16px', border: '1px solid var(--border)',
  boxShadow: '0 2px 8px rgba(26,10,0,0.06)',
};

const specGridStyle = {
  display: 'grid', gridTemplateColumns: '1fr auto', gap: '6px 16px',
};
