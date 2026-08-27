import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '../src/ui/theme.css';
import { AppNav } from '../src/ui/nav';
import { BugWidget } from '../src/ui/bug-widget';
import { ToastProvider } from '../src/ui/toast';
import { THEME_SCRIPT } from '../src/ui/theme-script';

export const metadata: Metadata = {
  title: 'wizard-ads',
  description: 'In-house Amazon Advertising tool',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f5f7fa' },
    { media: '(prefers-color-scheme: dark)', color: '#0b0f16' },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { currentUser } = await import('../src/auth/session');
  const user = await currentUser();

  return (
    // The theme stamp below rewrites `data-theme` before React sees the
    // document, which is exactly the mismatch this attribute exists for.
    <html lang="en" data-theme="light" suppressHydrationWarning>
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
            The frame, on every screen including `/login`: it is the only place
            the app offers a way in and a way out, so it cannot be a per-screen
            decision. The layout reads the session once for navigation and
            authenticated-only controls, which makes every route dynamic —
            correct for a tool whose every page is per-tenant.
          */}
          <AppNav user={user} />
          <div className="wa-content" id="wa-main">
            {children}
          </div>
          {/* The bug widget belongs to the signed-in frame, not to a screen. */}
          {user === null ? null : (
            <BugWidget appVersion={process.env['WIZARD_ADS_APP_VERSION'] ?? null} />
          )}
        </ToastProvider>
      </body>
    </html>
  );
}
