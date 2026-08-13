'use client';

import { useEffect, useState } from 'react';

const parentOriginAllowed = (origin: string) => {
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return host === 'dashboard.capereai.com' || host === 'app.gohighlevel.com' || host.endsWith('.gohighlevel.com') || host === 'app.leadconnectorhq.com' || host.endsWith('.leadconnectorhq.com');
  } catch { return false; }
};

export function GhlSsoGate({ product, destination }: { product: string; destination: string }) {
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let finished = false;
    let timer: ReturnType<typeof setTimeout>;
    const referrerOrigin = (() => { try { return new URL(document.referrer).origin; } catch { return ''; } })();
    const fail = (message: string) => {
      if (finished) return;
      finished = true;
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      setError(message);
    };
    const onMessage = async (event: MessageEvent) => {
      if (finished || event.source !== window.parent || !parentOriginAllowed(event.origin) || event.data?.message !== 'REQUEST_USER_DATA_RESPONSE' || typeof event.data?.payload !== 'string') return;
      finished = true;
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      try {
        const response = await fetch('/api/auth/ghl-sso', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ encryptedData: event.data.payload }),
        });
        const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
        if (!response.ok) {
          setError(body.error?.message ?? 'Your GoHighLevel session could not be verified.');
          return;
        }
        window.location.replace(destination);
      } catch {
        setError('Capere could not establish a secure session. Please try again.');
      }
    };
    window.addEventListener('message', onMessage);
    timer = setTimeout(() => fail('Open this page from the Capere menu inside GoHighLevel.'), 12_000);
    if (window.parent === window || !parentOriginAllowed(referrerOrigin)) {
      fail('Open this page from the Capere menu inside GoHighLevel.');
      return;
    }
    window.parent.postMessage({ message: 'REQUEST_USER_DATA' }, referrerOrigin);
    return () => { finished = true; window.removeEventListener('message', onMessage); clearTimeout(timer); };
  }, [attempt, destination]);

  return <main className="auth-page"><section className="card auth-card ghl-sso-card" aria-live="polite"><div className="brand-mark">C</div><div className="eyebrow">{product}</div><h1 className="title">Connecting securely</h1>{!error ? <><p className="subtitle">Confirming your GoHighLevel account and sub-account access.</p><div className="sso-spinner" aria-label="Authenticating" /></> : <><p className="form-error">{error}</p><button className="btn" type="button" onClick={() => { setError(''); setAttempt((n) => n + 1); }}>Try again</button></>}</section></main>;
}
