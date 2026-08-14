import type { NextConfig } from 'next';

/**
 * Workspace packages are consumed as TypeScript source (no build step between
 * packages), so Next has to transpile them itself.
 *
 * ## Why webpack, and why `extensionAlias`
 *
 * Every relative import in this repo carries a `.js` specifier, which is what
 * `verbatimModuleSyntax` + NodeNext-style output expects and what tsx, vitest
 * and the worker all resolve happily. Turbopack does not: it looks for a
 * literal `apply.js` next to `apply.ts` and fails, so *any* route importing
 * *any* workspace package fails the build. It is not caused by one package —
 * a page whose only import was `@wizard-ads/shared` reproduces it — and it
 * blocks WP-04, WP-06, WP-07 and WP-08 equally.
 *
 * `experimental.extensionAlias` is the documented fix, and Next lists it as a
 * webpack-only option (`lib/turbopack-warning.js` enumerates it among the
 * settings Turbopack ignores). So the two together are the smallest change
 * that makes a production build of this app work today: verified green here,
 * against a build that fails without them.
 *
 * This is deliberately the *reversible* half of the choice. The other candidate
 * — dropping `.js` from every relative import repo-wide, which
 * `moduleResolution: "Bundler"` already permits — is a one-line-per-import
 * change across every package and would let Turbopack back in. That call spans
 * package ownership boundaries, so it belongs to whoever owns the scaffold;
 * when it lands, delete these two lines and the `--webpack` flags in
 * `package.json` and nothing else changes.
 */
const nextConfig: NextConfig = {
  transpilePackages: ['@wizard-ads/shared', '@wizard-ads/ui'],
  typedRoutes: true,
  experimental: {
    extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
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
