import { redirect } from 'next/navigation';

type Props = { searchParams: Promise<{ module?: string }> };

export default async function GhlLaunch({ searchParams }: Props) {
  const { module } = await searchParams;

  if (module === 'seo' || module === 'cmo') {
    redirect(`/${module}`);
  }

  return (
    <div className="auth-page">
      <div className="card" style={{ maxWidth: 520 }}>
        <div className="eyebrow">GoHighLevel secure launch</div>
        <h1 className="title">Module not specified</h1>
        <p className="muted">
          Open this page from a configured Capere AI custom menu in GoHighLevel.
        </p>
        <span className="badge">Use module=seo or module=cmo</span>
      </div>
    </div>
  );
}
