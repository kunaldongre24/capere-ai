'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BarChart3, Bot, ChevronDown, FileText, Gauge, KeyRound, Lightbulb, ListTodo, Plug, Search, Settings, Users, Workflow } from 'lucide-react';
const groups = [
  { label:'Workspace', items:[['Dashboard','/',Gauge],['SEO Command Center','/seo',Search],['AI CMO','/cmo',Bot],['Recommendations','/recommendations',Lightbulb]] },
  { label:'Execution', items:[['Content','/content',FileText],['Knowledge','/knowledge',FileText],['Automations','/automations',Workflow],['Reports','/reports',BarChart3]] },
  { label:'Operations', items:[['Integrations','/integrations',Plug],['Jobs','/jobs',ListTodo],['Team & settings','/settings',Settings]] },
] as const;
export function Sidebar({ workspaceName = 'Your workspace' }: { workspaceName?: string }){ const pathname=usePathname(); return <aside className="sidebar"><div className="brand-row"><div className="brand-mark">C</div><div className="brand">Capere <span>AI</span></div></div><div className="workspace-picker"><div><div className="workspace-name">{workspaceName}</div><div className="workspace-type">CPA firm workspace</div></div><ChevronDown size={15}/></div><div className="nav-scroll">{groups.map(g=><div key={g.label}><div className="nav-label">{g.label}</div>{g.items.map(([label,href,Icon])=>{const active=href==='/'?pathname===href:pathname.startsWith(href);return <Link className={`nav-link${active?' active':''}`} href={href} key={href}><Icon size={16}/><span>{label}</span></Link>})}</div>)}</div><div className="sidebar-footer"><div className="nav-link"><Users size={16}/><span>CPA playbook</span></div><div className="nav-link"><KeyRound size={16}/><span>Security</span></div></div></aside> }
