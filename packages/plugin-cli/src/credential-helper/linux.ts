import type { CredentialHelper } from "./types"
import { fileExists as defaultFileExists, runWithStdin } from "./exec"

const SERVICE = "synapse-cli"

// Unlike macOS/Windows, Linux has no single guaranteed install location for
// secret-tool — distro packaging (and Nix, flatpak, etc.) can put it
// elsewhere. Check the common fixed locations by absolute path first.
const CANDIDATE_PATHS = ["/usr/bin/secret-tool", "/usr/local/bin/secret-tool", "/bin/secret-tool"]

export type ExecFn = typeof runWithStdin

/**
 * Shells out to `secret-tool` (the `libsecret-tools` package — GNOME/most
 * desktop Linux distros, but not guaranteed present). `secret-tool store`
 * reads the secret from stdin, so it never appears in argv. When the tool
 * is missing, `isAvailable()` reports false and the metadata store fails
 * closed (no plaintext fallback) rather than silently degrading.
 *
 * Resolution avoids trusting PATH for every call (CWE-426): a fixed
 * absolute candidate is preferred; only if none exists does this fall back
 * to a one-time `which` search, and the exact absolute path `which` returns
 * is cached and reused for every subsequent store/retrieve/erase — so at
 * most one call ever trusts PATH, not every call.
 */
export function createLinuxCredentialHelper(
  exec: ExecFn = runWithStdin,
  options: { fileExists?: (path: string) => Promise<boolean> } = {}
): CredentialHelper {
  const fileExists = options.fileExists ?? defaultFileExists
  let resolved: string | undefined

  async function resolvePath(): Promise<string | undefined> {
    if (resolved) return resolved
    for (const candidate of CANDIDATE_PATHS) {
      if (await fileExists(candidate)) {
        resolved = candidate
        return resolved
      }
    }
    const probe = await exec("which", ["secret-tool"]).catch(() => ({
      code: 1,
      stdout: "",
      stderr: "",
    }))
    const found = probe.code === 0 ? probe.stdout.trim().split(/\r?\n/)[0] : undefined
    if (found) resolved = found
    return resolved
  }

  return {
    name: "linux",
    async isAvailable() {
      return (await resolvePath()) !== undefined
    },
    async store(key, value) {
      const bin = await resolvePath()
      if (!bin) throw new Error("secret-tool is not available on this system")
      const result = await exec(
        bin,
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
      const bin = await resolvePath()
      if (!bin) return undefined
      const result = await exec(bin, ["lookup", "service", SERVICE, "account", key])
      if (result.code !== 0) return undefined
      return result.stdout.replace(/\n$/, "")
    },
    async erase(key) {
      const bin = await resolvePath()
      if (!bin) return
      // secret-tool clear exits 0 whether or not the entry existed.
      const result = await exec(bin, ["clear", "service", SERVICE, "account", key])
      if (result.code !== 0) {
        throw new Error(
          `secret-tool clear failed: ${result.stderr.trim() || `exit ${result.code}`}`
        )
      }
    },
  }
}
