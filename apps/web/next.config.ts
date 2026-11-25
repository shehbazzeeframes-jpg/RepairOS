import type { NextConfig } from 'next';

// Next bakes rewrite destinations in at build time, so API_URL must be set when building.
const apiUrl = (process.env.API_URL ?? 'http://localhost:4000').replace(/\/$/, '');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // e2e builds into its own folder (with a dead API_URL) so it never replaces the normal build.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  transpilePackages: ['@repairos/contracts'],
  async rewrites() {
    // The browser only ever talks to this origin, so Better Auth cookies stay first-party.
    return [{ source: '/api/:path*', destination: `${apiUrl}/api/:path*` }];
  },
};

export default nextConfig;
