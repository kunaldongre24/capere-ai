export function AppLoader({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? 'app-loader compact' : 'app-loader'} role="status" aria-live="polite" aria-label="Loading page">
      <div className="loader-progress"><span /></div>
      <div className="loader-heading">
        <span className="skeleton skeleton-eyebrow" />
        <span className="skeleton skeleton-title" />
        <span className="skeleton skeleton-subtitle" />
      </div>
      <div className="loader-tabs">
        {Array.from({ length: 6 }, (_, index) => <span className="skeleton" key={index} />)}
      </div>
      <div className="loader-grid">
        {Array.from({ length: 3 }, (_, index) => <div className="loader-card" key={index}><span className="skeleton skeleton-label" /><span className="skeleton skeleton-value" /><span className="skeleton skeleton-detail" /></div>)}
      </div>
      <div className="loader-panel"><span className="skeleton skeleton-panel-title" /><span className="skeleton skeleton-line" /><span className="skeleton skeleton-line short" /><span className="sr-only">Loading your latest business data…</span></div>
    </div>
  );
}
