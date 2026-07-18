import type { ToolResult } from "@synapse/plugin-sdk"
import type { RegisteredToolDescriptor, ToolInvocationOptions } from "../plugins/types"
import type { ProviderToolSchema } from "./providers/types"
import type { InvocationRecoveryAdapter } from "./tools/invocation-recovery"
import { createHash } from "node:crypto"
import { logger } from "../logging"
import { projectModelVisibleTool, warnOnce } from "./guardrails/tool-metadata"
import { frozenProvenance } from "./runs/authority-snapshot"
import {
  boundNonStreamingToolResult,
  NON_STREAMING_INGRESS_CAP_CHARS,
} from "./tool-result-boundary"
import { noneRecoveryAdapter } from "./tools/invocation-recovery"

// Bridges the plugin tool surface to what a model can call. Plugin fqNames look
// like `com.example.hello-world/greet`, which contain `.` and `/` and so fail
// the Anthropic/OpenAI tool-name charset (`^[a-zA-Z0-9_-]{1,128}$`). Host tools
// keep sanitized readable names; third-party tools receive opaque aliases. The
// reverse map routes all model calls back to the real fqName without putting an
// alias table in plugin manifests.

/**
 * Hard emergency ceiling on a raw ToolResult's rendered text, applied right
 * after a host/plugin/MCP adapter returns (Task 19's non-streaming-adapter
 * rule). Unlike execution-tool-host.ts's command capture (Task 18), which
 * streams stdout/stderr through a bounded tee as bytes arrive, every other
 * tool adapter today hands back its ENTIRE result already resident in one JS
 * string/object — there is no cooperative point to bound it before it
 * exists in memory. This is the one choke point every such adapter passes
 * through (AiToolRegistry.invoke, right after `this.host.invokeTool()`
 * returns), so it is where an absurdly oversized result (a buggy/malicious
 * plugin, a runaway MCP server) gets capped before it can reach
 * JSON.stringify/canonicalHash/checkpoint writes downstream.
 *
 * Deliberately far above both the ~24_000-char model preview budget
 * (context/tool-result-budget.ts) and tool-result-capture.ts's own default
 * ~24_000-char offload-trigger threshold, so this cap virtually never binds
 * for a legitimate tool result — those get handled correctly (and, when
 * oversized, offloaded to an artifact) by tool-result-capture.ts downstream.
 * It exists purely as the last-resort backstop for the pathological case
 * that capture path was never designed to buffer safely in the first place.
 */
export const NON_STREAMING_EMERGENCY_CAP_CHARS = NON_STREAMING_INGRESS_CAP_CHARS
export { MAX_NON_STREAMING_CONTENT_BLOCKS } from "./tool-result-boundary"

/** The slice of PluginHost the AI tool registry depends on. */
export interface ToolHostPort {
  listTools: () => RegisteredToolDescriptor[]
  invokeTool: (
    fqName: string,
    input: unknown,
    options: ToolInvocationOptions
  ) => Promise<ToolResult>
}

export class AiToolRegistry {
  private safeToDescriptor = new Map<string, RegisteredToolDescriptor>()
  private exclusionWarnings = new Map<string, string>()

  constructor(
    private readonly host: ToolHostPort,
    /** 可选：返回某插件的 agent 可读能力 note，前置到该插件每个工具的描述。 */
    private readonly pluginNote?: (pluginId: string) => string | undefined
  ) {}

  /** Current tools as model-facing schemas. Rebuilds the reverse map. */
  list(): ProviderToolSchema[] {
    return this.listWithDescriptors().map(({ schema }) => schema)
  }

  /** Same as {@link list}, paired with the descriptor each schema came from —
   *  what run-authority freezing (see runs/authority-snapshot.ts) needs to
   *  derive owner identity, required capabilities, and adapter metadata per
   *  visible tool. */
  listWithDescriptors(): { schema: ProviderToolSchema; descriptor: RegisteredToolDescriptor }[] {
    return this.refresh()
  }

  /** The plugin descriptor behind a model-facing name (for approval/annotations). */
  describe(safeName: string): RegisteredToolDescriptor | undefined {
    if (!this.safeToDescriptor.has(safeName)) this.refresh()
    return this.safeToDescriptor.get(safeName)
  }

  /** Invoke a tool by its model-facing (sanitized) name. */
  async invoke(
    safeName: string,
    input: unknown,
    options: ToolInvocationOptions
  ): Promise<ToolResult> {
    let descriptor = this.safeToDescriptor.get(safeName)
    if (!descriptor) {
      // The map may be stale (tools changed since the last list); rebuild once.
      this.refresh()
      descriptor = this.safeToDescriptor.get(safeName)
    }
    if (!descriptor) throw new Error(`Unknown tool: ${safeName}`)

    const projected = projectModelVisibleTool({
      description: descriptor.manifestTool.description,
      inputSchema: descriptor.manifestTool.inputSchema,
      outputSchema: descriptor.manifestTool.outputSchema,
      provenance: descriptor.provenance,
      hostNote: this.pluginNote?.(descriptor.pluginId),
    })
    if (!projected.ok) throw new Error(`Tool ${safeName} is not model-visible: ${projected.reason}`)

    const result = await this.host.invokeTool(descriptor.fqName, input, options)
    return applyNonStreamingEmergencyCap(result)
  }

  private refresh(): { schema: ProviderToolSchema; descriptor: RegisteredToolDescriptor }[] {
    this.safeToDescriptor.clear()
    const used = new Set<string>()
    return this.host
      .listTools()
      .map((descriptor) => {
        const safeName = uniqueName(modelToolName(descriptor), used)
        used.add(safeName)
        this.safeToDescriptor.set(safeName, descriptor)

        const projected = projectModelVisibleTool({
          description: descriptor.manifestTool.description,
          inputSchema: descriptor.manifestTool.inputSchema,
          outputSchema: descriptor.manifestTool.outputSchema,
          provenance: descriptor.provenance,
          hostNote: this.pluginNote?.(descriptor.pluginId),
        })
        if (!projected.ok) {
          warnOnce(this.exclusionWarnings, descriptor.fqName, projected.reason, (msg) =>
            logger.warn(msg)
          )
          return undefined
        }
        return {
          descriptor,
          schema: {
            name: safeName,
            description: projected.description,
            inputSchema: projected.inputSchema,
          },
        }
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
  }
}

/** Flatten a tool result into the plain text handed back to the model. */
export function renderToolResultText(result: ToolResult): string {
  const parts: string[] = []
  for (const block of result.content) {
    if (block.type === "text") parts.push(block.text)
    else if (block.type === "json") parts.push(JSON.stringify(block.json))
    else if (block.type === "image") parts.push(`[image: ${block.path}]`)
  }
  return parts.join("\n")
}

/**
 * Sentinel attached to a capped ToolResult's `structured` field (never to
 * its `content`, which stays human-readable text) so a downstream consumer
 * can detect "this text was already lossily truncated before anything else
 * ever saw it" WITHOUT string-sniffing the human-readable notice embedded
 * in `content`. tool-batch-runner.ts's executionPhase checks this before
 * trusting whatever `complete` a later artifact capture of the (already
 * -truncated) text reports — see isNonStreamingEmergencyCapMarker's doc
 * comment for why that distinction matters.
 *
 * Safe to overwrite unconditionally: the branch that sets this always also
 * replaces `content` wholesale (never spreads the original result), so
 * there is never a legitimate tool-declared `structured` payload to
 * clobber — this cap only ever fires for a result the host has already
 * decided it cannot trust as-is.
 */
export interface NonStreamingEmergencyCapMarker {
  synapseNonStreamingCapped: true
  omittedChars: number
}

/**
 * True when `value` is the marker `applyNonStreamingEmergencyCap` attaches
 * to a capped ToolResult's `structured` field.
 *
 * Why this matters: tool-result-capture.ts's `captured.complete` only ever
 * asks "did the artifact store capture every byte of the text it was
 * handed" — it has no way to know that the text it was handed was itself
 * already a lossy truncation of the tool's REAL output (the emergency cap
 * fires before capture ever sees the original). Without this check, a
 * capped-then-successfully-offloaded result would end up persisted as
 * `complete: true`, silently implying the full tool output survived when
 * real data was permanently discarded before capture ever ran.
 */
export function isNonStreamingEmergencyCapMarker(
  value: unknown
): value is NonStreamingEmergencyCapMarker {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).synapseNonStreamingCapped === true &&
    typeof (value as Record<string, unknown>).omittedChars === "number"
  )
}

/**
 * Applies the {@link NON_STREAMING_EMERGENCY_CAP_CHARS} ceiling to a raw
 * ToolResult's rendered text. Below the cap, `result` is returned completely
 * unchanged (same object) — this only ever rewrites content in the rare
 * pathological case. When it does trigger, the result is collapsed to a
 * single truncated text block, marked `isError: true` (a hard, host-level
 * size limit is a policy violation the model must be told about explicitly
 * — matching execution-tool-host.ts's own `output_limit_exceeded` precedent
 * for run_command), and tagged with {@link NonStreamingEmergencyCapMarker}
 * via `structured` so no downstream consumer can mistake a later,
 * successful capture of this already-truncated text for a complete result.
 */
export function applyNonStreamingEmergencyCap(
  result: ToolResult,
  maxChars: number = NON_STREAMING_EMERGENCY_CAP_CHARS
): ToolResult {
  return boundNonStreamingToolResult(result, maxChars)
}

export function sanitizeToolName(fqName: string): string {
  const cleaned = fqName.replace(/[^\w-]/g, "_")
  return cleaned.length > 128 ? cleaned.slice(0, 128) : cleaned
}

/**
 * Provider tool names are model-visible metadata. Host tools may use their
 * readable, host-authored names; names supplied by plugins and external MCP
 * servers must not become an unframed prompt-injection channel. The reverse
 * map retains the descriptor's real fqName for routing and audit.
 */
export function modelToolName(
  descriptor: Pick<RegisteredToolDescriptor, "fqName" | "provenance">
): string {
  if (descriptor.provenance === "host") return sanitizeToolName(descriptor.fqName)
  const source = descriptor.provenance === "mcp-client" ? "mcp" : "plugin"
  const digest = createHash("sha256").update(descriptor.fqName).digest("hex").slice(0, 20)
  return `external_${source}_${digest}`
}

/** The invocation-recovery adapter behind a tool descriptor. Every existing
 *  host/plugin/MCP tool source declares "none" today — see
 *  tools/invocation-recovery.ts for why an invocation id alone is never
 *  sufficient to claim more. */
export function invocationAdapterFor(
  descriptor: Pick<RegisteredToolDescriptor, "provenance">
): InvocationRecoveryAdapter {
  return noneRecoveryAdapter(frozenProvenance(descriptor.provenance))
}

export function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) return base
  for (let i = 2; ; i++) {
    const candidate = `${base.slice(0, 124)}_${i}`
    if (!used.has(candidate)) return candidate
  }
}
