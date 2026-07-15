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

// Every event this emitter produces is durably persisted (persisted: true) —
// it only ever calls RunEventStore.append. The protocol's "persisted: false"
// case is for live-only deltas (text streaming) that need a separate
// in-process bus interactive chat's existing AiChatEvent mechanism already
// covers; wiring that bus is out of scope here (see design note in
// packages/agent-protocol/src/events.ts).
export type RunEventInput = DistributiveOmit<
  AgentRunEvent,
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
}

export async function createRunEventEmitter(
  store: RunEventStore,
  identity: RunEventIdentity,
  now: () => number,
  newId: () => string = randomUUID
): Promise<RunEventEmitter> {
  const existing = await store.readAll(identity.runId)
  let sequence = existing.length > 0 ? existing[existing.length - 1]!.sequence : 0

  return {
    async emit(input: RunEventInput): Promise<void> {
      sequence += 1
      const event = {
        ...input,
        schemaVersion: 1,
        eventId: newId(),
        runId: identity.runId,
        rootRunId: identity.rootRunId,
        parentRunId: identity.parentRunId,
        conversationId: identity.conversationId,
        sequence,
        timestamp: now(),
        persisted: true,
      } as AgentRunEvent
      await store.append(identity.runId, event)
    },
  }
}
