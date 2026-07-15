import type { ChatMessage, ProviderToolSchema, RequestEstimateInput } from "./types"
import { Buffer } from "node:buffer"
import { describe, expect, it } from "vitest"
import {
  BYTE_UPPER_BOUND_ESTIMATOR_ID,
  BYTE_UPPER_BOUND_ESTIMATOR_VERSION,
  byteUpperBoundEstimator,
  noGuaranteeEstimator,
} from "./request-estimator"

const baseProfile = {
  profileId: "p1",
  providerId: "anthropic",
  modelPattern: "*",
  contextWindowTokens: 200_000,
  defaultMaxOutputTokens: 4096,
  supportsPromptCaching: true,
  supportsParallelToolCalls: true,
  supportsReasoningStream: false,
  tokenBudgeting: {
    upperBoundEstimatorId: BYTE_UPPER_BOUND_ESTIMATOR_ID,
    upperBoundEstimatorVersion: BYTE_UPPER_BOUND_ESTIMATOR_VERSION,
    providerFramingReserveTokens: 500,
  },
  contextPolicy: { summarizeAtFraction: 0.75, keepRecentFraction: 0.5, hardReserveTokens: 4000 },
}

function msg(role: "user" | "assistant", text: string): ChatMessage {
  return { role, content: [{ type: "text", text }] }
}

function baseInput(overrides: Partial<RequestEstimateInput> = {}): RequestEstimateInput {
  return {
    model: "claude-opus-4-8",
    systemText: "You are a helpful assistant.",
    messages: [msg("user", "hello")],
    tools: [],
    maxOutputTokens: 1024,
    ...overrides,
  }
}

describe("byteUpperBoundEstimator", () => {
  it("returns a bound that includes system text, messages, and the framing reserve", () => {
    const estimate = byteUpperBoundEstimator.estimate(baseInput(), baseProfile)
    expect(estimate).toBeDefined()
    expect(estimate!.estimatorId).toBe(BYTE_UPPER_BOUND_ESTIMATOR_ID)
    expect(estimate!.estimatorVersion).toBe(BYTE_UPPER_BOUND_ESTIMATOR_VERSION)
    expect(estimate!.maxOutputTokens).toBe(1024)
    // At minimum, the byte length of the system text + message text + reserve.
    expect(estimate!.inputUpperBoundTokens).toBeGreaterThanOrEqual(
      Buffer.byteLength(baseInput().systemText, "utf8") + Buffer.byteLength("hello", "utf8") + 500
    )
  })

  it("grows the bound for Unicode text using its actual UTF-8 byte length", () => {
    const asciiEstimate = byteUpperBoundEstimator.estimate(
      baseInput({ messages: [msg("user", "hello")] }),
      baseProfile
    )!
    const unicodeText = "你好世界🎉こんにちは" // multi-byte UTF-8 content
    const unicodeEstimate = byteUpperBoundEstimator.estimate(
      baseInput({ messages: [msg("user", unicodeText)] }),
      baseProfile
    )!
    expect(unicodeEstimate.inputUpperBoundTokens).toBeGreaterThan(
      asciiEstimate.inputUpperBoundTokens
    )
    expect(unicodeEstimate.inputUpperBoundTokens).toBeGreaterThanOrEqual(
      Buffer.byteLength(unicodeText, "utf8")
    )
  })

  it("includes tool schema bytes in the bound", () => {
    const tools: ProviderToolSchema[] = [
      {
        name: "search_files",
        description: "Search files in the workspace by glob pattern.",
        inputSchema: {
          type: "object",
          properties: { pattern: { type: "string" }, root: { type: "string" } },
          required: ["pattern"],
        },
      },
      {
        name: "run_command",
        description: "Run a shell command in the workspace with approval.",
        inputSchema: {
          type: "object",
          properties: { command: { type: "string" }, cwd: { type: "string" } },
        },
      },
    ]
    const withoutTools = byteUpperBoundEstimator.estimate(baseInput(), baseProfile)!
    const withTools = byteUpperBoundEstimator.estimate(baseInput({ tools }), baseProfile)!
    expect(withTools.inputUpperBoundTokens).toBeGreaterThan(withoutTools.inputUpperBoundTokens)
    const perToolBytes = tools.reduce(
      (sum, tool) => sum + Buffer.byteLength(JSON.stringify(tool), "utf8"),
      0
    )
    expect(withTools.inputUpperBoundTokens).toBeGreaterThanOrEqual(
      withoutTools.inputUpperBoundTokens + perToolBytes
    )
  })

  it("includes tool_use and tool_result content in message bytes", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "run it" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "run_command", input: { command: "ls" } }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "t1",
            content: "a very long stdout ".repeat(50),
            isError: false,
          },
        ],
      },
    ]
    const estimate = byteUpperBoundEstimator.estimate(baseInput({ messages }), baseProfile)!
    const rawBytes = messages.reduce(
      (sum, m) =>
        sum +
        m.content.reduce((s, block) => {
          if (block.type === "text") return s + Buffer.byteLength(block.text, "utf8")
          if (block.type === "tool_result") return s + Buffer.byteLength(block.content, "utf8")
          return s + Buffer.byteLength(JSON.stringify(block.input), "utf8")
        }, 0),
      0
    )
    expect(estimate.inputUpperBoundTokens).toBeGreaterThanOrEqual(rawBytes)
  })

  it("includes active skill instruction blocks in the bound", () => {
    const withoutSkills = byteUpperBoundEstimator.estimate(baseInput(), baseProfile)!
    const withSkills = byteUpperBoundEstimator.estimate(
      baseInput({ activeSkillBlocks: ["a".repeat(1000)] }),
      baseProfile
    )!
    expect(withSkills.inputUpperBoundTokens).toBeGreaterThanOrEqual(
      withoutSkills.inputUpperBoundTokens + 1000
    )
  })
})

describe("noGuaranteeEstimator", () => {
  it("always returns undefined — it cannot guarantee an upper bound", () => {
    expect(noGuaranteeEstimator.estimate(baseInput(), baseProfile)).toBeUndefined()
  })
})
