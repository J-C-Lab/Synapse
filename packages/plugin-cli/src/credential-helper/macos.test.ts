import type { ExecResult } from "./exec"
import { describe, expect, it, vi } from "vitest"
import { createMacosCredentialHelper } from "./macos"

function fakeExec(impl: (command: string, args: string[], stdin?: string) => ExecResult) {
  return vi.fn(async (command: string, args: string[], stdin?: string) =>
    impl(command, args, stdin)
  )
}

describe("createMacosCredentialHelper", () => {
  it("reports available when `security` resolves on PATH", async () => {
    const exec = fakeExec(() => ({ code: 0, stdout: "/usr/bin/security", stderr: "" }))
    const helper = createMacosCredentialHelper(exec)
    expect(await helper.isAvailable()).toBe(true)
    expect(exec).toHaveBeenCalledWith("which", ["security"])
  })

  it("reports unavailable when `security` is missing", async () => {
    const exec = fakeExec(() => ({ code: 1, stdout: "", stderr: "" }))
    const helper = createMacosCredentialHelper(exec)
    expect(await helper.isAvailable()).toBe(false)
  })

  it("stores a secret by passing it as the -w argument (Keychain has no stdin option)", async () => {
    const exec = fakeExec(() => ({ code: 0, stdout: "", stderr: "" }))
    const helper = createMacosCredentialHelper(exec)
    await helper.store("synapse-cli:https://m.test", "secret-token")
    expect(exec).toHaveBeenCalledWith("security", [
      "add-generic-password",
      "-a",
      "synapse-cli:https://m.test",
      "-s",
      "synapse-cli",
      "-w",
      "secret-token",
      "-U",
    ])
  })

  it("throws a clear error when the Keychain store call fails", async () => {
    const exec = fakeExec(() => ({
      code: 1,
      stdout: "",
      stderr: "SecKeychainAddGenericPassword failed",
    }))
    const helper = createMacosCredentialHelper(exec)
    await expect(helper.store("k", "v")).rejects.toThrow(/keychain store failed/i)
  })

  it("retrieves a stored secret from stdout", async () => {
    const exec = fakeExec(() => ({ code: 0, stdout: "secret-token\n", stderr: "" }))
    const helper = createMacosCredentialHelper(exec)
    expect(await helper.retrieve("synapse-cli:https://m.test")).toBe("secret-token")
  })

  it("returns undefined for a key that was never stored", async () => {
    const exec = fakeExec(() => ({ code: 44, stdout: "", stderr: "could not be found" }))
    const helper = createMacosCredentialHelper(exec)
    expect(await helper.retrieve("missing")).toBeUndefined()
  })

  it("erase is a no-op (not an error) for an already-absent key", async () => {
    const exec = fakeExec(() => ({
      code: 44,
      stdout: "",
      stderr: "The specified item could not be found",
    }))
    const helper = createMacosCredentialHelper(exec)
    await expect(helper.erase("missing")).resolves.toBeUndefined()
  })

  it("throws when erase fails for a reason other than missing-item", async () => {
    const exec = fakeExec(() => ({ code: 1, stdout: "", stderr: "permission denied" }))
    const helper = createMacosCredentialHelper(exec)
    await expect(helper.erase("k")).rejects.toThrow(/keychain erase failed/i)
  })
})
