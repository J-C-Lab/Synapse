import type { ExecResult } from "./exec"
import { describe, expect, it, vi } from "vitest"
import { createLinuxCredentialHelper } from "./linux"

function fakeExec(impl: (command: string, args: string[], stdin?: string) => ExecResult) {
  return vi.fn(async (command: string, args: string[], stdin?: string) =>
    impl(command, args, stdin)
  )
}

describe("createLinuxCredentialHelper", () => {
  it("reports available when secret-tool resolves on PATH", async () => {
    const exec = fakeExec(() => ({ code: 0, stdout: "/usr/bin/secret-tool", stderr: "" }))
    const helper = createLinuxCredentialHelper(exec)
    expect(await helper.isAvailable()).toBe(true)
    expect(exec).toHaveBeenCalledWith("which", ["secret-tool"])
  })

  it("reports unavailable when secret-tool is not installed (not every distro ships libsecret-tools)", async () => {
    const exec = fakeExec(() => ({ code: 1, stdout: "", stderr: "" }))
    const helper = createLinuxCredentialHelper(exec)
    expect(await helper.isAvailable()).toBe(false)
  })

  it("stores a secret via stdin, never as an argv value", async () => {
    const exec = fakeExec(() => ({ code: 0, stdout: "", stderr: "" }))
    const helper = createLinuxCredentialHelper(exec)
    await helper.store("synapse-cli:https://m.test", "secret-token")
    expect(exec).toHaveBeenCalledWith(
      "secret-tool",
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
    const exec = fakeExec(() => ({ code: 1, stdout: "", stderr: "no keyring daemon" }))
    const helper = createLinuxCredentialHelper(exec)
    await expect(helper.store("k", "v")).rejects.toThrow(/secret-tool store failed/i)
  })

  it("retrieves a stored secret from stdout", async () => {
    const exec = fakeExec(() => ({ code: 0, stdout: "secret-token\n", stderr: "" }))
    const helper = createLinuxCredentialHelper(exec)
    expect(await helper.retrieve("synapse-cli:https://m.test")).toBe("secret-token")
  })

  it("returns undefined for a key that was never stored", async () => {
    const exec = fakeExec(() => ({ code: 1, stdout: "", stderr: "" }))
    const helper = createLinuxCredentialHelper(exec)
    expect(await helper.retrieve("missing")).toBeUndefined()
  })

  it("erase succeeds whether or not the entry existed", async () => {
    const exec = fakeExec(() => ({ code: 0, stdout: "", stderr: "" }))
    const helper = createLinuxCredentialHelper(exec)
    await expect(helper.erase("missing")).resolves.toBeUndefined()
  })
})
