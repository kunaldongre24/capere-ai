import { EmptyState, Page } from '@/components/page';
import { capereFetch } from '@/lib/api';

type Recommendation = { id: string; title: string; rationale: string; action: string; priority: string; status: string };

export default async function RecommendationsPage() {
  let recommendations: Recommendation[] = [];
  try { recommendations = (await capereFetch<{ data: Recommendation[] }>('/api/v1/recommendations')).data ?? []; } catch { /* auth/API errors render the empty state */ }
  return <Page eyebrow="Recommendations" title="Turn signals into approved action" subtitle="Every recommendation is reviewable, auditable, and approval-first.">
    {recommendations.length ? <div className="grid grid-2">{recommendations.map((item) => <article className="card recommendation-card" key={item.id}><div className="card-header"><div><div className="eyebrow">Recommended action</div><h2 className="card-title">{item.title}</h2></div><span className={`badge priority-${item.priority.toLowerCase()}`}>{item.priority}</span></div><p className="muted">{item.rationale}</p><div className="recommendation-action"><strong>Next step</strong><p>{item.action}</p></div><div className="recommendation-footer"><span className="badge">{item.status.replaceAll('_',' ')}</span></div></article>)}</div> : <EmptyState title="No recommendations yet" body="Recommendations will appear when your connected services identify a clear opportunity or an item that needs attention." badge="Monitoring your data" />}
  </Page>;
}
