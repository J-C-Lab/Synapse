# Agent Context Compression — Design

> Date: 2026-07-01 · Status: draft, pending user review
> Phase 4 (lowest priority) of the agent-architecture backlog. Pure engineering
> debt — unrelated to capability governance. See `agent-architecture-backlog`
> memory. Ship only after phases 1–3 settle.

## Guiding principle

**Compress transparently; never lose the durable record.** Long conversations
eventually blow the model's context window. Today the full message history from
`ConversationStore` is sent verbatim on every turn, and only a token *budget*
(cost cap) exists — there is no window management. Compression must (a) keep the
persisted conversation lossless, (b) preserve tool_use/tool_result pairing so the
provider never rejects a dangling tool block, and (c) be off by default and
opt-in via a threshold, so it never surprises a user who is fine paying for full
context.

## Goal (this phase)

A `ContextCompressor` that runs just before `AgentRuntime` sends messages to the
provider. When the estimated token count of the outgoing history exceeds a
configured threshold, it replaces the oldest whole *turns* with a single compact
summary message, keeping recent turns verbatim. The `ConversationStore` keeps the
full, uncompressed history; compression affects only what is sent to the model on
a given turn.

## Non-goals (deferred)

- **Semantic long-term memory.** Synapse already has an embedding-based memory
  system (`src/main/ai/memory/`) for fact recall. This phase is purely about
  fitting the *active* conversation into the window, not durable knowledge. The
  two are independent and must not be conflated.
- **A real tokenizer.** We estimate tokens with a character heuristic (§3), not a
  provider-exact BPE count. Good enough for a window-safety margin.
- **Mid-turn compression.** Compression runs between turns (before a provider
  call), never in the middle of streaming a response.
- **Compressing tool_result payloads in place.** We drop/summarize whole old
  turns, not individual large tool outputs (that's a possible refinement later).
- **User-visible summary editing.** The summary is internal plumbing; not shown
  as an editable artifact this phase.

## 1. When compression runs

`AgentRuntime.run()` currently builds `messages = [...options.messages]` once and
loops. Compression is applied to this working array **before the first provider
call and again before each subsequent turn's provider call** (history grows as
tools append results). The check is cheap (a char count); the expensive
summarization call only happens when the threshold is actually crossed.

## 2. The compression algorithm

```
estimate = estimateTokens(system) + Σ estimateTokens(message)
if estimate <= thresholdTokens: send as-is (no-op)
else:
  keepRecent = the most recent messages whose cumulative estimate ≤ keepBudget
               (keepBudget = thresholdTokens * KEEP_FRACTION, e.g. 0.5)
  older      = everything before keepRecent (excluding the system prompt)
  summary    = summarizeMessages(older)             // one cheap provider call
  send: [ summaryMessage(summary), ...keepRecent ]
```

Constraints on the split point:

- **Never split a tool_use/tool_result pair.** The boundary between `older` and
  `keepRecent` must fall on a *turn* boundary — an assistant message with no
  pending tool calls, or a clean user message. If the natural cut lands mid-pair,
  extend `older` to include the whole pair. (A `tool_result` in `keepRecent`
  whose `tool_use` is in `older` would make the provider reject the request.)
- **The system prompt is never summarized** — it is re-supplied verbatim each
  turn by `buildSystemPrompt`.
- The `summaryMessage` is a single `{ role: "user", content: [{ type: "text",
  text: "[Earlier conversation summary]\n" + summary }] }` (user role so it reads
  as context the assistant should account for; kept simple and provider-portable).

## 3. Token estimation

No tokenizer dependency. Estimate with a character heuristic:

```ts
function estimateTokens(message: ChatMessage): number {
  // ~4 chars/token for English-ish text; count text + a small fixed overhead
  // per non-text block (tool_use/tool_result/image) for their structural cost.
}
```

This is deliberately conservative (rounds up) so the real token count stays under
the model's window with margin. Exactness is unnecessary — we're drawing a safety
line, not billing.

## 4. Summarization

`summarizeMessages(older)` makes one provider call with a fixed summarization
system prompt ("Summarize the following conversation excerpt into a compact set
of facts, decisions, and open threads; preserve names, IDs, and any state the
assistant will need to continue.") and the `older` messages rendered as plain
text. It uses the *same* provider/model the run already uses (no separate model
config in this phase — YAGNI; a cheaper summarizer model is a later refinement).

The summarization call's own token usage is added to the run's `usage` and
counts against the run budget, so compression can't be a hidden cost blowout.

## 5. Configuration

`AiSettings` gains:

```ts
interface AiSettings {
  // ...existing (activeProvider, models, budgetTokens)...
  contextCompression?: {
    enabled: boolean          // default false
    thresholdTokens: number   // e.g. 100_000 — compress when estimate exceeds this
  }
}
```

Off by default. When `enabled` is false or `thresholdTokens` is unset,
`AgentRuntime` skips the compressor entirely (behavior identical to today). A
Settings toggle + number field expose it, mirroring the existing `budgetTokens`
control.

## 6. Persistence semantics

- **`ConversationStore` is untouched** — it always stores the full, uncompressed
  message history. Compression is applied to a *copy* used for the provider call
  only. Reloading a conversation later replays full history (and re-compresses on
  the fly if still over threshold).
- The summary is therefore *not* persisted; it is recomputed as needed. This
  keeps the store lossless and avoids a summary drifting out of sync with edits.
- Trade-off accepted: re-summarizing on each over-threshold turn costs a provider
  call. Mitigation (later refinement, noted not built): cache the summary keyed
  by the hash of the `older` slice. Out of scope for phase 4's first cut.

## 7. Error handling

- **Summarization call fails** (network, provider error): fall back to sending
  the *truncated* recent window without a summary (drop `older` entirely) rather
  than failing the turn, and warn-log. A degraded-but-working turn beats a hard
  failure; the durable history is still intact in the store.
- **Estimate still over window after keeping recent + summary:** hard-trim the
  oldest of `keepRecent` (whole turns) until under threshold. Guarantees a
  sendable request.
- **Compression disabled or under threshold:** exact current behavior, zero
  overhead beyond one char count.

## 8. Testing

- `context-compressor.test.ts`:
  - under threshold → returns input unchanged (identity).
  - over threshold → older turns replaced by one summary message; recent turns
    preserved verbatim.
  - never splits a tool_use/tool_result pair — a boundary that would split one is
    pushed to include the whole pair.
  - system prompt never included in `older`.
  - summarization failure → falls back to recent window, no throw.
  - summarization usage is added to the returned usage.
- `estimate-tokens.test.ts`: monotonic with length; non-text blocks add overhead.
- `agent-runtime.test.ts` (extend): with compression enabled and a history over
  threshold, the provider receives a compacted message array; with it disabled,
  the provider receives the full array (regression guard).

## 9. Touchpoints summary

| Layer | Change |
| --- | --- |
| `src/main/ai/context/estimate-tokens.ts` | new — char-heuristic estimator |
| `src/main/ai/context/context-compressor.ts` | new — the compression algorithm |
| `agent-runtime.ts` | invoke the compressor before each provider call when enabled |
| `ai-settings-store.ts` | `contextCompression` setting |
| `agent-service.ts` | pass compression config into `AgentRuntimeOptions` |
| renderer Settings | enable toggle + threshold field (mirrors `budgetTokens`) |
