import type { ModelStepFaultPoint } from "../model-step-runner"
import type { RunFinalizerFaultPoint } from "../run-finalizer"
import type { ToolBatchFaultPoint } from "../tool-batch-runner"

// Canonical catalog of every named durable-boundary fault point across the
// three state machines the crash matrix (Task 16) proves recovery for. Each
// entry names which subsystem's `fault?:` callback it belongs to, so
// durable-run-child.ts (a real, killable Node child process) knows which
// deps bag to wire a process-exiting fault into for a given scenario.
//
// These are the SAME fault points Tasks 9-11's in-process unit tests already
// exercise via callback-throw simulation — this integration suite's only new
// claim is that a REAL process death (not a thrown JS error unwound within
// one still-running process) followed by a REAL fresh process reading only
// what's durable on disk recovers identically. It deliberately does not
// re-enumerate every unit-tested edge case; see durable-run-restart.test.ts
// for which representative subset it drives through a real child process.

export interface ModelFaultPoint {
  subsystem: "model"
  point: ModelStepFaultPoint
}
export interface ToolBatchFaultPointEntry {
  subsystem: "toolBatch"
  point: ToolBatchFaultPoint
}
export interface FinalizerFaultPoint {
  subsystem: "finalizer"
  point: RunFinalizerFaultPoint
}

export type DurableFaultPoint = ModelFaultPoint | ToolBatchFaultPointEntry | FinalizerFaultPoint

export const MODEL_FAULT_POINTS: readonly ModelStepFaultPoint[] = [
  "after_prepare",
  "after_hold_ledger",
  "after_hold",
  "after_dispatch_checkpoint",
  "before_provider_call",
  "after_provider_call",
  "after_response_staged",
  "after_settle_ledger",
  "after_settle",
  "after_unknown_response_checkpoint",
  "after_forfeit_ledger",
  "after_forfeit_checkpoint",
]

export const TOOL_BATCH_FAULT_POINTS: readonly ToolBatchFaultPoint[] = [
  "after_batch_created",
  "after_approval_pending",
  "after_approval_resolved",
  "after_attempt_started",
  "after_attempt_completed",
  "after_materialized",
]

export const FINALIZER_FAULT_POINTS: readonly RunFinalizerFaultPoint[] = [
  "before_prepare",
  "after_prepared",
  "before_conversation_commit",
  "after_conversation_committed",
  "before_trace_upsert",
  "after_trace_upserted",
  "before_resource_release",
  "after_resources_released",
  "before_lease_release",
  "after_lease_released",
  "before_complete",
  "after_complete",
]

export const ALL_FAULT_POINTS: readonly DurableFaultPoint[] = [
  ...MODEL_FAULT_POINTS.map((point): ModelFaultPoint => ({ subsystem: "model", point })),
  ...TOOL_BATCH_FAULT_POINTS.map(
    (point): ToolBatchFaultPointEntry => ({ subsystem: "toolBatch", point })
  ),
  ...FINALIZER_FAULT_POINTS.map(
    (point): FinalizerFaultPoint => ({ subsystem: "finalizer", point })
  ),
]

/** The child process's exit code when it deliberately dies at the requested
 *  fault point — distinct from a genuine crash (which could exit with any
 *  code, or none) so the parent test can tell "fault point reached and
 *  simulated-killed" apart from "child died some other way". */
export const SIMULATED_CRASH_EXIT_CODE = 91

export function faultPointId(fault: DurableFaultPoint): string {
  return `${fault.subsystem}:${fault.point}`
}
