import { cookies } from 'next/headers';
import { createSupabaseServerClient } from '../supabase/server';

export async function serverAccessToken(): Promise<string | null> {
  if (process.env.AUTH_PROVIDER === 'firebase') {
    return (await cookies()).get('__session')?.value ?? null;
  }
  const supabase = await createSupabaseServerClient();
  return (await supabase.auth.getSession()).data.session?.access_token ?? null;
}
