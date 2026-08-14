import type { NextConfig } from 'next';

/**
 * Workspace packages are consumed as TypeScript source (no build step between
 * packages), so Next has to transpile them itself.
 *
 * ## Why this app builds with webpack rather than Turbopack
 *
 * Every workspace package writes ESM-correct relative specifiers
 * (`export * from './strategy.js'`), which TypeScript resolves to the `.ts`
 * file. Turbopack has no equivalent of webpack's `resolve.extensionAlias` and
 * fails every one of those imports with "Can't resolve './strategy.js'", so no
 * route that touches `@wizard-ads/shared` — which is all of them — can render.
 * The alternative would be dropping the extensions across six packages this app
 * does not own. `--webpack` plus the alias below is the smaller change, and it
 * is a supported bundler, not a workaround.
 *
 * Revisit when Turbopack gains extension aliasing.
 */
const nextConfig: NextConfig = {
  transpilePackages: [
    '@wizard-ads/shared',
    '@wizard-ads/ui',
    '@wizard-ads/core',
    '@wizard-ads/db',
    '@wizard-ads/ads-api',
    '@wizard-ads/crosscheck-cli',
  ],
  typedRoutes: true,
  webpack: (config) => {
    config.resolve = config.resolve ?? {};
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};

export default nextConfig;
