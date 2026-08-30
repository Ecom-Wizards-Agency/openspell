import type { ReactNode } from 'react';
import type { Period } from '../../app/_lib/periods';
import { DateRangePicker } from './date-range-picker';

/** One unambiguous account/date context shared by analytical operator screens. */
export function OperatorContext({
  account,
  marketplace,
  currencyCode,
  timezone,
  path,
  period,
  today,
  includeToday = false,
  selectedPresetId,
  preserved,
}: {
  account: string;
  marketplace: string;
  currencyCode: string;
  timezone: string;
  path: string;
  period: Period;
  today: string;
  includeToday?: boolean;
  selectedPresetId?: string;
  preserved: Readonly<Record<string, string | undefined>>;
}): ReactNode {
  return (
    <section aria-label="Active advertising account and reporting window" className="wa-operator-context">
      <div className="wa-operator-context__account">
        <span className="wa-operator-context__eyebrow">
          <span aria-hidden="true" className="wa-operator-context__dot" />
          Active account
        </span>
        <strong>{account}</strong>
        <span className="wa-operator-context__meta">
          {marketplace} · {currencyCode} · {timezone}
        </span>
      </div>
      <div className="wa-operator-context__range">
        <span className="wa-label">Reporting window</span>
        <DateRangePicker
          path={path}
          period={period}
          today={today}
          includeToday={includeToday}
          selectedPresetId={selectedPresetId}
          preserved={preserved}
        />
      </div>
    </section>
  );
}
