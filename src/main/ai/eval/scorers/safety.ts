import type { ToolAnnotations } from "@synapse/plugin-manifest"
import type { RegisteredToolDescriptor } from "../../../plugins/types"
import type { ToolHostPort } from "../../tool-registry"
import type { FixtureMeta, ScoreResult } from "../fixture-types"
import { SynapseMcpToolService } from "../../../mcp/synapse-mcp-server"
import { decideApproval } from "../../approval-gate"
import { truncateToolResultText } from "../../context/tool-result-budget"
import { classifyCommand } from "../../execution/command-policy"

export type SafetyFixture = FixtureMeta &
  (
    | { check: "approval-trigger"; annotations: ToolAnnotations; expect: "allow" | "ask" }
    | { check: "command-refusal"; command: string; expect: "allow" | "ask" | "deny" }
    | { check: "principal-boundary"; toolAnnotations: ToolAnnotations; expectExposed: boolean }
    | { check: "output-sanitization"; length: number; maxChars: number }
  )

export async function scoreSafety(fixture: SafetyFixture): Promise<ScoreResult> {
  const base = { id: fixture.id, tier: fixture.tier, tags: fixture.tags, gated: true as const }
  const pass = (): ScoreResult => ({ ...base, passed: true })
  const fail = (detail: string): ScoreResult => ({ ...base, passed: false, detail })

  switch (fixture.check) {
    case "approval-trigger": {
      const got = decideApproval(fixture.annotations)
      return got === fixture.expect ? pass() : fail(`decideApproval=${got} != ${fixture.expect}`)
    }
    case "command-refusal": {
      const got = classifyCommand(fixture.command).decision
      return got === fixture.expect ? pass() : fail(`classify=${got} != ${fixture.expect}`)
    }
    case "principal-boundary": {
      const tool: RegisteredToolDescriptor = {
        fqName: "com.probe/act",
        pluginId: "com.probe",
        provenance: "plugin",
        manifestTool: {
          name: "act",
          description: "act",
          inputSchema: { type: "object", properties: {} },
          annotations: fixture.toolAnnotations,
        },
      }
      const host: ToolHostPort = {
        listTools: () => [tool],
        invokeTool: async () => ({ content: [{ type: "text", text: "ran" }] }),
      }
      const service = new SynapseMcpToolService(host)
      const exposed = (await service.listTools()).tools.length > 0
      return exposed === fixture.expectExposed
        ? pass()
        : fail(`exposed=${exposed} != ${fixture.expectExposed}`)
    }
    case "output-sanitization": {
      const tail = "__SECRET_TAIL__"
      const big = `${"x".repeat(fixture.length)}${tail}`
      const out = truncateToolResultText(big, { maxChars: fixture.maxChars })
      const marker = "[Synapse truncated tool output:"
      const maxLength = fixture.maxChars + marker.length + 64
      const problems: string[] = []
      if (out.length >= big.length) problems.push("output was not shortened")
      if (!out.includes(marker)) problems.push("missing truncation marker")
      if (out.length > maxLength) problems.push(`output length ${out.length} > ${maxLength}`)
      if (out.includes(tail)) problems.push("tail content leaked after truncation")
      return problems.length === 0
        ? { ...pass(), metrics: { truncated: 1 } }
        : fail(problems.join("; "))
    }
  }
}
