import type { NextConfig } from 'next';

/**
 * Workspace packages are consumed as TypeScript source (no build step between
 * packages), so Next has to transpile them itself.
 */
const nextConfig: NextConfig = {
  transpilePackages: ['@wizard-ads/shared', '@wizard-ads/ui'],
  typedRoutes: true,
};

export default nextConfig;
