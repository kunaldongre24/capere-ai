'use client';

import { usePathname } from 'next/navigation';
import { Bell, CircleHelp, Search } from 'lucide-react';
import { Sidebar } from './sidebar';
import { ThemeToggle } from './theme-toggle';
import { logout } from '@/app/auth/actions';
import { useEffect, useState } from 'react';
import Link from 'next/link';

const CHROMELESS_PREFIXES = ['/login', '/auth/', '/launch/ghl', '/onboarding', '/seo', '/cmo'];

export function AppChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [identity, setIdentity] = useState({ workspaceName: 'Your workspace', initials: 'U', profileLabel: 'User account' });
  const [profileOpen, setProfileOpen] = useState(false);
  const chromeless = CHROMELESS_PREFIXES.some((prefix) =>
    prefix.endsWith('/') ? pathname.startsWith(prefix) : pathname === prefix,
  );

  useEffect(() => {
    if (chromeless) return;
    let active = true;
    Promise.all([
      fetch('/api/capere/organizations/mine').then((r) => r.ok ? r.json() : null),
      fetch('/api/capere/organizations/me/profile').then((r) => r.ok ? r.json() : null),
    ]).then(([organizations, profile]) => {
      if (!active) return;
      const organization = organizations?.data?.[0];
      const user = profile?.data;
      const label = user?.full_name || user?.email || 'User account';
      const initials = user?.full_name
        ? user.full_name.split(/\s+/).slice(0, 2).map((part: string) => part[0]).join('').toUpperCase()
        : user?.email?.slice(0, 2).toUpperCase() || 'U';
      setIdentity({ workspaceName: organization?.name || 'Your workspace', initials, profileLabel: label });
    }).catch(() => undefined);
    return () => { active = false; };
  }, [chromeless]);

  if (chromeless) return <main className="public-main">{children}</main>;

  return (
    <div className="shell">
      <Sidebar workspaceName={identity.workspaceName} />
      <main className="main">
        <header className="topbar">
          <span className="topbar-title">Growth workspace</span>
          <div className="topbar-actions">
            <button className="icon-button" aria-label="Search"><Search size={17} /></button>
            <button className="icon-button" aria-label="Help"><CircleHelp size={17} /></button>
            <ThemeToggle />
            <button className="icon-button" aria-label="Notifications"><Bell size={17} /></button>
            <div className="profile-control"><button className="avatar avatar-button" type="button" onClick={() => setProfileOpen((open) => !open)} title={identity.profileLabel} aria-label="Open profile menu" aria-expanded={profileOpen}>{identity.initials}</button>{profileOpen&&<div className="profile-menu"><div className="profile-summary"><div className="profile-name">{identity.profileLabel}</div><div className="profile-workspace">{identity.workspaceName}</div></div><Link href="/settings" className="profile-menu-item" onClick={()=>setProfileOpen(false)}>Profile & settings</Link><form action={logout}><button className="profile-menu-item danger" type="submit">Sign out</button></form></div>}</div>
          </div>
        </header>
        {children}
      </main>
    </div>
  );
}
