'use client';

/**
 * The submit form.
 *
 * Two decisions worth stating:
 *
 *  - The captured context is *shown*, not merely attached. A widget that
 *    silently uploads the URL you were on is a support tool people stop
 *    trusting; one that says "this is what I am sending" is one they use.
 *  - Severity appears only for a bug, because the database refuses a severity
 *    on a feature request. The form mirrors the constraint rather than
 *    discovering it in an error message.
 */
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { describePageContext } from '../../../src/feedback/page-context';
import type { PageContext } from '../../../src/feedback/page-context';
import { BUG_SEVERITIES } from '../../../src/feedback/bug-form';
import { banner, button, colors, heading, muted, page } from '../../../src/ui/tokens';

const field = {
  border: `1px solid ${colors.border}`,
  borderRadius: '0.25rem',
  fontSize: '0.875rem',
  padding: '0.375rem 0.5rem',
  width: '100%',
} as const;

export function SubmitFeedbackForm({ context }: { context: PageContext }) {
  const [type, setType] = useState<'bug' | 'feature'>('bug');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [severity, setSeverity] = useState<(typeof BUG_SEVERITIES)[number]>('medium');
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);

  // The same hydration marker the tag surface uses: a click that lands before
  // React attaches submits the form natively and looks like it worked.
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setMessage('Sending…');
    void (async () => {
      try {
        const response = await fetch('/api/feedback', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type,
            title,
            body,
            severity: type === 'bug' ? severity : null,
            pageContext: {
              route: context.route,
              profileId: context.profileId,
              appVersion: context.appVersion,
            },
          }),
        });
        const payload = (await response.json().catch(() => null)) as {
          error?: string;
          item?: { id: string };
        } | null;
        if (!response.ok || !payload?.item) {
          throw new Error(payload?.error ?? `Submission failed (${response.status})`);
        }
        window.location.href = '/feedback';
      } catch (error) {
        setPending(false);
        setMessage(error instanceof Error ? error.message : 'Submission failed');
      }
    })();
  };

  return (
    <main style={page} data-interactive={ready ? 'true' : 'false'}>
      <h1 style={heading}>Tell us what is broken, or what is missing</h1>
      <p style={muted}>
        Everything filed here lands in the tracker the team works from. No screenshots in v1 —
        the page you were on comes along automatically.
      </p>

      {message && (
        <p role="status" style={banner(pending ? 'warn' : 'bad')}>
          {message}
        </p>
      )}

      <form onSubmit={submit} style={{ display: 'grid', gap: '0.875rem', maxWidth: '38rem' }}>
        <fieldset style={{ border: 'none', display: 'flex', gap: '1rem', padding: 0 }}>
          <legend style={{ ...muted, padding: 0 }}>What is this?</legend>
          {(['bug', 'feature'] as const).map((option) => (
            <label key={option} style={{ fontSize: '0.875rem' }}>
              <input
                type="radio"
                name="type"
                value={option}
                checked={type === option}
                onChange={() => setType(option)}
              />{' '}
              {option === 'bug' ? 'Bug report' : 'Feature request'}
            </label>
          ))}
        </fieldset>

        <label style={{ display: 'grid', gap: '0.25rem', fontSize: '0.875rem' }}>
          Title
          <input
            required
            maxLength={200}
            value={title}
            data-testid="feedback-title"
            onChange={(event) => setTitle(event.target.value)}
            style={field}
          />
        </label>

        <label style={{ display: 'grid', gap: '0.25rem', fontSize: '0.875rem' }}>
          Description
          <textarea
            rows={6}
            value={body}
            data-testid="feedback-body"
            onChange={(event) => setBody(event.target.value)}
            style={{ ...field, fontFamily: 'inherit' }}
          />
        </label>

        {type === 'bug' && (
          <label style={{ display: 'grid', gap: '0.25rem', fontSize: '0.875rem', maxWidth: '12rem' }}>
            Severity
            <select
              value={severity}
              data-testid="feedback-severity"
              onChange={(event) =>
                setSeverity(event.target.value as (typeof BUG_SEVERITIES)[number])
              }
              style={field}
            >
              {BUG_SEVERITIES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
        )}

        <aside
          aria-label="Attached page context"
          data-testid="page-context"
          style={{
            background: colors.subtle,
            border: `1px solid ${colors.border}`,
            borderRadius: '0.375rem',
            fontSize: '0.8125rem',
            padding: '0.625rem 0.75rem',
          }}
        >
          Sent with this report — {describePageContext(context)}
        </aside>

        <div>
          <button type="submit" disabled={pending} data-testid="feedback-submit" style={button}>
            {pending ? 'Sending…' : 'Send feedback'}
          </button>{' '}
          <a href="/feedback" style={{ ...muted, marginLeft: '0.5rem' }}>
            Cancel
          </a>
        </div>
      </form>
    </main>
  );
}
