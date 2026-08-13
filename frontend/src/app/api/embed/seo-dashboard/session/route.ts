import { NextRequest, NextResponse } from 'next/server';

export async function POST(request:NextRequest){
  const body=await request.json().catch(()=>null) as {key?:unknown}|null;
  if(!body||typeof body.key!=='string')return NextResponse.json({error:{message:'Dashboard key is required'}},{status:400});
  const upstream=await fetch(`${process.env.CAPERE_API_URL??'http://localhost:3001'}/api/v1/dashboard-embeds/seo/session`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:body.key}),cache:'no-store'});
  const result=await upstream.json().catch(()=>({})) as {data?:{token?:string;expiresInSeconds?:number};error?:unknown};
  if(!upstream.ok||!result.data?.token)return NextResponse.json({error:result.error??{message:'Dashboard access could not be verified'}},{status:upstream.status||401});
  const response=NextResponse.json({data:{authenticated:true}});
  response.cookies.set('capere-seo-dashboard',result.data.token,{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:process.env.NODE_ENV==='production'?'none':'lax',path:'/embed/seo-dashboard',maxAge:result.data.expiresInSeconds??3600});
  return response;
}
