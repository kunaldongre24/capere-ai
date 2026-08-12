import { cookies } from 'next/headers';
import { serverAccessToken } from './auth/session';

export async function capereFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await serverAccessToken();
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const organizationId = (await cookies()).get('capere-active-org')?.value;
  if (organizationId) headers.set('X-Organization-Id', organizationId);
  const response = await fetch(`${process.env.CAPERE_API_URL ?? 'http://localhost:3001'}${path}`, { ...init, headers, cache: 'no-store' });
  if (!response.ok) throw new Error(`Capere API request failed (${response.status})`);
  return response.json() as Promise<T>;
}

export type Envelope<T> = { data: T; meta: { requestId: string; timestamp: string } };
