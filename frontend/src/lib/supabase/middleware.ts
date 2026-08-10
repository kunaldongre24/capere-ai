import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import type { CookieOptions } from '@supabase/ssr';

type CookieToSet = { name: string; value: string; options: CookieOptions };

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });
  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (values: CookieToSet[]) => { values.forEach(({name,value}) => request.cookies.set(name,value)); response=NextResponse.next({request}); values.forEach(({name,value,options})=>response.cookies.set(name,value,options)); },
    },
  });
  const { data: { user } } = await supabase.auth.getUser();
  const publicPath = request.nextUrl.pathname.startsWith('/login') || request.nextUrl.pathname.startsWith('/auth/');
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
