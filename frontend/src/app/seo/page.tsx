import { Stat, EmptyState } from '@/components/page';
import { EmbeddedModule } from '@/components/embedded-module';
import { capereFetch, Envelope } from '@/lib/api';

const sections = [
  ['Overview', 'overview'], ['Technical SEO', 'technical'], ['Keywords', 'keywords'],
  ['Competitors', 'competitors'], ['GBP', 'gbp'], ['Recommendations', 'recommendations'], ['History', 'history'],
] as const;

export default async function SeoPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const view = (await searchParams).view ?? 'overview';
  let summary: Envelope<Record<string, unknown>> | null = null;
  try { summary = await capereFetch('/api/v1/command-centers/seo-command-center/summary'); } catch { /* render available empty states */ }
  const d = summary?.data ?? {};
  const metricRows = Array.isArray(d.metrics) ? d.metrics as Array<{ metric_name?: string; metric_value?: string }> : [];
  const metric = (name: string) => metricRows.find((row) => row.metric_name === name)?.metric_value;
  const clicks = metric('clicks');
  const impressions = metric('impressions');
  const position = metric('position');
  const audit = d.technicalAudit && typeof d.technicalAudit === 'object'
    ? d.technicalAudit as { score?: number; issue_count?: number; completed_at?: string; site_url?: string }
    : null;
  const recommendations = Array.isArray(d.recommendations) ? d.recommendations as Array<{ id?: string; title?: string; action?: string; priority?: string }> : [];
  const tabs = sections.map(([label, key]) => ({ label, href: key === 'overview' ? '/seo' : `/seo?view=${key}`, active: view === key }));

  let content: React.ReactNode;
  if (view === 'technical') content = audit
    ? <><div className="grid grid-3"><Stat label="Technical health" value={String(audit.score ?? '—')} detail="Latest DataForSEO audit"/><Stat label="Issues found" value={String(audit.issue_count ?? 0)} detail="Prioritized crawl checks"/><Stat label="Website" value={audit.site_url ?? 'Configured'} detail={audit.completed_at ? `Completed ${new Date(audit.completed_at).toLocaleString()}` : 'Audit completed'}/></div></>
    : <EmptyState title="Technical SEO" body="Run a DataForSEO technical audit to populate health scores and prioritized issues." badge="Waiting for technical audit" />;
  else if (view === 'keywords') content = <EmptyState title="Keyword tracking" body="Search Console is connected. Keyword history will appear after enough query data is available; DataForSEO adds rank tracking and competitive terms." badge="GSC connected — collecting data" />;
  else if (view === 'competitors') content = <EmptyState title="Competitor visibility" body="Competitor comparisons will appear after a DataForSEO project is configured." />;
  else if (view === 'gbp') content = <EmptyState title="Google Business Profile" body="Connect a GBP location to monitor ratings, reviews, calls, and directions." />;
  else if (view === 'recommendations') content = recommendations.length > 0
    ? <div className="grid">{recommendations.map((item, index) => <div className="card" key={item.id ?? index}><div className="eyebrow">{item.priority ?? 'SEO recommendation'}</div><h3>{item.title}</h3><p>{item.action}</p></div>)}</div>
    : <EmptyState title="SEO recommendations" body="The audit is complete. Recommendations will appear after the insight worker identifies actionable issues." badge={audit ? 'Audit complete — processing insights' : 'Waiting for provider data'} />;
  else if (view === 'history') content = audit
    ? <div className="card"><div className="eyebrow">Completed audit</div><h3>{audit.site_url}</h3><p>Technical health: {audit.score ?? '—'} · Issues: {audit.issue_count ?? 0}</p><p>{audit.completed_at ? new Date(audit.completed_at).toLocaleString() : ''}</p></div>
    : <EmptyState title="SEO history" body="Audit and ranking history will appear after the first completed provider run." badge="No completed runs yet" />;
  else content = <><div className="grid grid-4"><Stat label="Organic clicks" value={clicks ?? '—'} detail={clicks !== undefined ? 'Search Console synced' : 'Awaiting metric refresh'}/><Stat label="Impressions" value={impressions ?? '—'} detail={impressions !== undefined ? 'Search Console synced' : 'Awaiting metric refresh'}/><Stat label="Average position" value={position ?? '—'} detail={position !== undefined ? 'Search Console synced' : 'Awaiting metric refresh'}/><Stat label="Technical health" value={String(audit?.score ?? '—')} detail={audit ? `${audit.issue_count ?? 0} issues found` : 'Run a DataForSEO audit'}/></div><div className="grid grid-3" style={{ marginTop: 12 }}>{audit ? <div className="card"><div className="eyebrow">Audit complete</div><h3>Technical SEO</h3><p>Health score {audit.score ?? '—'} with {audit.issue_count ?? 0} detected issues.</p></div> : <EmptyState title="Technical SEO" body="Run a DataForSEO technical audit to populate health scores and prioritized issues." badge="Audit required"/>}<EmptyState title="Keywords & competitors" body="Search Console is connected and collecting query data." badge="GSC connected"/><EmptyState title="Google Business Profile" body="Connect a GBP location to monitor ratings, reviews, calls, and directions." badge="GBP not connected"/></div></>;

  return <EmbeddedModule product="SEO Command Center" title="Search visibility, made actionable" description="Technical health, rankings, competitors, and local presence for your firm." tabs={tabs}>{content}</EmbeddedModule>;
}
