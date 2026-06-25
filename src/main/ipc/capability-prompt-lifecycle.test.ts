import type { WebContents } from "electron"
import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import { attachCapabilityPromptLifecycle } from "./capability-prompt-lifecycle"

function mockWebContents(): WebContents & EventEmitter {
  const emitter = new EventEmitter()
  return Object.assign(emitter, {
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter),
  }) as unknown as WebContents & EventEmitter
}

/**
 * Mirrors Electron's `did-start-navigation`: the first listener arg is the
 * `Event<WebContentsDidStartNavigationEventParams>` carrying the named fields
 * (`isMainFrame`, `isSameDocument`, …) that the handler reads.
 */
function emitNavigation(
  wc: WebContents & EventEmitter,
  options: { isMainFrame?: boolean; isSameDocument?: boolean } = {}
): void {
  const isSameDocument = options.isSameDocument ?? false
  wc.emit("did-start-navigation", {
    url: "app://app/index.html",
    isInPlace: isSameDocument,
    isMainFrame: options.isMainFrame ?? true,
    isSameDocument,
  })
}

function emitMainNavigation(
  wc: WebContents & EventEmitter,
  options: { isSameDocument?: boolean } = {}
): void {
  emitNavigation(wc, { isMainFrame: true, isSameDocument: options.isSameDocument })
}

describe("attachCapabilityPromptLifecycle", () => {
  it("ignores the first main-frame load then fires on cross-document reload", () => {
    const wc = mockWebContents()
    const onStale = vi.fn()
    attachCapabilityPromptLifecycle(wc, onStale)

    emitMainNavigation(wc)
    expect(onStale).not.toHaveBeenCalled()

    emitMainNavigation(wc)
    expect(onStale).toHaveBeenCalledOnce()
  })

  it("does not treat same-document hash navigations as a reload", () => {
    const wc = mockWebContents()
    const onStale = vi.fn()
    attachCapabilityPromptLifecycle(wc, onStale)

    emitMainNavigation(wc)
    emitMainNavigation(wc, { isSameDocument: true })
    emitMainNavigation(wc, { isSameDocument: true })

    expect(onStale).not.toHaveBeenCalled()
  })

  it("ignores sub-frame navigations", () => {
    const wc = mockWebContents()
    const onStale = vi.fn()
    attachCapabilityPromptLifecycle(wc, onStale)

    emitMainNavigation(wc)
    emitNavigation(wc, { isMainFrame: false })
    emitMainNavigation(wc)

    expect(onStale).toHaveBeenCalledOnce()
  })

  it("fires on render-process-gone and destroyed", () => {
    const wc = mockWebContents()
    const onStale = vi.fn()
    attachCapabilityPromptLifecycle(wc, onStale)

    wc.emit("render-process-gone")
    expect(onStale).toHaveBeenCalledOnce()

    wc.emit("destroyed")
    expect(onStale).toHaveBeenCalledTimes(2)
  })
})
