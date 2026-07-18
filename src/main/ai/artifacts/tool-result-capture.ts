import type { AgentArtifactRefSummary } from "@synapse/agent-protocol"
import type { AgentArtifactRef, AgentArtifactStore, ArtifactOwnerContext } from "./artifact-types"

// Offload decision for one tool result's rendered text (design §"Recoverable
// artifact backend" / Task 19). Pure decision + composition logic — no
// registry, no checkpoint, no envelope wrapping. tool-batch-runner.ts calls
// this with the raw (pre-truncation) rendered text of a tool result and gets
// back a bounded, self-describing preview plus (when offload happened) both
// the renderer-safe summary and the full host-only ref. The caller is
// responsible for applying the untrusted-content envelope to `previewText`
// and for persisting `artifact`/`fullArtifact` — this module does no I/O
// beyond the one optional `store.capture()` call.

/** Everything needed to offload oversized text into a durable artifact.
 *  Omit entirely (pass `undefined`) when there is no run to scope a durable
 *  artifact under (no artifact store wired, or the caller carries no runId)
 *  — mirrors execution-tool-host.ts's buildArtifactCapture rule exactly. */
export interface ToolResultCaptureBackend {
  store: AgentArtifactStore
  owner: ArtifactOwnerContext
}

export interface ToolResultCaptureOptions {
  /** Raw text length (UTF-16 code units) at or under which nothing is
   *  captured — the text is returned completely unchanged. Above it, an
   *  offload is attempted. Defaults to 24_000, matching
   *  context/tool-result-budget.ts's pre-existing truncateToolResultText
   *  budget: anything that would previously have been silently truncated at
   *  that boundary is, from this task on, captured in full instead. */
  captureThresholdChars?: number
  /** Bounded live preview split retained in the model-facing text once an
   *  offload is attempted, in UTF-16 code units — computed directly off the
   *  in-memory string (no streaming tee; a ToolResult's content is already
   *  fully resident by the time this runs). */
  headPreviewChars?: number
  tailPreviewChars?: number
  /** Hard ceiling applied to the composed preview text on every path that
   *  does NOT end with a successful, store-backed capture (no backend
   *  wired, or the capture attempt itself threw) — the last line of defense
   *  against an unbounded string reaching the model or the checkpoint.
   *  Defaults to EMERGENCY_INLINE_CAP_CHARS. */
  emergencyCapChars?: number
}

export interface ToolResultCapture {
  /** Bounded, self-describing text for the model / PersistedToolResult.preview
   *  (before the untrusted-content envelope is applied). Below the
   *  threshold: the raw text, byte-for-byte. At/above it: a head+tail
   *  preview plus a metadata footer describing what happened. */
  previewText: string
  /** Whether the full original text is durably captured (below threshold —
   *  trivially true — or a complete artifact capture) versus only a bounded
   *  preview surviving anywhere (truncated capture, no backend, or a failed
   *  offload). */
  complete: boolean
  /** Renderer-safe projection of the artifact, present only on a completed
   *  `store.capture()` call (regardless of whether that capture itself was
   *  truncated by the store's own limits). */
  artifact?: AgentArtifactRefSummary
  /** The full host-only ref backing `artifact`, for durable round-tripping
   *  into ChatContentBlock.tool_result.artifact — never sent to a renderer
   *  directly. */
  fullArtifact?: AgentArtifactRef
  /** True only when a `store.capture()` call was actually attempted and
   *  threw — i.e. an offload was tried and explicitly failed, not merely
   *  "no backend was available to try." Design §"Recoverable artifact
   *  backend": offload failure must never silently discard content; when
   *  this is true, `previewText` is instead capped at the emergency ceiling
   *  and says so. */
  offloadFailed: boolean
}

export const DEFAULT_CAPTURE_THRESHOLD_CHARS = 24_000
export const DEFAULT_HEAD_PREVIEW_CHARS = 4_000
export const DEFAULT_TAIL_PREVIEW_CHARS = 4_000
/** Generous relative to head+tail (≈8_000 chars combined by default) — this
 *  only ever binds if a caller configures unusually large head/tail splits,
 *  or on the no-backend/offload-failed paths where nothing bigger is safe to
 *  keep. Comfortably below the artifact store's own 64 MiB per-artifact
 *  ceiling, so it is never the tightest bound on a successful capture. */
export const EMERGENCY_INLINE_CAP_CHARS = 48_000

export function toArtifactSummary(ref: AgentArtifactRef): AgentArtifactRefSummary {
  return {
    uri: ref.uri,
    kind: ref.kind,
    mediaType: ref.mediaType,
    capturedBytes: ref.capturedBytes,
    complete: ref.complete,
    truncationReason: ref.truncationReason,
  }
}

/** Decides whether `rawText` needs offloading, performs the capture when it
 *  does, and returns the bounded model-facing text alongside whatever
 *  artifact metadata resulted. Never throws — every failure mode (no
 *  backend, a throwing `store.capture()`) is represented in the returned
 *  `offloadFailed`/`complete` fields instead. */
export async function captureToolResultText(
  rawText: string,
  backend: ToolResultCaptureBackend | undefined,
  options: ToolResultCaptureOptions = {}
): Promise<ToolResultCapture> {
  const threshold = options.captureThresholdChars ?? DEFAULT_CAPTURE_THRESHOLD_CHARS
  if (rawText.length <= threshold) {
    return { previewText: rawText, complete: true, offloadFailed: false }
  }

  const emergencyCap = options.emergencyCapChars ?? EMERGENCY_INLINE_CAP_CHARS
  const { head, tail } = splitHeadTail(rawText, options)

  if (!backend) {
    return {
      previewText: capToLength(
        buildUncapturedPreviewText(
          head,
          tail,
          rawText.length,
          "no active run context was available to capture the remainder as an artifact"
        ),
        emergencyCap
      ),
      complete: false,
      offloadFailed: false,
    }
  }

  try {
    const bytes = new TextEncoder().encode(rawText)
    const ref = await backend.store.capture(
      bytes,
      {
        runId: backend.owner.runId,
        owner: backend.owner,
        kind: "tool-result",
        mediaType: "text/plain; charset=utf-8",
        sourceBytes: bytes.byteLength,
      },
      // A plain in-memory Uint8Array capture has nothing live to cancel —
      // the store may still call abort() on a hard quota/disk limit mid
      // write, which is a normal (if incomplete) capture outcome, not an
      // error this function needs to react to.
      { abort: () => {} }
    )
    return {
      previewText: capToLength(buildCapturedPreviewText(head, tail, ref), emergencyCap),
      complete: ref.complete,
      artifact: toArtifactSummary(ref),
      fullArtifact: ref,
      offloadFailed: false,
    }
  } catch {
    return {
      previewText: capToLength(
        buildUncapturedPreviewText(
          head,
          tail,
          rawText.length,
          "capturing the remainder as an artifact failed"
        ),
        emergencyCap
      ),
      complete: false,
      offloadFailed: true,
    }
  }
}

function splitHeadTail(
  rawText: string,
  options: ToolResultCaptureOptions
): { head: string; tail: string } {
  const headChars = Math.max(0, options.headPreviewChars ?? DEFAULT_HEAD_PREVIEW_CHARS)
  const tailChars = Math.max(0, options.tailPreviewChars ?? DEFAULT_TAIL_PREVIEW_CHARS)
  const head = rawText.slice(0, headChars)
  const tailStart = Math.max(headChars, rawText.length - tailChars)
  const tail = tailChars > 0 ? rawText.slice(tailStart) : ""
  return { head, tail }
}

function buildCapturedPreviewText(head: string, tail: string, ref: AgentArtifactRef): string {
  const middle = tail
    ? "\n\n[Synapse: middle of tool output omitted here — full content captured as an artifact]\n\n"
    : ""
  const status = ref.complete
    ? "complete"
    : `incomplete (truncationReason=${ref.truncationReason ?? "unknown"})`
  const footer =
    `\n\n[Synapse tool-result artifact: ${ref.uri} | kind=${ref.kind} | ` +
    `mediaType=${ref.mediaType} | capturedBytes=${ref.capturedBytes} | sha256=${ref.sha256} | ` +
    `${status} — use read_artifact with this uri to read more of it]`
  return `${head}${middle}${tail}${footer}`
}

function buildUncapturedPreviewText(
  head: string,
  tail: string,
  totalChars: number,
  reason: string
): string {
  const middle = tail ? "\n\n[Synapse: middle of tool output omitted here]\n\n" : ""
  const footer =
    `\n\n[Synapse: tool output was ${totalChars} chars, exceeding the inline preview budget, and ` +
    `${reason}; this result is incomplete.]`
  return `${head}${middle}${tail}${footer}`
}

function capToLength(text: string, max: number): string {
  if (text.length <= max) return text
  const omitted = text.length - max
  return `${text.slice(0, max)}\n\n[Synapse: preview itself truncated, ${omitted} more chars omitted]`
}
