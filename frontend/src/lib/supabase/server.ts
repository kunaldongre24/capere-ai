import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { CookieOptions } from '@supabase/ssr';

type CookieToSet = { name: string; value: string; options: CookieOptions };

const iframeCookieOptions = (options: CookieOptions): CookieOptions =>
  process.env.NODE_ENV === 'production' ? { ...options, sameSite: 'none', secure: true } : options;

export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: { getAll: () => cookieStore.getAll(), setAll: (values: CookieToSet[]) => values.forEach(({ name, value, options }) => cookieStore.set(name, value, iframeCookieOptions(options))) },
  });
}
