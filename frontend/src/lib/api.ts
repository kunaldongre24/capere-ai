import { createSupabaseServerClient } from './supabase/server';
import { cookies } from 'next/headers';

export async function capereFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const supabase = await createSupabaseServerClient();
  const { data: { session } } = await supabase.auth.getSession();
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  if (session?.access_token) headers.set('Authorization', `Bearer ${session.access_token}`);
  const organizationId = (await cookies()).get('capere-active-org')?.value;
  if (organizationId) headers.set('X-Organization-Id', organizationId);
  const response = await fetch(`${process.env.CAPERE_API_URL ?? 'http://localhost:3001'}${path}`, { ...init, headers, cache: 'no-store' });
  if (!response.ok) throw new Error(`Capere API request failed (${response.status})`);
  return response.json() as Promise<T>;
}

export type Envelope<T> = { data: T; meta: { requestId: string; timestamp: string } };
