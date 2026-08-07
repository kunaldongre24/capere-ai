import type { NextConfig } from 'next';
import path from 'node:path';

const nextConfig: NextConfig = {
  // Keep `next build` from corrupting a concurrently running dev server.
  distDir: process.env.NODE_ENV === 'development' ? '.next-dev' : '.next',
  // pnpm keeps the workspace dependency store at the repository root. Trace
  // from there so Firebase's standalone server includes Next's runtime.
  outputFileTracingRoot: path.join(__dirname, '..'),
  poweredByHeader: false,
  allowedDevOrigins: ['103.127.30.140'],
  experimental: { serverActions: { bodySizeLimit: '2mb' } },
};

export default nextConfig;
