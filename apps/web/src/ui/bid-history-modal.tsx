'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent, ReactNode } from 'react';
import type { BidHistoryPayload } from '../../app/_lib/bid-corridor';
import { bidHistoryKpiTiles } from '../optimizer/view';
import { KpiTile } from './dashboard';
import { BidCorridorChart } from './viz';

export interface BidHistoryModalProps {
  profileId: string;
  targetId: string;
  window: { start: string; end: string };
  currencyCode: string;
  onClose: () => void;
}

function focusable(dialog: HTMLDivElement): HTMLElement[] {
  return Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

/** One target's asynchronous, read-only bid-history drill-down. */
export function BidHistoryModal({
  profileId,
  targetId,
  window: dateWindow,
  currencyCode,
  onClose,
}: BidHistoryModalProps): ReactNode {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ready'; payload: BidHistoryPayload }
  >({ status: 'loading' });
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      window.requestAnimationFrame(() => previousFocus?.focus());
    };
  }, [onClose]);

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({
      profile: profileId,
      target: targetId,
      from: dateWindow.start,
      to: dateWindow.end,
    });
    setState({ status: 'loading' });
    void (async () => {
      try {
        const response = await fetch(`/api/bid-history?${query.toString()}`, {
          signal: controller.signal,
        });
        const payload = (await response.json().catch(() => null)) as
          | (BidHistoryPayload & { error?: never })
          | { error?: string }
          | null;
        if (!response.ok || payload === null || !('target' in payload)) {
          throw new Error(
            (payload !== null && 'error' in payload ? payload.error : null) ??
              `Bid history failed to load (${response.status})`,
          );
        }
        setState({ status: 'ready', payload });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : 'Bid history failed to load',
        });
      }
    })();
    return () => controller.abort();
  }, [dateWindow.end, dateWindow.start, profileId, targetId]);

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

  const payload = state.status === 'ready' ? state.payload : null;
  const title =
    payload === null
      ? 'Bid history'
      : `${payload.target.targeting}${
          payload.target.matchType === null ? '' : ` · ${payload.target.matchType}`
        }`;
  const campaignHref = useMemo(() => {
    if (payload === null) return null;
    const query = new URLSearchParams({
      profile: profileId,
      entity: 'campaigns',
      campaign: payload.target.campaignId,
      from: dateWindow.start,
      to: dateWindow.end,
    });
    return `/grid?${query.toString()}`;
  }, [dateWindow.end, dateWindow.start, payload, profileId]);

  const dismissBackdrop = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) onClose();
  };

  return (
    <div className="wa-modal-backdrop" onMouseDown={dismissBackdrop}>
      <div
        ref={dialogRef}
        className="wa-bid-history-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bid-history-title"
        aria-describedby="bid-history-subtitle"
        onKeyDown={trapFocus}
      >
        <header className="wa-bid-history-modal__head">
          <div style={{ minWidth: 0 }}>
            <h2 id="bid-history-title" className="wa-bid-history-modal__title" title={title}>
              {title}
            </h2>
            <p id="bid-history-subtitle" className="wa-bid-history-modal__sub">
              {payload === null ? (
                `${dateWindow.start} to ${dateWindow.end}`
              ) : (
                <>
                  {payload.target.adProduct} | {payload.target.targetKind} |{' '}
                  {campaignHref === null ? payload.target.campaignName : (
                    <a href={campaignHref}>{payload.target.campaignName} ↗</a>
                  )}
                  {' · '}{payload.window.from} to {payload.window.to}
                </>
              )}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="wa-btn wa-btn--ghost"
            aria-label="Close bid history"
            onClick={onClose}
          >
            ✕
          </button>
        </header>

        <div className="wa-bid-history-modal__body">
          {state.status === 'loading' ? (
            <div className="wa-bid-history-modal__loading" role="status">
              Loading bid history…
            </div>
          ) : state.status === 'error' ? (
            <div className="wa-empty" role="alert">
              <h3 className="wa-empty__title">Bid history unavailable</h3>
              <p className="wa-empty__body">{state.message}</p>
            </div>
          ) : (
            <>
              <section aria-label="Target metrics" className="wa-kpis wa-kpis--dense">
                {bidHistoryKpiTiles(state.payload.totals).map((tile) => (
                  <KpiTile
                    key={tile.metric}
                    label={tile.label}
                    value={tile.value}
                    scale={tile.scale}
                    better={tile.better}
                    delta={{ caption: 'vs prior period', pct: null, reference: null }}
                    context={{ currencyCode, locale: 'en-US' }}
                  />
                ))}
              </section>

              <section className="wa-card wa-bid-history-modal__chart" aria-label="Bid corridor chart">
                <BidCorridorChart
                  title="Bid corridor"
                  ariaLabel="Amazon suggested-bid corridor with bid, CPC and max potential CPC"
                  currencyCode={currencyCode}
                  points={state.payload.points}
                  aggregatable
                  caption={`Suggested-bid band, bid, realized CPC and max potential CPC. In ${currencyCode}.`}
                />
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
