'use server';

import { redirect } from 'next/navigation';
import { capereFetch } from '@/lib/api';

export async function createFirm(formData: FormData) {
  const name = String(formData.get('name') ?? '').trim();
  const slug = String(formData.get('slug') ?? '').trim().toLowerCase();
  if (!name || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) redirect('/onboarding?error=validation');

  try {
    await capereFetch('/api/v1/organizations', { method: 'POST', body: JSON.stringify({ name, slug }) });
  } catch {
    redirect('/onboarding?error=create');
  }
  redirect('/');
}
