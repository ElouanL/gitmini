// Common initialization of vitest (jsdom): matchers DOM, cleaning between tests.
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/svelte';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});

// jsdom does not implement ResizeObserver, IntersectionObserver, or scrollIntoView: single linings are sufficient for the components.
class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): unknown[] {
    return [];
  }
}
const g = globalThis as Record<string, unknown>;
g.ResizeObserver ??= NoopObserver;
g.IntersectionObserver ??= NoopObserver;
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};
