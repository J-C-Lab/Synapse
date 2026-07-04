import type { ToolResult } from "@synapse/plugin-sdk"
import type { RegisteredToolDescriptor, ToolInvocationOptions } from "../plugins/types"
import type { BreakerConfig, ToolStatSnapshot } from "./tool-circuit-breaker"
import type { ToolHostPort } from "./tool-registry"
import { logger } from "../logging"
import { ToolCircuitBreaker } from "./tool-circuit-breaker"

// A ToolHostPort decorator that wraps every invocation in a per-tool circuit
// breaker + timeout, so one hung or dead tool source (a crashed MCP server, a
// wedged plugin) can't stall or repeatedly punch the agent loop. It sits
// between AiToolRegistry and CompositeToolHost — no other layer changes.
//
// What trips the breaker: thrown invocations and our own timeouts. What does
// NOT: `isError` results (domain errors) and caller cancellations (the user
// aborted — not the tool's fault). See tool-circuit-breaker.ts for the state
// machine. Unlike the reference it was adapted from, an open circuit returns an
// honest `isError` result (never a fake success) so the model reroutes.

const log = logger.child("tool-circuit")

export interface ResilientToolHostConfig {
  /** Static config, or a getter read afresh for each newly-created breaker. */
  breaker?: Partial<BreakerConfig> | (() => Partial<BreakerConfig>)
  /** Per-tool timeout in ms; `undefined` (the default) means no timeout. */
  timeoutMs?: (fqName: string) => number | undefined
  /**
   * The failure domain a tool belongs to. Defaults to grouping MCP tools by
   * server (`mcp:<server>/<tool>` → `mcp:<server>`) so one dead server trips
   * its whole toolset; every other tool is its own domain (its fqName).
   */
  bulkheadKey?: (fqName: string) => string
  /** Injectable clock (ms). Defaults to Date.now. */
  now?: () => number
  /** Closed breakers untouched for longer than this are evicted. */
  idleEvictMs?: number
  /** Hard cap on retained breakers; oldest-idle beyond it are evicted. */
  maxEntries?: number
}

const DEFAULT_IDLE_EVICT_MS = 60 * 60 * 1000 // 1h
const DEFAULT_MAX_ENTRIES = 1024

export class ResilientToolHost implements ToolHostPort {
  private readonly breakers = new Map<string, ToolCircuitBreaker>()
  private readonly now: () => number
  private readonly idleEvictMs: number
  private readonly maxEntries: number

  constructor(
    private readonly inner: ToolHostPort,
    private readonly config: ResilientToolHostConfig = {}
  ) {
    this.now = config.now ?? (() => Date.now())
    this.idleEvictMs = config.idleEvictMs ?? DEFAULT_IDLE_EVICT_MS
    this.maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES
  }

  listTools(): RegisteredToolDescriptor[] {
    return this.inner.listTools()
  }

  async invokeTool(
    fqName: string,
    input: unknown,
    options: ToolInvocationOptions
  ): Promise<ToolResult> {
    const key = this.keyOf(fqName)
    const breaker = this.breakerFor(key)

    if (breaker.tryAcquire(this.now()) === "block") {
      log.warn("short-circuited: tool temporarily unavailable", { key, fqName })
      return openCircuitResult(fqName, breaker.snapshot(this.now()))
    }

    const startedAt = this.now()
    const { signal, cleanup, timedOut } = this.withTimeout(fqName, options.signal)
    try {
      const result = await this.inner.invokeTool(fqName, input, { ...options, signal })
      const latency = this.now() - startedAt
      if (result.isError) breaker.recordToolError(latency, this.now())
      else breaker.recordSuccess(latency, this.now())
      return result
    } catch (err) {
      // Caller cancelled (user aborted the run): not the tool's failure.
      if (options.signal?.aborted) throw err
      if (timedOut()) {
        this.recordFailure(breaker, key, fqName)
        return timeoutResult(fqName)
      }
      this.recordFailure(breaker, key, fqName)
      throw err
    } finally {
      cleanup()
    }
  }

  /** Current per-domain health, for run traces / a debug panel. */
  snapshots(): ToolStatSnapshot[] {
    const now = this.now()
    return [...this.breakers.values()].map((b) => b.snapshot(now))
  }

  private recordFailure(breaker: ToolCircuitBreaker, key: string, fqName: string): void {
    const wasOpen = breaker.snapshot(this.now()).state === "open"
    breaker.recordInfraFailure(this.now())
    if (!wasOpen && breaker.snapshot(this.now()).state === "open") {
      log.warn("circuit opened after repeated failures", { key, fqName })
    }
  }

  private keyOf(fqName: string): string {
    if (this.config.bulkheadKey) return this.config.bulkheadKey(fqName)
    if (fqName.startsWith("mcp:")) {
      const slash = fqName.indexOf("/")
      return slash === -1 ? fqName : fqName.slice(0, slash)
    }
    return fqName
  }

  /** Drop all breakers so they recreate with the current config (P3 retune). */
  resetBreakers(): void {
    this.breakers.clear()
  }

  private breakerFor(key: string): ToolCircuitBreaker {
    this.evictIdle(key)
    let breaker = this.breakers.get(key)
    if (!breaker) {
      const cfg =
        typeof this.config.breaker === "function" ? this.config.breaker() : this.config.breaker
      breaker = new ToolCircuitBreaker(key, cfg)
      this.breakers.set(key, breaker)
    }
    return breaker
  }

  // Bounded-map maintenance (fixes the unbounded-cache leak in the reference):
  // drop closed breakers idle past the window, then enforce the hard cap.
  private evictIdle(exceptKey: string): void {
    const now = this.now()
    for (const [k, b] of this.breakers) {
      if (k === exceptKey) continue
      if (b.snapshot(now).state === "closed" && now - b.idleSince() > this.idleEvictMs) {
        this.breakers.delete(k)
      }
    }
    if (this.breakers.size <= this.maxEntries) return
    const idleAscending = [...this.breakers.entries()]
      .filter(([k]) => k !== exceptKey)
      .sort(([, a], [, b]) => a.idleSince() - b.idleSince())
    for (const [k] of idleAscending) {
      if (this.breakers.size <= this.maxEntries) break
      this.breakers.delete(k)
    }
  }

  /**
   * Race the caller's signal with a fresh timeout controller. Returns the signal
   * to hand the inner host, a cleanup, and a predicate that reports whether the
   * timeout (not the caller) fired.
   */
  private withTimeout(
    fqName: string,
    callerSignal: AbortSignal | undefined
  ): { signal: AbortSignal | undefined; cleanup: () => void; timedOut: () => boolean } {
    const ms = this.config.timeoutMs?.(fqName)
    if (ms === undefined || ms <= 0) {
      return { signal: callerSignal, cleanup: () => {}, timedOut: () => false }
    }
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new DOMException("timeout", "TimeoutError")),
      ms
    )
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, controller.signal])
      : controller.signal
    return {
      signal,
      cleanup: () => clearTimeout(timer),
      timedOut: () => controller.signal.aborted,
    }
  }
}

function openCircuitResult(fqName: string, snap: ToolStatSnapshot): ToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text:
          `Tool "${fqName}" is temporarily unavailable (circuit open after ` +
          `${snap.consecutiveFailures} consecutive failures). ` +
          `Retry later or use a different approach.`,
      },
    ],
  }
}

function timeoutResult(fqName: string): ToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: `Tool "${fqName}" timed out and was aborted.` }],
  }
}
