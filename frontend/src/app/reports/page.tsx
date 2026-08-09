import { EmptyState, Page } from '@/components/page';
import { capereFetch } from '@/lib/api';

type Report = { title: string; period_start: string; period_end: string; content: string; generated_at: string };

export default async function Reports() {
  let report: Report | null = null;
  try { report = (await capereFetch<{ data: Report | null }>('/api/v1/command-centers/reports/latest')).data; } catch { /* auth/API errors render the empty state */ }
  return <Page eyebrow="Executive reporting" title="Reports your leadership can use" subtitle="Precomputed reporting models are designed for Looker Studio and weekly executive reviews.">
    {report ? <div className="report-layout"><div className="card report-hero"><div><div className="eyebrow">Weekly executive report · {report.period_start} – {report.period_end}</div><h2 className="card-title">{report.title}</h2><p className="muted">A plain-language summary of visibility, customer activity, and recommended next steps.</p></div><span className="badge">Ready to review</span></div><div className="card report-body"><pre>{report.content}</pre></div></div> : <div className="report-layout"><div className="grid grid-3"><div className="card report-placeholder"><div className="metric-label">Search visibility</div><div className="metric">—</div><span className="muted">Awaiting the first reporting period</span></div><div className="card report-placeholder"><div className="metric-label">Website health</div><div className="metric">—</div><span className="muted">Available after the website review</span></div><div className="card report-placeholder"><div className="metric-label">Recommended actions</div><div className="metric">—</div><span className="muted">Generated from connected data</span></div></div><EmptyState title="Your first weekly report is being prepared" body="Reports are created automatically after enough search, website, and customer activity has been collected." badge="Monitoring connected services" /></div>}
  </Page>;
}
