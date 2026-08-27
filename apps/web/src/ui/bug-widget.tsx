'use client';

import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { FeedbackSeverity } from '@wizard-ads/db';
import {
  BUG_SEVERITIES,
  bugTitleFromText,
  buildBugWidgetPayload,
} from '../feedback/bug-form';
import { describePageContext, pageContext, profileIdFromRoute } from '../feedback/page-context';
import type { UiFeedbackItem } from '../feedback/ui';
import { useToast } from './toast';

const SIMILAR_DEBOUNCE_MS = 350;

function focusable(dialog: HTMLDivElement): HTMLElement[] {
  return Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not(:disabled), select:not(:disabled), textarea:not(:disabled)',
    ),
  );
}

export function BugWidget({ appVersion = null }: { appVersion?: string | null }) {
  const [open, setOpen] = useState(false);
  const [route, setRoute] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [severity, setSeverity] = useState<FeedbackSeverity>('medium');
  const [similar, setSimilar] = useState<UiFeedbackItem[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const toast = useToast();

  useEffect(() => {
    setRoute(`${window.location.pathname}${window.location.search}`);
  }, []);

  const close = (): void => {
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  useEffect(() => {
    if (!open) return;
    textRef.current?.focus();
    const onDown = (event: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) close();
    };
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const title = bugTitleFromText(text);
    if (title.length < 3) {
      setSimilar([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(`/api/feedback/similar?q=${encodeURIComponent(title)}`, {
            signal: controller.signal,
          });
          const payload = (await response.json().catch(() => null)) as {
            items?: UiFeedbackItem[];
          } | null;
          if (response.ok && payload?.items) setSimilar(payload.items);
        } catch (caught) {
          if (!(caught instanceof DOMException && caught.name === 'AbortError')) setSimilar([]);
        }
      })();
    }, SIMILAR_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, text]);

  const trapFocus = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Tab' || dialogRef.current === null) return;
    const controls = focusable(dialogRef.current);
    const first = controls[0];
    const last = controls.at(-1);
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setError('');
    let payload;
    try {
      payload = buildBugWidgetPayload({ text, severity, route, appVersion });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Check the bug report.');
      return;
    }
    setPending(true);
    void (async () => {
      try {
        const response = await fetch('/api/feedback', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const result = (await response.json().catch(() => null)) as {
          error?: string;
          item?: { id: string };
        } | null;
        if (!response.ok || !result?.item) {
          throw new Error(result?.error ?? `Submission failed (${response.status})`);
        }
        const itemId = result.item.id;
        setText('');
        setSimilar([]);
        setPending(false);
        close();
        toast.show('Bug filed.', 'good', { href: `/bugs#bug-${itemId}`, label: 'View bug' });
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'Submission failed';
        setPending(false);
        setError(message);
        toast.show(message, 'bad');
      }
    })();
  };

  const context = pageContext({
    route,
    profileId: profileIdFromRoute(route),
    appVersion,
    actorType: 'user',
  });
  const fullFormHref = route === null ? '/feedback/new' : `/feedback/new?from=${encodeURIComponent(route)}`;

  return (
    <div className="wa-bug-widget" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="wa-bug-trigger"
        data-testid="feedback-entry"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span aria-hidden="true">⚑</span>
        Bug
      </button>

      {open ? (
        <div
          ref={dialogRef}
          className="wa-bug-popover"
          role="dialog"
          aria-modal="false"
          aria-labelledby="bug-widget-title"
          onKeyDown={trapFocus}
        >
          <div className="wa-bug-popover__head">
            <div>
              <h2 id="bug-widget-title" className="wa-bug-popover__title">Report a bug</h2>
              <p className="wa-bug-popover__sub">What broke?</p>
            </div>
            <button type="button" className="wa-btn wa-btn--ghost wa-btn--sm" onClick={close} aria-label="Close bug report">
              ✕
            </button>
          </div>

          <form className="wa-bug-form" onSubmit={submit}>
            <label className="wa-field">
              <span className="wa-label">Severity</span>
              <select
                className="wa-select"
                data-testid="feedback-severity"
                value={severity}
                onChange={(event) => setSeverity(event.target.value as FeedbackSeverity)}
              >
                {BUG_SEVERITIES.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </label>

            <label className="wa-field">
              <span className="wa-label">What happened?</span>
              <textarea
                ref={textRef}
                required
                rows={6}
                className="wa-textarea wa-bug-textarea"
                data-testid="feedback-body"
                placeholder={'Short title on the first line\nThen add useful detail…'}
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
              <span className="wa-hint">The first line becomes the title.</span>
            </label>

            {similar.length === 0 ? null : (
              <aside className="wa-bug-similar" data-testid="similar-bugs">
                <strong>Similar open bugs</strong>
                <ul>
                  {similar.map((item) => (
                    <li key={item.id}>
                      <a href={`/bugs#bug-${item.id}`}>{item.title}</a>
                    </li>
                  ))}
                </ul>
              </aside>
            )}

            <aside className="wa-bug-context" data-testid="page-context">
              Sent with this report — {describePageContext(context)}
            </aside>
            {error === '' ? null : <p className="wa-bug-error" role="status">{error}</p>}

            <div className="wa-bug-actions">
              <a href={fullFormHref}>Full form →</a>
              <button
                type="submit"
                className="wa-btn wa-btn--primary"
                data-testid="feedback-submit"
                disabled={pending}
              >
                {pending ? 'Sending…' : 'Send bug'}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
