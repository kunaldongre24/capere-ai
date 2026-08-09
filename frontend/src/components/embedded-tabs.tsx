'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

type Tab = { label: string; href: string; active?: boolean };

export function EmbeddedTabs({ product, tabs }: { product: string; tabs: Tab[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const current = `${pathname}${searchParams.size ? `?${searchParams.toString()}` : ''}`;
  return <div className="embedded-tabs-wrap">
    {pending && <div className="tab-loading-bar" role="status" aria-label={`Loading ${product} section`}><span /></div>}
    <nav className="embedded-tabs" aria-label={`${product} sections`} aria-busy={pending}>
      {tabs.map((tab) => <button type="button" key={tab.href} className={`embedded-tab${tab.active ? ' active' : ''}`} disabled={pending && tab.href === current} onClick={() => { if (tab.href === current) return; startTransition(() => router.push(tab.href)); }}>{tab.label}</button>)}
    </nav>
  </div>;
}
