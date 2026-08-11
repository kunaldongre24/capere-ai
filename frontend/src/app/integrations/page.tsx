import { Page } from '@/components/page';
import { IntegrationConnectPanel } from '@/components/integration-connect-panel';

export default function IntegrationsPage() {
  return <Page eyebrow="Integrations" title="Connected apps" subtitle="GoHighLevel is connected automatically. One Google authorization lets Capere discover and link matching Analytics, Search Console, and Business Profile resources for this sub-account."><IntegrationConnectPanel /></Page>;
}
