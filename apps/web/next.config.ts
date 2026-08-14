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
 *
 * ## What the alias actually fixes
 *
 * Without it every `export * from './x.js'` in packages/db, packages/shared,
 * packages/core and packages/ui resolves to nothing and the barrel silently
 * exports an empty namespace — a failure that shows up as `undefined is not a
 * function` deep inside a route rather than as a resolution error. Told to look
 * for `.ts` behind the `.js` specifier, webpack resolves the source.
 *
 * `@wizard-ads/ads-api` is deliberately absent from this list: eslint's
 * dependency-direction rule forbids the web app from importing it at all
 * (every Amazon API call lives in apps/worker).
 */
const nextConfig: NextConfig = {
  // pnpm monorepo: file tracing must walk from the workspace root, or the
  // serverless bundle references ../../node_modules/.pnpm paths that do not
  // exist inside the deployment (Vercel --prebuilt rejects exactly that).
  outputFileTracingRoot: new URL('../..', import.meta.url).pathname,
  transpilePackages: [
    '@wizard-ads/core',
    '@wizard-ads/crosscheck-cli',
    '@wizard-ads/db',
    '@wizard-ads/shared',
    '@wizard-ads/ui',
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
  /**
   * `next dev` otherwise writes its own `AGENTS.md` and `CLAUDE.md` into this
   * directory. This repo already has an authoritative `AGENTS.md` at the root
   * and a work-package system on top of it; a second, generated one that says
   * something else is worse than none.
   */
  agentRules: false,
};

export default nextConfig;
