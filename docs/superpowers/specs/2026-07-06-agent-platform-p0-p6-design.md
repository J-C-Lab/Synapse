# Synapse Agent Platform P0-P6 Design

> Date: 2026-07-06
> Status: Draft for implementation planning.
> Scope: mature the existing Synapse agent foundation into a safe local execution, context-managed, evaluable, and eventually multi-agent platform.

## 1. Current Baseline

Synapse already has the right foundation:

- `src/main/ai/agent-runtime.ts` implements a provider-neutral tool-use loop with `maxSteps`, token budget, `AbortSignal`, and an approval hook.
- `src/main/ai/agent-service.ts` owns provider selection, BYOK credentials, conversation persistence, approval round-trips, MCP lifecycle, and remembered approvals.
- `src/main/ai/composite-tool-host.ts` merges plugin tools, external MCP tools, and built-in memory tools behind one `ToolHostPort`.
- `src/main/mcp/synapse-mcp-server.ts` exposes Synapse plugin tools as an MCP server, defaulting to read-only tools.
- `src/main/ai/background-agent-runner.ts` already has the key primitives needed for future agents-as-tools: independent budget, timeout, token/tool-call limits, caller identity, and scoped tool subsets.
- `src/main/ai/memory/*` provides global long-term memory, embeddings-backed search, lexical fallback, and document chunk ingest.

The foundation does not need to be replaced. The missing pieces are mostly boundary layers around the loop: safe local execution, context assembly, scoped memory, deterministic evaluation, specialist-agent packaging, deferred workflows, and later A2A.

## 2. Design Principles

1. **Keep the agent loop simple.** Do not turn `AgentRuntime` into a workflow engine or policy engine. Keep it responsible for model/tool iteration only.
2. **Put safety before capability.** `run_command` and file mutation must ship with workspace boundaries, hard deny rules, and audit logs.
3. **Make context assembly explicit.** Memory and files existing on disk are not the same as useful context. A dedicated layer decides what enters the model window.
4. **Prefer deterministic eval first.** Start with cheap golden tests for tool calls, policy decisions, and injection fixtures. LLM-as-judge and RAGAS come later.
5. **Reuse existing primitives.** Background agents already provide budgeted, scoped execution. Agents-as-tools should wrap this rather than introduce a second runtime.
6. **Defer speculative workflow infrastructure.** Add state graphs only when a concrete user flow needs checkpoint/resume or staged human approval.
7. **Treat memory scope as a security boundary.** Conversation/workspace/user separation is earlier and more important than importance scoring or summarization.

## 3. Non-Goals

- Rewriting `AgentRuntime`.
- Opening unrestricted local shell access.
- Giving plugin sandbox code direct `fs` or `child_process`.
- Implementing a full LangGraph clone before a concrete workflow requires it.
- Making A2A part of the first execution or context milestone.
- Using RAGAS or LLM-as-judge as the first eval layer.

## 4. Target Architecture

```text
AgentService
  -> ContextAssembler
       -> SystemPromptBuilder
       -> WorkspaceInstructionLoader
       -> MemoryAutoRecall
       -> HistoryCompactor
       -> ToolResultBudget
  -> AgentRuntime
       -> AiToolRegistry
            -> CompositeToolHost
                 -> PluginHost tools
                 -> McpClientManager tools
                 -> MemoryToolSource
                 -> ExecutionToolHostSource
                 -> AgentToolSource
```

`AgentRuntime` remains the loop. New behavior enters through:

- `ContextAssembler` before provider calls.
- `ExecutionToolHostSource` as one more tool source.
- Policy modules that can return `allow`, `ask`, or `deny`.
- Tool-specific approval resolvers that run before the generic annotation gate.
- Eval fixtures around pure functions and injected fake providers/tools.
- `AgentToolSource` for specialist agents.

## 5. P0: Safe Local Execution Harness

### Goal

Let the built-in agent observe and modify an explicitly authorized workspace, then run commands, without exposing the whole machine.

### MVP Tools

| Tool | Purpose | Default decision |
| --- | --- | --- |
| `list_files` | List directory entries under workspace roots. | `allow` |
| `read_file` | Read bounded text ranges. | `allow` |
| `search_files` | Search text with `rg`-like behavior. | `allow` |
| `apply_patch` | Apply unified patches inside workspace roots. | `ask` |
| `run_command` | Run shell commands in bounded cwd with output limits. | `ask` or `deny` |

### Required Safety Boundary

P0 is not complete unless all of these ship together:

- Workspace roots are explicit and enforced.
- Paths are resolved with `fs.realpath` before access checks.
- Symlink escapes are rejected.
- Reads have max byte/line limits.
- Writes and patches are confined to workspace roots.
- `run_command` has a forbidden classifier that returns `deny` for destructive system-level actions, credential exfiltration patterns, shutdown/format commands, and known shell escape patterns.
- Recursive deletion is split by target: system roots, home directories, drive roots, parent escapes, and empty/root targets are `deny`; workspace-relative deletion such as `rm -rf ./dist` is `ask`, never `allow`.
- Command classification splits shell-control chains (`;`, `&&`, `||`, pipes) into segments and takes the strictest decision (`deny > ask > allow`) so `echo x && rm -rf /` is still denied.
- The forbidden classifier covers the platform's default shell, including PowerShell/Windows destructive equivalents such as `Remove-Item -Recurse -Force`, `rd /s`, `rmdir /s`, `Format-Volume`, `Stop-Computer`, and `Restart-Computer`.
- `ApprovalDecision` grows from `allow | ask` to `allow | ask | deny`.
- `AgentService.approve()` consumes `deny` as an immediate hard refusal and does not emit an `approval_request` for denied calls.
- `run_command` command classification runs in the approval path before the user is prompted, not only inside the tool implementation. This is required so read-only commands can auto-run and forbidden commands can be refused without a misleading approval dialog.
- Shell control operators (`;`, `&&`, `||`, pipes, redirects, command substitution, backticks, and newlines) prevent read-only auto-allow unless a stricter parser proves the command is safe.
- Local execution tools are not exposed unless at least one user-authorized workspace root exists. `process.cwd()` is never a production fallback workspace.
- Command execution emits an audit record when policy-denied, user-denied in the approval UI, executed successfully, failed, timed out, or was cancelled. User-denied audit is shared by all `execution:` write tools, including `apply_patch`.
- Tool output is truncated before it is returned to the model.
- Tool output is labeled as untrusted before it is returned to the model, because real-time `read_file` and `run_command` results are a primary prompt-injection surface.

### Main Modules

- `src/main/ai/execution/workspace-policy.ts`
- `src/main/ai/execution/command-policy.ts`
- `src/main/ai/execution/execution-approval.ts`
- `src/main/ai/execution/command-runner.ts`
- `src/main/ai/execution/execution-log-store.ts`
- `src/main/ai/execution/file-tools.ts`
- `src/main/ai/execution/patch-tools.ts`
- `src/main/ai/execution/execution-tool-host.ts`

### Acceptance Criteria

- The agent can read and search files inside an authorized workspace.
- Path traversal and symlink escapes are rejected before tool execution.
- Forbidden commands are denied without prompting.
- Destructive but not forbidden commands ask for approval.
- Read-only commands only auto-run when they match a strict single-command allowlist with no shell control operators.
- Every execution tool call writes an audit record containing conversation id, tool name, normalized paths, command/cwd when present, decision, timestamps, and preview output/error.
- Unit tests cover Windows paths, relative paths, absolute paths, symlink escape, command classification, timeout, cancellation, output truncation, and approval decision mapping.

## 6. P1: Context Assembly Layer

### Goal

Make model context an explicit product of policy and budget, not an accidental concatenation of full history and raw tool output.

### Responsibilities

`ContextAssembler` owns:

- System prompt construction.
- Repository instruction injection from `AGENTS.md`, `CLAUDE.md`, and future workspace metadata.
- Automatic memory recall for relevant conversations/workspaces.
- History compaction when token budget is at risk.
- Tool result truncation as a loop-level fallback, even if individual tools already truncate.
- Tool result untrusted labeling as a loop-level fallback, even if individual tools already label their own output.
- A context report for debugging and tests.

### Data Flow

```text
AgentService.chat()
  -> load stored conversation
  -> append current user text
  -> ContextAssembler.assemble()
       -> system
       -> compacted messages
       -> injected memory/context notes
       -> budget report
  -> AgentRuntime.run()
```

### Required Behavior

- `AgentRuntime` can still accept explicit `system` and `messages`; context assembly happens before the call.
- Tool-result budget is enforced centrally by a helper used when creating `tool_result` blocks.
- Memory auto-recall is bounded by scope, result count, and character budget.
- Compaction preserves the most recent user turn, pending tool result blocks, and the final summary of older context.

### Acceptance Criteria

- A unit test proves `AGENTS.md` instructions can be included in the system context.
- A unit test proves memory recall can be injected without the model explicitly calling `memory_search`.
- A unit test proves a large tool result is truncated at the loop layer.
- A unit test proves real-time tool results are wrapped or labeled as untrusted before they become `tool_result` content.
- A unit test proves long histories are compacted deterministically with no dropped latest user message.

## 7. P2: Memory Scope and Isolation

### Goal

Make memory access scoped by default so saved facts and ingested documents do not silently bleed across unrelated workspaces or conversations.

### Scope Model

Every memory entry gains:

```ts
interface MemoryScope {
  userId?: string
  workspaceId?: string
  conversationId?: string
  visibility: "conversation" | "workspace" | "global"
}
```

Default writes:

- Chat-triggered `memory_save`: `workspace` if a workspace exists, otherwise `global` only after approval text makes that clear.
- Document ingest from memory UI: `workspace` when invoked inside a workspace, otherwise `global`.
- Background agent writes: scoped to the triggering plugin/workspace if present.

Default reads:

- Search current conversation scope.
- Search current workspace scope.
- Search global scope only when the caller explicitly allows it or the entry visibility is global.

### Caller Context

Scoped memory requires caller context to reach the tool layer. P2 must extend the invocation context before changing memory behavior:

- `ToolCaller` gains optional `workspaceId` and `userId`.
- `ToolInvocationOptions.caller` carries this context from `AgentService.chat()` through `AgentRuntime.run()` into `ToolHostSource.invokeTool()`.
- `MemoryToolSource.invokeTool()` accepts the invocation options and derives default scope from `options.caller`.
- IPC chat requests and background-agent dispatches must provide workspace context when one is known.

### Migration

Existing entries are migrated to `visibility: "global"` with no workspace/conversation id. The UI labels them as global legacy memories.

### Acceptance Criteria

- Existing `memory.json` loads without data loss.
- Search can restrict to a workspace and exclude unrelated entries.
- `memory_search` remains read-only, but read-only no longer means read-everything.
- Memory management UI can show scope/visibility.
- Tests cover migration, scoped search, global search, and delete by source within scope.

## 8. P3: Deterministic Eval and Guardrails

### Goal

Add a low-cost regression harness for agent behavior before adding expensive LLM-as-judge evaluation.

### Eval Layers

1. **Policy golden tests**
   - `workspace-policy`
   - `command-policy`
   - `approval-gate`
   - memory scope filtering

2. **Tool-call golden tests**
   - Fake provider emits known `tool_use`.
   - Fake tools return deterministic output.
   - Assert call order, inputs, denial behavior, and final messages.

3. **Prompt-injection fixtures**
   - Malicious file content trying to override system instructions.
   - Malicious MCP tool description.
   - Malicious memory entry.
   - Malicious command output.

4. **RAG baseline metrics**
   - Fixed memory/document corpus.
   - Expected top-k memory ids.
   - No LLM judge required.

### Guardrail Hooks

Introduce small pure guardrails before any complex policy framework:

- `beforeModelContext`: scrub or mark untrusted context blocks.
- `beforeToolUse`: deny or ask based on policy.
- `afterToolResult`: truncate and label untrusted output.

### Acceptance Criteria

- `pnpm test` includes deterministic eval fixtures.
- No eval requires a real provider key.
- Prompt-injection fixtures prove untrusted file/tool/memory/command text is labeled and cannot become system instructions.
- Eval docs explain how to add a new fixture.

## 9. P4: Agents as Tools

### Goal

Expose bounded specialist agents as callable tools using the existing background-agent primitives.

### Design

Add `AgentToolSource`:

- Lists configured specialist agents as tools.
- Each tool has its own system prompt, allowed tool capabilities, max steps, max tokens, timeout, and optional output schema.
- Invocation creates a nested `AgentRuntime` or `BackgroundAgentRunner` run with a fresh conversation id.
- Caller identity becomes `{ kind: "agent-tool", parentConversationId, agentId }`.

### Required Safeguards

- Recursion limit: an agent tool cannot recursively call itself.
- Total nested budget: parent run owns an upper bound.
- Tool subset: specialist agent sees only explicitly allowed tools.
- Output schema: invalid structured output returns an error result.
- Nested call safety: every nested agent call carries a call stack and remaining aggregate budget. Reject cycles like `A -> B -> A`, not only direct `A -> A`.
- Audit: parent conversation records agent-tool call, budget, and result preview.

### Acceptance Criteria

- A specialist agent can be registered and listed as a tool.
- A parent agent can invoke it and receive a bounded result.
- Recursion is rejected.
- Indirect recursion is rejected.
- Nested runs cannot exceed the parent aggregate budget.
- Output schema mismatch returns an error tool result.
- Tool subset filtering is enforced in tests.

## 10. P5: Deferred Workflow and Advanced Memory

### Goal

Add workflow/checkpoint infrastructure only when required by concrete user flows, and separately improve memory quality after isolation is in place.

### Workflow Trigger Conditions

Build workflow support when at least one product flow needs:

- Multi-stage checkpoint/resume.
- Human approval between named phases.
- Recovery after app restart.
- Deterministic routing among named nodes.

### Minimal Workflow Shape

```ts
interface WorkflowDefinition<State> {
  id: string
  initial: string
  nodes: Record<string, WorkflowNode<State>>
}

interface WorkflowNode<State> {
  run: (state: State, ctx: WorkflowContext) => Promise<WorkflowTransition<State>>
}
```

This layer should call `AgentRuntime`; it should not be merged into `AgentRuntime`.

### Advanced Memory

After scope exists, add:

- Importance score.
- Manual pinning.
- Decay/expiration.
- Contradiction detection.
- Summaries for older memory clusters.

### Acceptance Criteria

- Workflow code is not added until a real flow is selected.
- Advanced memory changes preserve scoped search semantics.
- Importance/decay never widen scope.

## 11. P6: A2A Interop

### Goal

Add agent-to-agent interop only after Synapse has a strong local execution and specialist-agent story.

### Positioning

MCP already gives Synapse a strong tool interop surface. A2A becomes valuable when Synapse acts as a hub that can delegate tasks to other agents, advertise its own agent capabilities, and track remote task state.

### Proposed Capabilities

- Agent Card describing Synapse agent capabilities.
- Remote task creation and polling.
- Authentication and explicit trust decisions per remote agent.
- Disabled by default.
- No remote agent gets local execution tools unless the user explicitly grants a scoped bridge.

### Acceptance Criteria

- Synapse can advertise one read-only agent capability.
- Synapse can call a remote agent in a test harness.
- A2A cannot bypass MCP/tool approval or workspace policy.

## 12. Recommended Order

| Phase | Name | Why now |
| --- | --- | --- |
| P0 | Safe local execution | Unlocks real work; highest safety risk. |
| P1 | Context assembly | Needed before execution output and long histories become large. |
| P2 | Memory isolation | Prevents cross-workspace/context leakage and poisoning. |
| P3 | Deterministic eval/guardrails | Makes P0-P2 maintainable without provider keys. |
| P4 | Agents as tools | Reuses existing background-agent budget/scope primitives. |
| P5 | Workflow + advanced memory | Valuable only after concrete flows and scoped memory exist. |
| P6 | A2A | Useful once Synapse is a hub, not before. |

## 13. Open Product Decisions

1. How does a chat select its workspace root: current repo by default, explicit picker, or both?
2. Should global memory search be opt-in per turn, per conversation, or per user setting?
3. Which commands are allowed to auto-run after P0: read-only shell commands only, or never auto-run shell?
4. What is the first specialist agent worth exposing as a tool?
5. What concrete workflow justifies P5?
6. Should `rm -rf $HOME`, `%USERPROFILE%`, environment-variable targets, and glob-heavy deletions be hard-denied or kept as `ask` for MVP?
7. Should command classification eventually use a real shell parser per platform instead of conservative token/segment matching?

## 14. Self-Review

- No implementation phase requires rewriting the existing agent loop.
- P0 includes hard deny and audit; no naked shell milestone exists.
- Context assembly is separate from memory storage.
- Memory isolation is before memory quality features.
- Workflow and A2A are explicitly deferred until product need justifies them.
