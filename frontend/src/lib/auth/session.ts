import { cookies } from 'next/headers';
import { firebaseAdminAuth } from '../firebase/admin';
import { createSupabaseServerClient } from '../supabase/server';

export async function serverAccessToken(): Promise<string | null> {
  if (process.env.AUTH_PROVIDER === 'firebase') {
    const value = (await cookies()).get('__session')?.value;
    if (!value) return null;
    try { await firebaseAdminAuth().verifySessionCookie(value, true); return value; } catch { return null; }
  }
  const supabase = await createSupabaseServerClient();
  return (await supabase.auth.getSession()).data.session?.access_token ?? null;
}
