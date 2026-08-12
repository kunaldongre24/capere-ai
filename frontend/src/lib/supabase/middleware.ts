import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import type { CookieOptions } from '@supabase/ssr';

type CookieToSet = { name: string; value: string; options: CookieOptions };

const iframeCookieOptions = (options: CookieOptions): CookieOptions =>
  process.env.NODE_ENV === 'production' ? { ...options, sameSite: 'none', secure: true } : options;

export async function updateSession(request: NextRequest) {
  if (process.env.AUTH_PROVIDER === 'firebase') {
    const authenticated = Boolean(request.cookies.get('__session')?.value);
    const publicPath = request.nextUrl.pathname.startsWith('/login') || request.nextUrl.pathname.startsWith('/auth/') || request.nextUrl.pathname.startsWith('/embed/') || request.nextUrl.pathname === '/api/auth/ghl-sso';
    if (!authenticated && !publicPath) {
      const url=request.nextUrl.clone(); url.pathname='/login'; url.search=''; url.searchParams.set('next',`${request.nextUrl.pathname}${request.nextUrl.search}`); return NextResponse.redirect(url);
    }
    if (authenticated && request.nextUrl.pathname==='/login') { const url=request.nextUrl.clone(); url.pathname='/auth/continue'; return NextResponse.redirect(url); }
    return NextResponse.next({ request });
  }
  let response = NextResponse.next({ request });
  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (values: CookieToSet[]) => { values.forEach(({name,value}) => request.cookies.set(name,value)); response=NextResponse.next({request}); values.forEach(({name,value,options})=>response.cookies.set(name,value,iframeCookieOptions(options))); },
    },
  });
  const { data: { user } } = await supabase.auth.getUser();
  const publicPath = request.nextUrl.pathname.startsWith('/login') || request.nextUrl.pathname.startsWith('/auth/') || request.nextUrl.pathname.startsWith('/embed/') || request.nextUrl.pathname === '/api/auth/ghl-sso';
  if (!user && !publicPath) {
    const url=request.nextUrl.clone();
    const returnTo=`${request.nextUrl.pathname}${request.nextUrl.search}`;
    url.pathname='/login';
    url.search='';
    url.searchParams.set('next',returnTo);
    return NextResponse.redirect(url);
  }
  if (user && request.nextUrl.pathname==='/login') { const url=request.nextUrl.clone(); url.pathname='/auth/continue'; return NextResponse.redirect(url); }
  return response;
}
