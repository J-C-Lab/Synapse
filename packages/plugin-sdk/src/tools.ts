import type { PluginContext } from "./context"

/**
 * Where a tool invocation originated.
 *
 * - `agent` — Synapse's built-in agent picked the tool during a conversation.
 * - `background-agent` — a trigger-woken agent picked the tool outside a chat.
 * - `mcp` — an external MCP client (Claude Desktop/Code, …) called it.
 * - `user` — the user invoked it directly (e.g. a "run tool" affordance).
 */
export interface ToolCaller {
  kind: "agent" | "background-agent" | "mcp" | "user" | "agent-tool"
  /** The conversation this call belongs to, when driven by the built-in agent. */
  conversationId?: string
  /** The background invocation this call belongs to, when trigger-driven. */
  invocationId?: string
  workspaceId?: string
  userId?: string
  parentConversationId?: string
  agentId?: string
  agentCallStack?: string[]
}

/**
 * One block of tool output. This is the subset of MCP content blocks Synapse
 * supports; the host serialises these into the model's `tool_result`.
 */
export type ToolContentBlock =
  | { type: "text"; text: string }
  | { type: "json"; json: unknown }
  /**
   * An image produced by the tool. `path` must point inside the plugin's data
   * directory — the sandbox rejects paths that escape it.
   */
  | { type: "image"; path: string; mimeType: string }

/**
 * What a tool handler returns.
 *
 * `content` is what the model sees. `structured` is an optional
 * machine-readable payload that the host validates against the tool's
 * `outputSchema` when one is declared. Set `isError: true` to report a
 * tool-level failure to the model without throwing (a thrown error is also
 * caught by the host and surfaced as an error result).
 */
export interface ToolResult {
  content: ToolContentBlock[]
  isError?: boolean
  structured?: unknown
}

/**
 * Per-invocation runtime handed to a tool handler.
 *
 * Unlike command hooks, tools run headless: there is no view, no `locale` and
 * no `theme` (a tool may be called by the built-in agent, an external MCP
 * client, or the user, possibly with no UI in front of it). Everything else
 * from {@link PluginContext} — `storage`, `clipboard`, `system`,
 * `notifications`, `preferences`, `log` — is available, gated by the same
 * manifest capabilities.
 *
 * The host builds a fresh `ToolContext` per call. Long-running tools should
 * honour `signal` (cooperative cancellation) and may report `progress`.
 */
export interface ToolContext extends Omit<PluginContext, "locale" | "theme"> {
  /** Where this invocation came from. */
  caller: ToolCaller
  /** Cooperative cancellation. Long-running tools should listen and bail out. */
  signal: AbortSignal
  /** Optional progress reporting (streamed to the chat UI / MCP progress). */
  progress?: (pct: number, message?: string) => void
}

/**
 * A tool implementation. `input` has already been validated by the host
 * against the manifest's `inputSchema`, so handlers can trust its shape. Map
 * the generic `I` to the TypeScript type that mirrors that schema.
 *
 * @example
 * ```ts
 * const convert: ToolHandler<{ value: number; unit?: "s" | "ms" }> = (input) => {
 *   const ms = input.unit === "s" ? input.value * 1000 : input.value
 *   return { content: [{ type: "json", json: { iso: new Date(ms).toISOString() } }] }
 * }
 * ```
 */
export type ToolHandler<I = unknown> = (
  input: I,
  ctx: ToolContext
) => Promise<ToolResult> | ToolResult
