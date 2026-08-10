'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

export function CompetitorPending({ names }: { names: string[] }) {
  const router = useRouter();
  useEffect(() => {
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      router.refresh();
      if (attempts >= 8) window.clearInterval(timer);
    }, 7500);
    return () => window.clearInterval(timer);
  }, [router]);
  return <div className="comparison-pending" role="status"><strong>Preparing comparison data</strong><p>Capere is collecting search visibility for {names.join(', ')}. This normally finishes within 5–20 seconds. The figures will update automatically.</p></div>;
}
