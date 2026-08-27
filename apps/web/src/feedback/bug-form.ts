import { FEEDBACK_SEVERITIES } from '@wizard-ads/db';
import type { FeedbackSeverity } from '@wizard-ads/db';
import { pageContext, profileIdFromRoute } from './page-context';

/** One source for both the full form and the compact widget. */
export const BUG_SEVERITIES = FEEDBACK_SEVERITIES;

export interface BugWidgetPayload {
  type: 'bug';
  title: string;
  body: string;
  severity: FeedbackSeverity;
  pageContext: {
    route: string | null;
    profileId: string | null;
    appVersion: string | null;
  };
}

export function bugTitleFromText(text: string): string {
  return (text.split(/\r?\n/, 1)[0] ?? '').trim();
}

/** The widget's single-field rule, kept pure so its exact wire payload is testable. */
export function buildBugWidgetPayload(input: {
  text: string;
  severity: FeedbackSeverity;
  route: string | null;
  appVersion: string | null;
}): BugWidgetPayload {
  const [first = '', ...rest] = input.text.replace(/\r\n/g, '\n').split('\n');
  const title = first.trim();
  if (title === '') throw new Error('Start with a short title on the first line.');
  if (title.length > 200) throw new Error('The first-line title cannot exceed 200 characters.');
  const body = rest.join('\n').trim();
  if (body.length > 20_000) throw new Error('The bug description cannot exceed 20000 characters.');

  const context = pageContext({
    route: input.route,
    profileId: profileIdFromRoute(input.route),
    appVersion: input.appVersion,
    actorType: 'user',
  });
  return {
    type: 'bug',
    title,
    body,
    severity: input.severity,
    pageContext: {
      route: context.route,
      profileId: context.profileId,
      appVersion: context.appVersion,
    },
  };
}
