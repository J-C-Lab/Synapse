import type { WebContents } from "electron"
import { BrowserWindow } from "electron"

const promptTargetStack: WebContents[] = []

/**
 * While `fn` runs, capability JIT / approval prompts are delivered to this
 * renderer (the IPC caller) instead of every window.
 */
export async function withCapabilityPromptTarget<T>(
  target: WebContents,
  fn: () => T | Promise<T>
): Promise<T> {
  const wc = target.isDestroyed() ? undefined : target
  if (wc) promptTargetStack.push(wc)
  try {
    return await fn()
  } finally {
    if (wc) {
      const index = promptTargetStack.lastIndexOf(wc)
      if (index >= 0) promptTargetStack.splice(index, 1)
    }
  }
}

export function createCapabilityPromptSender(
  broadcast: (channel: string, payload: unknown) => void
): {
  sendGrantRequest: (payload: unknown) => void
  sendApprovalRequest: (payload: unknown) => void
} {
  return {
    sendGrantRequest: (payload) =>
      deliverCapabilityPrompt("capabilities:grant-request", payload, broadcast),
    sendApprovalRequest: (payload) =>
      deliverCapabilityPrompt("capabilities:approval-request", payload, broadcast),
  }
}

function deliverCapabilityPrompt(
  channel: string,
  payload: unknown,
  broadcast: (channel: string, payload: unknown) => void
): void {
  const targeted = currentPromptTarget()
  if (targeted) {
    targeted.send(channel, payload)
    return
  }

  const focused = BrowserWindow.getFocusedWindow()
  if (focused && isPromptCapableWebContents(focused.webContents)) {
    focused.webContents.send(channel, payload)
    return
  }

  const visible = promptCapableWindows().filter((win) => win.isVisible())
  if (visible.length === 1) {
    visible[0]!.webContents.send(channel, payload)
    return
  }

  broadcast(channel, payload)
}

function currentPromptTarget(): WebContents | undefined {
  while (promptTargetStack.length > 0) {
    const wc = promptTargetStack[promptTargetStack.length - 1]
    if (!wc || wc.isDestroyed()) {
      promptTargetStack.pop()
      continue
    }
    return wc
  }
  return undefined
}

function isPromptCapableWebContents(webContents: WebContents): boolean {
  if (webContents.isDestroyed()) return false
  return !webContents.getURL().includes("#floating-ball")
}

function promptCapableWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter(
    (win) => !win.isDestroyed() && isPromptCapableWebContents(win.webContents)
  )
}

/** Test seam: reset stack between cases. */
export function resetCapabilityPromptTargetsForTests(): void {
  promptTargetStack.length = 0
}
