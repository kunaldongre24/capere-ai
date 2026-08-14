import { NextRequest, NextResponse } from 'next/server';

type ExchangeResult={data?:{token?:string;customToken?:string;organizationId?:string;expiresInSeconds?:number};error?:unknown};
type SessionResult={data?:{sessionCookie?:string;expiresInSeconds?:number};error?:unknown};

export async function POST(request:NextRequest){
  const body=await request.json().catch(()=>null) as {key?:unknown}|null;
  if(!body||typeof body.key!=='string')return NextResponse.json({error:{message:'Dashboard key is required'}},{status:400});
  const upstream=await fetch(`${process.env.CAPERE_API_URL??'http://localhost:3001'}/api/v1/dashboard-embeds/seo/session`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:body.key}),cache:'no-store'});
  const result=await upstream.json().catch(()=>({})) as ExchangeResult;
  if(!upstream.ok||!result.data?.token)return NextResponse.json({error:result.error??{message:'Dashboard access could not be verified'}},{status:upstream.status||401});
  const response=NextResponse.json({data:{authenticated:true,destination:'/seo'}});
  response.cookies.set('capere-seo-dashboard',result.data.token,{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:process.env.NODE_ENV==='production'?'none':'lax',path:'/',maxAge:result.data.expiresInSeconds??3600});
  if(result.data.customToken&&result.data.organizationId&&process.env.FIREBASE_WEB_API_KEY){
    const tokenResponse=await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(process.env.FIREBASE_WEB_API_KEY)}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:result.data.customToken,returnSecureToken:true}),cache:'no-store'});
    const tokenBody=await tokenResponse.json().catch(()=>({})) as {idToken?:string};
    if(!tokenResponse.ok||!tokenBody.idToken)return NextResponse.json({error:{message:'Dashboard identity could not be created'}},{status:401});
    const sessionResponse=await fetch(`${process.env.CAPERE_API_URL??'http://localhost:3001'}/api/v1/auth/ghl-sso/session`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({idToken:tokenBody.idToken}),cache:'no-store'});
    const sessionBody=await sessionResponse.json().catch(()=>({})) as SessionResult;
    if(!sessionResponse.ok||!sessionBody.data?.sessionCookie)return NextResponse.json({error:sessionBody.error??{message:'Dashboard session could not be created'}},{status:sessionResponse.status||401});
    response.cookies.set('__session',sessionBody.data.sessionCookie,{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:process.env.NODE_ENV==='production'?'none':'lax',path:'/',maxAge:3600});
    response.cookies.set('capere-active-org',result.data.organizationId,{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:process.env.NODE_ENV==='production'?'none':'lax',path:'/',maxAge:3600});
  }
  return response;
}
