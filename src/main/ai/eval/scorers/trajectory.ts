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

  const fail = (detail: string): ScoreResult => ({
    id: fixture.id,
    tier: fixture.tier,
    tags: fixture.tags,
    passed: false,
    gated: true,
    detail,
  })

  if (!trace) return fail("no trace recorded")
  if (trace.outcome !== fixture.expect.stopReason) {
    return fail(`stopReason ${trace.outcome} != ${fixture.expect.stopReason}`)
  }
  const got = trace.toolCalls.map((c) => `${c.name}:${c.ok}`)
  const want = fixture.expect.toolCalls.map((c) => `${c.name}:${c.ok}`)
  if (got.join(",") !== want.join(",")) return fail(`toolCalls [${got}] != [${want}]`)
  if (fixture.expect.workspaceId && trace.workspaceId !== fixture.expect.workspaceId) {
    return fail(`workspaceId ${trace.workspaceId} != ${fixture.expect.workspaceId}`)
  }
  if (fixture.expect.principalKind && trace.principal?.kind !== fixture.expect.principalKind) {
    return fail(`principal ${trace.principal?.kind} != ${fixture.expect.principalKind}`)
  }
  if (
    fixture.expect.finalTextMatches &&
    !new RegExp(fixture.expect.finalTextMatches).test(finalText)
  ) {
    return fail(`final text did not match /${fixture.expect.finalTextMatches}/`)
  }
  return { id: fixture.id, tier: fixture.tier, tags: fixture.tags, passed: true, gated: true }
}
