import { EmptyState } from '@/components/page';
import { EmbeddedModule } from '@/components/embedded-module';

const sections = [['Morning Brief', 'brief'], ['Insights', 'insights'], ['Revenue Opportunities', 'revenue'], ['Marketing Advice', 'advice'], ['Tasks', 'tasks'], ['Ask CMO', 'ask']] as const;

export default async function CmoPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const view = (await searchParams).view ?? 'brief';
  const tabs = sections.map(([label, key]) => ({ label, href: key === 'brief' ? '/cmo' : `/cmo?view=${key}`, active: view === key }));
  let content: React.ReactNode;
  if (view === 'insights') content = <EmptyState title="Insights" body="Cross-channel insights will appear after provider events are synchronized and consumed." badge="Waiting for provider data" />;
  else if (view === 'revenue') content = <EmptyState title="Revenue opportunities" body="Capere will identify cross-sell, retention, and pipeline opportunities from GHL." badge="Waiting for CRM signals" />;
  else if (view === 'advice') content = <EmptyState title="Marketing advice" body="Connect your knowledge base and analytics data to receive advice aligned to your CPA playbook." />;
  else if (view === 'tasks') content = <EmptyState title="Tasks" body="Approved recommendations and automation tasks will appear here." badge="No tasks yet" />;
  else if (view === 'ask') content = <div className="card"><h2 className="card-title">Ask CMO</h2><p className="muted">Chat is provided by Open WebUI. Organization context is attached through a secure server-side ticket.</p><a className="btn" href={process.env.NEXT_PUBLIC_CHAT_URL ?? 'https://chat.capereai.com'} target="_blank" rel="noreferrer">Open Ask CMO</a></div>;
  else content = <div className="grid grid-2"><EmptyState title="Morning brief" body="The daily brief will appear after your first analytics sync and recommendation run." badge="Waiting for provider data"/><EmptyState title="Revenue opportunities" body="Capere will identify cross-sell, retention, and pipeline opportunities from GHL." badge="Waiting for CRM signals"/></div>;
  return <EmbeddedModule product="AI CMO" title="Your firm's strategic copilot" description="Morning briefs, revenue opportunities, and marketing advice grounded in your business data." tabs={tabs}>{content}</EmbeddedModule>;
}
