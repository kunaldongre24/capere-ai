import { EmptyState, Page } from '@/components/page';
import { capereFetch } from '@/lib/api';

type Recommendation = { id: string; title: string; rationale: string; action: string; priority: string; status: string };

export default async function RecommendationsPage() {
  let recommendations: Recommendation[] = [];
  try { recommendations = (await capereFetch<{ data: Recommendation[] }>('/api/v1/recommendations')).data ?? []; } catch { /* auth/API errors render the empty state */ }
  return <Page eyebrow="Recommendations" title="Turn signals into approved action" subtitle="Every recommendation is reviewable, auditable, and approval-first.">
    {recommendations.length ? <div className="grid grid-2">{recommendations.map((item) => <article className="card" key={item.id}><div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}><h2 className="card-title">{item.title}</h2><span className="badge">{item.priority}</span></div><p className="muted">{item.rationale}</p><p><strong>Next action:</strong> {item.action}</p><span className="badge">{item.status}</span></article>)}</div> : <EmptyState title="No recommendations yet" body="Recommendations will appear after synchronized provider data produces actionable insights." badge="Waiting for provider data" />}
  </Page>;
}
