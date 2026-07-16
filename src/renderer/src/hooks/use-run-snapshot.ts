import type { AgentRunSnapshot } from "@synapse/agent-protocol"
import type { RunSnapshotReducerState } from "@/lib/run-snapshot-reducer"
import { useEffect, useRef, useState } from "react"
import { getRunEventsSince, getRunSnapshot, onRunEvent } from "@/lib/electron"
import { applyRunEvent, initRunSnapshotReducerState } from "@/lib/run-snapshot-reducer"

// The consumer half of the snapshot-then-subscribe pattern (P1-2):
// getRunSnapshot() for the initial point-in-time view, onRunEvent() pushed
// live from there, run-snapshot-reducer.ts folding each event in with
// eventId de-duplication and sequence-gap detection. A gap (a dropped or
// out-of-order live event) triggers a getRunEventsSince() catch-up rather
// than silently drifting from the durable truth.

export function useRunSnapshot(runId: string | undefined): AgentRunSnapshot | undefined {
  const [snapshot, setSnapshot] = useState<AgentRunSnapshot | undefined>(undefined)
  const stateRef = useRef<RunSnapshotReducerState | undefined>(undefined)

  useEffect(() => {
    stateRef.current = undefined
    setSnapshot(undefined)
    if (!runId) return
    const id = runId

    let alive = true
    let catchingUp = false
    let requestedThrough = 0
    const bufferedEvents: import("@synapse/agent-protocol").AgentRunEvent[] = []

    function publish(): void {
      if (alive && stateRef.current) setSnapshot(stateRef.current.snapshot)
    }

    function apply(event: import("@synapse/agent-protocol").AgentRunEvent): void {
      if (!stateRef.current) {
        bufferedEvents.push(event)
        return
      }
      const outcome = applyRunEvent(stateRef.current, event)
      if (outcome.kind === "applied") {
        stateRef.current = outcome.state
        publish()
      } else if (outcome.kind === "gap") {
        requestedThrough = Math.max(requestedThrough, event.sequence)
        void catchUp()
      }
    }

    async function catchUp(): Promise<void> {
      if (catchingUp || !stateRef.current) return
      catchingUp = true
      try {
        do {
          const state = stateRef.current
          if (!state) return
          requestedThrough = 0
          const events = (await getRunEventsSince(id, state.snapshot.lastSequence)) ?? []
          for (const event of events) apply(event)
          publish()
          // A live event can arrive after getRunEventsSince's read but before
          // this loop reaches finally. Its gap raises requestedThrough again,
          // so keep draining until no later sequence remains requested.
        } while (stateRef.current && requestedThrough > stateRef.current.snapshot.lastSequence)
      } finally {
        catchingUp = false
        if (stateRef.current && requestedThrough > stateRef.current.snapshot.lastSequence) {
          void catchUp()
        }
      }
    }

    // Subscribe first. Events arriving while the snapshot request is in
    // flight are buffered and merged after its durable sequence watermark,
    // closing the otherwise permanent snapshot/subscribe race window.
    const unsubscribe = onRunEvent(apply)

    void getRunSnapshot(id).then((initial) => {
      if (!alive || !initial) return
      stateRef.current = initRunSnapshotReducerState(initial)
      setSnapshot(initial)
      for (const event of bufferedEvents.splice(0).sort((a, b) => a.sequence - b.sequence)) {
        apply(event)
      }
    })

    return () => {
      alive = false
      unsubscribe()
    }
  }, [runId])

  return snapshot
}
