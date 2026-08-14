import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { AppNav } from '../src/ui/nav';
import { FeedbackEntry } from '../src/ui/feedback-entry';

export const metadata: Metadata = {
  title: 'wizard-ads',
  description: 'In-house Amazon Advertising tool',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/*
          The frame's nav, on every screen including `/login`: it is the only
          place the app offers a way in and a way out, so it cannot be a
          per-screen decision. `AppNav` reads the session, which makes every
          route dynamic — correct for a tool whose every page is per-tenant.
        */}
        <AppNav />
        {children}
        {/* WP-15: the feedback widget belongs to the frame, not to a screen. */}
        <FeedbackEntry />
      </body>
    </html>
  );
}
