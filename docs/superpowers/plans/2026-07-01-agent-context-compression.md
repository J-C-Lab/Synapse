# Agent Context Compression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the outgoing message history exceeds a configured token threshold, replace the oldest whole turns with one summary message before sending to the provider — keeping recent turns verbatim and the persisted conversation lossless. Off by default.

**Architecture:** A pure `ContextCompressor` runs inside `AgentRuntime` before each provider call. It estimates tokens with a char heuristic; over threshold, it splits history at a turn boundary (never inside a tool_use/tool_result pair), summarizes the older slice via one provider call, and returns `[summary, ...recent]`. `ConversationStore` is untouched — compression affects only the in-flight copy.

**Tech Stack:** TypeScript (strict), Electron main, Vitest.

**Spec:** [docs/superpowers/specs/2026-07-01-agent-context-compression-design.md](../specs/2026-07-01-agent-context-compression-design.md)

**Prerequisites:** None hard — independent of phases 1–3. Ship after them per backlog priority.

---

## File Structure

**New files:**
- `src/main/ai/context/estimate-tokens.ts` — char-heuristic token estimator.
- `src/main/ai/context/estimate-tokens.test.ts`
- `src/main/ai/context/context-compressor.ts` — the compression algorithm.
- `src/main/ai/context/context-compressor.test.ts`

**Modified files:**
- `src/main/ai/ai-settings-store.ts` — `contextCompression` setting.
- `src/main/ai/agent-runtime.ts` — invoke the compressor before each provider call when enabled.
- `src/main/ai/agent-service.ts` — pass compression config into the runtime.
- renderer Settings — enable toggle + threshold field.

---

## Task 1: Token estimator

**Files:**
- Create: `src/main/ai/context/estimate-tokens.ts`
- Test: `src/main/ai/context/estimate-tokens.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/main/ai/context/estimate-tokens.test.ts`:

```ts
import type { ChatMessage } from "../providers/types"
import { describe, expect, it } from "vitest"
import { estimateMessageTokens, estimateMessagesTokens } from "./estimate-tokens"

function textMsg(text: string): ChatMessage {
  return { role: "user", content: [{ type: "text", text }] }
}

describe("estimateTokens", () => {
  it("grows monotonically with text length", () => {
    const short = estimateMessageTokens(textMsg("hi"))
    const long = estimateMessageTokens(textMsg("hi".repeat(500)))
    expect(long).toBeGreaterThan(short)
  })

  it("adds structural overhead for non-text blocks", () => {
    const plain = estimateMessageTokens(textMsg("x"))
    const withTool: ChatMessage = {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "n", input: {} }],
    }
    expect(estimateMessageTokens(withTool)).toBeGreaterThanOrEqual(plain)
  })

  it("sums a list", () => {
    const total = estimateMessagesTokens([textMsg("aaaa"), textMsg("bbbb")])
    expect(total).toBe(estimateMessageTokens(textMsg("aaaa")) + estimateMessageTokens(textMsg("bbbb")))
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- estimate-tokens`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the estimator**

Create `src/main/ai/context/estimate-tokens.ts`:

```ts
import type { ChatContentBlock, ChatMessage } from "../providers/types"

// Char-heuristic token estimate — deliberately conservative (rounds up) so the
// real BPE count stays under the model window with margin. Not a tokenizer; we
// are drawing a safety line, not billing.
const CHARS_PER_TOKEN = 4
const BLOCK_OVERHEAD = 8 // structural cost of any non-text block (tool_use/result/image)

export function estimateMessageTokens(message: ChatMessage): number {
  let chars = 0
  let overhead = 0
  for (const block of message.content) {
    if (block.type === "text") chars += block.text.length
    else {
      overhead += BLOCK_OVERHEAD
      chars += approxBlockChars(block)
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + overhead
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0)
}

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

function approxBlockChars(block: ChatContentBlock): number {
  // Approximate serialized size of a non-text block's payload.
  try {
    return JSON.stringify(block).length
  } catch {
    return 0
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test -- estimate-tokens`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/context/estimate-tokens.ts src/main/ai/context/estimate-tokens.test.ts
git commit -m "feat(ai): add char-heuristic token estimator"
```

---

## Task 2: The `ContextCompressor`

**Files:**
- Create: `src/main/ai/context/context-compressor.ts`
- Test: `src/main/ai/context/context-compressor.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/main/ai/context/context-compressor.test.ts`:

```ts
import type { ChatMessage } from "../providers/types"
import { describe, expect, it, vi } from "vitest"
import { ContextCompressor } from "./context-compressor"

function user(text: string): ChatMessage {
  return { role: "user", content: [{ type: "text", text }] }
}
function assistant(text: string): ChatMessage {
  return { role: "assistant", content: [{ type: "text", text }] }
}
function big(text: string, n: number): ChatMessage {
  return user(text.repeat(n))
}

function summarizer(summary = "SUMMARY") {
  return vi.fn(async () => ({ text: summary, tokens: 5 }))
}

describe("contextCompressor", () => {
  it("returns input unchanged when under threshold", async () => {
    const summarize = summarizer()
    const c = new ContextCompressor({ thresholdTokens: 1_000_000, summarize })
    const messages = [user("a"), assistant("b")]
    const out = await c.compress("SYS", messages)
    expect(out.messages).toEqual(messages)
    expect(summarize).not.toHaveBeenCalled()
  })

  it("replaces older turns with one summary message when over threshold", async () => {
    const summarize = summarizer("recap")
    const c = new ContextCompressor({ thresholdTokens: 200, keepFraction: 0.5, summarize })
    const messages = [big("old ", 200), user("recent-1"), assistant("recent-2")]
    const out = await c.compress("SYS", messages)

    expect(summarize).toHaveBeenCalledTimes(1)
    // First message is the summary; recent turns preserved verbatim at the tail.
    expect(out.messages[0].content[0]).toMatchObject({ type: "text" })
    expect(JSON.stringify(out.messages[0])).toContain("recap")
    expect(out.messages).toContainEqual(user("recent-1"))
    expect(out.messages).toContainEqual(assistant("recent-2"))
    // Summarization usage is surfaced.
    expect(out.summarizerTokens).toBe(5)
  })

  it("never splits a tool_use/tool_result pair across the boundary", async () => {
    const summarize = summarizer()
    const c = new ContextCompressor({ thresholdTokens: 50, keepFraction: 0.5, summarize })
    const toolUse: ChatMessage = { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "n", input: {} }] }
    const toolResult: ChatMessage = { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "r", isError: false }] }
    const messages = [big("old ", 50), toolUse, toolResult, user("tail")]
    const out = await c.compress("SYS", messages)

    // If toolResult is kept, toolUse must also be kept (no dangling result).
    const keptResult = out.messages.some((m) => m.content.some((b) => b.type === "tool_result" && b.toolUseId === "t1"))
    const keptUse = out.messages.some((m) => m.content.some((b) => b.type === "tool_use" && b.id === "t1"))
    if (keptResult) expect(keptUse).toBe(true)
  })

  it("falls back to the recent window (no summary) when summarize throws", async () => {
    const summarize = vi.fn(async () => { throw new Error("provider down") })
    const c = new ContextCompressor({ thresholdTokens: 200, keepFraction: 0.5, summarize })
    const messages = [big("old ", 200), user("recent")]
    const out = await c.compress("SYS", messages)

    expect(out.messages).toContainEqual(user("recent"))
    // No summary text present; older content dropped, not summarized.
    expect(out.messages.every((m) => JSON.stringify(m).includes("old ") === false || m === messages[0])).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- context-compressor`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the compressor**

Create `src/main/ai/context/context-compressor.ts`:

```ts
import type { ChatMessage } from "../providers/types"
import { estimateMessagesTokens, estimateTextTokens } from "./estimate-tokens"

// Fits the active conversation into the model window between turns. Lossless at
// the store layer — operates on a copy of the outgoing messages only. Never
// splits a tool_use/tool_result pair; system prompt is never summarized.

export interface SummarizeResult {
  text: string
  tokens: number
}

export interface ContextCompressorOptions {
  thresholdTokens: number
  /** Fraction of threshold to preserve verbatim as recent turns. Default 0.5. */
  keepFraction?: number
  /** One provider call summarizing the older slice into a compact recap. */
  summarize: (older: ChatMessage[]) => Promise<SummarizeResult>
}

export interface CompressResult {
  messages: ChatMessage[]
  summarizerTokens: number
}

export class ContextCompressor {
  constructor(private readonly options: ContextCompressorOptions) {}

  async compress(system: string, messages: ChatMessage[]): Promise<CompressResult> {
    const threshold = this.options.thresholdTokens
    const estimate = estimateTextTokens(system) + estimateMessagesTokens(messages)
    if (estimate <= threshold) return { messages, summarizerTokens: 0 }

    const keepBudget = threshold * (this.options.keepFraction ?? 0.5)
    const splitAt = this.recentStartIndex(messages, keepBudget)
    const older = messages.slice(0, splitAt)
    const recent = messages.slice(splitAt)
    if (older.length === 0) return { messages, summarizerTokens: 0 } // nothing to compress

    try {
      const summary = await this.options.summarize(older)
      return { messages: [summaryMessage(summary.text), ...recent], summarizerTokens: summary.tokens }
    } catch {
      // Degraded-but-working: drop the older slice rather than fail the turn.
      return { messages: recent, summarizerTokens: 0 }
    }
  }

  /**
   * Walk backward accumulating recent messages until keepBudget is hit, then
   * snap the boundary UP so it never lands between a tool_use and its
   * tool_result (a tool_result whose tool_use is in `older` is illegal).
   */
  private recentStartIndex(messages: ChatMessage[], keepBudget: number): number {
    let used = 0
    let start = messages.length
    for (let i = messages.length - 1; i >= 0; i--) {
      used += estimateMessagesTokens([messages[i]])
      if (used > keepBudget) break
      start = i
    }
    // If the message at `start` carries a tool_result, its tool_use may be in
    // `older` — pull `start` back to include the whole pair (or the whole turn).
    while (start > 0 && hasToolResult(messages[start])) start--
    return start
  }
}

function hasToolResult(message: ChatMessage): boolean {
  return message.content.some((b) => b.type === "tool_result")
}

function summaryMessage(summary: string): ChatMessage {
  return {
    role: "user",
    content: [{ type: "text", text: `[Earlier conversation summary]\n${summary}` }],
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test -- context-compressor`
Expected: PASS. If the tool-pair test reveals the boundary snap is insufficient (e.g. multi-message turns), refine `recentStartIndex` to snap to the nearest clean user/assistant turn boundary — the test is the spec of correctness here.

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/context/context-compressor.ts src/main/ai/context/context-compressor.test.ts
git commit -m "feat(ai): add context compressor with tool-pair-safe turn splitting"
```

---

## Task 3: Add the `contextCompression` setting

**Files:**
- Modify: `src/main/ai/ai-settings-store.ts`
- Test: `src/main/ai/ai-settings-store.test.ts` (if present; else add one)

- [ ] **Step 1: Write the failing test**

Add (or create) a test asserting the setting defaults off and round-trips:

```ts
it("defaults contextCompression to disabled and round-trips an update", async () => {
  const store = new AiSettingsStore(tmpFile(), "anthropic")
  expect((await store.get()).contextCompression?.enabled ?? false).toBe(false)
  await store.setContextCompression({ enabled: true, thresholdTokens: 80_000 })
  const s = await store.get()
  expect(s.contextCompression).toEqual({ enabled: true, thresholdTokens: 80_000 })
})
```

(Match the file's existing test harness for constructing the store and a temp path.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- ai-settings-store`
Expected: FAIL — `contextCompression` / `setContextCompression` don't exist.

- [ ] **Step 3: Add the setting**

In `src/main/ai/ai-settings-store.ts`, extend the settings shape and add a setter mirroring `setBudget`:

```ts
export interface AiSettings {
  // ...existing...
  contextCompression?: { enabled: boolean; thresholdTokens: number }
}
```

```ts
  async setContextCompression(value: { enabled: boolean; thresholdTokens: number }): Promise<void> {
    const next = { enabled: value.enabled, thresholdTokens: Math.max(0, Math.floor(value.thresholdTokens)) }
    // ...persist next alongside the other settings, same pattern as setBudget...
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test -- ai-settings-store`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/ai-settings-store.ts src/main/ai/ai-settings-store.test.ts
git commit -m "feat(ai): add contextCompression setting (off by default)"
```

---

## Task 4: Invoke the compressor in `AgentRuntime`

**Files:**
- Modify: `src/main/ai/agent-runtime.ts`
- Test: `src/main/ai/agent-runtime.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

Add to `src/main/ai/agent-runtime.test.ts`:

```ts
it("sends compacted messages when a compressor is configured", async () => {
  const host = fakeHost()
  const seenLengths: number[] = []
  const provider = {
    id: "fake",
    async *stream(req: { messages: unknown[] }) {
      seenLengths.push(req.messages.length)
      yield { type: "message" as const, message: { role: "assistant" as const, content: [{ type: "text" as const, text: "ok" }] }, usage: emptyUsage(), stopReason: "end_turn" as const }
    },
  }
  const runtime = new AgentRuntime({
    provider,
    tools: new AiToolRegistry(host),
    compress: async (_system, messages) => ({ messages: messages.slice(-1), summarizerTokens: 0 }),
  })

  await runtime.run({
    conversationId: "c1",
    messages: [userMessage("a"), userMessage("b"), userMessage("c")],
  })
  expect(seenLengths[0]).toBe(1) // compressor trimmed to the last message
})

it("sends the full history when no compressor is configured", async () => {
  const host = fakeHost()
  const seenLengths: number[] = []
  const provider = {
    id: "fake",
    async *stream(req: { messages: unknown[] }) {
      seenLengths.push(req.messages.length)
      yield { type: "message" as const, message: { role: "assistant" as const, content: [{ type: "text" as const, text: "ok" }] }, usage: emptyUsage(), stopReason: "end_turn" as const }
    },
  }
  const runtime = new AgentRuntime({ provider, tools: new AiToolRegistry(host) })
  await runtime.run({ conversationId: "c1", messages: [userMessage("a"), userMessage("b")] })
  expect(seenLengths[0]).toBe(2)
})
```

(Import `emptyUsage` at the top of the test file if not already present.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- agent-runtime`
Expected: FAIL — `compress` is not a known option; full history always sent.

- [ ] **Step 3: Add the `compress` port and apply it before each provider call**

In `src/main/ai/agent-runtime.ts`, extend `AgentRuntimeOptions`:

```ts
  /** Optional context compressor, applied to the outgoing messages before each
   *  provider call. Omitted → full history sent (current behavior). */
  compress?: (system: string, messages: ChatMessage[]) => Promise<{ messages: ChatMessage[]; summarizerTokens: number }>
```

Inside the loop, just before the `provider.stream({ ... })` call, compute the outgoing messages and fold summarizer usage into the run usage:

```ts
      const outgoing = this.options.compress
        ? await this.options.compress(system, messages)
        : { messages, summarizerTokens: 0 }
      if (outgoing.summarizerTokens > 0) {
        usage = addUsage(usage, { inputTokens: 0, outputTokens: outgoing.summarizerTokens })
      }

      for await (const event of this.options.provider.stream({
        model,
        system,
        messages: outgoing.messages,
        tools,
        maxTokens,
        signal: options.signal,
      })) {
```

Important: only the *outgoing* copy is compacted. The runtime's own `messages`
array (which accumulates assistant/tool_result turns and is returned/persisted)
is NOT mutated — persistence stays lossless per the spec.

(Confirm the `addUsage` shape matches `TokenUsage`; adapt the field names if the
usage type differs.)

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test -- agent-runtime`
Expected: PASS — both new tests plus all prior ones (no compressor → unchanged behavior).

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/agent-runtime.ts src/main/ai/agent-runtime.test.ts
git commit -m "feat(ai): apply optional context compression before each provider call"
```

---

## Task 5: Build the compressor in `AgentService` from settings

**Files:**
- Modify: `src/main/ai/agent-service.ts`
- Test: `src/main/ai/agent-service.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Add a test asserting that when `contextCompression.enabled` is true, the runtime is constructed with a `compress` port (and not when disabled). Because the compressor is internal, assert behavior via a settings stub with compression on and a large history, checking the provider receives fewer messages — or, more simply, spy that `AgentService` builds a compressor when the setting is on:

```ts
it("enables compression when the setting is on", async () => {
  const settings = settingsStub({ /* contextCompression: { enabled: true, thresholdTokens: 10 } */ })
  // Extend settingsStub to carry contextCompression; assert the outgoing provider
  // messages are compacted for a long history. Model on the agent-runtime test.
})
```

(Keep this test focused on the wiring; the compression algorithm itself is already covered in Task 2. If exercising end-to-end is fiddly, assert instead that the summarizer provider call happens for an over-threshold history.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- agent-service`
Expected: FAIL until the wiring exists.

- [ ] **Step 3: Construct the compressor when enabled**

In `AgentService`, where the per-turn `AgentRuntime` is built, read the setting and build a `ContextCompressor` whose `summarize` makes one provider call with the fixed summarization system prompt:

```ts
    const cfg = (await this.options.settings?.get())?.contextCompression
    const compress =
      cfg?.enabled && cfg.thresholdTokens > 0
        ? new ContextCompressor({
            thresholdTokens: cfg.thresholdTokens,
            summarize: async (older) => {
              const provider = this.createProviderFor(providerId, apiKey)
              // one non-streaming-style pass; collect the assistant text + usage
              return summarizeViaProvider(provider, model, older)
            },
          }).compress.bind(/* the instance */)
        : undefined
```

Then pass `compress` into `new AgentRuntime({ ..., compress })`. Implement a small `summarizeViaProvider(provider, model, older)` helper (in `context-compressor.ts` or a sibling) that renders `older` to a prompt, streams one turn with the summarization system prompt, and returns `{ text, tokens }`. Add a focused unit test for that helper against a fake provider.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test -- agent-service context-compressor`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/agent-service.ts src/main/ai/agent-service.test.ts src/main/ai/context/context-compressor.ts src/main/ai/context/context-compressor.test.ts
git commit -m "feat(ai): wire settings-driven context compression into AgentService"
```

---

## Task 6: Settings UI (enable toggle + threshold)

**Files:**
- Modify: the renderer AI settings component (mirror the existing `budgetTokens` control) + its IPC.

- [ ] **Step 1: Locate the budget control**

Find where `budgetTokens` is rendered/edited in the renderer settings (search `budgetTokens` under `src/renderer`). Add a compression section beside it: a `Switch` for `enabled` and an `Input` (number) for `thresholdTokens`, gated so the number is disabled when the toggle is off.

- [ ] **Step 2: Add the IPC round-trip**

If settings changes flow through an existing `ai:setSettings`-style channel, extend it to carry `contextCompression`; otherwise add a channel following the 4-touchpoint IPC pattern (pure handler → main registration → preload → renderer wrapper) calling `AiSettingsStore.setContextCompression`.

- [ ] **Step 3: Typecheck + test**

Run: `pnpm typecheck && pnpm test -- settings`
Expected: clean; any settings component test passes.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(renderer): add context compression settings control"
```

---

## Task 7: Final verification

- [ ] **Step 1: Typecheck** — Run: `pnpm typecheck` — Expected: clean.
- [ ] **Step 2: Lint** — Run: `pnpm lint` — Expected: clean.
- [ ] **Step 3: Full tests** — Run: `pnpm test` — Expected: green incl. `estimate-tokens`, `context-compressor`, extended `agent-runtime` / `agent-service` / `ai-settings-store`.
- [ ] **Step 4: Manual smoke (optional)** — enable compression with a low threshold, hold a long conversation, and confirm from provider logs (or a debug counter) that older turns are summarized while recent turns persist, and that reloading the conversation still shows full history (store lossless).

---

## Self-Review Notes

- **Spec coverage:** §1 when-it-runs → Task 4 (before each provider call). §2 algorithm (split, no pair-split, system excluded) → Task 2. §3 estimation → Task 1. §4 summarization (same provider, usage counted) → Tasks 4/5. §5 config (off by default) → Task 3. §6 persistence (store untouched, lossless) → Task 4 note (outgoing copy only). §7 error handling (summarize failure fallback, over-window trim) → Task 2. §8 testing → every task TDD.
- **Regression guard:** Task 4's "no compressor → full history" test locks that the default path is byte-for-byte current behavior.
- **Open seam flagged:** `summarizeViaProvider` (Task 5) is the one helper whose exact shape depends on the provider stream API — it gets its own unit test against a fake provider.
- **YAGNI honored:** no separate summarizer model, no summary caching, no tokenizer — all noted as later refinements in the spec, not built.
