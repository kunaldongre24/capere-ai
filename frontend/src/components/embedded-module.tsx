import { EmbeddedTabs } from './embedded-tabs';

type Tab = { label: string; href: string; active?: boolean };

export function EmbeddedModule({
  product,
  title,
  description,
  tabs,
  children,
}: {
  product: string;
  title: string;
  description: string;
  tabs: Tab[];
  children: React.ReactNode;
}) {
  return <main className="embedded-app"><header className="embedded-header"><div className="embedded-brand"><span className="embedded-mark">C</span><span>Capere AI</span><span className="embedded-divider"/><span className="embedded-product">{product}</span></div><span className="connection-status"><span className="status-dot"/>GoHighLevel connected</span></header><section className="embedded-heading"><div><div className="eyebrow">{product}</div><h1 className="title">{title}</h1><p className="subtitle">{description}</p></div></section><EmbeddedTabs product={product} tabs={tabs}/><section className="embedded-content">{children}</section></main>;
}
