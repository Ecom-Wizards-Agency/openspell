'use client';

/**
 * Toasts.
 *
 * The frame owns one live region and any client component can push into it, so
 * a save that happens inside a table row can say so without that row growing a
 * status paragraph and pushing every other row down.
 *
 * Two deliberate choices:
 *
 *  - The region is `aria-live="polite"` on a plain `div`, **not** `role="status"`.
 *    Several screens already own exactly one `role="status"` element and their
 *    specs assert against it by role; a second implicit status anywhere in the
 *    document would make that locator ambiguous. Politeness is the behaviour we
 *    want and the role is not.
 *  - A toast auto-dismisses but is also dismissible, and it never carries the
 *    only copy of a fact. Anything that must survive being missed belongs in the
 *    page, not here.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

export type ToastTone = 'good' | 'bad' | 'info';

export interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
}

interface ToastApi {
  show: (message: string, tone?: ToastTone) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const MARK: Record<ToastTone, string> = { good: '✓', bad: '!', info: 'i' };
const DISMISS_AFTER_MS = 5000;

export function ToastProvider({ children }: { children: ReactNode }): ReactNode {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback(
    (message: string, tone: ToastTone = 'info') => {
      const id = nextId.current;
      nextId.current += 1;
      setToasts((current) => [...current.slice(-2), { id, tone, message }]);
      window.setTimeout(() => dismiss(id), DISMISS_AFTER_MS);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div aria-live="polite" className="wa-toasts" data-testid="toast-region">
        {toasts.map((toast) => (
          <div key={toast.id} className={`wa-toast wa-toast--${toast.tone}`} data-testid="toast">
            <span aria-hidden="true" className="wa-toast__mark">
              {MARK[toast.tone]}
            </span>
            <span className="wa-toast__text">{toast.message}</span>
            <button
              type="button"
              aria-label="Dismiss"
              className="wa-btn wa-btn--ghost wa-btn--sm"
              onClick={() => dismiss(toast.id)}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/**
 * The hook.
 *
 * It degrades rather than throws when no provider is above it: a component that
 * merely *reports* success should never be the reason a screen fails to render.
 */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  return api ?? NO_TOASTS;
}

const NO_TOASTS: ToastApi = { show: () => undefined };
