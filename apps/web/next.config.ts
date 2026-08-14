import type { NextConfig } from 'next';

/**
 * Workspace packages are consumed as TypeScript source (no build step between
 * packages), so Next has to transpile them itself.
 */
const nextConfig: NextConfig = {
  transpilePackages: [
    '@wizard-ads/crosscheck-cli',
    '@wizard-ads/db',
    '@wizard-ads/shared',
    '@wizard-ads/ui',
  ],
  typedRoutes: true,
  experimental: {
    // Workspace sources import each other with the ESM-correct `.js`
    // specifier that TypeScript rewrites nothing about. A bundler has to be
    // told to look for `.ts` behind it, or every `export * from './x.js'` in
    // packages/db, packages/shared and packages/ui resolves to nothing and the
    // barrel silently exports an empty namespace.
    extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
  },
};

export default nextConfig;
