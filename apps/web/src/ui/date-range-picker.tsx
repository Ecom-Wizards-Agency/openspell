'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import type { Period } from '../../app/_lib/periods';
import { beginRouteNavigation } from '../performance/navigation';
import { dateRangeHref, dateRangePresets, selectedDateRangeLabel } from './date-range';

export function DateRangePicker({
  path,
  period,
  today,
  preserved = {},
}: {
  path: string;
  period: Period;
  today: string;
  preserved?: Readonly<Record<string, string | undefined>>;
}): ReactNode {
  const presets = dateRangePresets(today);
  const lastCompleteDay = presets[0]?.period.end ?? today;
  const selectedLabel = selectedDateRangeLabel(period, today);
  const hidden = Object.entries(preserved).filter(
    ([key, value]) => value !== undefined && key !== 'from' && key !== 'to',
  ) as Array<[string, string]>;

  return (
    <details className="wa-date-range">
      <summary className="wa-date-range__trigger" aria-label={`Date range: ${selectedLabel}`}>
        <svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16">
          <path d="M5 2.5v3m10-3v3M3.5 8h13M5 4h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
        </svg>
        <span>{selectedLabel}</span>
        <svg aria-hidden="true" className="wa-date-range__chevron" viewBox="0 0 12 12" width="12" height="12">
          <path d="m3 4.5 3 3 3-3" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
        </svg>
      </summary>

      <div className="wa-date-range__popover">
        <div className="wa-date-range__heading">
          <strong>Date range</strong>
          <span>Complete days only</span>
        </div>
        <nav className="wa-date-range__presets" aria-label="Date range presets">
          {presets.map((preset) => {
            const active = preset.label === selectedLabel;
            return (
              <Link
                aria-current={active ? 'date' : undefined}
                href={dateRangeHref(path, preset.period, preserved)}
                prefetch={false}
                onNavigate={() => beginRouteNavigation()}
                key={preset.id}
              >
                <span>{preset.label}</span>
                {active ? <span aria-hidden="true">✓</span> : null}
              </Link>
            );
          })}
        </nav>
        <form action={path} method="get" className="wa-date-range__custom">
          {hidden.map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
          <strong>Custom range</strong>
          <div className="wa-date-range__fields">
            <label>
              <span>From</span>
              <input className="wa-input wa-input--sm" name="from" type="date" defaultValue={period.start} required />
            </label>
            <label>
              <span>To</span>
              <input className="wa-input wa-input--sm" name="to" type="date" defaultValue={period.end} max={lastCompleteDay} required />
            </label>
          </div>
          <button className="wa-btn wa-btn--primary wa-btn--sm" type="submit">Apply range</button>
        </form>
      </div>
    </details>
  );
}
