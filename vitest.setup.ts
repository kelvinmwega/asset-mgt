import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Testing Library auto-registers cleanup ONLY when vitest runs with
// `globals: true`, which this project deliberately does not (vitest.config.ts).
// Without this, every render() leaks into the next test in the file: queries
// then hit "found multiple elements", or worse, silently assert against a
// previous test's DOM. Register it once here rather than per file.
afterEach(cleanup);

// Vitest loads .env into process.env, and this repo's gitignored .env holds the
// PRODUCTION DATABASE_URL (ops convenience from provisioning — AM-01 retro §5).
// So every test file starts life pointed at production, and a test that reaches
// getDb() before overriding DATABASE_URL itself would write to the live
// register. env() caches on first call, which makes it worse: one module
// touching env() early pins the production URL for the whole file.
//
// Point DATABASE_URL at the test database before any test code runs, so
// forgetting the per-file override is harmless instead of catastrophic. Files
// that set it themselves are unaffected. Without TEST_DATABASE_URL the
// integration suites skip anyway (describe.skipIf), and leaving the value alone
// keeps that skip behaviour honest.
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

// Radix/shadcn components need ResizeObserver, which jsdom does not provide
// (LEARNINGS §Testing).
class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = ResizeObserverStub;
}

// why: Radix and cmdk call pointer capture and scrollIntoView, absent from jsdom (testing/harness-repeat-offenders)
if (typeof Element !== "undefined") {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
}

// why: jsdom has no matchMedia; "no match" is the Combobox's desktop answer (testing/harness-repeat-offenders)
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
}
