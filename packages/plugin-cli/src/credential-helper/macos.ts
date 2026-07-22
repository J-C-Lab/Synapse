import type { CredentialHelper } from "./types"
import { runWithStdin } from "./exec"

const SERVICE = "synapse-cli"

export type ExecFn = typeof runWithStdin

/**
 * Shells out to the `security` CLI (macOS Keychain), present on every Mac —
 * no compiled native addon. NOTE: `security add-generic-password` has no
 * stdin option for the password itself (unlike `secret-tool` on Linux), so
 * the value briefly appears as an argv on this call only — a real but
 * transient tradeoff of avoiding a native binary, and strictly better than
 * a permanent plaintext file on disk.
 */
export function createMacosCredentialHelper(exec: ExecFn = runWithStdin): CredentialHelper {
  return {
    name: "macos",
    async isAvailable() {
      const result = await exec("which", ["security"]).catch(() => ({
        code: 1,
        stdout: "",
        stderr: "",
      }))
      return result.code === 0
    },
    async store(key, value) {
      const result = await exec("security", [
        "add-generic-password",
        "-a",
        key,
        "-s",
        SERVICE,
        "-w",
        value,
        "-U",
      ])
      if (result.code !== 0) {
        throw new Error(
          `macOS Keychain store failed: ${result.stderr.trim() || `exit ${result.code}`}`
        )
      }
    },
    async retrieve(key) {
      const result = await exec("security", [
        "find-generic-password",
        "-a",
        key,
        "-s",
        SERVICE,
        "-w",
      ])
      if (result.code !== 0) return undefined
      return result.stdout.trim()
    },
    async erase(key) {
      const result = await exec("security", ["delete-generic-password", "-a", key, "-s", SERVICE])
      // A missing key exits non-zero; erasing an already-absent entry is a no-op, not an error.
      if (result.code !== 0 && !/could not be found/i.test(result.stderr)) {
        throw new Error(
          `macOS Keychain erase failed: ${result.stderr.trim() || `exit ${result.code}`}`
        )
      }
    },
  }
}
