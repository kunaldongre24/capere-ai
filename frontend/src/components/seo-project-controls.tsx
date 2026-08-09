'use client';

import { useState } from 'react';

export function SeoProjectControls({ projectId, siteUrl }: { projectId?: string; siteUrl?: string }) {
  const [open, setOpen] = useState(!projectId);
  const [url, setUrl] = useState(siteUrl ?? '');
  const [name, setName] = useState('My website');
  const [location, setLocation] = useState('2356');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function save() {
    setBusy(true); setMessage(null);
    try {
      const response = await fetch('/api/capere/integrations/data-for-seo/projects', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name, siteUrl: url, targetLocationCode: Number(location), languageCode: 'en' }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error?.message ?? 'We could not save this website.');
      setMessage('Website saved. Your first review is being prepared.'); setOpen(false); window.location.reload();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'We could not save this website.'); }
    finally { setBusy(false); }
  }

  async function runReview() {
    if (!projectId) { setOpen(true); setMessage('Add your website first, then start a review.'); return; }
    setBusy(true); setMessage(null);
    try {
      const response = await fetch(`/api/capere/integrations/data-for-seo/projects/${projectId}/audits`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({maxCrawlPages:20}) });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error?.message ?? 'The review could not be started.');
      setMessage('Review started. Results will appear here when ready.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'The review could not be started.'); }
    finally { setBusy(false); }
  }

  return <div className="card" style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:16,flexWrap:'wrap',marginBottom:14}}><div><div className="eyebrow">Website review</div><strong>{siteUrl ?? 'No website added yet'}</strong><p style={{margin:'4px 0 0'}}>{projectId ? 'Your website is connected. Reviews are limited to 20 pages and run weekly.' : 'Add your website to start receiving clear improvement ideas.'}</p>{message&&<p style={{margin:'8px 0 0',color:message.includes('could')?'#b42318':'#1677ff'}}>{message}</p>}</div><div style={{display:'flex',gap:8}}><button className="btn secondary" type="button" onClick={()=>setOpen(!open)}>{projectId?'Change website':'Add website'}</button>{projectId&&<button className="btn" type="button" onClick={runReview} disabled={busy}>{busy?'Starting…':'Review website'}</button>}</div>{open&&<div style={{width:'100%',display:'grid',gridTemplateColumns:'2fr 1fr 1fr auto',gap:8,alignItems:'end'}}><label>Website address<input className="form-input" value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://yourfirm.com"/></label><label>Website name<input className="form-input" value={name} onChange={e=>setName(e.target.value)} placeholder="My website"/></label><label>Country code<input className="form-input" value={location} onChange={e=>setLocation(e.target.value)} placeholder="2356"/></label><button className="btn" type="button" onClick={save} disabled={busy||!url}>{busy?'Saving…':'Save website'}</button></div>}</div>;
}
