import type { ClipboardContentType, ClipboardTriggerScope } from "@synapse/plugin-manifest"
import type { ClipboardContent } from "@synapse/plugin-sdk"
import type { Buffer as NodeBuffer } from "node:buffer"
import { createHash, createHmac, randomBytes } from "node:crypto"

export interface ClipboardEvent {
  contentTypes: ClipboardContentType[]
  textLength?: number
  changedAt: number
}

export interface ClipboardAdapterOptions {
  pollMs?: number
  read: () => Promise<ClipboardContent | undefined>
  now?: () => number
  /** Runtime-private key for change dedup — never exposed to plugins. */
  dedupSecret?: NodeBuffer
  setTimer?: (cb: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export interface ClipboardAdapter {
  register: (
    pluginId: string,
    triggerId: string,
    scope: ClipboardTriggerScope,
    fire: (e: ClipboardEvent) => void
  ) => () => void
}

/** Shared host clipboard poll — triggers, legacy activation, and bridge watch. */
export interface ClipboardPollHub extends ClipboardAdapter {
  registerContentListener: (
    key: string,
    listener: (content: ClipboardContent) => void
  ) => () => void
  drain: () => Promise<void>
}

const ALL_CONTENT_TYPES: ClipboardContentType[] = ["text", "image", "file"]

function contentTypeOf(content: ClipboardContent): ClipboardContentType {
  return content.type
}

function toSafeEvent(content: ClipboardContent, changedAt: number): ClipboardEvent {
  const event: ClipboardEvent = {
    contentTypes: [contentTypeOf(content)],
    changedAt,
  }
  if (content.type === "text") event.textLength = content.text.length
  return event
}

function matchesScope(content: ClipboardContent, scope: ClipboardTriggerScope): boolean {
  const allowed = scope.contentTypes ?? ALL_CONTENT_TYPES
  return allowed.includes(contentTypeOf(content))
}

/** Host-private keyed fingerprint — never handed to the plugin. */
function fingerprint(content: ClipboardContent, secret: NodeBuffer): string {
  let payload: string
  if (content.type === "text") payload = content.text
  else if (content.type === "image")
    payload = createHash("sha256").update(content.dataUrl).digest("hex")
  else payload = content.paths.join("\0")
  return createHmac("sha256", secret).update(payload).digest("hex")
}

function registrationKey(pluginId: string, triggerId: string): string {
  return `${pluginId}\0${triggerId}`
}

export function createClipboardAdapter(options: ClipboardAdapterOptions): ClipboardPollHub {
  const pollMs = options.pollMs ?? 500
  const now = options.now ?? Date.now
  const secret = options.dedupSecret ?? randomBytes(32)
  const setTimer = options.setTimer ?? ((cb, ms) => setInterval(cb, ms))
  const clearTimer =
    options.clearTimer ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>))

  interface Registration {
    pluginId: string
    triggerId: string
    scope: ClipboardTriggerScope
    fire: (e: ClipboardEvent) => void
  }

  const registrations = new Map<string, Registration>()
  const contentListeners = new Map<string, (content: ClipboardContent) => void>()
  let pollHandle: unknown
  let lastFingerprint: string | undefined
  let readChain: Promise<void> = Promise.resolve()

  function hasSubscribers(): boolean {
    return registrations.size > 0 || contentListeners.size > 0
  }

  function stopPollIfIdle(): void {
    if (hasSubscribers() || pollHandle === undefined) return
    clearTimer(pollHandle)
    pollHandle = undefined
    lastFingerprint = undefined
  }

  function startPollIfNeeded(): void {
    if (pollHandle !== undefined) return
    pollHandle = setTimer(() => queueRead(), pollMs)
    queueRead()
  }

  function queueRead(): void {
    readChain = readChain.then(() => pollOnce()).catch(() => {})
  }

  async function pollOnce(): Promise<void> {
    if (!hasSubscribers()) return

    const content = await options.read()
    if (!content) return

    const fp = fingerprint(content, secret)
    if (fp === lastFingerprint) return
    lastFingerprint = fp

    const changedAt = now()
    const event = toSafeEvent(content, changedAt)

    for (const reg of registrations.values()) {
      if (!matchesScope(content, reg.scope)) continue
      reg.fire(event)
    }

    for (const listener of contentListeners.values()) listener(content)
  }

  return {
    register(pluginId, triggerId, scope, fire) {
      const key = registrationKey(pluginId, triggerId)
      registrations.set(key, { pluginId, triggerId, scope, fire })
      startPollIfNeeded()
      return () => {
        registrations.delete(key)
        if (registrations.size === 0) lastFingerprint = undefined
        stopPollIfIdle()
      }
    },

    registerContentListener(key, listener) {
      contentListeners.set(key, listener)
      startPollIfNeeded()
      return () => {
        contentListeners.delete(key)
        if (contentListeners.size === 0) lastFingerprint = undefined
        stopPollIfIdle()
      }
    },

    drain: () => readChain,
  }
}
