'use server';
import { redirect } from 'next/navigation'; import { createSupabaseServerClient } from '@/lib/supabase/server';

function safeReturnPath(value: FormDataEntryValue | null) {
  const path = String(value ?? '');
  return path.startsWith('/') && !path.startsWith('//') ? path : '/auth/continue';
}

export async function login(formData:FormData){
  const supabase=await createSupabaseServerClient();
  const email=String(formData.get('email')??'');
  const password=String(formData.get('password')??'');
  const next=safeReturnPath(formData.get('next'));
  const {error}=await supabase.auth.signInWithPassword({email,password});
  if(error)redirect(`/login?error=credentials&next=${encodeURIComponent(next)}`);
  redirect(next);
}
