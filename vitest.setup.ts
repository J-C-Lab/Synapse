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

// jsdom doesn't implement pointer capture or scrollIntoView, which Radix's
// Select/DropdownMenu/Popover primitives call when opening. No-op stubs let
// tests open these popups without polyfilling full pointer-event geometry.
if (typeof Element !== "undefined") {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {}
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {}
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {}
  }
}
