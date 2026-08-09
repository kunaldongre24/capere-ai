import { EmbeddedModule } from '@/components/embedded-module';
import { CompetitorControls } from '@/components/competitor-controls';
import { capereFetch, Envelope } from '@/lib/api';

const sections = [
  ['Overview', 'overview'],
  ['Website health', 'technical'],
  ['Search keywords', 'keywords'],
  ['Competitors', 'competitors'],
  ['Local profile', 'gbp'],
  ['Recommendations', 'recommendations'],
  ['History', 'history'],
] as const;
type Metric = { metric_name: string; metric_value: string; metric_date: string };
type Audit = {
  id: string;
  status: string;
  score: number | null;
  issue_count: number | null;
  completed_at: string | null;
  started_at: string;
  site_url?: string;
  summary?: unknown;
};
type Integration = {
  provider: string;
  status: string;
  last_sync_at: string | null;
  last_error: string | null;
};

const Icon = ({ name }: { name: string }) => (
  <span className={`seo-icon seo-icon-${name}`} aria-hidden>
    {(
      {
        clicks: '↗',
        impressions: '◉',
        position: '⌖',
        health: '✓',
        audit: '⌕',
        keywords: '⌨',
        competitors: '◎',
        gbp: '★',
        recommendations: '✦',
        history: '◷',
      } as Record<string, string>
    )[name] ?? '•'}
  </span>
);
const Card = ({
  title,
  value,
  detail,
  icon,
}: {
  title: string;
  value: string;
  detail: string;
  icon: string;
}) => (
  <div className="card seo-metric-card">
    <div className="seo-card-top">
      <div className="metric-label">{title}</div>
      <Icon name={icon} />
    </div>
    <div className="seo-metric-value">{value}</div>
    <p className="seo-metric-detail">{detail}</p>
  </div>
);
const Bar = ({
  label,
  value,
  max,
  detail,
}: {
  label: string;
  value: number;
  max: number;
  detail?: string;
}) => (
  <div className="seo-bar">
    <div className="seo-bar-label">
      <span>{label}</span>
      <strong>{detail ?? value}</strong>
    </div>
    <div className="seo-bar-track">
      <div
        className="seo-bar-fill"
        style={{ width: `${Math.max(2, Math.min(100, max ? (value / max) * 100 : 0))}%` }}
      />
    </div>
  </div>
);
const Panel = ({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) => (
  <div className="card seo-panel">
    <div className="seo-panel-header">
      <Icon
        name={
          title.toLowerCase().includes('keyword')
            ? 'keywords'
            : title.toLowerCase().includes('technical')
              ? 'audit'
              : 'recommendations'
        }
      />
      <div>
        <h3>{title}</h3>
        <p>{subtitle}</p>
      </div>
    </div>
    <div className="seo-panel-body">{children}</div>
  </div>
);
const LineChart = ({ points }: { points: Array<[string, number]> }) => {
  const width = 640,
    height = 210,
    padX = 28,
    padY = 24,
    max = Math.max(...points.map(([, value]) => value), 1),
    step = points.length > 1 ? (width - padX * 2) / (points.length - 1) : 0;
  const plotted = points.map(([date, value], index) => ({
    date,
    value,
    x: padX + index * step,
    y: height - padY - (value / max) * (height - padY * 2),
  }));
  const path = plotted
    .map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`)
    .join(' ');
  return (
    <div className="seo-line-chart">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Website visits from Google by date"
      >
        <line
          x1={padX}
          y1={height - padY}
          x2={width - padX}
          y2={height - padY}
          className="chart-axis"
        />
        <path d={path} className="chart-line" />
        <path
          d={`${path} L ${plotted.at(-1)?.x ?? padX} ${height - padY} L ${padX} ${height - padY} Z`}
          className="chart-area"
        />
        {plotted.map((point, index) => (
          <g key={`${point.date}-${index}`} className="chart-point">
            <circle cx={point.x} cy={point.y} r="5">
              <title>
                {point.date}: {point.value} website visit{point.value === 1 ? '' : 's'}
              </title>
            </circle>
            {(index === 0 ||
              index === plotted.length - 1 ||
              index % Math.max(1, Math.ceil(plotted.length / 5)) === 0) && (
              <text x={point.x} y={height - 5} textAnchor="middle">
                {point.date}
              </text>
            )}
          </g>
        ))}
      </svg>
      <div className="chart-caption">
        Select or hover over a point to see the date and number of website visits.
      </div>
    </div>
  );
};
const StatusList = ({
  items,
}: {
  items: Array<{
    label: string;
    value: string;
    status: 'good' | 'warning' | 'neutral';
    detail?: string;
  }>;
}) => (
  <div className="status-list">
    {items.map((item) => (
      <div className="status-row" key={item.label}>
        <span className={`status-indicator ${item.status}`} aria-hidden />
        <div className="status-copy">
          <strong>{item.label}</strong>
          {item.detail && <span>{item.detail}</span>}
        </div>
        <span className={`status-value ${item.status}`}>{item.value}</span>
      </div>
    ))}
  </div>
);

export default async function SeoPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const view = (await searchParams).view ?? 'overview';
  let summary: Envelope<Record<string, unknown>> | null = null;
  try {
    summary = await capereFetch('/api/v1/command-centers/seo-command-center/summary');
  } catch {}
  const d = summary?.data ?? {};
  const metrics = (Array.isArray(d.metrics) ? d.metrics : []) as Metric[];
  const latest = (name: string) => metrics.find((x) => x.metric_name === name)?.metric_value;
  const series = (name: string) =>
    metrics
      .filter((x) => x.metric_name === name)
      .slice()
      .reverse();
  const audit = (
    d.technicalAudit && typeof d.technicalAudit === 'object' ? d.technicalAudit : null
  ) as Audit | null;
  const findings = (Array.isArray(d.technicalFindings) ? d.technicalFindings : []) as Array<{
    code: string;
    title: string;
    severity: string;
    count: number;
    meaning: string;
    action: string;
  }>;
  const tech = (
    d.technicalOverview && typeof d.technicalOverview === 'object' ? d.technicalOverview : null
  ) as null | {
    pagesCrawled: number;
    totalPages: number;
    crawlLimit: number;
    crawlStatus: string;
    crawlStopReason: string;
    crawlStartedAt: string | null;
    crawlEndedAt: string | null;
    internalLinks: number;
    externalLinks: number;
    brokenLinks: number;
    brokenResources: number;
    nonIndexablePages: number;
    duplicateContent: number;
    https: boolean;
    http2: boolean;
    sitemap: boolean;
    robotsTxt: boolean;
    certificateValid: boolean;
    certificateExpiresAt: string | null;
    ip: string | null;
  };
  const history = (Array.isArray(d.auditHistory) ? d.auditHistory : []) as Audit[];
  const keywords = (Array.isArray(d.keywords) ? d.keywords : []) as Array<{
    keyword: string;
    rank: number | null;
    checked_on: string | null;
    url: string | null;
  }>;
  const searchQueries = (Array.isArray(d.searchQueries) ? d.searchQueries : []) as Array<{
    query: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
    latestDate: string;
  }>;
  const competitors = (Array.isArray(d.competitors) ? d.competitors : []) as Array<{
    domain: string;
    name: string | null;
    last_checked_at: string | null;
  }>;
  const integrations = (Array.isArray(d.integrations) ? d.integrations : []) as Integration[];
  const recs = (Array.isArray(d.recommendations) ? d.recommendations : []) as Array<{
    id: string;
    title: string;
    action: string;
    priority: string;
    rationale?: string;
  }>;
  const connected = (p: string) =>
    integrations.some((x) => x.provider === p && x.status === 'connected');
  const clicks = latest('clicks') ?? '0',
    impressions = latest('impressions') ?? '0',
    position = latest('position') ?? '—';
  const tabs = sections.map(([label, key]) => ({
    label,
    href: key === 'overview' ? '/seo' : `/seo?view=${key}`,
    active: view === key,
  }));
  const score = audit?.score ?? 0,
    issues = audit?.issue_count ?? 0;
  const crawlDenominator = tech
    ? Math.max(tech.pagesCrawled, Math.min(tech.totalPages, tech.crawlLimit))
    : 0;
  let content: React.ReactNode;
  if (view === 'technical')
    content = (
      <div className="grid">
        <div className="grid grid-3">
          <Card
            title="Website health"
            value={`${score}/100`}
            detail="Overall health of your website"
            icon="health"
          />
          <Card
            title="Items to review"
            value={String(issues)}
            detail={issues ? 'Recommended improvements' : 'No issues found in this review'}
            icon="audit"
          />
          <Card
            title="Last review"
            value={
              audit?.completed_at
                ? new Date(audit.completed_at).toLocaleDateString()
                : 'Not available'
            }
            detail={audit?.site_url ?? 'Add your website'}
            icon="history"
          />
        </div>
        <Panel title="What this means" subtitle="A simple summary of your website review.">
          <p>
            {audit
              ? 'Your website is working well overall. We found a few improvements that can help search engines understand and load it more reliably. Review the recommendations below; a high score does not mean every individual check passed.'
              : 'A website review has not been completed yet.'}
          </p>
          {audit && (
            <>
              <Bar label="Website health" value={score} max={100} detail={`${score} out of 100`} />
              <Bar
                label="Items to review"
                value={Math.min(issues, 100)}
                max={100}
                detail={`${issues} items`}
              />
            </>
          )}
        </Panel>
        {findings.length > 0 && (
          <Panel
            title="Recommended improvements"
            subtitle="Specific items found during the latest website review."
          >
            <div className="grid grid-2">
              {findings.map((f) => (
                <div
                  className="card"
                  key={f.code}
                  style={{
                    borderLeft: `4px solid ${f.severity === 'high' ? '#ef5350' : f.severity === 'medium' ? '#ffb020' : '#6d5dfc'}`,
                  }}
                >
                  <div className="eyebrow">
                    {f.severity === 'high'
                      ? 'Important'
                      : f.severity === 'medium'
                        ? 'Recommended'
                        : 'Optional'}{' '}
                    · {f.count} item
                  </div>
                  <h3>{f.title}</h3>
                  <p>{f.meaning}</p>
                  <strong>What to do</strong>
                  <p>{f.action}</p>
                </div>
              ))}
            </div>
          </Panel>
        )}
      </div>
    );
  else if (view === 'keywords') {
    const terms = searchQueries.length
      ? searchQueries
      : keywords.map((k) => ({
          query: k.keyword,
          clicks: 0,
          impressions: 0,
          ctr: 0,
          position: k.rank ?? 0,
          latestDate: k.checked_on ?? '',
        }));
    const maxTermImpressions = Math.max(...terms.map((t) => t.impressions), 1);
    content = (
      <div className="grid">
        <div className="grid grid-3">
          <Card
            title="Search terms found"
            value={String(terms.length)}
            detail={
              terms.length
                ? 'Phrases people used to find you'
                : 'Google is still collecting activity'
            }
            icon="keywords"
          />
          <Card
            title="Average ranking"
            value={position}
            detail="A smaller number means a higher result"
            icon="position"
          />
          <Card
            title="Times shown in search"
            value={impressions}
            detail="How often your website appeared"
            icon="impressions"
          />
        </div>
        <Panel
          title="How customers found you"
          subtitle="Search phrases that showed your website in Google during the last 30 days."
        >
          {terms.length ? (
            <div>
              {terms.map((term, i) => (
                <div
                  key={`${term.query}-${i}`}
                  style={{ padding: '14px 0', borderBottom: '1px solid var(--border)' }}
                >
                  <Bar
                    label={term.query}
                    value={term.impressions}
                    max={maxTermImpressions}
                    detail={`${term.impressions} appearance${term.impressions === 1 ? '' : 's'}`}
                  />
                  <div
                    style={{
                      display: 'flex',
                      gap: 18,
                      flexWrap: 'wrap',
                      fontSize: 13,
                      opacity: 0.78,
                    }}
                  >
                    <span>
                      <strong>{term.clicks}</strong> website visit{term.clicks === 1 ? '' : 's'}
                    </span>
                    <span>
                      <strong>{term.position ? term.position.toFixed(1) : '—'}</strong> average
                      ranking
                    </span>
                    <span>
                      <strong>{(term.ctr * 100).toFixed(1)}%</strong> visit rate
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p>
              Google Search is connected, but there is not enough activity yet to show individual
              search phrases. Your website has appeared {impressions} time(s), received {clicks}{' '}
              visit(s), and has an average ranking of {position}. This section will fill
              automatically as more people find your website.
            </p>
          )}
        </Panel>
        <Panel title="How to read this report" subtitle="A simple guide to the numbers above.">
          <p>
            <strong>Appearances</strong> show how often Google displayed your website.{' '}
            <strong>Website visits</strong> show how many people selected it.{' '}
            <strong>Average ranking</strong> shows where it appeared; numbers closer to 1 are
            better. <strong>Visit rate</strong> shows the percentage of appearances that became
            visits.
          </p>
        </Panel>
      </div>
    );
  } else if (view === 'competitors')
    content = (
      <div className="grid">
        <CompetitorControls projectId={typeof d.project==='object'&&d.project&&'id' in d.project?String((d.project as {id:string}).id):undefined}/>
        <div className="grid grid-3">
          <Card
            title="Competitors added"
            value={String(competitors.length)}
            detail="Businesses selected for comparison"
            icon="competitors"
          />
          <Card
            title="Your average ranking"
            value={position}
            detail="Current Google position"
            icon="position"
          />
          <Card
            title="Comparison status"
            value={competitors.length ? 'Ready' : 'Not set up'}
            detail="Add businesses you want to compare"
            icon="audit"
          />
        </div>
        <Panel
          title="Competitor comparison"
          subtitle="See how your business compares with similar businesses in search."
        >
          {competitors.length ? (
            competitors.map((c) => (
              <div
                key={c.domain}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '12px 0',
                  borderBottom: '1px solid var(--border)',
                }}
              >
                <strong>{c.name ?? c.domain}</strong>
                <span>
                  {c.last_checked_at
                    ? `Checked ${new Date(c.last_checked_at).toLocaleDateString()}`
                    : 'Waiting for first comparison'}
                </span>
              </div>
            ))
          ) : (
            <p>
              Your website review is active, but no comparison businesses have been added. Add a few
              local or industry competitors to see search visibility differences and opportunities.
            </p>
          )}
        </Panel>
      </div>
    );
  else if (view === 'gbp')
    content = (
      <div className="grid">
        <div className="grid grid-3">
          <Card
            title="Google business listing"
            value={connected('google_business_profile') ? 'Connected' : 'Not connected'}
            detail="Your profile shown in Google Maps"
            icon="gbp"
          />
          <Card
            title="Customer reviews"
            value="—"
            detail="Available after connecting your listing"
            icon="gbp"
          />
          <Card
            title="Customer actions"
            value="—"
            detail="Calls, directions, and website visits"
            icon="clicks"
          />
        </div>
        <Panel
          title="Local business visibility"
          subtitle="Understand how customers find and contact you through Google."
        >
          <p>
            {connected('google_business_profile')
              ? 'Your Google Business Profile is connected. Reviews and customer activity will appear after the next data update.'
              : 'Connect your Google Business Profile to see reviews, calls, direction requests, website visits, and how customers discover your business locally.'}
          </p>
        </Panel>
      </div>
    );
  else if (view === 'recommendations')
    content = (
      <div className="grid">
        <div className="grid grid-3">
          <Card
            title="Recommended actions"
            value={String(recs.length || findings.length)}
            detail="Ways to improve your website"
            icon="recommendations"
          />
          <Card
            title="Website review"
            value={audit ? 'Complete' : 'Pending'}
            detail={audit ? `${issues} items found` : 'Waiting for first review'}
            icon="audit"
          />
          <Card
            title="Google visibility"
            value={`${impressions} appearances`}
            detail={`${clicks} visits from search`}
            icon="clicks"
          />
        </div>
        {recs.length ? (
          recs.map((r) => (
            <Panel key={r.id} title={r.title} subtitle={`${r.priority} priority`}>
              <p>{r.rationale}</p>
              <strong>What to do</strong>
              <p>{r.action}</p>
            </Panel>
          ))
        ) : findings.length ? (
          findings.map((f) => (
            <Panel
              key={f.code}
              title={f.title}
              subtitle={
                f.severity === 'high'
                  ? 'Important improvement'
                  : f.severity === 'medium'
                    ? 'Recommended improvement'
                    : 'Optional improvement'
              }
            >
              <p>{f.meaning}</p>
              <strong>What to do</strong>
              <p>{f.action}</p>
            </Panel>
          ))
        ) : (
          <Panel
            title="No urgent actions right now"
            subtitle="We will continue monitoring your website and search performance."
          >
            <p>
              Recommendations appear when enough reliable information is available. Your connected
              services will continue collecting data automatically.
            </p>
          </Panel>
        )}
      </div>
    );
  else if (view === 'history')
    content = (
      <div className="grid">
        <div className="grid grid-3">
          <Card
            title="Audits completed"
            value={String(history.filter((x) => x.status === 'succeeded').length)}
            detail="Recent retained runs"
            icon="history"
          />
          <Card
            title="Latest score"
            value={String(score)}
            detail="Technical health"
            icon="health"
          />
          <Card
            title="Latest issues"
            value={String(issues)}
            detail="Detected crawl issues"
            icon="audit"
          />
        </div>
        <Panel title="Audit timeline" subtitle="Technical audit status and results over time.">
          {history.length ? (
            history.map((h) => (
              <div
                key={h.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr auto auto',
                  gap: 16,
                  padding: '14px 0',
                  borderBottom: '1px solid var(--border)',
                }}
              >
                <div>
                  <strong>{h.status === 'succeeded' ? 'Completed audit' : 'Audit run'}</strong>
                  <div style={{ fontSize: 13, opacity: 0.7 }}>
                    {new Date(h.completed_at ?? h.started_at).toLocaleString()}
                  </div>
                </div>
                <span>Score {h.score ?? '—'}</span>
                <span>{h.issue_count ?? 0} issues</span>
              </div>
            ))
          ) : (
            <p>No audit history is available.</p>
          )}
        </Panel>
      </div>
    );
  else {
    const rawClicks = series('clicks');
    const byDate = new Map<string, number>();
    for (const m of rawClicks) {
      const date = new Date(m.metric_date).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      });
      byDate.set(date, (byDate.get(date) ?? 0) + Number(m.metric_value));
    }
    const clickSeries = [...byDate.entries()];
    content = (
      <div className="grid">
        <div className="grid grid-4">
          <Card
            title="Organic clicks"
            value={clicks}
            detail="Visits from Google Search"
            icon="clicks"
          />
          <Card
            title="Impressions"
            value={impressions}
            detail="Times shown in search"
            icon="impressions"
          />
          <Card
            title="Average position"
            value={position}
            detail="Average Google ranking"
            icon="position"
          />
          <Card
            title="Technical health"
            value={`${score}/100`}
            detail={audit ? `${issues} findings · audit complete` : 'Audit not completed'}
            icon="health"
          />
        </div>
        {tech && (
          <div className="grid grid-4">
            <Card
              title="Pages crawled"
              value={`${tech.pagesCrawled}/${crawlDenominator}`}
              detail={`Crawl ${tech.crawlStatus}`}
              icon="audit"
            />
            <Card
              title="Internal links"
              value={String(tech.internalLinks)}
              detail={`${tech.brokenLinks} broken links`}
              icon="clicks"
            />
            <Card
              title="Indexability"
              value={tech.nonIndexablePages ? 'Needs review' : 'Healthy'}
              detail={`${tech.nonIndexablePages} non-indexable pages`}
              icon="health"
            />
            <Card
              title="Site transport"
              value={tech.https && tech.http2 ? 'HTTPS + HTTP/2' : 'Review needed'}
              detail={tech.certificateValid ? 'Valid SSL certificate' : 'Certificate issue'}
              icon="health"
            />
          </div>
        )}
        <div className="grid grid-2">
          <Panel title="Search performance" subtitle="Website visits from Google over time.">
            {clickSeries.length ? (
              <LineChart points={clickSeries} />
            ) : (
              <p>
                Google Search is connected but the property has very little historical traffic so
                far. Current totals are {clicks} website visits and {impressions} appearance(s).
              </p>
            )}
          </Panel>
          <Panel
            title="Technical coverage"
            subtitle="Important website access and indexing checks."
          >
            {tech ? (
              <StatusList items={[{label:'SSL certificate',value:tech.certificateValid?'Valid':'Needs attention',status:tech.certificateValid?'good':'warning'},{label:'HTTPS security',value:tech.https?'Enabled':'Needs attention',status:tech.https?'good':'warning'},{label:'Modern connection',value:tech.http2?'HTTP/2 enabled':'Review needed',status:tech.http2?'good':'warning'},{label:'XML sitemap',value:tech.sitemap?'Detected':'Not detected',status:tech.sitemap?'good':'warning',detail:'Helps Google discover your pages'},{label:'Robots instructions',value:tech.robotsTxt?'Detected':'Not detected',status:tech.robotsTxt?'good':'warning',detail:'Controls search engine access'}]} />
            ) : (
              <p>A website review is needed before these checks are available.</p>
            )}
          </Panel>
        </div>
        {tech && (
          <div className="grid grid-2">
            <Panel title="Crawl quality" subtitle="Items that can affect visitors and search visibility."><StatusList items={[{label:'Broken links',value:tech.brokenLinks?`${tech.brokenLinks} found`:'None found',status:tech.brokenLinks?'warning':'good'},{label:'Broken resources',value:tech.brokenResources?`${tech.brokenResources} found`:'None found',status:tech.brokenResources?'warning':'good'},{label:'Duplicate content',value:tech.duplicateContent?`${tech.duplicateContent} found`:'None found',status:tech.duplicateContent?'warning':'good'},{label:'Pages unavailable to search',value:tech.nonIndexablePages?`${tech.nonIndexablePages} found`:'None found',status:tech.nonIndexablePages?'warning':'good'}]} /></Panel>
            <Panel title="Audit findings" subtitle="Priority improvements from the latest crawl.">
              {findings.map((f) => (
                <div
                  key={f.code}
                  style={{
                    padding: '9px 0',
                    borderBottom: '1px solid var(--border)',
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 12,
                  }}
                >
                  <span>{f.title}</span>
                  <strong>{f.severity}</strong>
                </div>
              ))}
            </Panel>
          </div>
        )}
        <Panel title="SEO readiness" subtitle="Information sources currently available to your team."><StatusList items={[{label:'Google Search performance',value:connected('google_search_console')?'Connected':'Not connected',status:connected('google_search_console')?'good':'warning',detail:'Search appearances and website visits'},{label:'Website review',value:audit?'Complete':'Pending',status:audit?'good':'neutral',detail:'Technical checks and recommendations'},{label:'Google business listing',value:connected('google_business_profile')?'Connected':'Not connected',status:connected('google_business_profile')?'good':'warning',detail:'Reviews and local customer actions'},{label:'Competitor comparison',value:competitors.length?'Active':'Not configured',status:competitors.length?'good':'neutral',detail:'Visibility comparison with selected businesses'}]} /></Panel>
        <Panel title="Executive interpretation" subtitle="What the current SEO evidence says.">
          <p>
            Google Search Console reports {impressions} impression(s), {clicks} click(s), and
            average position {position}. The DataForSEO crawl scored {score}/100 across{' '}
            {tech?.pagesCrawled ?? 0} discovered page(s), with {issues} specific improvements.
            HTTPS, HTTP/2, and the SSL certificate are healthy; sitemap and robots.txt coverage are
            the clearest technical gaps. GBP and competitor tracking remain the largest missing data
            sources.
          </p>
        </Panel>
      </div>
    );
  }
  return (
    <EmbeddedModule
      product="SEO Command Center"
      title="Understand and improve your online visibility"
      description="A clear view of how customers find your business, what is working, and what to improve next."
      tabs={tabs}
    >
      {content}
    </EmbeddedModule>
  );
}
