import type { AgentRunEvent } from "@synapse/agent-protocol"
import type { RunEventStore } from "./run-event-store"
import { randomUUID } from "node:crypto"

// Assigns strictly-increasing sequence numbers and fills in the envelope
// fields (schemaVersion/eventId/runId/rootRunId/.../timestamp) every
// AgentRunEvent needs, so call sites throughout model-step-runner.ts,
// tool-batch-runner.ts, and run-finalizer.ts only ever supply the
// type-specific fields. One emitter is constructed per top-level driver
// invocation (see interactive-run-driver.ts), seeded from the event
// journal's current last sequence so a resumed/crashed-and-restarted run
// continues the same monotonic sequence rather than restarting at zero.

export interface RunEventIdentity {
  runId: string
  rootRunId: string
  parentRunId?: string
  conversationId?: string
}

/** Plain Omit collapses a discriminated union to its common fields only;
 *  this distributes the omission over each member so RunEventInput stays a
 *  discriminated union callers can narrow by `type`. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

// Normal lifecycle events are durably persisted. Text deltas intentionally
// stay live-only: storing every token would turn the observation journal into
// an unbounded transcript, but they still travel through this shared protocol
// rather than a second legacy renderer event bus.
export type RunEventInput = DistributiveOmit<
  Exclude<AgentRunEvent, { type: "text_delta" }>,
  | "schemaVersion"
  | "eventId"
  | "runId"
  | "rootRunId"
  | "parentRunId"
  | "conversationId"
  | "sequence"
  | "timestamp"
  | "persisted"
>

export interface RunEventEmitter {
  emit: (input: RunEventInput) => Promise<void>
  /** Optional so narrow test/maintenance emitters that only persist lifecycle
   * events remain valid; production emitters always provide it. */
  emitTextDelta?: (text: string) => void
}

// More than one driver may observe the same durable run. In particular a
// resumed parent driver and the child-task scheduler can both publish to the
// parent's journal. Keep that serialization process-wide rather than on an
// individual emitter, because scheduler lifecycle notifications deliberately
// use short-lived emitters.
const appendTails = new Map<string, Promise<void>>()

function serializeAppend<T>(runId: string, operation: () => Promise<T>): Promise<T> {
  const prior = appendTails.get(runId) ?? Promise.resolve()
  const queued = prior.then(operation, operation)
  const settled = queued.then(
    () => undefined,
    () => undefined
  )
  appendTails.set(runId, settled)
  void settled.then(() => {
    if (appendTails.get(runId) === settled) appendTails.delete(runId)
  })
  return queued
}

export async function createRunEventEmitter(
  store: Pick<RunEventStore, "readAll" | "append">,
  identity: RunEventIdentity,
  now: () => number,
  newId: () => string = randomUUID,
  /** Fired synchronously after a successful durable append — the real-time
   *  push side of the subscribeRun channel (P1-2). Never awaited and never
   *  allowed to throw back into the caller: a renderer-push failure must
   *  never break the agent driver, which is exactly why the event journal
   *  itself is written first and this hook second. */
  onEvent?: (event: AgentRunEvent) => void
): Promise<RunEventEmitter> {
  // The journal is observational. A corrupt/unreadable prior projection
  // must not prevent the checkpoint-authoritative driver from recovering;
  // start a fresh in-memory sequence and let append's own boundary decide
  // whether subsequent observations can be persisted.
  let existing: AgentRunEvent[] = []
  try {
    existing = await store.readAll(identity.runId)
  } catch {
    existing = []
  }
  let sequence = existing.length > 0 ? existing[existing.length - 1]!.sequence : 0

  const emitTextDelta = (text: string): void => {
    if (!text) return
    const event: AgentRunEvent = {
      type: "text_delta",
      schemaVersion: 1,
      eventId: newId(),
      runId: identity.runId,
      rootRunId: identity.rootRunId,
      parentRunId: identity.parentRunId,
      conversationId: identity.conversationId,
      // Live-only deltas never advance the journal cursor. Consumers that
      // fold durable snapshots ignore them before sequence-gap detection.
      sequence: Math.max(sequence, 1),
      timestamp: now(),
      persisted: false,
      text,
    }
    try {
      onEvent?.(event)
    } catch {
      // Renderer delivery is observational and must not affect the run.
    }
  }

  return {
    emitTextDelta,
    async emit(input: RunEventInput): Promise<void> {
      // Keep the live-only boundary effective even for an untyped/plugin
      // caller that bypasses RunEventInput's compile-time exclusion.
      if ((input as { type?: string }).type === "text_delta") {
        const text = (input as { text?: unknown }).text
        if (typeof text === "string") emitTextDelta(text)
        return
      }
      // The event journal is observational: a storage failure must never
      // break the checkpoint-authoritative driver. Serializing all emitters
      // for a run means normal concurrent lifecycle updates cannot race on a
      // sequence number and silently disappear after an arbitrary retry cap.
      await serializeAppend(identity.runId, async () => {
        let durableSequence = sequence
        try {
          const latest = await store.readAll(identity.runId)
          durableSequence = latest.length > 0 ? latest[latest.length - 1]!.sequence : 0
        } catch {
          // Fall back to this emitter's last successful write. append below
          // remains the durable boundary and its failure is still harmless.
        }
        const nextSequence = Math.max(sequence, durableSequence) + 1
        const event = {
          ...input,
          schemaVersion: 1,
          eventId: newId(),
          runId: identity.runId,
          rootRunId: identity.rootRunId,
          parentRunId: identity.parentRunId,
          conversationId: identity.conversationId,
          sequence: nextSequence,
          timestamp: now(),
          persisted: true,
        } as AgentRunEvent
        try {
          await store.append(identity.runId, event)
          sequence = nextSequence
          try {
            onEvent?.(event)
          } catch {
            // A broadcast-side failure must never surface as a driver failure.
          }
        } catch {
          // The checkpoint is authoritative. A diagnostic/projection write
          // failure must never stop a model/tool/finalization driver.
        }
      })
    },
  }
}
