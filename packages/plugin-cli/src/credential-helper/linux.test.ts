import type { ExecResult } from "./exec"
import { describe, expect, it, vi } from "vitest"
import { createLinuxCredentialHelper } from "./linux"

function fakeExec(impl: (command: string, args: string[], stdin?: string) => ExecResult) {
  return vi.fn(async (command: string, args: string[], stdin?: string) =>
    impl(command, args, stdin)
  )
}

describe("createLinuxCredentialHelper", () => {
  it("resolves secret-tool via a pure filesystem check on a fixed candidate path first", async () => {
    const exec = fakeExec(() => ({ code: 0, stdout: "", stderr: "" }))
    const fileExists = vi.fn(async (p: string) => p === "/usr/bin/secret-tool")
    const helper = createLinuxCredentialHelper(exec, { fileExists })
    expect(await helper.isAvailable()).toBe(true)
    expect(exec).not.toHaveBeenCalled()
  })

  it("falls back to a one-time PATH search only when no fixed candidate path exists, then reuses that resolved absolute path for every later call", async () => {
    const fileExists = vi.fn(async () => false)
    const exec = fakeExec((command) =>
      command === "which"
        ? { code: 0, stdout: "/opt/homebrew/bin/secret-tool\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" }
    )
    const helper = createLinuxCredentialHelper(exec, { fileExists })
    expect(await helper.isAvailable()).toBe(true)
    expect(exec).toHaveBeenCalledWith("which", ["secret-tool"])

    exec.mockClear()
    await helper.store("k", "v")
    expect(exec).toHaveBeenCalledWith(
      "/opt/homebrew/bin/secret-tool",
      expect.arrayContaining(["store"]),
      "v"
    )
  })

  it("reports unavailable when secret-tool is not installed anywhere (not every distro ships libsecret-tools)", async () => {
    const fileExists = vi.fn(async () => false)
    const exec = fakeExec(() => ({ code: 1, stdout: "", stderr: "" }))
    const helper = createLinuxCredentialHelper(exec, { fileExists })
    expect(await helper.isAvailable()).toBe(false)
  })

  it("stores a secret via stdin, never as an argv value", async () => {
    const fileExists = vi.fn(async (p: string) => p === "/usr/bin/secret-tool")
    const exec = fakeExec(() => ({ code: 0, stdout: "", stderr: "" }))
    const helper = createLinuxCredentialHelper(exec, { fileExists })
    await helper.store("synapse-cli:https://m.test", "secret-token")
    expect(exec).toHaveBeenCalledWith(
      "/usr/bin/secret-tool",
      [
        "store",
        "--label",
        "Synapse CLI",
        "service",
        "synapse-cli",
        "account",
        "synapse-cli:https://m.test",
      ],
      "secret-token"
    )
  })

  it("throws a clear error when the store call fails", async () => {
    const fileExists = vi.fn(async (p: string) => p === "/usr/bin/secret-tool")
    const exec = fakeExec(() => ({ code: 1, stdout: "", stderr: "no keyring daemon" }))
    const helper = createLinuxCredentialHelper(exec, { fileExists })
    await expect(helper.store("k", "v")).rejects.toThrow(/secret-tool store failed/i)
  })

  it("retrieves a stored secret from stdout", async () => {
    const fileExists = vi.fn(async (p: string) => p === "/usr/bin/secret-tool")
    const exec = fakeExec(() => ({ code: 0, stdout: "secret-token\n", stderr: "" }))
    const helper = createLinuxCredentialHelper(exec, { fileExists })
    expect(await helper.retrieve("synapse-cli:https://m.test")).toBe("secret-token")
  })

  it("returns undefined for a key that was never stored", async () => {
    const fileExists = vi.fn(async (p: string) => p === "/usr/bin/secret-tool")
    const exec = fakeExec(() => ({ code: 1, stdout: "", stderr: "" }))
    const helper = createLinuxCredentialHelper(exec, { fileExists })
    expect(await helper.retrieve("missing")).toBeUndefined()
  })

  it("erase succeeds whether or not the entry existed", async () => {
    const fileExists = vi.fn(async (p: string) => p === "/usr/bin/secret-tool")
    const exec = fakeExec(() => ({ code: 0, stdout: "", stderr: "" }))
    const helper = createLinuxCredentialHelper(exec, { fileExists })
    await expect(helper.erase("missing")).resolves.toBeUndefined()
  })

  it("throws from store when secret-tool can't be resolved at all", async () => {
    const fileExists = vi.fn(async () => false)
    const exec = fakeExec(() => ({ code: 1, stdout: "", stderr: "" }))
    const helper = createLinuxCredentialHelper(exec, { fileExists })
    await expect(helper.store("k", "v")).rejects.toThrow(/secret-tool/i)
  })
})
