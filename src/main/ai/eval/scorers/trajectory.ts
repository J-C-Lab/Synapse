import type { ToolPrincipal } from "@synapse/plugin-sdk"
import type { RegisteredToolDescriptor } from "../../../plugins/types"
import type { RunTrace } from "../../run-trace-store"
import type { ToolHostPort } from "../../tool-registry"
import type { FixtureMeta, ScoreResult } from "../fixture-types"
import type { ScriptedTurn } from "../scripted-provider"
import { AgentRuntime } from "../../agent-runtime"
import { AiToolRegistry } from "../../tool-registry"
import { scriptedProvider } from "../scripted-provider"

// Corpus A: drives the real AgentRuntime loop (approval hook, trace recording,
// untrusted-content labeling all included) with a scripted provider and a stub
// tool host, then scores the resulting RunTrace against a fixture's expectation.

export interface TrajectoryFixture extends FixtureMeta {
  /** Stub tools the model can call. Script uses the *sanitized* name; expect uses fqName. */
  tools: RegisteredToolDescriptor[]
  script: ScriptedTurn[]
  approvals?: Record<string, "allow" | "deny"> // keyed by sanitized tool name
  budgetTokens?: number
  workspaceId?: string
  expect: {
    toolCalls: { name: string; ok: boolean }[]
    stopReason: RunTrace["outcome"]
    finalTextMatches?: string
    workspaceId?: string
    principalKind?: ToolPrincipal["kind"]
  }
}

export async function scoreTrajectory(fixture: TrajectoryFixture): Promise<ScoreResult> {
  // The stub host always returns the same fixed text regardless of tool/input,
  // so a fixture can assert on call sequence/success but not on tool *output*
  // content flowing into the model's next turn. Extend this (and TrajectoryFixture)
  // if a future fixture needs "model reacts to a specific tool result".
  const host: ToolHostPort = {
    listTools: () => fixture.tools,
    invokeTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
  }
  let trace: RunTrace | undefined
  let finalText = ""
  const runtime = new AgentRuntime({
    provider: scriptedProvider(fixture.script),
    tools: new AiToolRegistry(host),
    budgetTokens: fixture.budgetTokens,
    recordRun: (t) => {
      trace = t
    },
  })

  await runtime.run({
    conversationId: `eval-${fixture.id}`,
    messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    workspaceId: fixture.workspaceId,
    onText: (delta) => {
      finalText += delta
    },
    approve: (req) => ({ allowed: fixture.approvals?.[req.toolName] !== "deny" }),
  })

  const base = { id: fixture.id, tier: fixture.tier, tags: fixture.tags }
  const detail = diffTrace(fixture.expect, trace, finalText)
  if (detail) return { ...base, passed: false, gated: true, detail }
  return { ...base, passed: true, gated: true }
}

/** Returns the first mismatch as a human-readable detail, or undefined if the trace matches. */
function diffTrace(
  expect: TrajectoryFixture["expect"],
  trace: RunTrace | undefined,
  finalText: string
): string | undefined {
  if (!trace) return "no trace recorded"
  if (trace.outcome !== expect.stopReason) {
    return `stopReason ${trace.outcome} != ${expect.stopReason}`
  }
  if (!sameToolCalls(trace.toolCalls, expect.toolCalls)) {
    const got = trace.toolCalls.map((c) => `${c.name}:${c.ok}`)
    const want = expect.toolCalls.map((c) => `${c.name}:${c.ok}`)
    return `toolCalls [${got}] != [${want}]`
  }
  if (expect.workspaceId !== undefined && trace.workspaceId !== expect.workspaceId) {
    return `workspaceId ${trace.workspaceId} != ${expect.workspaceId}`
  }
  if (expect.principalKind !== undefined && trace.principal?.kind !== expect.principalKind) {
    return `principal ${trace.principal?.kind} != ${expect.principalKind}`
  }
  if (expect.finalTextMatches && !new RegExp(expect.finalTextMatches).test(finalText)) {
    return `final text did not match /${expect.finalTextMatches}/`
  }
  return undefined
}

function sameToolCalls(
  got: RunTrace["toolCalls"],
  want: TrajectoryFixture["expect"]["toolCalls"]
): boolean {
  if (got.length !== want.length) return false
  return got.every((call, i) => call.name === want[i]?.name && call.ok === want[i]?.ok)
}
