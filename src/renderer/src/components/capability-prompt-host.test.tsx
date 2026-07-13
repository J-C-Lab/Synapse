import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  resolveCapabilityApproval,
  resolveCapabilityGrant,
  resolveHostResourceApproval,
} from "@/lib/electron"
import { CapabilityPromptHost } from "./capability-prompt-host"

let grantHandler: ((event: unknown) => void) | undefined
let approvalHandler: ((event: unknown) => void) | undefined
let hostResourceApprovalHandler: ((event: unknown) => void) | undefined
let settledHandler: ((event: unknown) => void) | undefined
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
        "plugins.capabilities.requestCancelledTitle": "Request cancelled",
        "plugins.capabilities.requestCancelledBody":
          "The request behind this prompt was cancelled elsewhere, so there's nothing left to approve.",
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
  onCapabilityGrantRequest: (handler: (event: unknown) => void) => {
    grantHandler = handler
    return () => {
      grantHandler = undefined
    }
  },
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
  onApprovalSettled: (handler: (event: unknown) => void) => {
    settledHandler = handler
    return () => {
      settledHandler = undefined
    }
  },
  resolveCapabilityGrant: vi.fn(),
  resolveCapabilityApproval: vi.fn(),
  resolveHostResourceApproval: vi.fn(),
}))

afterEach(() => {
  cleanup()
  grantHandler = undefined
  approvalHandler = undefined
  hostResourceApprovalHandler = undefined
  settledHandler = undefined
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

describe("approvals:settled", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("shows a transient cancellation notice for the shown prompt, then auto-advances after ~1.8s", async () => {
    render(<CapabilityPromptHost />)
    act(() => {
      approvalHandler?.({
        promptId: "cap_apr_1",
        pluginId: "com.synapse.test",
        capability: "clipboard:watch",
        actor: "agent",
        trigger: "tool:x",
        operation: "watch",
      })
    })
    expect(screen.getByText("Approve elevated capability?")).toBeInTheDocument()

    act(() => {
      settledHandler?.({ id: "cap_apr_1", kind: "capability-approval", outcome: "cancelled" })
    })

    expect(screen.getByText("Request cancelled")).toBeInTheDocument()
    expect(screen.queryByText("Approve elevated capability?")).not.toBeInTheDocument()
    expect(screen.getByRole("dialog")).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(1800)
    })

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("silently removes a queued but not-yet-shown prompt when it settles, leaving the shown dialog untouched", async () => {
    render(<CapabilityPromptHost />)
    act(() => {
      approvalHandler?.({
        promptId: "cap_apr_1",
        pluginId: "com.synapse.test",
        capability: "clipboard:watch",
        actor: "agent",
        trigger: "tool:x",
        operation: "watch",
      })
    })
    expect(screen.getByText("Approve elevated capability?")).toBeInTheDocument()

    act(() => {
      grantHandler?.({
        promptId: "cap_grant_1",
        pluginId: "com.synapse.test",
        capability: "clipboard:watch",
        tier: "consent",
      })
    })

    act(() => {
      settledHandler?.({ id: "cap_grant_1", kind: "capability-grant", outcome: "denied" })
    })

    expect(screen.getByText("Approve elevated capability?")).toBeInTheDocument()
    expect(screen.queryByText("Request cancelled")).not.toBeInTheDocument()

    act(() => {
      settledHandler?.({ id: "cap_apr_1", kind: "capability-approval", outcome: "denied" })
    })

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("immediately dismisses the shown prompt with no transient notice when the outcome is allowed/denied", async () => {
    render(<CapabilityPromptHost />)
    act(() => {
      approvalHandler?.({
        promptId: "cap_apr_1",
        pluginId: "com.synapse.test",
        capability: "clipboard:watch",
        actor: "agent",
        trigger: "tool:x",
        operation: "watch",
      })
    })
    expect(screen.getByText("Approve elevated capability?")).toBeInTheDocument()

    act(() => {
      settledHandler?.({ id: "cap_apr_1", kind: "capability-approval", outcome: "denied" })
    })

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(screen.queryByText("Request cancelled")).not.toBeInTheDocument()
    expect(resolveCapabilityApproval).not.toHaveBeenCalled()
  })

  it("drops a request for an id that has already settled instead of re-queuing it", async () => {
    render(<CapabilityPromptHost />)

    act(() => {
      settledHandler?.({ id: "cap_apr_1", kind: "capability-approval", outcome: "denied" })
    })
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()

    act(() => {
      approvalHandler?.({
        promptId: "cap_apr_1",
        pluginId: "com.synapse.test",
        capability: "clipboard:watch",
        actor: "agent",
        trigger: "tool:x",
        operation: "watch",
      })
    })

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(resolveCapabilityGrant).not.toHaveBeenCalled()
  })
})
