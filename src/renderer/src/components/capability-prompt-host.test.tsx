import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CapabilityPromptHost } from "./capability-prompt-host"

let approvalHandler: ((event: unknown) => void) | undefined

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: "en" },
    t: (key: string, options?: Record<string, unknown>) => {
      const copy: Record<string, string> = {
        "plugins.capabilities.approvalTitle": "Approve elevated capability?",
        "plugins.capabilities.approvalBody":
          "{{plugin}} requests {{capability}} as {{actor}} for {{operation}}.",
        "plugins.capabilities.grantTitle": "Allow plugin permission?",
        "plugins.capabilities.grantBody": "{{plugin}} wants {{capability}} ({{tier}}).",
        "plugins.capabilities.reportedIdentity":
          "Reported identity: {{clientId}} (self-reported by the client, not verified)",
        "plugins.capabilities.allow": "Allow",
        "plugins.capabilities.deny": "Deny",
      }
      const template = copy[key] ?? key
      if (!options) return template
      return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) =>
        String(options[name] ?? "")
      )
    },
  }),
}))

vi.mock("@/lib/electron", () => ({
  isElectron: () => true,
  getPluginCapabilityProfile: vi.fn(async () => null),
  onCapabilityGrantRequest: () => () => {},
  onCapabilityApprovalRequest: (handler: (event: unknown) => void) => {
    approvalHandler = handler
    return () => {
      approvalHandler = undefined
    }
  },
  resolveCapabilityGrant: vi.fn(),
  resolveCapabilityApproval: vi.fn(),
}))

afterEach(() => {
  cleanup()
  approvalHandler = undefined
})

describe("capabilityPromptHost", () => {
  it("shows the reported-identity line, with the clientId interpolated, for a forwarded external-mcp request", async () => {
    render(<CapabilityPromptHost />)
    approvalHandler?.({
      promptId: "cap_apr_1",
      pluginId: "com.synapse.test",
      capability: "clipboard:watch",
      actor: "external-mcp",
      trigger: "mcp:call",
      operation: "watch",
      clientId: "Claude Desktop",
    })

    expect(await screen.findByText(/Reported identity: Claude Desktop/)).toBeInTheDocument()
  })

  it("omits the reported-identity line when the request has no clientId", async () => {
    render(<CapabilityPromptHost />)
    approvalHandler?.({
      promptId: "cap_apr_1",
      pluginId: "com.synapse.test",
      capability: "clipboard:watch",
      actor: "agent",
      trigger: "tool:x",
      operation: "watch",
    })

    expect(await screen.findByRole("dialog")).toBeInTheDocument()
    expect(screen.queryByText(/Reported identity/)).not.toBeInTheDocument()
  })
})
