'use client';

import { useEffect } from 'react';

export default function GoogleOauthCompletePage() {
  useEffect(() => {
    window.opener?.postMessage({ message: 'CAPERE_GOOGLE_OAUTH_COMPLETE' }, window.location.origin);
    window.close();
  }, []);

  return <main className="auth-page"><section className="card auth-card"><div className="brand-mark">C</div><div className="eyebrow">Google connected</div><h1 className="title">Connection complete</h1><p className="subtitle">You can close this window and return to Marketing Advisor.</p></section></main>;
}
