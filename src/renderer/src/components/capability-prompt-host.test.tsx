import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resolveCapabilityApproval, resolveHostResourceApproval } from "@/lib/electron"
import { CapabilityPromptHost } from "./capability-prompt-host"

let approvalHandler: ((event: unknown) => void) | undefined
let hostResourceApprovalHandler: ((event: unknown) => void) | undefined
const useCapabilityProfile = vi.fn((_pluginId: string | undefined) => null)

vi.mock("@/hooks/use-capability-profile", () => ({
  useCapabilityProfile: (pluginId: string | undefined) => useCapabilityProfile(pluginId),
}))

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
        "plugins.hostResources.approvalTitle": "Allow this read?",
        "plugins.hostResources.approvalBody":
          "An external MCP client wants to read {{resourceLabel}} for workspace {{workspaceName}} (root: {{rootName}}).",
        "plugins.hostResources.reportedIdentity":
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
  onCapabilityGrantRequest: () => () => {},
  onCapabilityApprovalRequest: (handler: (event: unknown) => void) => {
    approvalHandler = handler
    return () => {
      approvalHandler = undefined
    }
  },
  onHostResourceApprovalRequest: (handler: (event: unknown) => void) => {
    hostResourceApprovalHandler = handler
    return () => {
      hostResourceApprovalHandler = undefined
    }
  },
  resolveCapabilityGrant: vi.fn(),
  resolveCapabilityApproval: vi.fn(),
  resolveHostResourceApproval: vi.fn(),
}))

afterEach(() => {
  cleanup()
  approvalHandler = undefined
  hostResourceApprovalHandler = undefined
  useCapabilityProfile.mockClear()
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

describe("host-resource prompts", () => {
  beforeEach(() => {
    useCapabilityProfile.mockClear()
  })

  it("renders workspace and root name without touching useCapabilityProfile", async () => {
    render(<CapabilityPromptHost />)
    hostResourceApprovalHandler?.({
      promptId: "host_res_apr_1",
      resourceType: "workspace-instructions",
      workspaceId: "w1",
      rootId: "r1",
      workspaceName: "My Workspace",
      rootName: "repo",
      uri: "workspace://w1/instructions",
      clientId: "Claude Desktop",
    })

    expect(await screen.findByText(/My Workspace/)).toBeInTheDocument()
    expect(screen.getByText(/\(root: repo\)/)).toBeInTheDocument()
    expect(useCapabilityProfile).toHaveBeenCalledWith(undefined)
  })

  it("shows the reported-identity line when clientId is present", async () => {
    render(<CapabilityPromptHost />)
    hostResourceApprovalHandler?.({
      promptId: "host_res_apr_2",
      resourceType: "workspace-instructions",
      workspaceId: "w1",
      rootId: "r1",
      workspaceName: "My Workspace",
      rootName: "repo",
      uri: "workspace://w1/instructions",
      clientId: "Claude Desktop",
    })
    expect(await screen.findByText(/Reported identity: Claude Desktop/)).toBeInTheDocument()
  })

  it("omits the reported-identity line when clientId is absent", async () => {
    render(<CapabilityPromptHost />)
    hostResourceApprovalHandler?.({
      promptId: "host_res_apr_3",
      resourceType: "workspace-instructions",
      workspaceId: "w1",
      rootId: "r1",
      workspaceName: "My Workspace",
      rootName: "repo",
      uri: "workspace://w1/instructions",
    })
    expect(await screen.findByRole("dialog")).toBeInTheDocument()
    expect(screen.queryByText(/Reported identity/)).not.toBeInTheDocument()
  })

  it("resolves via resolveHostResourceApproval, not resolveCapabilityApproval", async () => {
    render(<CapabilityPromptHost />)
    hostResourceApprovalHandler?.({
      promptId: "host_res_apr_4",
      resourceType: "workspace-instructions",
      workspaceId: "w1",
      rootId: "r1",
      workspaceName: "My Workspace",
      rootName: "repo",
      uri: "workspace://w1/instructions",
    })
    fireEvent.click(await screen.findByText("Allow"))
    await waitFor(() => {
      expect(resolveHostResourceApproval).toHaveBeenCalledWith("host_res_apr_4", true)
    })
    expect(resolveCapabilityApproval).not.toHaveBeenCalled()
  })
})
