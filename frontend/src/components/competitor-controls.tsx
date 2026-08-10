'use client';
import { useState } from 'react';

function readableDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

export function CompetitorControls({ projectId, competitorCount = 0 }: { projectId?: string; competitorCount?: number }) {
  const [domain, setDomain] = useState(''); const [name, setName] = useState(''); const [busy, setBusy] = useState(false); const [message, setMessage] = useState<{text:string;tone:'info'|'warning'|'error'} | null>(null);
  const limitReached=competitorCount>=4;
  async function add() { if (!projectId || !domain || !name || limitReached) return; setBusy(true); setMessage({text:'Saving the business. Capere will prepare the comparison automatically.',tone:'info'}); try { const r = await fetch(`/api/capere/integrations/data-for-seo/projects/${projectId}/competitors`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({domain,name}) }); const b=await r.json(); if(!r.ok) throw new Error(b?.error?.message??'Could not add competitor'); setDomain(''); setName(''); setMessage({text:'Competitor added. Comparison data will be prepared automatically.',tone:'info'}); window.location.reload(); } catch(e) { setMessage({text:e instanceof Error?e.message:'Could not add competitor',tone:'error'}); } finally { setBusy(false); } }
  async function refresh() { if (!projectId) return; setBusy(true); setMessage(null); try { const r=await fetch(`/api/capere/integrations/data-for-seo/projects/${projectId}/competitors/refresh`, { method:'POST' }); const b=await r.json(); if(!r.ok) throw new Error(b?.error?.message??'Could not refresh comparison'); if(b?.data?.cached&&b?.data?.nextEligibleAt)setMessage({text:`Your comparison is current. You can refresh it again on ${readableDate(b.data.nextEligibleAt)}.`,tone:'warning'});else setMessage({text:b?.data?.message??'Comparison refreshed.',tone:'info'}); if(!b?.data?.cached)window.location.reload(); } catch(e) { setMessage({text:e instanceof Error?e.message:'Could not refresh comparison',tone:'error'}); } finally { setBusy(false); } }
  return <div className="competitor-setup"><div><div className="eyebrow">Comparison setup</div><strong>Add businesses you want to compare</strong><p className="muted">Compare up to four businesses. Search comparison data can be refreshed once every 24 hours.</p></div><div className="competitor-form"><input className="form-input" value={name} onChange={e=>setName(e.target.value)} placeholder="Business name" disabled={limitReached}/><input className="form-input" value={domain} onChange={e=>setDomain(e.target.value)} placeholder="competitor.com" disabled={limitReached}/><button className="btn" type="button" disabled={busy||!projectId||!name||!domain||limitReached} onClick={add}>{limitReached?'Limit reached':busy?'Adding…':'Add competitor'}</button><button className="btn secondary" type="button" disabled={busy||!projectId||!competitorCount} onClick={refresh}>{busy?'Please wait…':'Refresh comparison'}</button></div>{limitReached&&<div className="competitor-limit-banner" role="status"><div><strong>Competitor limit reached</strong><p>You are currently comparing the maximum of four businesses for this website.</p></div><span className="competitor-limit-count">4 of 4 used</span></div>}{message&&<div className={`competitor-toast ${message.tone}`} role="status"><span>{message.text}</span><button type="button" onClick={()=>setMessage(null)}>Dismiss</button></div>}</div>;
}
