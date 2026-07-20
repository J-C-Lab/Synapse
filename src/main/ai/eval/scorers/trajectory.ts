import type { ToolPrincipal } from "@synapse/plugin-sdk"
import type { RegisteredToolDescriptor } from "../../../plugins/types"
import type { ToolHostPort } from "../../tool-registry"
import type { FixtureMeta, ScoreResult } from "../fixture-types"
import type { ScriptedTurn } from "../scripted-provider"
import { AgentRuntime } from "../../agent-runtime"
import { buildInteractiveRun } from "../../run-provenance"
import { AiToolRegistry } from "../../tool-registry"
import { scriptedProvider } from "../scripted-provider"

// Corpus A: drives the real AgentRuntime loop (approval hook and
// untrusted-content labeling) with a scripted provider and a stub tool host.

export interface TrajectoryFixture extends FixtureMeta {
  /** Stub tools the model can call. Script uses the *sanitized* name; expect uses fqName. */
  tools: RegisteredToolDescriptor[]
  script: ScriptedTurn[]
  approvals?: Record<string, "allow" | "deny"> // keyed by sanitized tool name
  budgetTokens?: number
  workspaceId?: string
  expect: {
    toolCalls: { name: string; ok: boolean }[]
    stopReason: "end_turn" | "max_steps" | "aborted" | "budget_exceeded" | "error"
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
  const toolCalls: Array<{ name: string; ok: boolean }> = []
  const toolNames = new Map<string, string>()
  let finalText = ""
  const runtime = new AgentRuntime({
    provider: scriptedProvider(fixture.script),
    tools: new AiToolRegistry(host),
    budgetTokens: fixture.budgetTokens,
  })

  const result = await runtime.run({
    provenance: buildInteractiveRun({
      runId: `eval-${fixture.id}`,
      conversationId: `eval-${fixture.id}`,
      workspaceId: fixture.workspaceId,
    }),
    messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    onText: (delta) => {
      finalText += delta
    },
    onEvent: (event) => {
      if (event.type === "tool_call") {
        toolNames.set(event.id, event.name)
      } else {
        toolCalls.push({ name: toolNames.get(event.id) ?? event.id, ok: !event.isError })
      }
    },
    approve: (req) => ({ allowed: fixture.approvals?.[req.toolName] !== "deny" }),
  })

  const base = { id: fixture.id, tier: fixture.tier, tags: fixture.tags }
  const detail = diffTrajectory(fixture.expect, result.stopReason, toolCalls, fixture, finalText)
  if (detail) return { ...base, passed: false, gated: true, detail }
  return { ...base, passed: true, gated: true }
}

/** Returns the first mismatch as a human-readable detail, or undefined. */
function diffTrajectory(
  expect: TrajectoryFixture["expect"],
  stopReason: TrajectoryFixture["expect"]["stopReason"],
  toolCalls: Array<{ name: string; ok: boolean }>,
  fixture: TrajectoryFixture,
  finalText: string
): string | undefined {
  if (stopReason !== expect.stopReason) {
    return `stopReason ${stopReason} != ${expect.stopReason}`
  }
  if (!sameToolCalls(toolCalls, expect.toolCalls)) {
    const got = toolCalls.map((c) => `${c.name}:${c.ok}`)
    const want = expect.toolCalls.map((c) => `${c.name}:${c.ok}`)
    return `toolCalls [${got}] != [${want}]`
  }
  if (expect.workspaceId !== undefined && fixture.workspaceId !== expect.workspaceId) {
    return `workspaceId ${fixture.workspaceId} != ${expect.workspaceId}`
  }
  if (expect.principalKind !== undefined && expect.principalKind !== "internal-agent") {
    return `principal internal-agent != ${expect.principalKind}`
  }
  if (expect.finalTextMatches && !new RegExp(expect.finalTextMatches).test(finalText)) {
    return `final text did not match /${expect.finalTextMatches}/`
  }
  return undefined
}

function sameToolCalls(
  got: Array<{ name: string; ok: boolean }>,
  want: TrajectoryFixture["expect"]["toolCalls"]
): boolean {
  if (got.length !== want.length) return false
  return got.every((call, i) => call.name === want[i]?.name && call.ok === want[i]?.ok)
}
