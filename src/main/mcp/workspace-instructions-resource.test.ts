import type { WorkspaceRootRecord } from "../ai/execution/types"
import type { Workspace } from "../ai/workspace/workspace-store"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createWorkspaceInstructionsResourcePort } from "./workspace-instructions-resource"

const tempDirs: string[] = []
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function makeRootDir(files: Record<string, string> = {}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-wi-resource-"))
  tempDirs.push(root)
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(root, name), content, "utf-8")
  }
  return root
}

function fakeWorkspaces(workspaces: Workspace[]) {
  return { get: async (id: string) => workspaces.find((w) => w.id === id) }
}

function fakeWorkspaceRoots(records: WorkspaceRootRecord[]) {
  return {
    listForWorkspace: async (workspaceId: string) =>
      records.filter((r) => r.workspaceId === workspaceId),
  }
}

function record(overrides: Partial<WorkspaceRootRecord> = {}): WorkspaceRootRecord {
  return {
    id: "r1",
    workspaceId: "w1",
    name: "repo",
    root: "/unused",
    role: "primary",
    createdAt: 1,
    ...overrides,
  }
}

describe("workspaceInstructionsResourcePort", () => {
  describe("list()", () => {
    it("returns only files that actually exist and are non-empty", async () => {
      const root = await makeRootDir({ "AGENTS.md": "Run tests.\n" })
      const port = createWorkspaceInstructionsResourcePort({
        workspaces: fakeWorkspaces([{ id: "w1", name: "My Workspace", createdAt: 1 }]),
        workspaceRoots: fakeWorkspaceRoots([record({ root })]),
        approve: vi.fn(async () => ({ allow: true as const })),
        recordAccess: vi.fn(),
      })

      const descriptors = await port.list("w1")

      expect(descriptors).toEqual([
        { uri: "synapse://workspace-instructions/w1/AGENTS.md", fileName: "AGENTS.md" },
      ])
    })

    it("returns [] without touching workspaceRoots when the workspace doesn't exist", async () => {
      const listForWorkspace = vi.fn(async () => [])
      const port = createWorkspaceInstructionsResourcePort({
        workspaces: fakeWorkspaces([]),
        workspaceRoots: { listForWorkspace },
        approve: vi.fn(async () => ({ allow: true as const })),
        recordAccess: vi.fn(),
      })

      expect(await port.list("ghost")).toEqual([])
      expect(listForWorkspace).not.toHaveBeenCalled()
    })

    it("returns [] for a rootless workspace", async () => {
      const port = createWorkspaceInstructionsResourcePort({
        workspaces: fakeWorkspaces([{ id: "w1", name: "W", createdAt: 1 }]),
        workspaceRoots: fakeWorkspaceRoots([]),
        approve: vi.fn(async () => ({ allow: true as const })),
        recordAccess: vi.fn(),
      })
      expect(await port.list("w1")).toEqual([])
    })

    it("returns [] when the primary root has neither file", async () => {
      const root = await makeRootDir()
      const port = createWorkspaceInstructionsResourcePort({
        workspaces: fakeWorkspaces([{ id: "w1", name: "W", createdAt: 1 }]),
        workspaceRoots: fakeWorkspaceRoots([record({ root })]),
        approve: vi.fn(async () => ({ allow: true as const })),
        recordAccess: vi.fn(),
      })
      expect(await port.list("w1")).toEqual([])
    })
  })

  describe("read()", () => {
    it("resolves the primary root, requests approval with the real workspace/root names, and returns content when approved", async () => {
      const root = await makeRootDir({ "AGENTS.md": "Run tests before committing.\n" })
      const approve = vi.fn(async () => ({ allow: true as const }))
      const recordAccess = vi.fn()
      const port = createWorkspaceInstructionsResourcePort({
        workspaces: fakeWorkspaces([{ id: "w1", name: "My Workspace", createdAt: 1 }]),
        workspaceRoots: fakeWorkspaceRoots([record({ id: "r1", root, name: "repo" })]),
        approve,
        recordAccess,
      })

      const result = await port.read({
        workspaceId: "w1",
        uri: "synapse://workspace-instructions/w1/AGENTS.md",
        clientId: "Claude Desktop",
      })

      expect(result).toEqual({
        uri: "synapse://workspace-instructions/w1/AGENTS.md",
        text: "Run tests before committing.",
      })
      expect(approve).toHaveBeenCalledWith({
        request: {
          resourceType: "workspace-instructions",
          workspaceId: "w1",
          rootId: "r1",
          workspaceName: "My Workspace",
          rootName: "repo",
          uri: "synapse://workspace-instructions/w1/AGENTS.md",
          clientId: "Claude Desktop",
        },
        signal: undefined,
      })
      expect(recordAccess).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "resource-access",
          workspaceId: "w1",
          rootId: "r1",
          fileName: "AGENTS.md",
          charsReturned: "Run tests before committing.".length,
        })
      )
    })

    it("returns undefined without calling approve() when there's no primary root", async () => {
      const approve = vi.fn(async () => ({ allow: true as const }))
      const port = createWorkspaceInstructionsResourcePort({
        workspaces: fakeWorkspaces([{ id: "w1", name: "W", createdAt: 1 }]),
        workspaceRoots: fakeWorkspaceRoots([]),
        approve,
        recordAccess: vi.fn(),
      })

      const result = await port.read({
        workspaceId: "w1",
        uri: "synapse://workspace-instructions/w1/AGENTS.md",
      })

      expect(result).toBeUndefined()
      expect(approve).not.toHaveBeenCalled()
    })

    it("returns undefined and does not call recordAccess when approve() denies", async () => {
      const root = await makeRootDir({ "AGENTS.md": "content" })
      const recordAccess = vi.fn()
      const port = createWorkspaceInstructionsResourcePort({
        workspaces: fakeWorkspaces([{ id: "w1", name: "W", createdAt: 1 }]),
        workspaceRoots: fakeWorkspaceRoots([record({ root })]),
        approve: vi.fn(async () => ({ allow: false as const })),
        recordAccess,
      })

      const result = await port.read({
        workspaceId: "w1",
        uri: "synapse://workspace-instructions/w1/AGENTS.md",
      })

      expect(result).toBeUndefined()
      expect(recordAccess).not.toHaveBeenCalled()
    })

    it("denies when the previously-primary root was demoted to additional during approval", async () => {
      const root = await makeRootDir({ "AGENTS.md": "content" })
      let callCount = 0
      const workspaceRoots = {
        listForWorkspace: async () => {
          callCount++
          return [record({ id: "r1", root, role: callCount === 1 ? "primary" : "additional" })]
        },
      }
      const recordAccess = vi.fn()
      const port = createWorkspaceInstructionsResourcePort({
        workspaces: fakeWorkspaces([{ id: "w1", name: "W", createdAt: 1 }]),
        workspaceRoots,
        approve: vi.fn(async () => ({ allow: true as const })),
        recordAccess,
      })

      const result = await port.read({
        workspaceId: "w1",
        uri: "synapse://workspace-instructions/w1/AGENTS.md",
      })

      expect(result).toBeUndefined()
      expect(recordAccess).not.toHaveBeenCalled()
    })

    it("returns undefined for a URI whose embedded workspaceId doesn't match the caller's", async () => {
      const root = await makeRootDir({ "AGENTS.md": "content" })
      const port = createWorkspaceInstructionsResourcePort({
        workspaces: fakeWorkspaces([{ id: "w1", name: "W", createdAt: 1 }]),
        workspaceRoots: fakeWorkspaceRoots([record({ root })]),
        approve: vi.fn(async () => ({ allow: true as const })),
        recordAccess: vi.fn(),
      })

      const result = await port.read({
        workspaceId: "w1",
        uri: "synapse://workspace-instructions/some-other-workspace/AGENTS.md",
      })

      expect(result).toBeUndefined()
    })

    it("returns undefined for a malformed URI", async () => {
      const port = createWorkspaceInstructionsResourcePort({
        workspaces: fakeWorkspaces([{ id: "w1", name: "W", createdAt: 1 }]),
        workspaceRoots: fakeWorkspaceRoots([record()]),
        approve: vi.fn(async () => ({ allow: true as const })),
        recordAccess: vi.fn(),
      })
      expect(await port.read({ workspaceId: "w1", uri: "not-a-synapse-uri" })).toBeUndefined()
    })
  })
})
