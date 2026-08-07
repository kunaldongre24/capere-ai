import { redirect } from 'next/navigation';
import { capereFetch, type Envelope } from '@/lib/api';
import { createFirm } from './actions';

type Membership = { id: string };

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const result = await capereFetch<Envelope<Membership[]>>('/api/v1/organizations/mine');
  if (result.data.length > 0) redirect('/');
  const { error } = await searchParams;
  return <div className="auth-page"><div className="card auth-card onboarding-card"><div style={{display:'flex',alignItems:'center',marginBottom:28}}><div className="brand-mark">C</div><div className="brand">Capere <span>AI</span></div></div><div className="eyebrow">Workspace setup</div><h1 className="title">Create your firm</h1><p className="subtitle">This creates your Capere organization and assigns you as its owner. You can invite your team afterward.</p>{error&&<p className="form-error">{error==='validation'?'Enter a valid firm name and workspace URL.':'The workspace could not be created. The URL may already be in use.'}</p>}<form action={createFirm} className="grid"><label>Firm name<input name="name" required maxLength={200} placeholder="Example CPA Advisors" className="form-input"/></label><label>Workspace URL<input name="slug" required minLength={2} maxLength={63} pattern="[a-z0-9][a-z0-9-]{1,62}" placeholder="example-cpa" className="form-input"/><span className="field-help">Lowercase letters, numbers, and hyphens only.</span></label><button className="btn" type="submit">Create workspace</button></form></div></div>;
}
