/**
 * The primitives.
 *
 * Small, unopinionated, and styled entirely by class from `theme.css` — no
 * inline palette anywhere, which is what makes them themeable and what stopped
 * the app from accumulating a twelfth shade of grey.
 *
 * They are all plain presentational components with no state, so they render in
 * a server component as happily as in a client one. Anything that needs state
 * (toasts, the theme toggle, the sidebar's active mark) lives in its own
 * `'use client'` file rather than being smuggled in here.
 *
 * Every one of them forwards the rest of its props, so `data-testid`, `aria-*`
 * and `form` reach the real element. That matters more than usual here: the e2e
 * suites locate controls by test id and by accessible name, and a primitive
 * that swallowed either would be a primitive that could not be adopted.
 */
import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';

export type Tone = 'good' | 'warn' | 'bad' | 'info' | 'neutral';

/** Test and analytics hooks reach the real element, on every primitive. */
export type DataProps = { [key: `data-${string}`]: string | undefined };

const join = (...parts: (string | false | undefined)[]): string =>
  parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join(' ');

/* -------------------------------------------------------------- button --- */

export type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
}

export function Button({
  variant = 'default',
  size = 'md',
  className,
  type = 'button',
  ...rest
}: ButtonProps): ReactNode {
  return (
    <button
      {...rest}
      type={type}
      className={join(
        'wa-btn',
        variant !== 'default' && `wa-btn--${variant}`,
        size === 'sm' && 'wa-btn--sm',
        className,
      )}
    />
  );
}

/** The same shape as a `Button`, for the places where the action is a link. */
export function LinkButton({
  variant = 'default',
  size = 'md',
  className,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
}): ReactNode {
  return (
    <a
      {...rest}
      className={join(
        'wa-btn',
        variant !== 'default' && `wa-btn--${variant}`,
        size === 'sm' && 'wa-btn--sm',
        className,
      )}
    />
  );
}

/* --------------------------------------------------------------- fields -- */

export interface FieldProps {
  label: string;
  /** Hidden labels still exist: an unlabelled control is not a smaller control. */
  hideLabel?: boolean;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
  grow?: boolean;
}

export function Field({ label, hideLabel, hint, htmlFor, children, grow }: FieldProps): ReactNode {
  return (
    <div className="wa-field" style={grow === true ? { flex: '1 1 16rem' } : undefined}>
      <label className={hideLabel === true ? 'wa-sr-only' : 'wa-label'} htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint === undefined ? null : <span className="wa-hint">{hint}</span>}
    </div>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>): ReactNode {
  return <input {...rest} className={join('wa-input', className)} />;
}

export function Select({
  className,
  compact,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { compact?: boolean }): ReactNode {
  return (
    <select {...rest} className={join('wa-select', compact === true && 'wa-select--sm', className)} />
  );
}

export function Textarea({
  className,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement>): ReactNode {
  return <textarea {...rest} className={join('wa-textarea', className)} />;
}

export function Checkbox({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>): ReactNode {
  return <input {...rest} type="checkbox" className={join('wa-checkbox', className)} />;
}

/* ---------------------------------------------------------------- card --- */

export interface CardProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  flush?: boolean;
  className?: string;
  children: ReactNode;
  'aria-label'?: string;
}

export function Card({
  title,
  subtitle,
  actions,
  flush,
  className,
  children,
  ...rest
}: CardProps): ReactNode {
  return (
    <section {...rest} className={join('wa-card', className)}>
      {title === undefined && actions === undefined ? null : (
        <header className="wa-card__head">
          <div style={{ flex: '1 1 auto', minWidth: 0 }}>
            {title === undefined ? null : <h2 className="wa-card__title">{title}</h2>}
            {subtitle === undefined ? null : <p className="wa-card__sub">{subtitle}</p>}
          </div>
          {actions}
        </header>
      )}
      <div className={join('wa-card__body', flush === true && 'wa-card__body--flush')}>
        {children}
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- badge --- */

export function Badge({
  tone = 'neutral',
  dot,
  children,
  ...rest
}: {
  tone?: Tone;
  dot?: boolean;
  children: ReactNode;
} & DataProps): ReactNode {
  return (
    <span {...rest} className={join('wa-badge', tone !== 'neutral' && `wa-badge--${tone}`)}>
      {dot === true ? <span aria-hidden="true" className="wa-badge__dot" /> : null}
      {children}
    </span>
  );
}

/* -------------------------------------------------------------- banner --- */

export function Banner({
  tone = 'info',
  children,
  role,
  ...rest
}: {
  tone?: Exclude<Tone, 'neutral'>;
  children: ReactNode;
  role?: 'alert' | 'status';
} & DataProps): ReactNode {
  return (
    <p {...rest} role={role} className={join('wa-banner', `wa-banner--${tone}`)}>
      {children}
    </p>
  );
}

/* ---------------------------------------------------------------- tabs --- */

export interface TabItem {
  href: string;
  label: string;
}

export function Tabs({
  items,
  current,
  ariaLabel,
}: {
  items: readonly TabItem[];
  current: string;
  ariaLabel: string;
}): ReactNode {
  return (
    <nav aria-label={ariaLabel} className="wa-tabs">
      {items.map((item) => (
        <a
          key={item.href}
          href={item.href}
          className="wa-tab"
          {...(item.href === current ? { 'aria-current': 'page' as const } : {})}
        >
          {item.label}
        </a>
      ))}
    </nav>
  );
}

/* --------------------------------------------------------------- table --- */

/**
 * The table shell.
 *
 * A scroll container around the table rather than around the page: a
 * twelve-column roster on a laptop should scroll sideways inside its own frame,
 * not push the whole layout wider. `wa-table` does the rest.
 */
export function TableFrame({
  children,
  className,
  ...rest
}: {
  children: ReactNode;
  className?: string;
} & DataProps): ReactNode {
  return (
    <div {...rest} className={join('wa-tablewrap', className)}>
      {children}
    </div>
  );
}

/* -------------------------------------------------------- empty states --- */

/**
 * An empty state that reads as a state, not as a failure.
 *
 * Three parts, always: what is empty, why it might be, and the one thing to do
 * next. A bare "no data" is indistinguishable from a broken query, which is the
 * single most common way a working tool looks broken.
 */
export function EmptyState({
  title,
  body,
  meta,
  action,
  ...rest
}: {
  title: string;
  body: ReactNode;
  /** Timestamp or result context that distinguishes a completed empty run. */
  meta?: ReactNode;
  action?: ReactNode;
} & DataProps): ReactNode {
  return (
    <div {...rest} className="wa-empty">
      <p className="wa-empty__title">{title}</p>
      <p className="wa-empty__body">{body}</p>
      {meta === undefined ? null : <p className="wa-empty__meta">{meta}</p>}
      {action}
    </div>
  );
}

/* -------------------------------------------------------- page furniture -- */

export function PageHeader({
  title,
  subtitle,
  actions,
  meta,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
}): ReactNode {
  return (
    <header className="wa-page-head">
      <div style={{ minWidth: 0 }}>
        <h1 className="wa-page-title">{title}</h1>
        {subtitle === undefined ? null : <p className="wa-page-sub">{subtitle}</p>}
        {meta === undefined ? null : (
          <div className="wa-row" style={{ marginTop: '0.625rem' }}>
            {meta}
          </div>
        )}
      </div>
      {actions === undefined ? null : <div className="wa-row">{actions}</div>}
    </header>
  );
}

export function Toolbar({
  children,
  ...rest
}: { children: ReactNode } & DataProps): ReactNode {
  return (
    <div {...rest} className="wa-toolbar">
      {children}
    </div>
  );
}
