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
  const tabs = sections.map(([label, key]) => ({ label, href: key === 'overview' ? '/seo' : `/seo?view=${key}`, active: view === key }));

  let content: React.ReactNode;
  if (view === 'technical') content = <EmptyState title="Technical SEO" body="Run a DataForSEO technical audit to populate health scores and prioritized issues." badge="Waiting for technical audit" />;
  else if (view === 'keywords') content = <EmptyState title="Keyword tracking" body="Connect a DataForSEO project or Search Console site to track rankings and search demand." />;
  else if (view === 'competitors') content = <EmptyState title="Competitor visibility" body="Competitor comparisons will appear after a DataForSEO project is configured." />;
  else if (view === 'gbp') content = <EmptyState title="Google Business Profile" body="Connect a GBP location to monitor ratings, reviews, calls, and directions." />;
  else if (view === 'recommendations') content = <EmptyState title="SEO recommendations" body="Recommendations will appear after synchronized SEO data produces actionable insights." badge="Waiting for provider data" />;
  else if (view === 'history') content = <EmptyState title="SEO history" body="Audit and ranking history will appear after the first completed provider run." badge="No completed runs yet" />;
  else content = <><div className="grid grid-4"><Stat label="Health score" value={String(d.healthScore ?? '—')} detail="Run an audit to calculate"/><Stat label="Tracked keywords" value={String(d.keywords ?? '—')} detail="DataForSEO project required"/><Stat label="Average position" value={String(d.averagePosition ?? '—')} detail="Search Console required"/><Stat label="GBP rating" value={String(d.rating ?? '—')} detail="Google Business Profile required"/></div><div className="grid grid-3" style={{ marginTop: 12 }}>{['Technical SEO', 'Keywords & competitors', 'Google Business Profile'].map((x) => <EmptyState key={x} title={x} body="This capability is available after its provider integration is connected." />)}</div></>;

  return <EmbeddedModule product="SEO Command Center" title="Search visibility, made actionable" description="Technical health, rankings, competitors, and local presence for your firm." tabs={tabs}>{content}</EmbeddedModule>;
}
