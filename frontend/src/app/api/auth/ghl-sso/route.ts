import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

type ExchangeResponse = { data?: { tokenHash?: string; customToken?: string; organizationId?: string }; error?: { code?: string; message?: string } };
type FirebaseSessionResponse = { data?: { sessionCookie?: string; expiresInSeconds?: number }; error?: { code?: string; message?: string } };

export async function POST(request: NextRequest) {
  const payload = (await request.json().catch(() => null)) as { encryptedData?: unknown } | null;
  if (!payload || typeof payload.encryptedData !== 'string') return NextResponse.json({ error: { code: 'VALIDATION_FAILED', message: 'Encrypted GHL context is required' } }, { status: 400 });
  const upstream = await fetch(`${process.env.CAPERE_API_URL ?? 'http://localhost:3001'}/api/v1/auth/ghl-sso/exchange`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ encryptedData: payload.encryptedData }), cache: 'no-store',
  });
  const result = (await upstream.json().catch(() => ({}))) as ExchangeResponse;
  if (!upstream.ok || !result.data?.organizationId) return NextResponse.json({ error: result.error ?? { code: 'SSO_FAILED', message: 'GHL authentication failed' } }, { status: upstream.status || 502 });
  const response = NextResponse.json({ data: { authenticated: true } });
  if (process.env.AUTH_PROVIDER === 'firebase') {
    if (!result.data.customToken || !process.env.FIREBASE_WEB_API_KEY) return NextResponse.json({ error: { code: 'SSO_SESSION_FAILED', message: 'Firebase authentication is not configured' } }, { status: 503 });
    const tokenResponse = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(process.env.FIREBASE_WEB_API_KEY)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: result.data.customToken, returnSecureToken: true }), cache: 'no-store' });
    const tokenBody = await tokenResponse.json().catch(() => ({})) as { idToken?: string };
    if (!tokenResponse.ok || !tokenBody.idToken) return NextResponse.json({ error: { code: 'SSO_SESSION_FAILED', message: 'A Firebase session could not be created' } }, { status: 401 });
    const sessionResponse = await fetch(`${process.env.CAPERE_API_URL ?? 'http://localhost:3001'}/api/v1/auth/ghl-sso/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken: tokenBody.idToken }), cache: 'no-store',
    });
    const sessionBody = await sessionResponse.json().catch(() => ({})) as FirebaseSessionResponse;
    if (!sessionResponse.ok || !sessionBody.data?.sessionCookie) return NextResponse.json({ error: sessionBody.error ?? { code: 'SSO_SESSION_FAILED', message: 'A Firebase session could not be created' } }, { status: sessionResponse.status || 401 });
    response.cookies.set('__session', sessionBody.data.sessionCookie, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax', path: '/', maxAge: sessionBody.data.expiresInSeconds ?? 60 * 60 * 8 });
  } else {
    if (!result.data.tokenHash) return NextResponse.json({ error: { code: 'SSO_SESSION_FAILED', message: 'Supabase authentication is not configured' } }, { status: 503 });
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.verifyOtp({ token_hash: result.data.tokenHash, type: 'magiclink' });
    if (error) return NextResponse.json({ error: { code: 'SSO_SESSION_FAILED', message: 'A Capere session could not be created' } }, { status: 401 });
  }
  response.cookies.set('capere-active-org', result.data.organizationId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    path: '/',
    maxAge: 60 * 60 * 8,
  });
  return response;
}
