'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type WebsiteStatus = {
  status: 'connected' | 'provisioning' | 'missing' | 'change_pending' | 'unavailable';
  currentWebsite: string | null;
  ghlWebsite: string | null;
  message: string;
};

const domain = (value: string | null) => {
  if (!value) return '';
  try { return new URL(value).hostname.replace(/^www\./, ''); } catch { return value; }
};

export function SeoWebsiteStatus({ value }: { value: WebsiteStatus | null }) {
  const router = useRouter();
  const [website, setWebsite] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const resolved: WebsiteStatus = value ?? {
    status: 'missing',
    currentWebsite: null,
    ghlWebsite: null,
    message: 'Add your website to begin your first review.',
  };

  async function save(siteUrl: string, confirmChange: boolean) {
    setBusy(true); setMessage(null);
    try {
      const normalized = siteUrl.trim().includes('://') ? siteUrl.trim() : `https://${siteUrl.trim()}`;
      const response = await fetch('/api/capere/integrations/data-for-seo/website', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteUrl: normalized, confirmChange }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message ?? 'The website could not be saved.');
      setMessage('Website connected. Your first review is being prepared.');
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The website could not be saved.');
    } finally { setBusy(false); }
  }

  if (resolved.status === 'missing' || (resolved.status === 'unavailable' && !resolved.currentWebsite)) return (
    <section className="seo-website-status attention">
      <div className="seo-website-copy"><span>Website setup</span><strong>Add your business website</strong><p>{resolved.message || 'Enter the website customers use to find your business. Capere will prepare the first review automatically.'}</p></div>
      <div className="seo-website-form"><input className="form-input" value={website} onChange={(event)=>setWebsite(event.target.value)} placeholder="yourbusiness.com" aria-label="Business website"/><button className="btn" disabled={busy||!website.trim()} onClick={()=>save(website,false)}>{busy?'Saving…':'Add website'}</button></div>
      {message&&<p className="seo-website-message">{message}</p>}
    </section>
  );

  if (resolved.status === 'change_pending' && resolved.ghlWebsite && !dismissed) return (
    <section className="seo-website-status warning">
      <div className="seo-website-copy"><span>Website update found</span><strong>{domain(resolved.ghlWebsite)}</strong><p>GoHighLevel now lists this website. Confirm it to begin new reports while keeping your previous audit history.</p><small>Current website: {domain(resolved.currentWebsite)}</small></div>
      <div className="seo-website-actions"><button className="btn secondary" disabled={busy} onClick={()=>setDismissed(true)}>Keep current</button><button className="btn" disabled={busy} onClick={()=>save(resolved.ghlWebsite!,true)}>{busy?'Updating…':'Use this website'}</button></div>
      {message&&<p className="seo-website-message">{message}</p>}
    </section>
  );

  return (
    <section className={`seo-website-status ${resolved.status}`}>
      <div className="seo-website-copy"><span>{resolved.status==='unavailable'?'Website status':'Website being reviewed'}</span><strong>{domain(resolved.currentWebsite)||'Waiting for website details'}</strong><p>{resolved.message}</p></div>
      {resolved.status==='connected'&&<div className="seo-website-badge">Connected</div>}
    </section>
  );
}
