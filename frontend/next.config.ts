import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  // Firebase installs this package from its frontend-scoped lockfile and
  // expects the standalone server at `.next/standalone/server.js`.
  outputFileTracingRoot: __dirname,
  outputFileTracingIncludes: {
    // pnpm's linked layout otherwise omits Next's server runtime and its
    // styled-jsx runtime dependency from the standalone Cloud Run bundle.
    '/*': ['./node_modules/next/**/*', './node_modules/styled-jsx/**/*'],
  },
  poweredByHeader: false,
  allowedDevOrigins: ['103.127.30.140'],
  experimental: { serverActions: { bodySizeLimit: '2mb' } },
};

export default nextConfig;
