import { SeoDashboardWidget } from '@/components/seo-dashboard-widget';

export default async function SeoDashboardPage({searchParams}:{searchParams:Promise<{key?:string}>}){const{key}=await searchParams;return <SeoDashboardWidget bootstrapKey={key}/>}
