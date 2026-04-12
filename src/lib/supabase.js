import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

export const ADMIN_EMAIL = import.meta.env.VITE_ADMIN_EMAIL || '';

export function storageUrl(bucket, path) {
  return `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/public/${bucket}/${path}`;
}
