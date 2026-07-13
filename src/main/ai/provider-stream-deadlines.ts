import type { ChatProvider, ProviderRequest, ProviderStreamEvent } from "./providers/types"

export type DeadlineKind = "headers" | "idle" | "duration"

export class ProviderStreamDeadlineError extends Error {
  constructor(
    readonly kind: DeadlineKind,
    readonly ms: number
  ) {
    super(`provider stream ${kind} deadline of ${ms}ms exceeded`)
    this.name = "ProviderStreamDeadlineError"
  }
}

export interface ProviderStreamDeadlines {
  headersDeadlineMs?: number
  idleTimeoutMs?: number
  maxDurationMs?: number
}

const DEFAULT_HEADERS_DEADLINE_MS = 30_000
const DEFAULT_IDLE_TIMEOUT_MS = 60_000
const DEFAULT_MAX_DURATION_MS = 600_000

type TerminalCause = { type: "caller" } | { type: "deadline"; error: ProviderStreamDeadlineError }

function combineAbortSignals(primary: AbortSignal, secondary: AbortSignal): AbortSignal {
  if (typeof AbortSignal.any === "function") return AbortSignal.any([primary, secondary])

  const controller = new AbortController()
  if (primary.aborted) controller.abort(primary.reason)
  else if (secondary.aborted) controller.abort(secondary.reason)
  else {
    primary.addEventListener("abort", () => controller.abort(primary.reason), { once: true })
    secondary.addEventListener("abort", () => controller.abort(secondary.reason), { once: true })
  }
  return controller.signal
}

/** Wraps a ChatProvider's stream with absolute headers/idle/duration
 *  deadlines, driven by the provider calling req.onTransportProgress at
 *  the raw-SDK-event level (the normalized ProviderStreamEvent stream
 *  doesn't reliably signal "the server responded" — see the design spec).
 *  Tracks its own first-terminal-cause-wins state so a deadline firing
 *  surfaces as ProviderStreamDeadlineError regardless of what the
 *  underlying vendor SDK does with an aborted signal. */
export async function* streamWithDeadlines(
  provider: ChatProvider,
  req: ProviderRequest,
  deadlines: ProviderStreamDeadlines = {}
): AsyncGenerator<ProviderStreamEvent> {
  const headersDeadlineMs = deadlines.headersDeadlineMs ?? DEFAULT_HEADERS_DEADLINE_MS
  const idleTimeoutMs = deadlines.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const maxDurationMs = deadlines.maxDurationMs ?? DEFAULT_MAX_DURATION_MS

  const controller = new AbortController()
  const combinedSignal = req.signal
    ? combineAbortSignals(req.signal, controller.signal)
    : controller.signal

  let terminalCause: TerminalCause | undefined
  let closed = false
  let headersTimer: ReturnType<typeof setTimeout> | undefined
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let durationTimer: ReturnType<typeof setTimeout> | undefined

  function clearAllTimers(): void {
    if (headersTimer) clearTimeout(headersTimer)
    if (idleTimer) clearTimeout(idleTimer)
    if (durationTimer) clearTimeout(durationTimer)
  }

  function fireDeadline(kind: DeadlineKind, ms: number): void {
    if (closed || terminalCause || req.signal?.aborted) return
    const error = new ProviderStreamDeadlineError(kind, ms)
    terminalCause = { type: "deadline", error }
    clearAllTimers()
    controller.abort(error)
  }

  function onCallerAbort(): void {
    if (closed || terminalCause) return
    terminalCause = { type: "caller" }
    clearAllTimers()
  }
  req.signal?.addEventListener("abort", onCallerAbort, { once: true })

  function armIdle(): void {
    if (closed || terminalCause) return
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(fireDeadline, idleTimeoutMs, "idle", idleTimeoutMs)
    if (typeof idleTimer.unref === "function") idleTimer.unref()
  }

  headersTimer = setTimeout(fireDeadline, headersDeadlineMs, "headers", headersDeadlineMs)
  if (typeof headersTimer.unref === "function") headersTimer.unref()
  durationTimer = setTimeout(fireDeadline, maxDurationMs, "duration", maxDurationMs)
  if (typeof durationTimer.unref === "function") durationTimer.unref()

  const onTransportProgress = (phase: "headers" | "activity"): void => {
    if (closed || terminalCause) return
    if (phase === "headers") {
      if (headersTimer) clearTimeout(headersTimer)
      headersTimer = undefined
      armIdle()
    } else {
      armIdle()
    }
  }

  try {
    const source = provider.stream({ ...req, signal: combinedSignal, onTransportProgress })
    for await (const event of source) {
      if (terminalCause?.type === "deadline") throw terminalCause.error
      yield event
    }
    if (terminalCause?.type === "deadline") throw terminalCause.error
  } catch (error) {
    if (terminalCause?.type === "deadline") throw terminalCause.error
    throw error
  } finally {
    closed = true
    clearAllTimers()
    req.signal?.removeEventListener("abort", onCallerAbort)
  }
}
