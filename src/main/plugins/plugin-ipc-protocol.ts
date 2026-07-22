import type { PluginManifest } from "@synapse/plugin-manifest"
import type { ToolCaller, ToolContentBlock } from "@synapse/plugin-sdk"

/**
 * Message shapes exchanged between the host process and a plugin's
 * `utilityProcess` child over a `MessagePortMain`. Plugin code runs in its
 * own OS process here (Critical #1 — see plugin-process-host.ts) instead of
 * a `node:vm` context in the host process: there is no shared V8 heap,
 * `require` cache, or object graph, so the escape this replaces (a captured
 * host function reference reaching real `process`/`require` via
 * `Function.constructor`) has nothing to capture.
 *
 * Capability-gate state (grants, prompts, budgets, `CapabilityGovernance`)
 * stays entirely host-side. The child only ever carries opaque ids
 * (`pluginId`, `invocationId`, `callId`) — never a real host object,
 * function reference, or secret. Every capability call the child's thin
 * `ctx` stub makes is a plain, serializable request; the host looks up the
 * real `PluginBridge`-backed implementation itself.
 */

// ── Command / tool / event / trigger invocation (host -> child) ──────────

export interface InvokeCommandWireRequest {
  commandId: string
  phase: "run" | "onSearchChange" | "onAction"
  payload?: unknown
}

export interface InvokeCommandMessage {
  type: "invoke-command"
  callId: string
  request: InvokeCommandWireRequest
}

export interface DisposeCommandMessage {
  type: "dispose-command"
  callId: string
  commandId: string
}

export interface InvokeToolWireRequest {
  toolName: string
  input: unknown
  caller: ToolCaller
}

export interface InvokeToolMessage {
  type: "invoke-tool"
  callId: string
  request: InvokeToolWireRequest
}

/** Host tells the child to abort a tool's `ctx.signal` (timeout or caller cancel). */
export interface CancelToolMessage {
  type: "cancel-tool"
  callId: string
  reason?: string
}

export interface DispatchEventMessage {
  type: "dispatch-event"
  callId: string
  event: "clipboard:change"
  payload: unknown
}

export interface DispatchTriggerMessage {
  type: "dispatch-trigger"
  callId: string
  /** Manifest handler path, e.g. "triggers.onTick". */
  handler: string
  trigger: string
  invocationId: string
  event: unknown
}

/** Host tells the child to abort a trigger dispatch's signal. */
export interface CancelTriggerMessage {
  type: "cancel-trigger"
  callId: string
}

// ── Results (child -> host) ───────────────────────────────────────────────

export interface SerializedError {
  message: string
  stack?: string
}

export interface InvokeCommandResultMessage {
  type: "invoke-command-result"
  callId: string
  ok: boolean
  /** A `View | void` on success. */
  value?: unknown
  error?: SerializedError
}

export interface DisposeCommandResultMessage {
  type: "dispose-command-result"
  callId: string
  ok: boolean
  error?: SerializedError
}

export interface InvokeToolResultMessage {
  type: "invoke-tool-result"
  callId: string
  ok: boolean
  value?: { content: ToolContentBlock[]; isError?: boolean; structured?: unknown }
  error?: SerializedError
}

export interface DispatchEventResultMessage {
  type: "dispatch-event-result"
  callId: string
  ok: boolean
  error?: SerializedError
}

export interface DispatchTriggerResultMessage {
  type: "dispatch-trigger-result"
  callId: string
  ok: boolean
  error?: SerializedError
}

/** Reports `ctx.progress(pct, message)` for an in-flight tool call. */
export interface ToolProgressMessage {
  type: "tool-progress"
  callId: string
  pct: number
  message?: string
}

// ── Generic capability calls (child -> host -> child) ────────────────────

/**
 * Every `ctx.*` method that is plain data in/out — `storage.get`,
 * `clipboard.readText`, `fs.move`, `credentials.status`, etc. — is a single
 * request/response round trip through this generic envelope. `capability`
 * is a dot-path into the ctx object (e.g. `"storage.get"`); `args` is the
 * method's argument list. The host's dispatcher (plugin-process-host.ts)
 * maps `capability` to the real `PluginBridge`-backed implementation —
 * this is the ONLY place gate/grant/audit logic runs, matching the
 * pre-migration design where the sandbox called `PluginBridge` directly.
 */
export interface CapabilityCallMessage {
  type: "capability-call"
  callId: string
  invocationId: string
  capability: string
  args: unknown[]
}

export interface CapabilityCallResultMessage {
  type: "capability-call-result"
  callId: string
  ok: boolean
  value?: unknown
  error?: SerializedError
}

// ── clipboard.watch (push-based; no listener function crosses the boundary) ──

/** Host -> child: the OS clipboard changed for a listener this child registered. */
export interface ClipboardChangedMessage {
  type: "clipboard-changed"
  listenerId: string
  content: unknown
}

// ── network.fetchStream (chunked; the request itself is one capability call) ──

export interface StreamChunkMessage {
  type: "stream-chunk"
  streamId: string
  /** Transferred as an ArrayBuffer over MessagePortMain, not base64. */
  data: ArrayBuffer
}

export interface StreamEndMessage {
  type: "stream-end"
  streamId: string
}

export interface StreamErrorMessage {
  type: "stream-error"
  streamId: string
  error: SerializedError
}

/** Child -> host: stop reading, release the in-flight slot (NetworkStreamBody.cancel()). */
export interface StreamCancelMessage {
  type: "stream-cancel"
  streamId: string
}

// ── Lifecycle ──────────────────────────────────────────────────────────────

export interface LoadPluginMessage {
  type: "load-plugin"
  callId: string
  pluginId: string
  rootDir: string
  mainPath: string
  manifest: PluginManifest
}

export interface LoadPluginResultMessage {
  type: "load-plugin-result"
  callId: string
  ok: boolean
  /** Command ids and tool names the loaded module actually exports. */
  value?: { commandIds: string[]; toolNames: string[]; hasClipboardChangeHandler: boolean }
  error?: SerializedError
}

/** Unhandled error in the child (e.g. a runaway timer callback throwing) — not
 *  tied to any in-flight call. The host treats this like a crash. */
export interface ChildFaultMessage {
  type: "child-fault"
  error: SerializedError
}

export type HostToChildMessage =
  | LoadPluginMessage
  | InvokeCommandMessage
  | DisposeCommandMessage
  | InvokeToolMessage
  | CancelToolMessage
  | DispatchEventMessage
  | DispatchTriggerMessage
  | CancelTriggerMessage
  | CapabilityCallResultMessage
  | ClipboardChangedMessage
  | StreamChunkMessage
  | StreamEndMessage
  | StreamErrorMessage

export type ChildToHostMessage =
  | LoadPluginResultMessage
  | InvokeCommandResultMessage
  | DisposeCommandResultMessage
  | InvokeToolResultMessage
  | ToolProgressMessage
  | DispatchEventResultMessage
  | DispatchTriggerResultMessage
  | CapabilityCallMessage
  | StreamCancelMessage
  | ChildFaultMessage

let callIdCounter = 0

/** Monotonic per-process call ids — readable in logs, unlike a UUID, and
 *  cheaper than crypto.randomUUID() for a value that's never a secret and
 *  never crosses a trust boundary (child and host each mint their own). */
export function nextCallId(prefix: string): string {
  callIdCounter += 1
  return `${prefix}-${callIdCounter}`
}

export function serializeError(err: unknown): SerializedError {
  if (
    err &&
    typeof err === "object" &&
    typeof (err as { message?: unknown }).message === "string"
  ) {
    const stack = (err as { stack?: unknown }).stack
    return {
      message: (err as { message: string }).message,
      stack: typeof stack === "string" ? stack : undefined,
    }
  }
  return { message: String(err) }
}

/** Reconstruct an Error from a wire-transferred SerializedError, preserving
 *  the original stack for host-side logs when available. */
export function deserializeError(serialized: SerializedError): Error {
  const err = new Error(serialized.message)
  if (serialized.stack) err.stack = serialized.stack
  return err
}
