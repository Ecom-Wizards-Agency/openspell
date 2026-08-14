/**
 * The virtual window, as a pure function.
 *
 * `@tanstack/react-virtual` does this inside a hook against real element
 * measurements, which is right for the browser and untestable in a unit suite.
 * The same arithmetic lives here so the property that actually matters --
 * *the number of rows materialised never grows with the number of rows loaded*
 * -- is assertable without a browser, and so a server render has something
 * sensible to emit before hydration.
 *
 * This is the acceptance check behind "50k rows scroll without jank". Jank is
 * not really a frame-time measurement; it is what happens when the row count
 * reaches the DOM. Bound that and the frame time follows.
 */
export interface VirtualWindowInput {
  rowCount: number;
  rowHeight: number;
  scrollTop: number;
  viewportHeight: number;
  /** Rows rendered beyond each edge, so a fast scroll does not show blank space. */
  overscan?: number;
}

export interface VirtualWindow {
  startIndex: number;
  /** Exclusive. */
  endIndex: number;
  /** Spacer height above the first rendered row. */
  paddingTop: number;
  /** Spacer height below the last rendered row. */
  paddingBottom: number;
  totalHeight: number;
  count: number;
}

export const DEFAULT_ROW_HEIGHT = 30;
export const DEFAULT_OVERSCAN = 10;

export function virtualWindow(input: VirtualWindowInput): VirtualWindow {
  const overscan = input.overscan ?? DEFAULT_OVERSCAN;
  const rowHeight = Math.max(1, input.rowHeight);
  const totalHeight = input.rowCount * rowHeight;

  if (input.rowCount === 0) {
    return { startIndex: 0, endIndex: 0, paddingTop: 0, paddingBottom: 0, totalHeight: 0, count: 0 };
  }

  const first = Math.floor(Math.max(0, input.scrollTop) / rowHeight);
  const visible = Math.ceil(Math.max(0, input.viewportHeight) / rowHeight) + 1;
  const endIndex = Math.min(input.rowCount, first + visible + overscan);
  // Clamped against `endIndex`, not just against zero: a scroll position past
  // the end of a shrunken set (filter applied while scrolled down, say) would
  // otherwise produce a start beyond the end and a negative row count.
  const startIndex = Math.min(Math.max(0, first - overscan), endIndex);

  return {
    startIndex,
    endIndex,
    paddingTop: startIndex * rowHeight,
    paddingBottom: Math.max(0, (input.rowCount - endIndex) * rowHeight),
    totalHeight,
    count: endIndex - startIndex,
  };
}
