/**
 * The nav icon set.
 *
 * One family, one weight: 16×16 viewBox, 1.5px strokes, round joins, drawn on
 * `currentColor` so each icon inherits the link's ink and its active/hover
 * states for free. Kept as bare `<path>` data rather than an icon dependency so
 * the bundle carries exactly the thirteen glyphs the nav uses and no more, and
 * so a public repo ships no third-party icon licence to reason about.
 *
 * Presentational and pure — safe to render inside the client sidebar or any
 * server component.
 */
import type { ReactNode } from 'react';

const PATHS: Record<string, ReactNode> = {
  gauge: (
    <>
      <path d="M2.5 11a5.5 5.5 0 1 1 11 0" />
      <path d="M8 8.5 10.5 6" />
    </>
  ),
  sliders: (
    <>
      <path d="M3 4.5h10M3 8h10M3 11.5h10" />
      <circle cx="6" cy="4.5" r="1.4" />
      <circle cx="10.5" cy="8" r="1.4" />
      <circle cx="5" cy="11.5" r="1.4" />
    </>
  ),
  layers: (
    <>
      <path d="M8 2.5 14 5.5 8 8.5 2 5.5 8 2.5Z" />
      <path d="M3 8l5 2.5L13 8" />
      <path d="M3 10.5 8 13l5-2.5" />
    </>
  ),
  check: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M5.5 8.2 7.2 10l3.3-3.6" />
    </>
  ),
  grid: (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1" />
      <path d="M2.5 6.5h11M2.5 10h11M6.5 2.5v11" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4" />
      <path d="M10 10l3 3" />
    </>
  ),
  tag: (
    <>
      <path d="M7.5 2.5H12a1.5 1.5 0 0 1 1.5 1.5v4.5L8 14 2.5 8.5 7.5 2.5Z" />
      <circle cx="10.5" cy="5.5" r="0.9" />
    </>
  ),
  shield: (
    <>
      <path d="M8 2.5 13 4v4c0 3-2.2 4.8-5 5.5C5.2 12.8 3 11 3 8V4l5-1.5Z" />
      <path d="M6 8l1.5 1.5L10.5 6.5" />
    </>
  ),
  clock: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3.2l2.2 1.3" />
    </>
  ),
  spark: (
    <>
      <path d="M8 2.5 9.3 6.7 13.5 8 9.3 9.3 8 13.5 6.7 9.3 2.5 8 6.7 6.7 8 2.5Z" />
    </>
  ),
  chat: (
    <>
      <path d="M3 4.5h10a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H7l-3 2.5V11.5H3a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1Z" />
    </>
  ),
  bug: (
    <>
      <path d="M5 6.5h6v4a3 3 0 0 1-6 0v-4Z" />
      <path d="M6.5 6.5v-1a1.5 1.5 0 0 1 3 0v1M2.5 7.5H5M11 7.5h2.5M2.5 11H5M11 11h2.5M4 4l1.5 1.5M12 4l-1.5 1.5" />
    </>
  ),
  map: (
    <>
      <path d="M6 3 2.5 4.5v9L6 12l4 1.5 3.5-1.5v-9L10 4.5 6 3Z" />
      <path d="M6 3v9M10 4.5v9" />
    </>
  ),
  cog: (
    <>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 2.5v1.7M8 11.8v1.7M13.5 8h-1.7M4.2 8H2.5M11.9 4.1l-1.2 1.2M5.3 10.7l-1.2 1.2M11.9 11.9l-1.2-1.2M5.3 5.3 4.1 4.1" />
    </>
  ),
  key: (
    <>
      <circle cx="5.5" cy="8" r="2.5" />
      <path d="M8 8h5.5M11.5 8v2M13.5 8v2.5" />
    </>
  ),
  flask: (
    <>
      <path d="M6.5 2.5v4L3.5 12a1 1 0 0 0 .9 1.5h7.2a1 1 0 0 0 .9-1.5L9.5 6.5v-4" />
      <path d="M5.5 2.5h5M5.6 9.5h4.8" />
    </>
  ),
  history: (
    <>
      <path d="M2.8 6.2A5.5 5.5 0 1 1 2.5 9" />
      <path d="M2.5 3v3.2h3.2" />
      <path d="M8 5.2v3l2 1.2" />
    </>
  ),
};

export function NavIcon({ icon }: { icon: string }): ReactNode {
  const paths = PATHS[icon] ?? PATHS['grid'];
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths}
    </svg>
  );
}
