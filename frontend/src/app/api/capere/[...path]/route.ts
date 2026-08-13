import { NextRequest, NextResponse } from 'next/server';
import { serverAccessToken } from '@/lib/auth/session';

type ProxyContext = { params: Promise<{ path: string[] }> };

async function proxy(request: NextRequest, { params }: ProxyContext) {
  const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
  const origin = request.headers.get('origin');
  if (unsafe && origin && origin !== request.nextUrl.origin) {
    return NextResponse.json(
      { error: { code: 'FORBIDDEN', message: 'Cross-origin request rejected' } },
      { status: 403 },
    );
  }

  const { path } = await params;
  const token = await serverAccessToken();
  if (!token) {
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
      { status: 401 },
    );
  }

  const headers = new Headers();
  headers.set('authorization', `Bearer ${token}`);
  headers.set('content-type', request.headers.get('content-type') ?? 'application/json');
  const organizationId = request.cookies.get('capere-active-org')?.value;
  if (organizationId) headers.set('x-organization-id', organizationId);

  const body = ['GET', 'HEAD'].includes(request.method)
    ? undefined
    : await request.arrayBuffer();
  const upstream = await fetch(
    `${process.env.CAPERE_API_URL ?? 'http://localhost:3001'}/api/v1/${path.join('/')}${new URL(request.url).search}`,
    { method: request.method, headers, body, cache: 'no-store' },
  );
  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  });
}

export const GET = proxy;
export const POST = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
