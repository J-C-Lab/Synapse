import type { JsonSchema } from "@synapse/plugin-manifest"
import type { ToolCaller, ToolResult } from "@synapse/plugin-sdk"
import type { RegisteredToolDescriptor, ToolInvocationOptions } from "../../plugins/types"
import type { ToolHostSource } from "../composite-tool-host"
import type {
  AgentArtifactRef,
  AgentArtifactStore,
  ArtifactCaller,
  ArtifactRange,
} from "./artifact-types"
import { Buffer } from "node:buffer"
import { ArtifactReadError } from "./artifact-types"

// Host-owned, read-only `artifact:core/read_artifact` (design §"Recoverable
// artifact backend" / Task 19). Lets a model that received a bounded
// head/tail preview + `artifact://...` uri in a prior tool result pull a
// further byte or line range of that artifact's full captured content,
// through the same registry/provenance/access/resilience/audit path as
// every other tool.
//
// The one subtlety this module exists to solve: the model only ever sees a
// bare `artifact://run/<runId>/<artifactId>` string, never a full ref.
// `AgentArtifactStore.stat()`/`read()` take a full `AgentArtifactRef` and
// cross-check EVERY field against the on-disk manifest — including
// `sha256` — as a forgery/staleness guard against a caller-supplied ref;
// a ref rebuilt from a bare uri has no way to know the real sha256, so it
// can never pass that guard.
//
// `AgentArtifactStore.resolve(runId, artifactId, caller)` is the fix
// (artifact-store.ts, Task 19 follow-up): it looks the manifest up by id
// alone — no caller-supplied ref to trust or cross-check — and returns the
// authoritative on-disk ref (real sha256 included), still gated by the same
// `checkArtifactAccess` check `stat`/`read` run. This works for every
// artifact ever captured, regardless of which tool captured it or how (or
// whether) its uri was ever echoed into a ChatContentBlock — unlike an
// earlier version of this file that scanned the owning run's checkpoint
// message history, `resolve` never depends on live checkpoint content
// still existing for a given call, so it is unaffected by e.g. Task 18's
// run_command (which never touches ChatContentBlock.tool_result.artifact
// at all — its stdout/stderr artifact uris live only in run_command's own
// bespoke JSON payload text) or a future context-compression pass evicting
// old messages.

export const ARTIFACT_FQ_PREFIX = "artifact:"
const ARTIFACT_PLUGIN_ID = "artifact:core"
export const READ_ARTIFACT_FQ = `${ARTIFACT_PLUGIN_ID}/read_artifact`

/** Strict per-call cap on how many bytes one read_artifact invocation may
 *  return — well under the artifact store's own 64 MiB per-artifact ceiling,
 *  generous enough to be useful for inspecting a captured chunk. Also the
 *  byte window line-mode scans from the start of the artifact to locate
 *  requested lines (see readLines below). */
export const MAX_ARTIFACT_READ_BYTES = 200_000

/** Default number of lines returned by a line-mode call when `end` is
 *  omitted. */
const DEFAULT_LINE_WINDOW = 200

export interface ArtifactToolSourceOptions {
  store: AgentArtifactStore
}

/** Parses the one URI shape every artifact ref uses. Charset-restricted to
 *  the same `[\w-]{1,128}` id grammar artifact-store.ts enforces, so a
 *  malformed/injected uri is rejected here before it ever reaches the
 *  store. */
export function parseArtifactUri(uri: string): { runId: string; artifactId: string } | undefined {
  const match = /^artifact:\/\/run\/([\w-]{1,128})\/([\w-]{1,128})$/.exec(uri)
  if (!match) return undefined
  return { runId: match[1]!, artifactId: match[2]! }
}

const INPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    uri: {
      type: "string",
      description: "The artifact:// uri previously returned in a tool result.",
    },
    rangeKind: {
      type: "string",
      enum: ["bytes", "lines"],
      description: 'Defaults to "bytes".',
    },
    start: {
      type: "number",
      description: "Inclusive start offset (byte or line, 0-based). Defaults to 0.",
    },
    end: {
      type: "number",
      description:
        "Exclusive end offset (byte or line, 0-based). Omit for a default-sized window from start, " +
        `bounded by a strict per-call cap of ${MAX_ARTIFACT_READ_BYTES} bytes.`,
    },
  },
  required: ["uri"],
}

const DESCRIPTOR: RegisteredToolDescriptor = {
  fqName: READ_ARTIFACT_FQ,
  pluginId: ARTIFACT_PLUGIN_ID,
  provenance: "host",
  manifestTool: {
    name: "read_artifact",
    title: "Read artifact",
    description:
      "Read a bounded byte or line range of a previously captured artifact by its artifact:// uri " +
      "(as seen in an earlier tool result's preview). Each call is capped in size — read in windows " +
      "for a large artifact.",
    inputSchema: INPUT_SCHEMA,
    annotations: { readOnlyHint: true },
  },
}

interface ParsedReadInput {
  uri: string
  rangeKind: "bytes" | "lines"
  start?: number
  end?: number
}

export class ArtifactToolSource implements ToolHostSource {
  constructor(private readonly options: ArtifactToolSourceOptions) {}

  ownsTool(fqName: string): boolean {
    return fqName.startsWith(ARTIFACT_FQ_PREFIX)
  }

  listTools(): RegisteredToolDescriptor[] {
    return [DESCRIPTOR]
  }

  async invokeTool(
    fqName: string,
    input: unknown,
    options: ToolInvocationOptions
  ): Promise<ToolResult> {
    if (fqName !== READ_ARTIFACT_FQ) return errorResult(`Unknown tool: ${fqName}`)

    const artifactCaller = artifactCallerFrom(options.caller)
    if (!artifactCaller) return errorResult("read_artifact requires an active run.")

    const parsed = parseInput(input)
    if (!parsed.ok) return errorResult(parsed.reason)

    const uriParts = parseArtifactUri(parsed.value.uri)
    if (!uriParts) {
      return errorResult(`range_invalid: malformed artifact uri: ${parsed.value.uri}`)
    }

    try {
      const stat = await this.options.store.resolve(
        uriParts.runId,
        uriParts.artifactId,
        artifactCaller
      )
      if (parsed.value.rangeKind === "lines") {
        return await this.readLines(stat, artifactCaller, parsed.value)
      }
      return await this.readBytes(stat, artifactCaller, parsed.value)
    } catch (err) {
      if (err instanceof ArtifactReadError) return errorResult(`${err.code}: ${err.message}`)
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  }

  private async readBytes(
    stat: AgentArtifactRef,
    caller: ArtifactCaller,
    parsed: ParsedReadInput
  ): Promise<ToolResult> {
    const start = parsed.start ?? 0
    if (start > stat.capturedBytes) {
      return errorResult(
        `range_invalid: start (${start}) is beyond this artifact's captured length (${stat.capturedBytes}).`
      )
    }
    const requestedEnd = parsed.end ?? Math.min(stat.capturedBytes, start + MAX_ARTIFACT_READ_BYTES)
    const cappedEnd = Math.min(requestedEnd, stat.capturedBytes, start + MAX_ARTIFACT_READ_BYTES)
    const range: ArtifactRange = { start, end: cappedEnd }
    const clamped = cappedEnd < requestedEnd

    const bytes = await this.options.store.read(stat, range, caller)
    const decoded = decodeForModel(bytes, stat.mediaType)
    return textResult({
      uri: stat.uri,
      kind: stat.kind,
      mediaType: stat.mediaType,
      capturedBytes: stat.capturedBytes,
      complete: stat.complete,
      truncationReason: stat.truncationReason,
      rangeKind: "bytes",
      range,
      rangeClamped: clamped,
      encoding: decoded.encoding,
      content: decoded.content,
    })
  }

  private async readLines(
    stat: AgentArtifactRef,
    caller: ArtifactCaller,
    parsed: ParsedReadInput
  ): Promise<ToolResult> {
    // Line boundaries aren't indexed anywhere durable, so line-mode scans a
    // bounded window from the artifact's start (never more than the same
    // per-call cap bytes-mode enforces) and slices lines out of it. This is
    // a deliberately limited but strictly bounded and correct-within-its-
    // documented-limits approach: lines beyond the scanned window are
    // reported as unavailable rather than silently missing.
    const scanEnd = Math.min(stat.capturedBytes, MAX_ARTIFACT_READ_BYTES)
    const bytes = await this.options.store.read(stat, { start: 0, end: scanEnd }, caller)
    const text = new TextDecoder("utf-8").decode(bytes)
    const lines = text.split("\n")
    const scannedEverything = scanEnd >= stat.capturedBytes

    const start = parsed.start ?? 0
    if (start >= lines.length) {
      const suffix = scannedEverything
        ? " (the entire artifact was scanned)."
        : '; re-read with rangeKind: "bytes" and a larger start offset instead.'
      return errorResult(
        `range_invalid: line start ${start} is beyond the ${lines.length} line(s) available within ` +
          `the first ${scanEnd} scanned bytes of this artifact${suffix}`
      )
    }
    const requestedEnd = parsed.end ?? start + DEFAULT_LINE_WINDOW
    const end = Math.min(requestedEnd, lines.length)
    const clamped = requestedEnd > lines.length && !scannedEverything

    return textResult({
      uri: stat.uri,
      kind: stat.kind,
      mediaType: stat.mediaType,
      capturedBytes: stat.capturedBytes,
      complete: stat.complete,
      truncationReason: stat.truncationReason,
      rangeKind: "lines",
      lineStart: start,
      lineEnd: end,
      linesScannedFromBytes: scanEnd,
      allBytesScanned: scannedEverything,
      rangeClamped: clamped,
      encoding: "utf-8",
      content: lines.slice(start, end).join("\n"),
    })
  }
}

function artifactCallerFrom(caller: ToolCaller): ArtifactCaller | undefined {
  if (!caller.runId) return undefined
  return {
    runId: caller.runId,
    rootRunId: caller.parentRunId ?? caller.runId,
    parentRunId: caller.parentRunId,
    conversationId: caller.conversationId,
    workspaceId: caller.workspaceId,
    principal: caller.principal ?? { kind: "local-user" },
  }
}

function parseInput(
  input: unknown
): { ok: true; value: ParsedReadInput } | { ok: false; reason: string } {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {}
  if (typeof obj.uri !== "string" || obj.uri.length === 0) {
    return { ok: false, reason: "uri is required." }
  }
  const rangeKind = obj.rangeKind === "lines" ? "lines" : "bytes"
  if (
    obj.start !== undefined &&
    (typeof obj.start !== "number" || !Number.isInteger(obj.start) || obj.start < 0)
  ) {
    return { ok: false, reason: "range_invalid: start must be a non-negative integer." }
  }
  if (
    obj.end !== undefined &&
    (typeof obj.end !== "number" || !Number.isInteger(obj.end) || obj.end < 0)
  ) {
    return { ok: false, reason: "range_invalid: end must be a non-negative integer." }
  }
  if (
    obj.start !== undefined &&
    obj.end !== undefined &&
    (obj.end as number) <= (obj.start as number)
  ) {
    return { ok: false, reason: "range_invalid: end must be greater than start." }
  }
  return {
    ok: true,
    value: {
      uri: obj.uri,
      rangeKind,
      start: obj.start as number | undefined,
      end: obj.end as number | undefined,
    },
  }
}

function isTextMediaType(mediaType: string): boolean {
  return (
    mediaType.startsWith("text/") || mediaType === "application/json" || mediaType.endsWith("+json")
  )
}

function decodeForModel(
  bytes: Uint8Array,
  mediaType: string
): { encoding: "utf-8" | "base64"; content: string } {
  if (isTextMediaType(mediaType)) {
    return { encoding: "utf-8", content: new TextDecoder("utf-8").decode(bytes) }
  }
  return { encoding: "base64", content: Buffer.from(bytes).toString("base64") }
}

function textResult(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] }
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true }
}
