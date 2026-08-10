import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

type ExchangeResponse = { data?: { tokenHash?: string; organizationId?: string }; error?: { code?: string; message?: string } };

export async function POST(request: NextRequest) {
  const payload = (await request.json().catch(() => null)) as { encryptedData?: unknown } | null;
  if (!payload || typeof payload.encryptedData !== 'string') return NextResponse.json({ error: { code: 'VALIDATION_FAILED', message: 'Encrypted GHL context is required' } }, { status: 400 });
  const upstream = await fetch(`${process.env.CAPERE_API_URL ?? 'http://localhost:3001'}/api/v1/auth/ghl-sso/exchange`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ encryptedData: payload.encryptedData }), cache: 'no-store',
  });
  const result = (await upstream.json().catch(() => ({}))) as ExchangeResponse;
  if (!upstream.ok || !result.data?.tokenHash || !result.data.organizationId) return NextResponse.json({ error: result.error ?? { code: 'SSO_FAILED', message: 'GHL authentication failed' } }, { status: upstream.status || 502 });
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.verifyOtp({ token_hash: result.data.tokenHash, type: 'magiclink' });
  if (error) return NextResponse.json({ error: { code: 'SSO_SESSION_FAILED', message: 'A Capere session could not be created' } }, { status: 401 });
  const response = NextResponse.json({ data: { authenticated: true } });
  response.cookies.set('capere-active-org', result.data.organizationId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    path: '/',
    maxAge: 60 * 60 * 8,
  });
  return response;
}
