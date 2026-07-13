import type { WorkspaceRootRecord } from "../ai/execution/types"
import type { WorkspaceRootStore } from "../ai/workspace/workspace-root-store"
import type { WorkspaceStore } from "../ai/workspace/workspace-store"
import type { HostResourceApprover } from "./host-resource-approval"
import type { HostResourceAccessAuditEntry } from "./host-resource-audit"
import { loadWorkspaceInstructions } from "../ai/context/workspace-instructions"

export interface WorkspaceInstructionsResourceDescriptor {
  uri: string
  fileName: "AGENTS.md" | "CLAUDE.md"
}

export interface WorkspaceInstructionsResourceContent {
  uri: string
  text: string
}

export interface WorkspaceInstructionsResourcePort {
  list: (workspaceId: string) => Promise<WorkspaceInstructionsResourceDescriptor[]>
  read: (input: {
    workspaceId: string
    uri: string
    clientId?: string
    signal?: AbortSignal
  }) => Promise<WorkspaceInstructionsResourceContent | undefined>
}

export interface WorkspaceInstructionsResourcePortOptions {
  workspaces: Pick<WorkspaceStore, "get">
  workspaceRoots: Pick<WorkspaceRootStore, "listForWorkspace">
  approve: HostResourceApprover
  recordAccess: (entry: HostResourceAccessAuditEntry) => void
}

// Exported so synapse-mcp-server.ts's readResource() dispatch checks
// against the exact same string this module builds URIs from — two
// independently-hardcoded copies of this constant would be a real risk
// of drifting apart.
export const WORKSPACE_INSTRUCTIONS_PREFIX = "synapse://workspace-instructions/"

export function toWorkspaceInstructionsUri(workspaceId: string, fileName: string): string {
  return `${WORKSPACE_INSTRUCTIONS_PREFIX}${encodeURIComponent(workspaceId)}/${fileName}`
}

export function parseWorkspaceInstructionsUri(
  uri: string
): { workspaceId: string; fileName: "AGENTS.md" | "CLAUDE.md" } | undefined {
  if (!uri.startsWith(WORKSPACE_INSTRUCTIONS_PREFIX)) return undefined
  const rest = uri.slice(WORKSPACE_INSTRUCTIONS_PREFIX.length)
  const slash = rest.indexOf("/")
  if (slash === -1) return undefined
  let workspaceId: string
  try {
    workspaceId = decodeURIComponent(rest.slice(0, slash))
  } catch {
    return undefined
  }
  const fileName = rest.slice(slash + 1)
  if (fileName !== "AGENTS.md" && fileName !== "CLAUDE.md") return undefined
  if (!workspaceId) return undefined
  return { workspaceId, fileName }
}

export function createWorkspaceInstructionsResourcePort(
  options: WorkspaceInstructionsResourcePortOptions
): WorkspaceInstructionsResourcePort {
  return {
    list: (workspaceId) => list(workspaceId, options),
    read: (input) => read(input, options),
  }
}

async function primaryRoot(
  workspaceId: string,
  workspaceRoots: Pick<WorkspaceRootStore, "listForWorkspace">
): Promise<WorkspaceRootRecord | undefined> {
  const roots = await workspaceRoots.listForWorkspace(workspaceId)
  return roots.find((r) => r.role === "primary")
}

async function list(
  workspaceId: string,
  options: WorkspaceInstructionsResourcePortOptions
): Promise<WorkspaceInstructionsResourceDescriptor[]> {
  const workspace = await options.workspaces.get(workspaceId)
  if (!workspace) return []
  const primary = await primaryRoot(workspaceId, options.workspaceRoots)
  if (!primary) return []

  const instructions = await loadWorkspaceInstructions([{ id: primary.id, root: primary.root }])
  return instructions.map((i) => ({
    uri: toWorkspaceInstructionsUri(workspaceId, i.fileName),
    fileName: i.fileName as "AGENTS.md" | "CLAUDE.md",
  }))
}

async function read(
  input: { workspaceId: string; uri: string; clientId?: string; signal?: AbortSignal },
  options: WorkspaceInstructionsResourcePortOptions
): Promise<WorkspaceInstructionsResourceContent | undefined> {
  const workspace = await options.workspaces.get(input.workspaceId)
  const primary = await primaryRoot(input.workspaceId, options.workspaceRoots)
  const parsed = parseWorkspaceInstructionsUri(input.uri)
  if (!workspace || !primary || !parsed || parsed.workspaceId !== input.workspaceId) {
    return undefined
  }

  const result = await options.approve({
    request: {
      resourceType: "workspace-instructions",
      workspaceId: input.workspaceId,
      rootId: primary.id,
      workspaceName: workspace.name,
      rootName: primary.name,
      uri: input.uri,
      clientId: input.clientId,
    },
    signal: input.signal,
  })
  if (!result.allow) return undefined

  // Binding constraint (spec ②): require the SAME root id AND that it's
  // still primary — WorkspaceRootStore.setPrimary() demotes the previous
  // primary to "additional" rather than removing it, so checking
  // existence alone would still pass for a root the approval no longer
  // actually describes.
  const rootsAfterApproval = await options.workspaceRoots.listForWorkspace(input.workspaceId)
  const stillPrimary = rootsAfterApproval.some((r) => r.id === primary.id && r.role === "primary")
  if (!stillPrimary) return undefined

  const instructions = await loadWorkspaceInstructions([{ id: primary.id, root: primary.root }])
  const match = instructions.find((i) => i.fileName === parsed.fileName)
  if (!match) return undefined

  options.recordAccess({
    event: "resource-access",
    resourceType: "workspace-instructions",
    workspaceId: input.workspaceId,
    rootId: primary.id,
    fileName: parsed.fileName,
    uri: input.uri,
    clientId: input.clientId,
    charsReturned: match.text.length,
    timestamp: Date.now(),
  })
  return { uri: input.uri, text: match.text }
}
