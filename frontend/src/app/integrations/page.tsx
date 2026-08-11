'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Page } from '@/components/page';

const providers = [
  ['GoHighLevel', 'CRM, leads, opportunities, conversations, workflows'],
  ['Google Analytics 4', 'Traffic, conversions, events, and revenue'],
  ['Search Console', 'Queries, clicks, impressions, CTR, position'],
  ['Google Business Profile', 'Reviews, calls, photos, and directions'],
  ['DataForSEO', 'Keywords, SERPs, competitors, backlinks'],
  ['GitHub', 'Repository analysis and approved changes'],
] as const;

function GoogleConnectButton({ provider, label }: { provider: string; label: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    fetch('/api/capere/integrations').then((r) => r.ok ? r.json() : null).then((body) => {
      setConnected((body?.data ?? []).some((item: { provider?: string; status?: string }) =>
        item.status === 'connected' && item.provider === provider));
    }).catch(() => undefined);
  }, [provider]);

  async function connect() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/capere/integrations/google/authorize');
      const body = await response.json();
      if (!response.ok || !body?.data?.authorizationUrl) {
        throw new Error(body?.error?.message ?? 'Unable to start Google authorization');
      }
      window.location.assign(body.data.authorizationUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to start Google authorization');
      setLoading(false);
    }
  }

  return <>
    {connected ? <span className="badge">Connected automatically</span> : <button className="btn" type="button" onClick={connect} disabled={loading}>
      {loading ? 'Connecting…' : `Connect ${label}`}
    </button>}
    {error && <p className="error-text" role="alert">{error}</p>}
  </>;
}

export default function IntegrationsPage() {
  const searchParams = useSearchParams();
  const linked = Number(searchParams.get('linked') ?? 0);
  const unmatched = Number(searchParams.get('unmatched') ?? 0);
  return <Page eyebrow="Integrations" title="Connected apps" subtitle="GoHighLevel is connected automatically. One Google authorization lets Capere discover and link matching Analytics, Search Console, and Business Profile resources for this sub-account.">{searchParams.get('google') === 'connected' && <div className="card"><strong>Google authorization complete</strong><p className="muted">Capere linked {linked} matching service{linked === 1 ? '' : 's'} automatically{unmatched ? `; ${unmatched} service${unmatched === 1 ? '' : 's'} need a unique matching resource.` : '.'}</p></div>}<div className="grid grid-3">{providers.map(([name, desc]) => <article className="card integration-card" key={name}><div className="integration-card-header"><div className="integration-logo">{name.slice(0,2).toUpperCase()}</div><div><h2 className="card-title">{name}</h2><p className="muted">{desc}</p></div></div><div className="integration-card-footer">{name === 'Google Analytics 4' ? <GoogleConnectButton provider="google_analytics_4" label="Analytics" /> : name === 'Search Console' ? <GoogleConnectButton provider="google_search_console" label="Search Console" /> : name === 'Google Business Profile' ? <GoogleConnectButton provider="google_business_profile" label="Business Profile" /> : <span className="badge">Managed by Capere</span>}</div></article>)}</div></Page>;
}
