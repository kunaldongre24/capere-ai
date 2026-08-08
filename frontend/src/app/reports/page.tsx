import { EmptyState, Page } from '@/components/page';
import { capereFetch } from '@/lib/api';

type Report = { title: string; period_start: string; period_end: string; content: string; generated_at: string };

export default async function Reports() {
  let report: Report | null = null;
  try { report = (await capereFetch<{ data: Report | null }>('/api/v1/command-centers/reports/latest')).data; } catch { /* auth/API errors render the empty state */ }
  return <Page eyebrow="Executive reporting" title="Reports your leadership can use" subtitle="Precomputed reporting models are designed for Looker Studio and weekly executive reviews.">
    {report ? <div className="card"><div className="eyebrow">{report.period_start} – {report.period_end}</div><h2 className="card-title">{report.title}</h2><pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', lineHeight: 1.6 }}>{report.content}</pre></div> : <EmptyState title="No reports generated" body="The weekly report worker will publish the first report after analytics data is available." badge="Waiting for provider data" />}
  </Page>;
}
