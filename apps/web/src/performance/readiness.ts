/** A route is usable only after its real main content replaces any loading shell. */
export function routeContentIsUsable(document: Document): boolean {
  const content = document.querySelector('#wa-main');
  if (content === null) return false;
  const routeMain = Array.from(content.children).find((element) => element.tagName === 'MAIN');
  return routeMain !== undefined && routeMain.getAttribute('aria-busy') !== 'true';
}

/**
 * Wait for two consecutive usable frames. Loading fallbacks in this app are
 * marked aria-busy on the route's top-level main, so URL/search changes cannot
 * become route-ready evidence while that fallback is still the destination.
 * Nested streamed panels may remain busy without making the primary route
 * unusable.
 */
export function waitForUsableRouteContent(
  document: Document,
  onReady: () => void,
  scheduleFrame: (callback: FrameRequestCallback) => number = window.requestAnimationFrame.bind(window),
  cancelFrame: (handle: number) => void = window.cancelAnimationFrame.bind(window),
): () => void {
  let handle = 0;
  let usableFrames = 0;
  let cancelled = false;

  const check = (): void => {
    if (cancelled) return;
    usableFrames = routeContentIsUsable(document) ? usableFrames + 1 : 0;
    if (usableFrames >= 2) {
      onReady();
      return;
    }
    handle = scheduleFrame(check);
  };

  handle = scheduleFrame(check);
  return () => {
    cancelled = true;
    cancelFrame(handle);
  };
}
