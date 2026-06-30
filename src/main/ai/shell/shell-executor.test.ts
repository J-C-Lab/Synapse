import { describe, expect, it } from "vitest"
import { createNodeShellExecutor } from "./shell-executor"

const isWin = process.platform === "win32"
const limits = { timeoutMs: 5000, maxOutputBytes: 1000 }

describe("createNodeShellExecutor", () => {
  it("runs a safe command and captures stdout + exit code", async () => {
    const exec = createNodeShellExecutor(limits)
    const cmd = isWin ? "Write-Output hi" : "echo hi"
    const result = await exec.run({ command: cmd, cwd: process.cwd() })
    expect(result.stdout.trim()).toBe("hi")
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
  })

  it("reports a non-zero exit code", async () => {
    const exec = createNodeShellExecutor(limits)
    const cmd = isWin ? "exit 3" : "exit 3"
    const result = await exec.run({ command: cmd, cwd: process.cwd() })
    expect(result.exitCode).toBe(3)
  })

  it("truncates output beyond maxOutputBytes", async () => {
    const exec = createNodeShellExecutor({ timeoutMs: 5000, maxOutputBytes: 5 })
    const cmd = isWin ? "Write-Output 0123456789" : "echo 0123456789"
    const result = await exec.run({ command: cmd, cwd: process.cwd() })
    expect(result.truncated).toBe(true)
    expect(result.stdout.length).toBeLessThanOrEqual(5)
  })
})
