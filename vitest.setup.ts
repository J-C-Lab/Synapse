import "@testing-library/jest-dom/vitest"

// jsdom does not implement ResizeObserver, which some components (e.g. input-otp)
// rely on. Provide a no-op stub so they can mount in the test environment.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
}

// jsdom lacks elementFromPoint, which input-otp's password-manager badge
// detection calls from a timer. Stub it to avoid stray async errors in tests.
if (typeof document !== "undefined" && typeof document.elementFromPoint !== "function") {
  document.elementFromPoint = () => null
}
