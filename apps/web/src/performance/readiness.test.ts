// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routeContentIsUsable, waitForUsableRouteContent } from './readiness';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('route content readiness', () => {
  it('does not report while a loading fallback is visible and waits for two usable frames', () => {
    document.body.innerHTML = '<div id="wa-main"><main aria-busy="true">Loading</main></div>';
    const frames: FrameRequestCallback[] = [];
    const ready = vi.fn();
    waitForUsableRouteContent(
      document,
      ready,
      (callback) => {
        frames.push(callback);
        return frames.length;
      },
      () => undefined,
    );

    flushFrame(frames);
    flushFrame(frames);
    expect(ready).not.toHaveBeenCalled();
    expect(routeContentIsUsable(document)).toBe(false);

    document.querySelector('#wa-main')?.replaceChildren(main('Ready'));
    flushFrame(frames);
    expect(ready).not.toHaveBeenCalled();
    flushFrame(frames);
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it('treats loaded empty and error main content as usable', () => {
    document.body.innerHTML = '<div id="wa-main"><main><p role="alert">No rows</p></main></div>';
    expect(routeContentIsUsable(document)).toBe(true);
  });
});

function flushFrame(frames: FrameRequestCallback[]): void {
  const callback = frames.shift();
  if (callback === undefined) throw new Error('Expected a scheduled frame.');
  callback(performance.now());
}

function main(text: string): HTMLElement {
  const element = document.createElement('main');
  element.textContent = text;
  return element;
}
