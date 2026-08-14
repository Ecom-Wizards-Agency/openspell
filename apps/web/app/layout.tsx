import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
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
        {children}
        {/* WP-15: the feedback widget belongs to the frame, not to a screen. */}
        <FeedbackEntry />
      </body>
    </html>
  );
}
