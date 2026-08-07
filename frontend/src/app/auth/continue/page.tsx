import { redirect } from 'next/navigation';
import { capereFetch, type Envelope } from '@/lib/api';

type Membership = { id: string; name: string; slug: string; role: string };

export default async function ContinuePage() {
  try {
    const result = await capereFetch<Envelope<Membership[]>>('/api/v1/organizations/mine');
    redirect(result.data.length === 0 ? '/onboarding' : '/');
  } catch (error) {
    if (error && typeof error === 'object' && 'digest' in error) throw error;
    redirect('/login?error=session');
  }
}
