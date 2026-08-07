import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Keep `next build` from corrupting a concurrently running dev server.
  distDir: process.env.NODE_ENV === 'development' ? '.next-dev' : '.next',
  poweredByHeader: false,
  allowedDevOrigins: ['103.127.30.140'],
  experimental: { serverActions: { bodySizeLimit: '2mb' } },
};

export default nextConfig;
