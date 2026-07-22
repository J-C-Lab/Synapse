import type { CredentialHelper } from "./types"
import { runWithStdin } from "./exec"

const SERVICE = "synapse-cli"

export type ExecFn = typeof runWithStdin

/**
 * Shells out to `secret-tool` (the `libsecret-tools` package — GNOME/most
 * desktop Linux distros, but not guaranteed present). `secret-tool store`
 * reads the secret from stdin, so it never appears in argv. When the tool
 * is missing, `isAvailable()` reports false and the metadata store fails
 * closed (no plaintext fallback) rather than silently degrading.
 */
export function createLinuxCredentialHelper(exec: ExecFn = runWithStdin): CredentialHelper {
  return {
    name: "linux",
    async isAvailable() {
      const result = await exec("which", ["secret-tool"]).catch(() => ({
        code: 1,
        stdout: "",
        stderr: "",
      }))
      return result.code === 0
    },
    async store(key, value) {
      const result = await exec(
        "secret-tool",
        ["store", "--label", "Synapse CLI", "service", SERVICE, "account", key],
        value
      )
      if (result.code !== 0) {
        throw new Error(
          `secret-tool store failed: ${result.stderr.trim() || `exit ${result.code}`}`
        )
      }
    },
    async retrieve(key) {
      const result = await exec("secret-tool", ["lookup", "service", SERVICE, "account", key])
      if (result.code !== 0) return undefined
      return result.stdout.replace(/\n$/, "")
    },
    async erase(key) {
      // secret-tool clear exits 0 whether or not the entry existed.
      const result = await exec("secret-tool", ["clear", "service", SERVICE, "account", key])
      if (result.code !== 0) {
        throw new Error(
          `secret-tool clear failed: ${result.stderr.trim() || `exit ${result.code}`}`
        )
      }
    },
  }
}
