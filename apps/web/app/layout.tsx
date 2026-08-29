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
  title: 'wizard-ads',
  description: 'In-house Amazon Advertising tool',
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
            Rendered unconditionally: the header-bridge e2e harness carries no
            Supabase session, so a session gate here hides the widget from that
            whole suite. The widget hides itself on /login instead.
          */}
          <BugWidget appVersion={process.env['WIZARD_ADS_APP_VERSION'] ?? null} />
        </ToastProvider>
      </body>
    </html>
  );
}
