import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { CONSENT_TEXT, MAX_VIDEO_SECONDS, readVideoInfo, clampBoardAngle } from '../utils/routeVideos';
import { BOARD_SPECS } from '../utils/constants';

/**
 * AddVideoButton — "+ Add video" button, the pick-a-video sheet and the consent
 * pop-up. It uploads NOTHING itself: it hands { file, durationS, angle } to
 * onConsented once the climber has agreed, and the caller decides what to do.
 * The pop-up asks which board angle the video was climbed at (a slider).
 *
 * Steps: closed → menu → checking → (tooLong | consent) → closed.
 *
 * The two file inputs live HERE, always mounted (not inside the sheet): iOS can
 * lose the change event if an input leaves the DOM while the picker is open, and
 * .click() must happen synchronously inside the tap handler to count as a user
 * gesture.
 *
 * The sheet and the pop-up are portalled to document.body: the route carousel
 * wrapper has a CSS transform, which would make `position: fixed` relative to
 * the wrapper instead of the screen. data-no-swipe stops the carousel swipe
 * (React events bubble through portals), and clicks stop at the portal root so
 * they can't reach whatever the button is nested in.
 *
 * Props:
 *   onConsented({ file, durationS, angle }) – durationS is null when it couldn't be read
 *   defaultAngle                            – where the angle slider starts (number, or
 *                                             null/undefined); clamped to the wall's range, 30 if not a number
 *   minAngle, maxAngle                      – the active WALL's angle range (Yonder 12–45, The Barn
 *                                             18–55); default to the global BOARD_SPECS
 *   label                                   – button text
 *   style                                   – merged over the button's default style
 *
 * Also exports AngleSlider (label + big value + touch-sized slider), shared with
 * the "Change angle" editor in RouteVideos.
 */
export default function AddVideoButton({
  onConsented, defaultAngle, minAngle = BOARD_SPECS.minAngle, maxAngle = BOARD_SPECS.maxAngle,
  label = '+ Add video', style,
}) {
  const [step, setStep] = useState('closed'); // closed | menu | checking | tooLong | consent
  const [tooLongSeconds, setTooLongSeconds] = useState(0);
  const [picked, setPicked] = useState(null); // { file, durationS } waiting for consent
  const [angle, setAngle] = useState(() => clampBoardAngle(defaultAngle, minAngle, maxAngle)); // the slider in the consent pop-up
  const recordRef = useRef(null);
  const chooseRef = useRef(null);
  const checkRef = useRef(0); // bumped on cancel/unmount so a late duration check is ignored

  // No touch = a laptop: there is no camera to "record" with, so only offer files.
  const canRecord = !(typeof navigator !== 'undefined' && navigator.maxTouchPoints === 0);

  useEffect(() => () => { checkRef.current++; }, []);

  const close = () => {
    checkRef.current++;
    setPicked(null);
    setStep('closed');
  };

  const handleFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // so picking the same file again still fires a change
    if (!file) return;

    const token = ++checkRef.current;
    setStep('checking');
    let info = null;
    try { info = await readVideoInfo(file); } catch { info = null; } // it shouldn't throw; belt and braces
    if (token !== checkRef.current) return; // cancelled while checking

    // A null duration means "couldn't tell": let it through, the server and the
    // shrinker still enforce their own limits.
    const durationS = info && Number.isFinite(info.durationS) ? info.durationS : null;
    if (durationS !== null && durationS > MAX_VIDEO_SECONDS) {
      setTooLongSeconds(Math.ceil(durationS));
      setStep('tooLong');
      return;
    }
    setPicked({ file, durationS });
    setAngle(clampBoardAngle(defaultAngle, minAngle, maxAngle)); // start from the session / route angle each time
    setStep('consent');
  };

  const confirm = () => {
    const chosen = picked;
    close();
    if (chosen) onConsented({ ...chosen, angle });
  };

  return (
    <>
      <button type="button" onClick={() => setStep('menu')} style={{ ...buttonStyle, ...style }}>
        {label}
      </button>

      <input
        ref={recordRef} type="file" accept="video/*" capture="environment"
        onChange={handleFile} style={{ display: 'none' }} tabIndex={-1} aria-hidden="true"
      />
      <input
        ref={chooseRef} type="file" accept="video/*"
        onChange={handleFile} style={{ display: 'none' }} tabIndex={-1} aria-hidden="true"
      />

      {(step === 'menu' || step === 'checking' || step === 'tooLong') && (
        <Overlay align="bottom" onBackdrop={step === 'checking' ? undefined : close}>
          <div role="dialog" aria-modal="true" style={sheetStyle}>
            {step === 'menu' && (
              <>
                <div style={sheetTitleStyle}>Add a video</div>
                {canRecord && (
                  <button type="button" style={primaryBtn} onClick={() => recordRef.current && recordRef.current.click()}>
                    Record video
                  </button>
                )}
                <button
                  type="button"
                  style={canRecord ? secondaryBtn : primaryBtn}
                  onClick={() => chooseRef.current && chooseRef.current.click()}
                >
                  {canRecord ? 'Choose from phone' : 'Choose a file'}
                </button>
                <button type="button" style={cancelBtn} onClick={close}>Cancel</button>
              </>
            )}
            {step === 'checking' && (
              <>
                <div style={sheetTitleStyle}>Checking video…</div>
                <button type="button" style={cancelBtn} onClick={close}>Cancel</button>
              </>
            )}
            {step === 'tooLong' && (
              <>
                <div style={{ ...sheetTitleStyle, fontWeight: 600, lineHeight: 1.4 }}>
                  That clip is {tooLongSeconds} seconds. The limit is {MAX_VIDEO_SECONDS}, so trim it in your Photos app first.
                </div>
                <button type="button" style={primaryBtn} onClick={close}>OK</button>
              </>
            )}
          </div>
        </Overlay>
      )}

      {step === 'consent' && picked && (
        <Overlay align="center">
          <ConsentDialog
            file={picked.file} angle={angle} minAngle={minAngle} maxAngle={maxAngle}
            onAngleChange={setAngle} onCancel={close} onConfirm={confirm}
          />
        </Overlay>
      )}
    </>
  );
}

// Full-screen dimmed layer rendered straight into <body>.
function Overlay({ children, align, onBackdrop }) {
  return createPortal(
    <div
      data-no-swipe
      onClick={(e) => {
        e.stopPropagation();
        if (onBackdrop && e.target === e.currentTarget) onBackdrop();
      }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(26,10,0,0.55)',
        display: 'flex', justifyContent: 'center',
        alignItems: align === 'bottom' ? 'flex-end' : 'center',
        padding: '16px 16px calc(16px + env(safe-area-inset-bottom))', boxSizing: 'border-box',
      }}
    >
      {children}
    </div>,
    document.body
  );
}

// Preview + the consent wording. Owns the preview's object URL so it is revoked
// the moment the pop-up closes.
function ConsentDialog({ file, angle, minAngle, maxAngle, onAngleChange, onCancel, onConfirm }) {
  const [url, setUrl] = useState(null);
  const [previewFailed, setPreviewFailed] = useState(false);

  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    setPreviewFailed(false);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  return (
    <div role="dialog" aria-modal="true" style={{ ...sheetStyle, maxHeight: 'calc(100dvh - 32px)', overflowY: 'auto' }}>
      {previewFailed ? (
        <div style={{
          padding: '18px 12px', borderRadius: '8px', background: 'rgba(26,10,0,0.06)',
          fontSize: '13px', color: 'var(--text-secondary)', textAlign: 'center', wordBreak: 'break-all',
        }}>
          {file.name || 'Your video'}
        </div>
      ) : url ? (
        <video
          src={`${url}#t=0.001`} controls playsInline preload="metadata"
          onError={() => setPreviewFailed(true)}
          style={{ width: '100%', maxHeight: '40vh', background: '#000', borderRadius: '8px', display: 'block' }}
        />
      ) : null}

      <div style={{ marginTop: '12px' }}>
        <AngleSlider value={angle} onChange={onAngleChange} min={minAngle} max={maxAngle} />
      </div>

      <h2 style={{
        margin: '14px 0 14px', fontSize: '16px', fontWeight: 700, lineHeight: 1.35,
        color: '#1A0A00', fontFamily: 'var(--font-body)',
      }}>
        {CONSENT_TEXT}
      </h2>

      <div style={{ display: 'flex', gap: '10px' }}>
        <button type="button" style={{ ...cancelBtn, flex: 1, marginTop: 0 }} onClick={onCancel}>Cancel</button>
        <button type="button" style={{ ...primaryBtn, flex: 2, marginTop: 0 }} onClick={onConfirm}>I consent, upload</button>
      </div>
    </div>
  );
}

// "Angle climbed at   35°" + a 44px-tall slider + the slab / steep end labels.
// Used in the consent pop-up and in the "Change angle" editor on a saved video.
export function AngleSlider({ value, onChange, min = BOARD_SPECS.minAngle, max = BOARD_SPECS.maxAngle }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px' }}>
        <span style={{ fontSize: '13px', fontWeight: 700, color: '#1A0A00' }}>Angle climbed at</span>
        <span style={{ fontFamily: 'var(--font-heading)', fontSize: '18px', fontWeight: 800, color: 'var(--accent)' }}>
          {value}°
        </span>
      </div>
      <input
        type="range" className="range-touch" aria-label="Angle climbed at"
        min={min} max={max} step={1} value={value}
        aria-valuetext={`${value} degrees`}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
      />
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)',
      }}>
        <span>{min}° slab</span>
        <span>{max}° steep</span>
      </div>
    </div>
  );
}

const buttonStyle = {
  padding: '0 14px', minHeight: '44px', borderRadius: '8px',
  border: '1.5px solid var(--accent)', background: 'var(--accent-dim)', color: 'var(--accent)',
  fontSize: '12px', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
};

const sheetStyle = {
  width: '100%', maxWidth: '440px', boxSizing: 'border-box',
  background: '#fff', color: '#1A0A00', borderRadius: '14px', padding: '16px',
  boxShadow: '0 8px 30px rgba(26,10,0,0.3)',
};

const sheetTitleStyle = {
  fontSize: '15px', fontWeight: 700, color: '#1A0A00', marginBottom: '12px', textAlign: 'center',
};

const baseBtn = {
  display: 'block', width: '100%', minHeight: '48px', padding: '0 14px', marginTop: '8px',
  borderRadius: '10px', fontSize: '15px', fontWeight: 700, cursor: 'pointer', boxSizing: 'border-box',
};
const primaryBtn = { ...baseBtn, border: 'none', background: 'var(--accent)', color: '#fff' };
const secondaryBtn = { ...baseBtn, border: '1.5px solid var(--accent)', background: 'var(--accent-dim)', color: 'var(--accent)' };
const cancelBtn = { ...baseBtn, border: '1px solid rgba(26,10,0,0.15)', background: 'rgba(26,10,0,0.06)', color: 'var(--text-secondary)' };
