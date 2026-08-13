import { EmbeddedModule } from '@/components/embedded-module';
import { CmoTaskQueue } from '@/components/cmo-task-queue';
import { AskCmoChat } from '@/components/ask-cmo-chat';
import { capereFetch, type Envelope } from '@/lib/api';
import { IntegrationConnectPanel } from '@/components/integration-connect-panel';
import { BusinessProfileDashboard, type BusinessProfileData } from '@/components/business-profile-dashboard';

const sections = [
  ['Overview', 'overview'],
  ['Growth', 'revenue'],
  ['Operations', 'activity'],
  ['Business Profile', 'business'],
  ['Ask CMO', 'ask'],
] as const;
type Metric = {
  metric_name: string;
  metric_value: string;
  metric_date: string;
  dimension_key: string;
  dimension_value: string;
};
type Insight = {
  id: string;
  category: string;
  severity: string;
  title: string;
  body: string;
  confidence: string | null;
  created_at: string;
};
type Recommendation = {
  id: string;
  source_insight_id: string | null;
  category: string;
  priority: string;
  status: string;
  title: string;
  rationale: string;
  action: string;
  expected_impact: string | null;
  due_at: string | null;
  created_at: string;
};
type Brief = {
  id: string;
  artifact_date: string;
  title: string;
  content: string;
  status: string;
  created_at: string;
};
type Task = {
  id: string;
  kind: string;
  status: string;
  title: string;
  payload?: unknown;
  error: string | null;
  approved_at: string | null;
  executed_at: string | null;
  created_at: string;
};
type Integration = {
  provider: string;
  status: string;
  last_sync_at: string | null;
  last_error: string | null;
};
type Pipeline = { connected:boolean; returned:number; total:number; pipelineValue:number; byStatus:Record<string,number>; error:string|null; locationName?:string };
type Performance = { periodDays:number; currentSessions:number; previousSessions:number; currentSearchClicks:number; currentSearchImpressions:number; searchAveragePosition:number|null };
type OperationalSource = { available:boolean; message?:string };
type Operations = {
  connected:boolean;
  locationName?:string|null;
  contacts:OperationalSource&{total:number;addedLast7Days:number;addedLast30Days:number};
  conversations:OperationalSource&{total:number;unread:number;activeLast7Days:number};
  appointments:OperationalSource&{upcoming7Days:number;upcoming30Days:number;calendars:number};
  workflows:OperationalSource&{total:number;published:number};
  team:OperationalSource&{users:number};
  reputation:OperationalSource&{reviewCount:number;averageRating:number;unanswered:number};
};

const Card = ({ label, value, detail }: { label: string; value: string; detail: string }) => (
  <div className="card cmo-summary">
    <div className="metric-label">{label}</div>
    <div className="metric">{value}</div>
    <span className="muted">{detail}</span>
  </div>
);
const Section = ({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) => (
  <section className="card cmo-section">
    <header>
      <div>
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>
    </header>
    <div className="cmo-section-body">{children}</div>
  </section>
);
const State = ({ title, body }: { title: string; body: string }) => (
  <div className="cmo-empty">
    <div>
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  </div>
);
const label = (value: string) =>
  value.replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export default async function CmoPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const requestedView = (await searchParams).view ?? 'overview';
  const view = requestedView === 'brief' || requestedView === 'insights' ? 'overview'
    : requestedView === 'advice' ? 'revenue'
      : requestedView === 'tasks' ? 'activity'
        : requestedView === 'integrations' ? 'overview' : requestedView;
  let summary: Envelope<Record<string, unknown>> | null = null;
  try {
    summary = await capereFetch('/api/v1/command-centers/ai-cmo/summary');
  } catch {}
  const d = summary?.data ?? {};
  const metrics = (Array.isArray(d.metrics) ? d.metrics : []) as Metric[];
  const insights = (Array.isArray(d.insights) ? d.insights : []) as Insight[];
  const recommendations = (
    Array.isArray(d.recommendations) ? d.recommendations : []
  ) as Recommendation[];
  const briefs = (Array.isArray(d.briefs) ? d.briefs : []) as Brief[];
  const tasks = (Array.isArray(d.tasks) ? d.tasks : []) as Task[];
  const integrations = (Array.isArray(d.integrations) ? d.integrations : []) as Integration[];
  const pipeline = (d.pipeline && typeof d.pipeline === 'object' ? d.pipeline : { connected:false, returned:0, total:0, pipelineValue:0, byStatus:{}, error:null }) as Pipeline;
  const performance = (d.performance && typeof d.performance === 'object' ? d.performance : { periodDays:7, currentSessions:0, previousSessions:0, currentSearchClicks:0, currentSearchImpressions:0, searchAveragePosition:null }) as Performance;
  const operations = (d.operations && typeof d.operations === 'object' ? d.operations : null) as Operations|null;
  const businessProfile = (d.businessProfile && typeof d.businessProfile === 'object' ? d.businessProfile : null) as BusinessProfileData|null;
  const latest = (name: string) => metrics.find((m) => m.metric_name === name)?.metric_value;
  const activeTasks = tasks.filter((t) => ['draft', 'approved', 'executing'].includes(t.status));
  const revenueRecs = recommendations.filter((r) => r.category === 'revenue');
  const marketingRecs = recommendations.filter((r) =>
    ['marketing', 'analytics', 'seo', 'gbp'].includes(r.category),
  );
  const highSignals = insights.filter((i) => ['high', 'critical'].includes(i.severity));
  const connected = integrations.filter((i) => i.status === 'connected').length;
  const tabs = sections.map(([text, key]) => ({
    label: text,
    href: key === 'overview' ? '/cmo' : `/cmo?view=${key}`,
    active: view === key,
  }));
  let content: React.ReactNode;
  if (view === 'integrations')
    content = <IntegrationConnectPanel embedded gbpConnected={Boolean(businessProfile?.connected)} />;
  else if (view === 'business')
    content = <div className="cmo-layout"><BusinessProfileDashboard profile={businessProfile} /></div>;
  else if (view === 'insights')
    content = (
      <div className="cmo-layout">
        <div className="grid grid-3">
          <Card
            label="Active insights"
            value={String(insights.length)}
            detail="Current business signals"
          />
          <Card
            label="Important signals"
            value={String(highSignals.length)}
            detail="Items needing closer review"
          />
          <Card
            label="Connected data sources"
            value={String(connected)}
            detail="Services providing evidence"
          />
        </div>
        <Section
          title="Business insights"
          subtitle="What your connected data is showing across marketing, search, revenue, and operations."
        >
          {insights.length ? (
            <div className="cmo-list">
              {insights.map((i) => (
                <article className="cmo-list-row" key={i.id}>
                  <span className={`cmo-severity ${i.severity}`}>{label(i.severity)}</span>
                  <div>
                    <strong>{i.title}</strong>
                    <p>{i.body}</p>
                    <small>
                      {label(i.category)} · {new Date(i.created_at).toLocaleDateString()}
                    </small>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <State
              title="No active insights yet"
              body="Capere will add insights here when connected data shows a meaningful change, risk, or opportunity."
            />
          )}
        </Section>
      </div>
    );
  else if (view === 'revenue')
    content = (
      <div className="cmo-layout">
        <div className="grid grid-3">
          <Card label="Open growth recommendations" value={String(revenueRecs.length)} detail="Actions linked to revenue signals" />
          <Card
            label="Pipeline value"
            value={pipeline.connected ? pipeline.pipelineValue.toLocaleString(undefined,{style:'currency',currency:'USD',maximumFractionDigits:0}) : '—'}
            detail={pipeline.error ? 'CRM data unavailable' : `${pipeline.total} opportunities in GoHighLevel`}
          />
          <Card
            label="Conversions"
            value={latest('conversions') ?? '0'}
            detail="Recent recorded conversions"
          />
        </div>
        {pipeline.error && <div className="card cmo-provider-warning"><strong>Pipeline data needs attention</strong><p>{pipeline.error}. Revenue totals will update automatically after the connection is available.</p></div>}
        <Section title="Pipeline overview" subtitle="A simple view of where current GoHighLevel opportunities stand.">
          {pipeline.connected && pipeline.returned ? <div className="pipeline-status-grid">{Object.entries(pipeline.byStatus).map(([status,count])=><div className="pipeline-status" key={status}><span>{label(status)}</span><strong>{count}</strong><small>opportunit{count===1?'y':'ies'}</small></div>)}</div> : <State title="No pipeline opportunities found" body="GoHighLevel is connected, but no opportunity records are available for this location yet."/>}
        </Section>
        <Section
          title="Revenue opportunities"
          subtitle="Practical ways to improve pipeline, retention, conversion, and client value."
        >
          {revenueRecs.length ? (
            <div className="cmo-grid">
              {revenueRecs.map((r) => (
                <article className="cmo-opportunity" key={r.id}>
                  <div className="cmo-row-top">
                    <span className={`badge priority-${r.priority}`}>{label(r.priority)}</span>
                    <span className="muted">{label(r.status)}</span>
                  </div>
                  <h3>{r.title}</h3>
                  <p>{r.rationale}</p>
                  <div className="cmo-next">
                    <strong>Recommended next step</strong>
                    <p>{r.action}</p>
                  </div>
                  {r.expected_impact && <small>Expected benefit: {r.expected_impact}</small>}
                </article>
              ))}
            </div>
          ) : (
            <State
              title="No additional revenue recommendations yet"
              body={pipeline.returned ? 'Capere is monitoring the current pipeline and will recommend actions when a clear opportunity is supported by the data.' : 'Revenue recommendations will appear after GoHighLevel opportunity activity is available.'}
            />
          )}
        </Section>
        <Section title="Marketing advice" subtitle="Practical guidance for improving visibility, traffic, and conversion.">
          {marketingRecs.length ? <div className="cmo-grid">{marketingRecs.map((r) => <article className="cmo-opportunity" key={r.id}><div className="cmo-row-top"><span className={`badge priority-${r.priority}`}>{label(r.priority)}</span><span className="muted">{label(r.category)}</span></div><h3>{r.title}</h3><p>{r.rationale}</p><div className="cmo-next"><strong>What to do</strong><p>{r.action}</p></div></article>)}</div> : <State title="No marketing advice is ready yet" body="Advice appears when connected marketing and search data provides enough evidence for a useful recommendation." />}
        </Section>
      </div>
    );
  else if (view === 'activity')
    content = (
      <div className="cmo-layout">
        <div className="grid grid-4">
          <Card label="New contacts" value={operations?.contacts.available ? String(operations.contacts.addedLast7Days) : '—'} detail="Added during the last 7 days" />
          <Card label="Upcoming appointments" value={operations?.appointments.available ? String(operations.appointments.upcoming7Days) : '—'} detail="Scheduled during the next 7 days" />
          <Card label="Conversations needing attention" value={operations?.conversations.available ? String(operations.conversations.unread) : '—'} detail="Unread customer conversations" />
          <Card label="Customer rating" value={operations?.reputation.available && operations.reputation.reviewCount ? `${operations.reputation.averageRating.toFixed(1)}/5` : '—'} detail={operations?.reputation.available ? `${operations.reputation.reviewCount} reviews in GoHighLevel` : 'Waiting for review access'} />
        </div>
        <Section title="Customer activity" subtitle="A clear view of recent demand and follow-up activity in GoHighLevel.">
          <div className="pipeline-status-grid">
            <div className="pipeline-status"><span>All contacts</span><strong>{operations?.contacts.available ? operations.contacts.total.toLocaleString() : '—'}</strong><small>{operations?.contacts.available ? `${operations.contacts.addedLast30Days} added in 30 days` : operations?.contacts.message ?? 'Data unavailable'}</small></div>
            <div className="pipeline-status"><span>Recent conversations</span><strong>{operations?.conversations.available ? operations.conversations.activeLast7Days : '—'}</strong><small>{operations?.conversations.available ? 'Active during the last 7 days' : operations?.conversations.message ?? 'Data unavailable'}</small></div>
            <div className="pipeline-status"><span>Appointments</span><strong>{operations?.appointments.available ? operations.appointments.upcoming30Days : '—'}</strong><small>{operations?.appointments.available ? 'Scheduled during the next 30 days' : operations?.appointments.message ?? 'Data unavailable'}</small></div>
            <div className="pipeline-status"><span>Published automations</span><strong>{operations?.workflows.available ? operations.workflows.published : '—'}</strong><small>{operations?.workflows.available ? `${operations.workflows.total} workflows available` : operations?.workflows.message ?? 'Data unavailable'}</small></div>
            <div className="pipeline-status"><span>Team members</span><strong>{operations?.team.available ? operations.team.users : '—'}</strong><small>{operations?.team.available ? 'Users available in this location' : operations?.team.message ?? 'Data unavailable'}</small></div>
            <div className="pipeline-status"><span>Reviews awaiting replies</span><strong>{operations?.reputation.available ? operations.reputation.unanswered : '—'}</strong><small>{operations?.reputation.available ? 'Customer feedback needing attention' : operations?.reputation.message ?? 'Data unavailable'}</small></div>
          </div>
        </Section>
        <Section title="What to focus on" subtitle="Simple operating checks based on your current customer activity.">
          <div className="cmo-list">
            {operations?.conversations.available && operations.conversations.unread > 0 && <article className="cmo-list-row"><span className="cmo-severity high">Priority</span><div><strong>Reply to unread customer conversations</strong><p>{operations.conversations.unread} conversation{operations.conversations.unread===1?' is':'s are'} waiting for attention. Fast replies can improve the chance of converting an enquiry.</p></div></article>}
            {operations?.reputation.available && operations.reputation.unanswered > 0 && <article className="cmo-list-row"><span className="cmo-severity medium">Review</span><div><strong>Respond to recent customer reviews</strong><p>{operations.reputation.unanswered} review{operations.reputation.unanswered===1?' has':'s have'} no recorded reply. A professional response shows customers that their feedback is valued.</p></div></article>}
            {operations?.appointments.available && operations.appointments.upcoming7Days > 0 && <article className="cmo-list-row"><span className="cmo-severity green">Upcoming</span><div><strong>Prepare for this week’s appointments</strong><p>{operations.appointments.upcoming7Days} appointment{operations.appointments.upcoming7Days===1?' is':'s are'} scheduled during the next seven days.</p></div></article>}
            {operations && ![operations.conversations.unread,operations.reputation.unanswered,operations.appointments.upcoming7Days].some((value)=>value>0) && <State title="No urgent customer activity" body="Capere is monitoring contacts, conversations, appointments, workflows, and customer reviews through GoHighLevel." />}
          </div>
        </Section>
        <Section title="Action queue" subtitle="Review approved work and track completed actions.">
          {tasks.length ? <CmoTaskQueue tasks={tasks} /> : <State title="No CMO tasks yet" body="Tasks appear after a recommendation is approved for execution." />}
        </Section>
      </div>
    );
  else if (view === 'advice')
    content = (
      <div className="cmo-layout">
        <div className="grid grid-3">
          <Card
            label="Open recommendations"
            value={String(marketingRecs.length)}
            detail="Marketing and visibility actions"
          />
          <Card
            label="Website visits"
            value={String(performance.currentSessions)}
            detail={`Latest ${performance.periodDays} days`}
          />
          <Card
            label="Search appearances"
            value={String(performance.currentSearchImpressions)}
            detail={`Latest ${performance.periodDays} days`}
          />
        </div>
        <Section
          title="Marketing advice"
          subtitle="Prioritized guidance based on your website, search visibility, customer activity, and firm context."
        >
          {marketingRecs.length ? (
            <div className="cmo-grid">
              {marketingRecs.map((r) => (
                <article className="cmo-opportunity" key={r.id}>
                  <div className="cmo-row-top">
                    <span className={`badge priority-${r.priority}`}>{label(r.priority)}</span>
                    <span className="muted">{label(r.category)}</span>
                  </div>
                  <h3>{r.title}</h3>
                  <p>{r.rationale}</p>
                  <div className="cmo-next">
                    <strong>What to do</strong>
                    <p>{r.action}</p>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <State
              title="No marketing advice is ready yet"
              body="Advice appears when connected marketing and search data provides enough evidence for a useful recommendation."
            />
          )}
        </Section>
      </div>
    );
  else if (view === 'tasks')
    content = (
      <div className="cmo-layout">
        <div className="grid grid-4">
          <Card
            label="Needs approval"
            value={String(tasks.filter((t) => t.status === 'draft').length)}
            detail="Actions waiting for your review"
          />
          <Card
            label="In progress"
            value={String(tasks.filter((t) => ['approved', 'executing'].includes(t.status)).length)}
            detail="Approved or currently running"
          />
          <Card
            label="Completed"
            value={String(tasks.filter((t) => t.status === 'succeeded').length)}
            detail="Successfully finished actions"
          />
          <Card label="Needs attention" value={String(tasks.filter((t) => t.status === 'failed').length)} detail="Actions requiring review" />
        </div>
        <Section
          title="Action queue"
          subtitle="Review recommended actions, track approved work, and see what has already been completed."
        >
          {tasks.length ? (
            <CmoTaskQueue tasks={tasks} />
          ) : (
            <State
              title="No CMO tasks yet"
              body="Tasks appear after a recommendation is approved for execution. No action is taken without the required approval."
            />
          )}
        </Section>
      </div>
    );
  else if (view === 'ask')
    content = (
      <div className="cmo-layout">
        <AskCmoChat />
      </div>
    );
  else {
    const recommendedInsightIds = new Set(recommendations.map((r) => r.source_insight_id).filter(Boolean));
    const feed = [
      ...insights.filter((i) => !recommendedInsightIds.has(i.id)).map((i) => ({ id: `insight-${i.id}`, kind: 'insight', title: i.title, body: i.body, action: null, date: i.created_at, label: `${label(i.category)} insight`, tone: i.severity })),
      ...recommendations.map((r) => ({ id: `recommendation-${r.id}`, kind: 'recommendation', title: r.title, body: r.rationale, action: r.action, date: r.created_at, label: `${label(r.priority)} priority recommendation`, tone: r.priority })),
      ...tasks.filter((t) => t.status !== 'draft').map((t) => ({ id: `task-${t.id}`, kind: 'task', title: t.title, body: `This ${label(t.kind).toLowerCase()} is currently ${label(t.status).toLowerCase()}.`, action: t.error ?? null, date: t.executed_at ?? t.approved_at ?? t.created_at, label: `Task · ${label(t.status)}`, tone: t.status === 'failed' ? 'critical' : 'green' })),
    ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    content = (
      <div className="cmo-layout">
        <div className="overview-connections" aria-label="Connected services">
          <div className="overview-connections-heading">
            <strong>Data connections</strong>
            <span>Services used to prepare your insights</span>
          </div>
          <IntegrationConnectPanel embedded compact gbpConnected={Boolean(businessProfile?.connected)} />
        </div>
        <div className="grid grid-4">
          <Card
            label="Active insights"
            value={String(insights.length)}
            detail="Signals across your business"
          />
          <Card
            label="Open recommendations"
            value={String(recommendations.length)}
            detail="Actions awaiting progress"
          />
          <Card
            label="Open tasks"
            value={String(activeTasks.length)}
            detail="Approved and active work"
          />
          <Card label="Website visits" value={String(performance.currentSessions)} detail={`Last ${performance.periodDays} days`} />
          <Card label="Pipeline value" value={pipeline.connected ? pipeline.pipelineValue.toLocaleString(undefined,{style:'currency',currency:'USD',maximumFractionDigits:0}) : '—'} detail={pipeline.connected ? `${pipeline.total} GoHighLevel opportunities` : 'CRM data unavailable'} />
        </div>
        <Section title="Morning brief" subtitle="A chronological feed of what changed, why it matters, and what to do next.">
          {feed.length ? <div className="cmo-feed">{feed.map((item) => <article className="cmo-feed-item" key={item.id}><div className={`cmo-feed-avatar ${item.tone}`}>{item.kind==='insight'?'!':item.kind==='recommendation'?'→':'✓'}</div><div className="cmo-feed-card"><div className="cmo-feed-meta"><span>{item.label}</span><time>{new Date(item.date).toLocaleString()}</time></div><h3>{item.title}</h3><p className="cmo-feed-body">{item.body}</p>{item.action&&<div className="cmo-feed-action"><strong>Next step</strong><span>{item.action}</span></div>}<div className="cmo-feed-footer"><span>AI CMO</span><span>Based on connected business data</span></div></div></article>)}</div>:<State title="No updates yet" body="The feed will fill automatically after synchronized metrics and recommendations are available."/>}
        </Section>
      </div>
    );
  }
  return (
    <EmbeddedModule
      product="AI CMO"
      title="Your strategic marketing workspace"
      description="Business insights, revenue opportunities, marketing guidance, and approved actions grounded in your connected data."
      tabs={tabs}
    >
      {content}
    </EmbeddedModule>
  );
}
