import type { AgentRunEvent, AgentRunSnapshot } from "@synapse/agent-protocol"
import type { AiChatMessage } from "@/lib/electron"

// Display model for the chat view, plus a mapper from the stored provider-neutral
// IR (AiChatMessage[]) back into it so a selected history conversation can be
// rehydrated. In the IR, assistant turns carry text + tool_use blocks, and the
// agent loop pushes the matching tool_result blocks inside a following "user"
// message — those are not real user bubbles, only result carriers, so we fold
// them back onto the assistant's tool cards instead of rendering them.
//
// `blocks` is an ORDERED array of text/tool segments (not separate text+tools
// fields) so a turn that interleaves text and tool calls renders in the order
// they actually happened, live or after reload.

export interface TextBlock {
  kind: "text"
  text: string
}

/** Bounded artifact summary captured at tool-result time (Task 19) — never
 *  the full host-only `AgentArtifactRef` (no sha256/runId/artifactId, which
 *  never cross the IPC boundary to the renderer). */
export interface ArtifactSummary {
  uri: string
  kind: string
  mediaType: string
  capturedBytes: number
  complete: boolean
  truncationReason?: string
}

/** Live availability of a tool card's `artifact`, matching read_artifact's
 *  closed `ArtifactReadErrorCode` union plus "available" and the transient
 *  "checking" state a caller sets while a status IPC call is in flight.
 *  Never derived here — chat-message-model.ts does no IO; a caller (chat
 *  -page.tsx) fetches it and folds the result in via
 *  applyArtifactAvailability. */
export type ArtifactAvailability =
  | "checking"
  | "available"
  | "artifact_expired"
  | "artifact_missing"
  | "artifact_corrupt"
  | "artifact_forbidden"
  | "range_invalid"

export interface ToolCard {
  kind: "tool"
  id: string
  name: string
  input: unknown
  status: "running" | "success" | "error"
  /** Present only when this call's output was offloaded to a durable
   *  artifact (Task 19). The preview text callers already render for a
   *  completed tool card is untouched by this — this is additional,
   *  purely-informational metadata about the backing artifact. */
  artifact?: ArtifactSummary
  /** Undefined until a caller (chat-page.tsx) checks live status for
   *  `artifact.uri`. Once set to any TERMINAL value (everything except
   *  "checking"), a caller must treat it as final for this uri and never
   *  re-issue the same status check as if it were a fresh, different
   *  request — see applyArtifactAvailability's docstring. */
  artifactAvailability?: ArtifactAvailability
}

export type MessageBlock = TextBlock | ToolCard

export interface DisplayMessage {
  id: string
  role: "user" | "assistant"
  blocks: MessageBlock[]
}

/** Append text to the last block if it's already text, else start a new one — keeps adjacent text segments as one paragraph. */
export function pushText(blocks: MessageBlock[], text: string): void {
  if (!text) return
  const last = blocks[blocks.length - 1]
  if (last?.kind === "text") last.text += text
  else blocks.push({ kind: "text", text })
}

export function hydrateMessages(stored: AiChatMessage[]): DisplayMessage[] {
  const messages: DisplayMessage[] = []
  const toolsById = new Map<string, ToolCard>()

  stored.forEach((message, index) => {
    if (message.role === "assistant") {
      const blocks: MessageBlock[] = []
      for (const block of message.content) {
        if (block.type === "text") {
          pushText(blocks, block.text)
        } else if (block.type === "tool_use") {
          const card: ToolCard = {
            kind: "tool",
            id: block.id,
            name: block.name,
            input: block.input,
            status: "success",
          }
          blocks.push(card)
          toolsById.set(block.id, card)
        }
      }
      messages.push({ id: `m${index}`, role: "assistant", blocks })
      return
    }

    // User turn: fold tool_result blocks back onto their tool card; only emit a
    // bubble when there is genuine user text.
    for (const block of message.content) {
      if (block.type === "tool_result") {
        const card = toolsById.get(block.toolUseId)
        if (card) {
          card.status = block.isError ? "error" : "success"
          if (block.artifact) card.artifact = { ...block.artifact }
        }
      }
    }
    const text = textOf(message)
    if (text) messages.push({ id: `m${index}`, role: "user", blocks: [{ kind: "text", text }] })
  })

  return messages
}

/** Immutable version of pushText for React state updates: returns a new array, does not mutate `blocks`. */
export function flushTextIntoBlocks(blocks: MessageBlock[], text: string): MessageBlock[] {
  if (!text) return blocks
  const next = blocks.slice()
  const tailIndex = next.length - 1
  const tail = next[tailIndex]
  if (tail?.kind === "text") next[tailIndex] = { ...tail, text: tail.text + text }
  else next.push({ kind: "text", text })
  return next
}

/** Applies one shared-protocol live event to the message list. Tool inputs
 * intentionally stay host-only, so live cards use an empty object until a
 * completed conversation is rehydrated from its durable projection. */
export function applyEvent(messages: DisplayMessage[], event: AgentRunEvent): DisplayMessage[] {
  const next = messages.slice()
  const lastIndex = next.length - 1
  const last = next[lastIndex]
  if (!last || last.role !== "assistant") return next

  switch (event.type) {
    case "tool_requested":
      // A renderer can receive a live event after it has already rehydrated
      // the same durable tool ordinal from a run snapshot. Never
      // create a second card for that toolUseId.
      if (
        next.some((message) =>
          message.blocks.some((block) => block.kind === "tool" && block.id === event.toolUseId)
        )
      ) {
        break
      }
      next[lastIndex] = {
        ...last,
        blocks: [
          ...last.blocks,
          {
            kind: "tool",
            id: event.toolUseId,
            name: event.fqName,
            input: {},
            status: "running",
          },
        ],
      }
      break
    case "tool_completed":
      next[lastIndex] = {
        ...last,
        blocks: last.blocks.map((block) =>
          block.kind === "tool" && block.id === event.toolUseId
            ? { ...block, status: event.isError ? "error" : "success" }
            : block
        ),
      }
      break
    case "run_failed": {
      const blocks = last.blocks.slice()
      const tailIndex = blocks.length - 1
      const tail = blocks[tailIndex]
      const warning = `⚠️ ${event.reason ?? "Run failed."}`
      if (tail?.kind === "text") blocks[tailIndex] = { ...tail, text: `${tail.text}\n\n${warning}` }
      else blocks.push({ kind: "text", text: warning })
      next[lastIndex] = { ...last, blocks }
      break
    }
    default:
      break
  }
  return next
}

/**
 * Folds a live artifact-status check's result onto every tool card whose
 * `artifact.uri` matches — pure, no IO (the caller already did the IPC
 * round-trip). Keyed by uri, not by a single toolId, since Task 21's design
 * requires caching "per artifact URI": the same uri could in principle
 * appear on more than one card (e.g. a re-run), and a caller must never
 * re-issue the same status check for a uri it has already resolved to a
 * terminal outcome — "never retry a forbidden/missing read as another
 * caller." The caller (chat-page.tsx) is responsible for actually
 * maintaining that per-uri cache and only calling this once per uri; this
 * function itself is just the state fold.
 */
export function applyArtifactAvailability(
  messages: DisplayMessage[],
  uri: string,
  availability: ArtifactAvailability
): DisplayMessage[] {
  return messages.map((message) => ({
    ...message,
    blocks: message.blocks.map((block) =>
      block.kind === "tool" && block.artifact?.uri === uri
        ? { ...block, artifactAvailability: availability }
        : block
    ),
  }))
}

/**
 * Adds the renderer-safe portion of an in-flight durable run to an existing
 * conversation transcript. The snapshot intentionally does not expose tool
 * inputs/results, so cards recovered before conversation finalization carry
 * an empty input and only their durable status. Once the normal conversation
 * projection is available, its richer card replaces this placeholder by the
 * shared toolUseId instead of producing a duplicate card.
 */
export function mergeDurableRunSnapshot(
  messages: DisplayMessage[],
  snapshot: AgentRunSnapshot
): DisplayMessage[] {
  const snapshotCalls = new Map(snapshot.toolCalls.map((call) => [call.toolUseId, call]))
  const existingToolIds = new Set<string>()
  const withUpdatedStatuses = messages.map((message) => ({
    ...message,
    blocks: message.blocks.map((block) => {
      if (block.kind !== "tool") return block
      existingToolIds.add(block.id)
      const durable = snapshotCalls.get(block.id)
      return durable ? { ...block, status: toolCardStatus(durable) } : block
    }),
  }))

  const missing = snapshot.toolCalls.filter((call) => !existingToolIds.has(call.toolUseId))
  const terminal = ["completed", "cancelled", "failed"].includes(snapshot.status)
  if (missing.length === 0 && terminal) return withUpdatedStatuses

  const byStep = new Map<number, AgentRunSnapshot["toolCalls"]>()
  for (const call of missing) {
    const calls = byStep.get(call.modelStep) ?? []
    calls.push(call)
    byStep.set(call.modelStep, calls)
  }

  const next = withUpdatedStatuses.slice()
  const existingMessageIds = new Set(next.map((message) => message.id))
  const assistantTextById = new Map(
    snapshot.messages
      .filter((message) => message.role === "assistant" && message.text)
      .map((message) => [message.messageId, message.text!] as const)
  )
  for (const [step, calls] of [...byStep.entries()].sort(([a], [b]) => a - b)) {
    const text = assistantTextById.get(calls[0]?.assistantMessageId ?? "")
    const stepId = `durable-run:${snapshot.identity.runId}:step:${step}`
    const assistantMessageId = calls[0]?.assistantMessageId
    const textOnlyId = assistantMessageId
      ? `durable-run:${snapshot.identity.runId}:message:${assistantMessageId}`
      : undefined
    const existingStepIndex = next.findIndex((message) => message.id === stepId)
    const existingTextIndex = textOnlyId
      ? next.findIndex((message) => message.id === textOnlyId)
      : -1
    const existingIndex = existingStepIndex >= 0 ? existingStepIndex : existingTextIndex
    const toolBlocks = calls.map((call) => ({
      kind: "tool" as const,
      id: call.toolUseId,
      name: call.safeName,
      input: {},
      status: toolCardStatus(call),
    }))
    if (existingIndex >= 0) {
      // A response_staged snapshot may first surface assistant text before
      // tool_requested arrives. Prefer the already-created step message when
      // a later event adds another tool in the same model step; otherwise
      // promote the exact text placeholder instead of rendering it twice.
      const existing = next[existingIndex]!
      const existingBlocks = existing.blocks.filter(
        (block) => block.kind !== "tool" || !toolBlocks.some((tool) => tool.id === block.id)
      )
      next[existingIndex] = {
        ...existing,
        id: stepId,
        blocks: [...existingBlocks, ...toolBlocks],
      }
    } else {
      next.push({
        id: stepId,
        role: "assistant",
        blocks: [...(text ? [{ kind: "text" as const, text }] : []), ...toolBlocks],
      })
    }
  }
  const assistantMessageIdsWithTools = new Set(
    snapshot.toolCalls.map((call) => call.assistantMessageId).filter(Boolean)
  )
  for (const message of snapshot.messages) {
    const id = `durable-run:${snapshot.identity.runId}:message:${message.messageId}`
    if (
      message.role !== "assistant" ||
      message.producedByRunId !== snapshot.identity.runId ||
      !message.text ||
      assistantMessageIdsWithTools.has(message.messageId) ||
      existingMessageIds.has(id)
    ) {
      continue
    }
    next.push({ id, role: "assistant", blocks: [{ kind: "text", text: message.text }] })
  }
  return next
}

function toolCardStatus(call: AgentRunSnapshot["toolCalls"][number]): ToolCard["status"] {
  if (call.status === "completed") return call.isError ? "error" : "success"
  if (call.status === "denied" || call.status === "unknown") return "error"
  return "running"
}

function textOf(message: AiChatMessage): string {
  return message.content
    .filter(
      (block): block is Extract<AiChatMessage["content"][number], { type: "text" }> =>
        block.type === "text"
    )
    .map((block) => block.text)
    .join("")
}
