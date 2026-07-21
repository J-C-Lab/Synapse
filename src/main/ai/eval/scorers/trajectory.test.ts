import type { RegisteredToolDescriptor } from "../../../plugins/types"
import type { TrajectoryFixture } from "./trajectory"
import { describe, expect, it } from "vitest"
import { modelToolName } from "../../tool-registry"
import { scoreTrajectory } from "./trajectory"

const greetTool: RegisteredToolDescriptor = {
  fqName: "com.probe/greet",
  pluginId: "com.probe",
  provenance: "plugin",
  manifestTool: {
    name: "greet",
    description: "greet",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
}

const GREET_TOOL_NAME = modelToolName({ fqName: greetTool.fqName, provenance: "plugin" })

function hostTool(fqName: string): RegisteredToolDescriptor {
  return {
    fqName,
    pluginId: "synapse-host",
    provenance: "host",
    manifestTool: {
      name: fqName,
      description: fqName,
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
    },
  }
}

const base: TrajectoryFixture = {
  id: "happy",
  title: "happy path",
  tier: "T0",
  tags: [],
  tools: [greetTool],
  script: [{ toolUses: [{ id: "t1", name: GREET_TOOL_NAME, input: {} }] }, { text: "Hello Ada" }],
  workspaceId: "default",
  expect: {
    toolCalls: [{ name: "com.probe/greet", ok: true }],
    stopReason: "end_turn",
    finalTextMatches: "Hello Ada",
    workspaceId: "default",
    principalKind: "internal-agent",
  },
}

describe("scoreTrajectory", () => {
  it("passes when the trace matches the expectation", async () => {
    const result = await scoreTrajectory(base)
    expect(result.passed).toBe(true)
    expect(result.gated).toBe(true)
  })

  it("fails on a stopReason mismatch", async () => {
    const result = await scoreTrajectory({
      ...base,
      id: "wrong-stop",
      expect: { ...base.expect, stopReason: "max_steps" },
    })
    expect(result.passed).toBe(false)
    expect(result.detail).toContain("stopReason")
  })

  it("uses registry-issued names when host fqNames collide after sanitization", async () => {
    const result = await scoreTrajectory({
      ...base,
      id: "sanitized-name-collision",
      tools: [hostTool("a/b"), hostTool("a_b")],
      // AiToolRegistry issues a_b, then a_b_2; recomputing modelToolName()
      // would map both to a_b and incorrectly attribute the first event.
      script: [
        {
          toolUses: [
            { id: "slash", name: "a_b", input: {} },
            { id: "underscore", name: "a_b_2", input: {} },
          ],
        },
        { text: "done" },
      ],
      expect: {
        toolCalls: [
          { name: "a/b", ok: true },
          { name: "a_b", ok: true },
        ],
        stopReason: "end_turn",
      },
    })

    expect(result.passed).toBe(true)
  })
})
