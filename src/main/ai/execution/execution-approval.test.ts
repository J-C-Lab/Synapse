import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ExecutionApprovalResolver } from "./execution-approval"
import { ExecutionLogStore } from "./execution-log-store"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function makeLog(): Promise<ExecutionLogStore> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-exec-approval-"))
  tempDirs.push(dir)
  return new ExecutionLogStore(path.join(dir, "execution-log.json"))
}

describe("executionApprovalResolver", () => {
  it("allows safe read-only run_command calls before UI approval", async () => {
    const log = await makeLog()
    const resolver = new ExecutionApprovalResolver({ log, now: () => 1 })
    await expect(
      resolver.decide({
        conversationId: "c1",
        fqName: "execution:core/run_command",
        input: { workspaceId: "repo", command: "git status" },
      })
    ).resolves.toBe("allow")
  })

  it("denies forbidden run_command calls and writes audit", async () => {
    const log = await makeLog()
    const resolver = new ExecutionApprovalResolver({ log, now: () => 1 })
    await expect(
      resolver.decide({
        conversationId: "c1",
        fqName: "execution:core/run_command",
        input: { workspaceId: "repo", command: "rm -rf /" },
      })
    ).resolves.toBe("deny")
    await expect(log.list()).resolves.toEqual([
      expect.objectContaining({
        conversationId: "c1",
        toolName: "execution:core/run_command",
        decision: "deny",
        inputPreview: expect.stringContaining("rm -rf /"),
      }),
    ])
  })

  it("audits user-denied run_command approvals", async () => {
    const log = await makeLog()
    const resolver = new ExecutionApprovalResolver({ log, now: () => 1 })
    await expect(
      resolver.decide({
        conversationId: "c1",
        fqName: "execution:core/run_command",
        input: { userDenied: true, originalInput: { workspaceId: "repo", command: "pnpm test" } },
      })
    ).resolves.toBe("deny")
    await expect(log.list()).resolves.toEqual([
      expect.objectContaining({
        decision: "deny",
        inputPreview: expect.stringContaining("pnpm test"),
        errorPreview: "user denied approval",
      }),
    ])
  })
})
