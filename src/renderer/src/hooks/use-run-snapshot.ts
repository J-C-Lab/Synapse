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

    async function catchUp(fromSequence: number): Promise<void> {
      // A gap event arriving while an earlier catch-up is still in flight is
      // expected (more events kept arriving) — the in-flight call will pick
      // up everything once it re-reads the current lastSequence next time.
      if (catchingUp) return
      catchingUp = true
      try {
        const events = await getRunEventsSince(id, fromSequence)
        for (const event of events) {
          if (!stateRef.current) return
          const outcome = applyRunEvent(stateRef.current, event)
          if (outcome.kind === "applied") stateRef.current = outcome.state
        }
        if (alive && stateRef.current) setSnapshot(stateRef.current.snapshot)
      } finally {
        catchingUp = false
      }
    }

    void getRunSnapshot(id).then((initial) => {
      if (!alive || !initial) return
      stateRef.current = initRunSnapshotReducerState(initial)
      setSnapshot(initial)
    })

    const unsubscribe = onRunEvent((event) => {
      if (!stateRef.current) return
      const outcome = applyRunEvent(stateRef.current, event)
      if (outcome.kind === "applied") {
        stateRef.current = outcome.state
        setSnapshot(outcome.state.snapshot)
      } else if (outcome.kind === "gap") {
        void catchUp(outcome.state.snapshot.lastSequence)
      }
    })

    return () => {
      alive = false
      unsubscribe()
    }
  }, [runId])

  return snapshot
}
