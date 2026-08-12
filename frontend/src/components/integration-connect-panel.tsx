'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

const providers = [
  ['GoHighLevel', 'CRM, leads, opportunities, conversations, workflows'],
  ['Google Analytics 4', 'Traffic, conversions, events, and revenue'],
  ['Search Console', 'Queries, clicks, impressions, CTR, position'],
  ['Google Business Profile', 'Business listing, ratings, and customer reviews through GoHighLevel'],
  ['DataForSEO', 'Keywords, SERPs, competitors, backlinks'],
  ['GitHub', 'Repository analysis and approved changes'],
] as const;

function GoogleConnectButton({ provider, label, embedded }: { provider: string; label: string; embedded: boolean }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [authorizationId, setAuthorizationId] = useState<string | null>(null);
  const [options, setOptions] = useState<Array<{ id: string; name?: string; parentAccount?: string }>>([]);
  const [selected, setSelected] = useState('');

  const refreshStatus = async () => {
    const response = await fetch('/api/capere/integrations/google/connection-status');
    const body = response.ok ? await response.json() : null;
    const status = body?.data;
    setAuthorized(Boolean(status?.authorized));
    const isConnected = (status?.integrations ?? []).some((item: { provider?: string; status?: string }) => item.status === 'connected' && item.provider === provider);
    setConnected(isConnected);
    setAuthorizationId(status?.authorizationId ?? null);
    if (status?.authorizationId && !isConnected) {
      const resourcesResponse = await fetch(`/api/capere/integrations/google/available-resources?authorizationId=${encodeURIComponent(status.authorizationId)}&provider=${encodeURIComponent(provider)}`);
      const resourcesBody = resourcesResponse.ok ? await resourcesResponse.json() : null;
      const key = provider === 'google_analytics_4' ? 'ga4' : provider === 'google_search_console' ? 'gsc' : 'gbp';
      const discovered = (resourcesBody?.data?.[key] ?? []).filter((item: { id?: string }) => Boolean(item.id));
      setOptions(discovered);
      setSelected((current) => current || discovered[0]?.id || '');
      const warning = resourcesBody?.data?.warnings?.[0]?.message;
      setError(warning ?? (discovered.length === 0 ? `No accessible ${label} resources were found in this Google account.` : null));
    } else if (isConnected) setOptions([]);
    return status;
  };

  useEffect(() => {
    refreshStatus();
    const onMessage = (event: MessageEvent) => {
      if (event.origin === window.location.origin && event.data?.message === 'CAPERE_GOOGLE_OAUTH_COMPLETE') {
        setLoading(false);
        refreshStatus();
      }
    };
    window.addEventListener('message', onMessage);
    const onFocus = () => { setLoading(false); void refreshStatus(); };
    window.addEventListener('focus', onFocus);
    return () => { window.removeEventListener('message', onMessage); window.removeEventListener('focus', onFocus); };
  }, [provider]);

  async function connect() {
    setLoading(true); setError(null);
    const popup = embedded ? window.open('about:blank', 'capere-google-oauth', 'popup,width=640,height=760') : null;
    if (embedded && !popup) {
      setError('Allow pop-ups for Capere to connect Google securely outside the GoHighLevel iframe.');
      setLoading(false);
      return;
    }
    try {
      const startedAt = Date.now();
      const response = await fetch(`/api/capere/integrations/google/authorize${embedded ? '?returnTo=cmo' : ''}`);
      const body = await response.json();
      if (!response.ok || !body?.data?.authorizationUrl) throw new Error(body?.error?.message ?? 'Unable to start Google authorization');
      if (popup) popup.location.href = body.data.authorizationUrl;
      else window.location.assign(body.data.authorizationUrl);
      if (popup) {
        const interval = window.setInterval(async () => {
          const status = await refreshStatus().catch(() => null);
          const authorizedAt = status?.authorizedAt ? new Date(status.authorizedAt).getTime() : 0;
          if (authorizedAt >= startedAt - 1_000 || Date.now() - startedAt > 120_000) {
            window.clearInterval(interval);
            setLoading(false);
          }
        }, 2_000);
      }
    } catch (cause) {
      popup?.close();
      setError(cause instanceof Error ? cause.message : 'Unable to start Google authorization'); setLoading(false);
    }
  }

  async function linkSelected() {
    if (!authorizationId || !selected) return;
    setLoading(true); setError(null);
    const option = options.find((item) => item.id === selected);
    try {
      const response = await fetch(`/api/capere/integrations/google/resources?authorizationId=${encodeURIComponent(authorizationId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider, resourceId: selected, resourceName: option?.name, parentAccount: option?.parentAccount }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message ?? `Unable to link ${label}`);
      await refreshStatus();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Unable to link ${label}`);
    } finally { setLoading(false); }
  }

  return <>{connected ? <span className="badge">Connected</span> : options.length ? <div><select value={selected} onChange={(event) => setSelected(event.target.value)} aria-label={`Choose ${label} resource`}>{options.map((option) => <option key={option.id} value={option.id}>{option.name || option.id}</option>)}</select><button className="btn" type="button" onClick={linkSelected} disabled={loading || !selected}>{loading ? 'Linking…' : `Link ${label}`}</button></div> : authorized ? <button className="btn" type="button" onClick={() => void refreshStatus()} disabled={loading}>{loading ? 'Checking…' : `Retry ${label} discovery`}</button> : <button className="btn" type="button" onClick={connect} disabled={loading}>{loading ? 'Waiting for Google…' : `Connect ${label}`}</button>}{error && <p className="error-text" role="alert">{error}</p>}</>;
}

export function IntegrationConnectPanel({ embedded = false, gbpConnected = false }: { embedded?: boolean; gbpConnected?: boolean }) {
  const searchParams = useSearchParams();
  const linked = Number(searchParams.get('linked') ?? 0);
  const unmatched = Number(searchParams.get('unmatched') ?? 0);
  return <div className={embedded ? 'cmo-layout' : undefined}>
    {searchParams.get('google') === 'connected' && <div className="card"><strong>Google authorization complete</strong><p className="muted">Capere linked {linked} matching service{linked === 1 ? '' : 's'} automatically{unmatched ? `; ${unmatched} service${unmatched === 1 ? '' : 's'} need a unique matching resource.` : '.'}</p></div>}
    <div className="grid grid-3">{providers.map(([name, desc]) => <article className="card integration-card" key={name}><div className="integration-card-header"><div className="integration-logo">{name.slice(0, 2).toUpperCase()}</div><div><h2 className="card-title">{name}</h2><p className="muted">{desc}</p></div></div><div className="integration-card-footer">{name === 'Google Analytics 4' ? <GoogleConnectButton provider="google_analytics_4" label="Analytics" embedded={embedded} /> : name === 'Search Console' ? <GoogleConnectButton provider="google_search_console" label="Search Console" embedded={embedded} /> : name === 'Google Business Profile' ? gbpConnected?<span className="badge good">Connected through GoHighLevel</span>:<GbpConnectButton/> : <span className="badge">Managed by Capere</span>}</div></article>)}</div>
  </div>;
}

function GbpConnectButton(){
  const [loading,setLoading]=useState(false),[error,setError]=useState<string|null>(null);
  async function open(){setLoading(true);setError(null);try{const response=await fetch('/api/capere/command-centers/ai-cmo/business-profile/connect-url');const body=await response.json();if(!response.ok||!body?.data?.url)throw new Error(body?.error?.message??'Unable to open GoHighLevel');window.open(body.data.url,'_blank','noopener,noreferrer');}catch(cause){setError(cause instanceof Error?cause.message:'Unable to open GoHighLevel');}finally{setLoading(false)}}
  return <div><button className="btn" type="button" onClick={open} disabled={loading}>{loading?'Opening GoHighLevel…':'Connect GBP in GoHighLevel'}</button>{error&&<p className="error-text" role="alert">{error}</p>}</div>;
}
