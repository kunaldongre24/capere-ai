import { NextRequest, NextResponse } from 'next/server';

export async function GET(request:NextRequest){
  const token=request.cookies.get('capere-seo-dashboard')?.value;
  if(!token)return NextResponse.json({error:{message:'Dashboard session is required'}},{status:401});
  const upstream=await fetch(`${process.env.CAPERE_API_URL??'http://localhost:3001'}/api/v1/dashboard-embeds/seo/summary`,{headers:{authorization:`Embed ${token}`},cache:'no-store'});
  return new NextResponse(upstream.body,{status:upstream.status,headers:{'content-type':upstream.headers.get('content-type')??'application/json','cache-control':'private, max-age=60'}});
}
