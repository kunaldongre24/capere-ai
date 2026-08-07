import './globals.css';
import { AppChrome } from '@/components/app-chrome';

export const metadata = { title: 'Capere AI', description: 'AI Growth Operating System for CPA firms' };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{__html:`try{document.documentElement.dataset.theme=localStorage.getItem('capere-theme')==='dark'?'dark':'light'}catch(e){document.documentElement.dataset.theme='light'}`}} /></head><body><AppChrome>{children}</AppChrome></body></html>;
}
