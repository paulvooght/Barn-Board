import { createClient } from '@supabase/supabase-js';

// Captured BEFORE the client is created: supabase-js reads and then clears the
// URL hash when it processes a password-reset link, and its PASSWORD_RECOVERY
// event can fire before App's auth listener is attached. This flag lets App
// show the "set new password" screen either way.
export const isRecoveryLink =
  typeof window !== 'undefined' && window.location.hash.includes('type=recovery');

// An expired/used email link comes back as #error=...&error_description=...
// Captured here for the same reason, so the login screen can explain it.
export const authLinkError = (() => {
  if (typeof window === 'undefined') return '';
  const params = new URLSearchParams(window.location.hash.slice(1));
  return params.get('error_description')?.replace(/\+/g, ' ') || '';
})();

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

export const ADMIN_EMAIL = import.meta.env.VITE_ADMIN_EMAIL || '';

export function storageUrl(bucket, path) {
  return `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/public/${bucket}/${path}`;
}
