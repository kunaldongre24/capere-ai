'use client';
import { useState } from 'react';

type Competitor = { id: string; name: string; domain: string };
type Message = { text: string; tone: 'info' | 'warning' | 'error' };

function readableDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date(value));
}

export function CompetitorControls({ projectId, competitors = [] }: { projectId?: string; competitors?: Competitor[] }) {
  const [domain, setDomain] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editDomain, setEditDomain] = useState('');
  const [removingId, setRemovingId] = useState<string | null>(null);
  const limitReached = competitors.length >= 4;

  async function request(url: string, options: RequestInit, fallback: string) {
    const response = await fetch(url, options);
    const body = await response.json();
    if (!response.ok) throw new Error(body?.error?.message ?? fallback);
    return body;
  }

  async function add() {
    if (!projectId || !domain || !name || limitReached) return;
    setBusy(true); setMessage({ text: 'Saving the business. Capere will prepare the comparison automatically.', tone: 'info' });
    try {
      await request(`/api/capere/integrations/data-for-seo/projects/${projectId}/competitors`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domain, name }) }, 'Could not add competitor');
      setDomain(''); setName(''); window.location.reload();
    } catch (error) { setMessage({ text: error instanceof Error ? error.message : 'Could not add competitor', tone: 'error' }); }
    finally { setBusy(false); }
  }

  function startEdit(competitor: Competitor) {
    setEditingId(competitor.id); setEditName(competitor.name); setEditDomain(competitor.domain); setRemovingId(null); setMessage(null);
  }

  async function saveEdit() {
    if (!projectId || !editingId || !editName.trim() || !editDomain.trim()) return;
    setBusy(true);
    try {
      await request(`/api/capere/integrations/data-for-seo/projects/${projectId}/competitors/${editingId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: editName, domain: editDomain }) }, 'Could not update competitor');
      window.location.reload();
    } catch (error) { setMessage({ text: error instanceof Error ? error.message : 'Could not update competitor', tone: 'error' }); }
    finally { setBusy(false); }
  }

  async function remove(id: string) {
    if (!projectId) return;
    setBusy(true);
    try {
      await request(`/api/capere/integrations/data-for-seo/projects/${projectId}/competitors/${id}`, { method: 'DELETE' }, 'Could not remove competitor');
      window.location.reload();
    } catch (error) { setMessage({ text: error instanceof Error ? error.message : 'Could not remove competitor', tone: 'error' }); setRemovingId(null); }
    finally { setBusy(false); }
  }

  async function refresh() {
    if (!projectId) return;
    setBusy(true); setMessage(null);
    try {
      const body = await request(`/api/capere/integrations/data-for-seo/projects/${projectId}/competitors/refresh`, { method: 'POST' }, 'Could not refresh comparison');
      if (body?.data?.cached && body?.data?.nextEligibleAt) setMessage({ text: `Your comparison is current. You can refresh it again on ${readableDate(body.data.nextEligibleAt)}.`, tone: 'warning' });
      else { setMessage({ text: body?.data?.message ?? 'Comparison refreshed.', tone: 'info' }); window.location.reload(); }
    } catch (error) { setMessage({ text: error instanceof Error ? error.message : 'Could not refresh comparison', tone: 'error' }); }
    finally { setBusy(false); }
  }

  return <div className="competitor-setup">
    <div><div className="eyebrow">Comparison setup</div><strong>Businesses you want to compare</strong><p className="muted">Add, update, or remove up to four competitors. Search data can be refreshed once every 24 hours.</p></div>
    <div className="competitor-form"><input className="form-input" value={name} onChange={(event) => setName(event.target.value)} placeholder="Business name" disabled={limitReached}/><input className="form-input" value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="competitor.com" disabled={limitReached}/><button className="btn" type="button" disabled={busy || !projectId || !name || !domain || limitReached} onClick={add}>{limitReached ? 'Limit reached' : busy ? 'Please wait…' : 'Add competitor'}</button><button className="btn secondary" type="button" disabled={busy || !projectId || !competitors.length} onClick={refresh}>{busy ? 'Please wait…' : 'Refresh comparison'}</button></div>
    {competitors.length > 0 && <div className="competitor-manage-list">{competitors.map((competitor) => <div className="competitor-manage-row" key={competitor.id}>
      {editingId === competitor.id ? <><div className="competitor-edit-fields"><input className="form-input" value={editName} onChange={(event) => setEditName(event.target.value)} aria-label="Business name"/><input className="form-input" value={editDomain} onChange={(event) => setEditDomain(event.target.value)} aria-label="Website domain"/></div><div className="competitor-row-actions"><button className="btn small" type="button" disabled={busy || !editName.trim() || !editDomain.trim()} onClick={saveEdit}>Save</button><button className="btn secondary small" type="button" disabled={busy} onClick={() => setEditingId(null)}>Cancel</button></div></> : <><div className="competitor-row-identity"><strong>{competitor.name}</strong><span>{competitor.domain}</span></div><div className="competitor-row-actions">{removingId === competitor.id ? <><span>Remove this competitor?</span><button className="btn danger small" type="button" disabled={busy} onClick={() => remove(competitor.id)}>Remove</button><button className="btn secondary small" type="button" disabled={busy} onClick={() => setRemovingId(null)}>Cancel</button></> : <><button className="btn secondary small" type="button" disabled={busy} onClick={() => startEdit(competitor)}>Edit</button><button className="btn subtle-danger small" type="button" disabled={busy} onClick={() => { setRemovingId(competitor.id); setEditingId(null); }}>Remove</button></>}</div></>}
    </div>)}</div>}
    {limitReached && <div className="competitor-limit-banner" role="status"><div><strong>Competitor limit reached</strong><p>Remove or edit a business before adding another.</p></div><span className="competitor-limit-count">4 of 4 used</span></div>}
    {message && <div className={`competitor-toast ${message.tone}`} role="status"><span>{message.text}</span><button type="button" onClick={() => setMessage(null)}>Dismiss</button></div>}
  </div>;
}
