export function Page({
  eyebrow,
  title,
  subtitle,
  children,
  action,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="content app-page">
      <header className="page-header">
        <div>
          <div className="eyebrow">{eyebrow}</div>
          <h1 className="title">{title}</h1>
          {subtitle && <p className="subtitle">{subtitle}</p>}
        </div>
        {action && <div className="page-actions">{action}</div>}
      </header>
      {children}
    </section>
  );
}
export function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="card stat-card">
      <div className="metric-label">{label}</div>
      <div className="metric">{value}</div>
      <div className="muted stat-detail">{detail}</div>
    </div>
  );
}
export function EmptyState({
  title,
  body,
  badge = 'Setup required',
}: {
  title: string;
  body: string;
  badge?: string;
}) {
  return (
    <div className="card empty-state">
      <div className="empty-state-icon" aria-hidden>
        ◇
      </div>
      <h3 className="card-title">{title}</h3>
      <p className="muted">{body}</p>
      <span className="badge">{badge}</span>
    </div>
  );
}
