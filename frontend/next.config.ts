import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  experimental: { serverActions: { bodySizeLimit: '2mb' } },
  async headers() {
    const embeddedHeaders = [
      {
        key: 'Content-Security-Policy',
        value:
          "frame-ancestors 'self' https://dashboard.capereai.com https://app.gohighlevel.com https://*.gohighlevel.com https://app.leadconnectorhq.com https://*.leadconnectorhq.com;",
      },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    ];
    return [
      {
        // These are the two URLs registered in the GHL Marketplace custom
        // menu. GHL renders them in an iframe, so they need an explicit,
        // narrow frame policy instead of the default X-Frame-Options policy.
        source: '/embed/:path*',
        headers: [...embeddedHeaders,{key:'X-Robots-Tag',value:'noindex, nofollow'},{key:'Referrer-Policy',value:'no-referrer'}],
      },
      // Tab changes currently use the canonical routes. Keep those responses
      // frameable as well so navigating inside the GHL menu never breaks out.
      { source: '/seo', headers: embeddedHeaders },
      { source: '/cmo', headers: embeddedHeaders },
    ];
  },
};

export default nextConfig;
