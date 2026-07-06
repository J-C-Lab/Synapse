import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runCommand } from "./command-runner"
import { WorkspacePolicy } from "./workspace-policy"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function makeWorkspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-cmd-"))
  tempDirs.push(root)
  return root
}

describe("runCommand", () => {
  it("runs a simple command with exit code 0", async () => {
    const root = await makeWorkspace()
    const policy = new WorkspacePolicy([{ id: "repo", root }])
    const command = process.platform === "win32" ? "Write-Output ok" : "echo ok"
    const result = await runCommand(policy, { workspaceId: "repo", command })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("ok")
  })

  it("returns non-zero exit codes", async () => {
    const root = await makeWorkspace()
    const policy = new WorkspacePolicy([{ id: "repo", root }])
    const command = process.platform === "win32" ? "exit 3" : "exit 3"
    const result = await runCommand(policy, { workspaceId: "repo", command, timeoutMs: 5_000 })
    expect(result.exitCode).not.toBe(0)
  })

  it("times out long-running commands", async () => {
    const root = await makeWorkspace()
    const policy = new WorkspacePolicy([{ id: "repo", root }])
    const command = process.platform === "win32" ? "Start-Sleep -Seconds 5" : "sleep 5"
    const result = await runCommand(policy, {
      workspaceId: "repo",
      command,
      timeoutMs: 200,
    })
    expect(result.timedOut).toBe(true)
  }, 15_000)

  it("cancels via AbortSignal", async () => {
    const root = await makeWorkspace()
    const policy = new WorkspacePolicy([{ id: "repo", root }])
    const controller = new AbortController()
    const command = process.platform === "win32" ? "ping -n 60 127.0.0.1 >nul" : "sleep 60"
    const pending = runCommand(
      policy,
      { workspaceId: "repo", command, timeoutMs: 60_000 },
      controller.signal
    )
    controller.abort()
    const result = await pending
    expect(result.cancelled).toBe(true)
  }, 15_000)
})
