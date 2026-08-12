'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';

type Session = {
  id: string;
  title: string | null;
  summary_title: string | null;
  preview: string | null;
  last_message_at: string | null;
  created_at: string;
};
type Message = { role: 'user' | 'assistant'; content: string; createdAt: string; sources?: string[] };
type Envelope<T> = { data: T };

const prompts = [
  'What should we focus on this week?',
  'Explain our marketing performance in simple language.',
  'Where could we improve revenue?',
  'How is our search visibility performing?',
];

function renderInline(value: string) {
  return value.split(/(\*\*[^*]+\*\*)/g).map((part, index) =>
    part.startsWith('**') && part.endsWith('**')
      ? <strong key={index}>{part.slice(2, -2)}</strong>
      : part,
  );
}

function isTableDivider(value: string) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(value);
}

function tableCells(value: string) {
  return value.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

function MessageBody({ content }: { content: string }) {
  const lines = content.split('\n');
  const blocks: React.ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    if (index + 1 < lines.length && lines[index].includes('|') && isTableDivider(lines[index + 1])) {
      const headers = tableCells(lines[index]);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(tableCells(lines[index]));
        index += 1;
      }
      blocks.push(<div className="ask-cmo-table-wrap" key={`table-${index}`}><table className="ask-cmo-response-table"><thead><tr>{headers.map((header, cellIndex) => <th key={cellIndex}>{renderInline(header)}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{headers.map((_, cellIndex) => <td key={cellIndex}>{renderInline(row[cellIndex] ?? '—')}</td>)}</tr>)}</tbody></table></div>);
      continue;
    }
    const line = lines[index];
    const bullet = line.match(/^\s*[-*]\s+(.+)/);
    if (bullet) blocks.push(<div className="ask-cmo-bullet" key={index}><span>•</span><p>{renderInline(bullet[1])}</p></div>);
    else if (/^\s*-{3,}\s*$/.test(line)) blocks.push(<hr className="ask-cmo-rule" key={index}/>);
    else if (!line.trim()) blocks.push(<div className="ask-cmo-space" key={index} />);
    else blocks.push(<p key={index}>{renderInline(line.replace(/^#{1,4}\s*/, ''))}</p>);
    index += 1;
  }
  return <div className="ask-cmo-copy">{blocks}</div>;
}

export function AskCmoChat() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  async function loadConversation(id: string) {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/capere/command-centers/ai-cmo/conversations/${id}`, { cache: 'no-store' });
      if (!response.ok) throw new Error('This conversation could not be loaded.');
      const payload = await response.json() as Envelope<{ messages: Message[] }>;
      setSessionId(id);
      setMessages(payload.data.messages);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'This conversation could not be loaded.');
    } finally {
      setLoading(false);
    }
  }

  async function loadSessions(selectLatest = true) {
    try {
      const response = await fetch('/api/capere/command-centers/ai-cmo/conversations', { cache: 'no-store' });
      if (!response.ok) throw new Error('Conversation history is unavailable.');
      const payload = await response.json() as Envelope<Session[]>;
      setSessions(payload.data);
      if (selectLatest && payload.data[0]) await loadConversation(payload.data[0].id);
      else setLoading(false);
    } catch {
      setLoading(false);
    }
  }

  useEffect(() => { void loadSessions(); }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [messages, sending]);

  function startNew() {
    setSessionId(null);
    setMessages([]);
    setError(null);
    setInput('');
  }

  async function send(question?: string) {
    const message = (question ?? input).trim();
    if (!message || sending) return;
    setInput('');
    setError(null);
    setSending(true);
    setMessages((current) => [...current, { role: 'user', content: message, createdAt: new Date().toISOString() }]);
    try {
      const response = await fetch('/api/capere/command-centers/ai-cmo/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, ...(sessionId ? { sessionId } : {}) }),
      });
      const payload = await response.json() as Envelope<{ sessionId: string; message: string; sources: string[] }> & { error?: { message?: string } };
      if (!response.ok) throw new Error(payload.error?.message ?? 'Ask CMO could not prepare an answer.');
      setSessionId(payload.data.sessionId);
      setMessages((current) => [...current, { role: 'assistant', content: payload.data.message, sources: payload.data.sources ?? [], createdAt: new Date().toISOString() }]);
      void loadSessions(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Ask CMO could not prepare an answer.');
    } finally {
      setSending(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void send();
  }

  return <div className="ask-cmo-shell">
    <aside className="ask-cmo-history">
      <div className="ask-cmo-history-head">
        <div><strong>Conversations</strong><span>Your recent CMO discussions</span></div>
        <button className="btn btn-secondary ask-cmo-new" type="button" onClick={startNew}>New</button>
      </div>
      <div className="ask-cmo-session-list">
        {sessions.map((session) => <button className={`ask-cmo-session ${sessionId === session.id ? 'active' : ''}`} type="button" key={session.id} onClick={() => void loadConversation(session.id)}>
          <strong>{session.summary_title || session.title || 'New CMO conversation'}</strong>
          {session.preview && <p>{session.preview}</p>}
          <span>{new Date(session.last_message_at ?? session.created_at).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
        </button>)}
        {!sessions.length && !loading && <p className="ask-cmo-history-empty">Your conversations will appear here.</p>}
      </div>
    </aside>

    <section className="ask-cmo-workspace">
      <header className="ask-cmo-header">
        <div><div className="eyebrow">Ask CMO</div><h2>Business guidance based on your connected data</h2><p>Ask in everyday language. Capere will explain what the numbers mean and suggest practical next steps.</p></div>
        <span className="ask-cmo-grounded">Connected business data</span>
      </header>

      <div className="ask-cmo-messages" aria-live="polite">
        {loading ? <div className="ask-cmo-loading"><span className="ask-cmo-spinner"/><strong>Loading your conversation…</strong></div> : !messages.length ? <div className="ask-cmo-welcome">
          <div className="ask-cmo-avatar">C</div>
          <h3>What would you like to understand?</h3>
          <p>I can review website traffic, search visibility, pipeline activity, SEO health, and current recommendations.</p>
          <div className="ask-cmo-suggestions">{prompts.map((prompt) => <button type="button" key={prompt} onClick={() => void send(prompt)}>{prompt}</button>)}</div>
        </div> : messages.map((message, index) => <article className={`ask-cmo-message ${message.role}`} key={`${message.createdAt}-${index}`}>
          <div className="ask-cmo-message-avatar">{message.role === 'assistant' ? 'C' : 'You'}</div>
          <div className="ask-cmo-message-content"><div className="ask-cmo-message-meta"><strong>{message.role === 'assistant' ? 'Capere AI CMO' : 'You'}</strong><time>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div><MessageBody content={message.content}/>{message.role === 'assistant' && message.sources && message.sources.length > 0 && <div className="ask-cmo-sources"><span>Data checked</span>{message.sources.map((source) => <small key={source}>{source}</small>)}</div>}</div>
        </article>)}
        {sending && <article className="ask-cmo-message assistant"><div className="ask-cmo-message-avatar">C</div><div className="ask-cmo-message-content ask-cmo-thinking"><span className="ask-cmo-spinner"/><div><strong>Reviewing your business data</strong><p>This can take a few moments while Capere checks the relevant sources.</p></div></div></article>}
        <div ref={endRef}/>
      </div>

      {error && <div className="ask-cmo-error" role="alert">{error} <button type="button" onClick={() => setError(null)}>Dismiss</button></div>}
      <form className="ask-cmo-composer" onSubmit={submit}>
        <textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder="Ask about marketing, revenue, leads, website traffic, or search performance…" rows={2} maxLength={2000} disabled={sending}/>
        <div className="ask-cmo-composer-foot"><span>Capere provides guidance; actions still require your approval.</span><button className="btn" type="submit" disabled={sending || input.trim().length < 2}>{sending ? 'Preparing answer…' : 'Ask CMO'}</button></div>
      </form>
    </section>
  </div>;
}
