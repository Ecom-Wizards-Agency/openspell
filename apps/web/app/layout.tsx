import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import type { ReactNode } from 'react';
import '../src/ui/theme.css';
import { AppNav } from '../src/ui/nav';
import { BugWidget } from '../src/ui/bug-widget';
import { ToastProvider } from '../src/ui/toast';
import { THEME_SCRIPT } from '../src/ui/theme-script';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
});

export const metadata: Metadata = {
  title: 'OpenSpell',
  description: 'Amazon Advertising operator workspace',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#FFFFFF' },
    { media: '(prefers-color-scheme: dark)', color: '#0F1318' },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { currentUser } = await import('../src/auth/session');
  const user = await currentUser();
  let feedbackEnabled = user !== null;

  // The production-style Playwright suite authenticates with the deliberately
  // isolated header bridge rather than a Supabase cookie. Recognise that
  // already-verified test actor here so the suite still exercises the widget;
  // the bridge refuses to arm alongside a real auth provider.
  if (!feedbackEnabled) {
    const { actorFromHeaders, e2eAuthBridgeEnabled, RequestAuthError } = await import(
      '../src/server/request-context'
    );
    if (e2eAuthBridgeEnabled()) {
      const { headers } = await import('next/headers');
      try {
        actorFromHeaders(await headers());
        feedbackEnabled = true;
      } catch (error) {
        // Playwright's web-server readiness probe does not carry the browser
        // context's auth headers. It must be allowed to receive the anonymous
        // frame; invalid bridge configuration (503) still fails the request.
        if (!(error instanceof RequestAuthError && error.status === 401)) throw error;
      }
    }
  }

  return (
    // The theme stamp below rewrites `data-theme` before React sees the
    // document, which is exactly the mismatch this attribute exists for.
    <html lang="en" data-theme="light" className={inter.variable} suppressHydrationWarning>
      <head>
        {/*
          Before first paint, not after hydration: a dark-mode user who watches
          the app flash white on every navigation does not have dark mode, they
          have an apology.
        */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <ToastProvider>
          {/*
            The layout reads the session once for the frame. Anonymous screens
            get a quiet public header and no unreachable operator navigation;
            authenticated screens get the complete operator frame. Every route
            remains dynamic, which is correct for a per-tenant tool.
          */}
          <AppNav user={user} />
          <div
            className={user === null ? 'wa-content wa-content--public' : 'wa-content'}
            id="wa-main"
          >
            {children}
          </div>
          {/*
            The bug reporter is an operator control. Gating it on a verified
            session (or the isolated e2e bridge) prevents an anonymous hydration
            flash on /login while preserving the signed-in browser workflow.
          */}
          {feedbackEnabled ? (
            <BugWidget appVersion={process.env['WIZARD_ADS_APP_VERSION'] ?? null} />
          ) : null}
        </ToastProvider>
      </body>
    </html>
  );
}
