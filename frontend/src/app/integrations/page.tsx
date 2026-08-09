'use client';

import { useEffect, useState } from 'react';
import { Page } from '@/components/page';

const providers = [
  ['GoHighLevel', 'CRM, leads, opportunities, conversations, workflows'],
  ['Google Analytics 4', 'Traffic, conversions, events, and revenue'],
  ['Search Console', 'Queries, clicks, impressions, CTR, position'],
  ['Google Business Profile', 'Reviews, calls, photos, and directions'],
  ['DataForSEO', 'Keywords, SERPs, competitors, backlinks'],
  ['GitHub', 'Repository analysis and approved changes'],
] as const;

function GoogleConnectButton({ provider }: { provider: string }) {
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
    {connected ? <span className="badge">Connected</span> : <button className="btn" type="button" onClick={connect} disabled={loading}>
      {loading ? 'Connecting…' : 'Connect Google'}
    </button>}
    {error && <p className="error-text" role="alert">{error}</p>}
  </>;
}

export default function IntegrationsPage() {
  return <Page eyebrow="Integrations" title="Connected apps" subtitle="Manage the services that provide customer, marketing, search, and website information."><div className="grid grid-3">{providers.map(([name, desc]) => <article className="card integration-card" key={name}><div className="integration-card-header"><div className="integration-logo">{name.slice(0,2).toUpperCase()}</div><div><h2 className="card-title">{name}</h2><p className="muted">{desc}</p></div></div><div className="integration-card-footer">{name === 'Google Analytics 4' ? <GoogleConnectButton provider="google_analytics_4" /> : name === 'Search Console' ? <GoogleConnectButton provider="google_search_console" /> : name === 'Google Business Profile' ? <GoogleConnectButton provider="google_business_profile" /> : <span className="badge">Managed by Capere</span>}</div></article>)}</div></Page>;
}
