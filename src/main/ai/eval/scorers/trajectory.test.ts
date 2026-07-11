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
})
