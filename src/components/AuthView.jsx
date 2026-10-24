import { useState } from 'react';
import { supabase, authLinkError } from '../lib/supabase';

// mode: 'login' | 'signup' | 'forgot' (request a reset email).
// recovery=true: the user arrived from a reset-email link and is already signed
// in — show only "choose a new password" (no old password needed).
export default function AuthView({ recovery = false, onRecoveryDone }) {
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm]   = useState('');
  const [mode, setMode]         = useState('login');
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState(
    authLinkError ? `That email link didn't work (${authLinkError}). Request a new one below.` : ''
  );
  const [message, setMessage]   = useState('');
  const [revealPw, setRevealPw] = useState(false);

  const switchMode = (m) => { setMode(m); setError(''); setMessage(''); };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setMessage('');

    if (recovery) {
      if (password.length < 6) { setError('Password must be at least 6 characters.'); return; }
      if (password !== confirm) { setError("Passwords don't match."); return; }
      setLoading(true);
      const { error } = await supabase.auth.updateUser({ password });
      setLoading(false);
      if (error) setError(error.message);
      else onRecoveryDone?.();
      return;
    }

    setLoading(true);
    let result;
    if (mode === 'forgot') {
      // Supabase emails a one-time link back to this site; opening it signs the
      // user in and fires PASSWORD_RECOVERY (handled in App.jsx).
      result = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin,
      });
    } else if (mode === 'signup') {
      result = await supabase.auth.signUp({ email, password });
    } else {
      result = await supabase.auth.signInWithPassword({ email, password });
    }

    if (result.error) {
      setError(result.error.message);
    } else if (mode === 'signup') {
      setMessage('Check your email to confirm your account, then log in.');
    } else if (mode === 'forgot') {
      setMessage('If that email has an account, a reset link is on its way. Open it on this device.');
    }
    setLoading(false);
  };

  const linkBtn = { background: 'none', border: 'none', color: '#0047FF', fontFamily: 'DM Sans, sans-serif', fontSize: 13, cursor: 'pointer', padding: 6 };
  const showEmail    = !recovery;
  const showPassword = recovery || mode !== 'forgot';
  const submitLabel  = recovery ? 'Set New Password'
    : mode === 'forgot' ? 'Send Reset Link'
    : mode === 'signup' ? 'Create Account' : 'Log In';

  const input = {
    width: '100%', padding: '10px 14px', borderRadius: 8,
    border: '1.5px solid #e0d5cc', fontFamily: 'DM Sans, sans-serif',
    fontSize: 16, boxSizing: 'border-box',
  };
  // Password inputs leave room on the right for the show/hide eye button.
  const pwInput = { ...input, paddingRight: 48 };
  const pwType = revealPw ? 'text' : 'password';

  // Eye button sitting inside the password field — toggles plain-text display.
  const revealBtn = (
    <button type="button" onClick={() => setRevealPw(v => !v)}
      aria-label={revealPw ? 'Hide password' : 'Show password'}
      aria-pressed={revealPw}
      style={{
        position: 'absolute', right: 2, top: '50%', transform: 'translateY(-50%)',
        width: 44, height: 44, background: 'none', border: 'none', padding: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: revealPw ? '#0047FF' : '#998877', cursor: 'pointer',
      }}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
        <circle cx="12" cy="12" r="3" />
        {!revealPw && <line x1="3" y1="3" x2="21" y2="21" />}
      </svg>
    </button>
  );

  return (
    <div style={{
      minHeight: '100dvh', background: '#FFAB94',
      paddingTop: '30vh', paddingLeft: 20, paddingRight: 20, paddingBottom: 20,
    }}>
      <div style={{
        background: 'white', borderRadius: 16, padding: '32px 24px',
        width: '100%', maxWidth: 360, margin: '0 auto',
        boxShadow: '0 4px 24px rgba(0,0,0,0.08)',
      }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{ fontFamily: "'Kodchasan', sans-serif", fontWeight: 700, fontSize: 22, color: '#0047FF', letterSpacing: 1 }}>
            BARN BOARD
          </div>
          <div style={{ fontFamily: 'DM Sans, sans-serif', fontSize: 12, color: '#888', marginTop: 2, letterSpacing: 1 }}>
            ROUTE LOGGER
          </div>
        </div>

        {(recovery || mode === 'forgot') && (
          <div style={{ fontFamily: 'DM Sans, sans-serif', fontSize: 13, color: '#555', marginBottom: 14, textAlign: 'center' }}>
            {recovery ? 'Choose a new password.' : "Enter your email and we'll send you a link to reset your password."}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          {showEmail && (
            <div style={{ marginBottom: 12 }}>
              <input type="email" autoComplete="email"
                placeholder="Email" value={email}
                onChange={e => setEmail(e.target.value)} required style={input} />
            </div>
          )}
          {showPassword && (
            <div style={{ marginBottom: recovery ? 12 : 20, position: 'relative' }}>
              <input type={pwType}
                autoComplete={recovery || mode === 'signup' ? 'new-password' : 'current-password'}
                placeholder={recovery ? 'New password (min 6 chars)' : 'Password'} value={password}
                onChange={e => setPassword(e.target.value)} required style={pwInput} />
              {revealBtn}
            </div>
          )}
          {recovery && (
            <div style={{ marginBottom: 20 }}>
              <input type={pwType} autoComplete="new-password"
                placeholder="Confirm new password" value={confirm}
                onChange={e => setConfirm(e.target.value)} required style={pwInput} />
            </div>
          )}

          {error   && <div style={{ color: '#f87171', fontSize: 13, marginBottom: 10, fontFamily: 'DM Sans, sans-serif' }}>{error}</div>}
          {message && <div style={{ color: '#22a870', fontSize: 13, marginBottom: 10, fontFamily: 'DM Sans, sans-serif' }}>{message}</div>}

          <button type="submit" disabled={loading} style={{
            width: '100%', padding: '12px', background: '#0047FF', color: 'white',
            border: 'none', borderRadius: 8, fontFamily: 'DM Sans, sans-serif',
            fontWeight: 700, fontSize: 15, cursor: loading ? 'wait' : 'pointer',
          }}>
            {loading ? '...' : submitLabel}
          </button>
        </form>

        {!recovery && (
          <div style={{ marginTop: 16, textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {mode === 'login' && (
              <button type="button" onClick={() => switchMode('forgot')} style={linkBtn}>
                Forgot password?
              </button>
            )}
            <button type="button" onClick={() => switchMode(mode === 'login' ? 'signup' : 'login')} style={linkBtn}>
              {mode === 'login' ? 'Need an account? Sign up' : 'Back to log in'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
