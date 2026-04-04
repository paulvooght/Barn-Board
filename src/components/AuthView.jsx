import { useState, useRef, useCallback } from 'react';
import { supabase } from '../lib/supabase';

// Detect iOS PWA standalone mode
const isStandalone = window.navigator.standalone === true;

export default function AuthView() {
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [isSignUp, setIsSignUp] = useState(false);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');
  const [message, setMessage]   = useState('');
  const emailRef = useRef(null);
  const passRef = useRef(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setMessage('');

    const { error } = isSignUp
      ? await supabase.auth.signUp({ email, password })
      : await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      setError(error.message);
    } else if (isSignUp) {
      setMessage('Check your email to confirm your account, then log in.');
    }
    setLoading(false);
  };

  // iOS PWA standalone: readonly trick to force keyboard appearance
  const iosFocus = useCallback((ref) => (e) => {
    if (!isStandalone || !ref.current) return;
    e.preventDefault();
    const el = ref.current;
    el.setAttribute('readonly', 'readonly');
    el.focus();
    setTimeout(() => {
      el.removeAttribute('readonly');
      el.focus();
    }, 50);
  }, []);

  const input = {
    width: '100%', padding: '10px 14px', borderRadius: 8,
    border: '1.5px solid #e0d5cc', fontFamily: 'DM Sans, sans-serif',
    fontSize: 16, boxSizing: 'border-box',
    WebkitAppearance: 'none', appearance: 'none',
    background: 'white', color: '#1A0A00',
  };

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

        <form onSubmit={handleSubmit}>
          <label style={{ display: 'block', marginBottom: 12 }}
            onTouchEnd={iosFocus(emailRef)}>
            <input ref={emailRef} type="email" inputMode="email" autoComplete="email"
              placeholder="Email" value={email}
              onChange={e => setEmail(e.target.value)} required style={input} />
          </label>
          <label style={{ display: 'block', marginBottom: 20 }}
            onTouchEnd={iosFocus(passRef)}>
            <input ref={passRef} type="password" inputMode="text" autoComplete="current-password"
              placeholder="Password" value={password}
              onChange={e => setPassword(e.target.value)} required style={input} />
          </label>

          {error   && <div style={{ color: '#f87171', fontSize: 13, marginBottom: 10, fontFamily: 'DM Sans, sans-serif' }}>{error}</div>}
          {message && <div style={{ color: '#22a870', fontSize: 13, marginBottom: 10, fontFamily: 'DM Sans, sans-serif' }}>{message}</div>}

          <button type="submit" disabled={loading} style={{
            width: '100%', padding: '12px', background: '#0047FF', color: 'white',
            border: 'none', borderRadius: 8, fontFamily: 'DM Sans, sans-serif',
            fontWeight: 700, fontSize: 15, cursor: loading ? 'wait' : 'pointer',
          }}>
            {loading ? '...' : isSignUp ? 'Create Account' : 'Log In'}
          </button>
        </form>

        <div style={{ marginTop: 16, textAlign: 'center' }}>
          <button onClick={() => { setIsSignUp(!isSignUp); setError(''); setMessage(''); }}
            style={{ background: 'none', border: 'none', color: '#0047FF', fontFamily: 'DM Sans, sans-serif', fontSize: 13, cursor: 'pointer' }}>
            {isSignUp ? 'Already have an account? Log in' : 'Need an account? Sign up'}
          </button>
        </div>
      </div>
    </div>
  );
}
