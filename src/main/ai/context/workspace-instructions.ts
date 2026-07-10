import type { ResolvedWorkspacePath } from "../execution/types"
import { Buffer } from "node:buffer"
import { promises as fs } from "node:fs"
import { WorkspacePolicy } from "../execution/workspace-policy"

const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const

export interface WorkspaceInstruction {
  workspaceId: string
  fileName: string
  text: string
}

export interface LoadWorkspaceInstructionsOptions {
  maxCharsPerFile?: number
  maxTotalChars?: number
}

// Headroom multiplier so a maxCharsPerFile-sized read still captures
// maxCharsPerFile actual characters even when the file is multi-byte
// UTF-8 (ASCII is 1 byte/char; worst case is 4 bytes/char).
const MAX_READ_BYTES_MULTIPLIER = 4

export async function loadWorkspaceInstructions(
  workspaces: Array<{ id: string; root: string }>,
  options: LoadWorkspaceInstructionsOptions = {}
): Promise<WorkspaceInstruction[]> {
  const maxPerFile = options.maxCharsPerFile ?? 8_000
  const maxTotal = options.maxTotalChars ?? 16_000
  const policy = new WorkspacePolicy(workspaces.map((w) => ({ id: w.id, root: w.root })))
  const out: WorkspaceInstruction[] = []
  let total = 0

  for (const workspace of workspaces) {
    for (const fileName of INSTRUCTION_FILES) {
      if (total >= maxTotal) return out
      let resolved: ResolvedWorkspacePath
      try {
        resolved = await policy.resolvePath(workspace.id, fileName)
      } catch {
        continue // outside the root (symlink escape), or the root itself is missing
      }
      const remaining = maxTotal - total
      const maxChars = Math.min(maxPerFile, remaining)
      const raw = await readBounded(resolved.absolutePath, maxChars * MAX_READ_BYTES_MULTIPLIER)
      if (raw === undefined) continue // ENOENT — most workspaces don't define instruction files
      const trimmed = raw.trim().slice(0, maxChars)
      if (!trimmed) continue
      out.push({ workspaceId: workspace.id, fileName, text: trimmed })
      total += trimmed.length
    }
  }

  return out
}

/** Reads at most `maxBytes` from `absolutePath` without ever loading more
 *  of the file into memory than that, regardless of the file's actual
 *  size. Returns undefined for ENOENT; rethrows anything else. Exported
 *  so tests can assert directly on the bytes actually requested from the
 *  filesystem, not just on the returned text's length. */
export async function readBounded(
  absolutePath: string,
  maxBytes: number
): Promise<string | undefined> {
  let handle
  try {
    handle = await fs.open(absolutePath, "r")
  } catch (err) {
    if (isNotFound(err)) return undefined
    throw err
  }
  try {
    const buffer = Buffer.alloc(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
    return buffer.subarray(0, bytesRead).toString("utf-8")
  } finally {
    await handle.close()
  }
}

function isNotFound(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "ENOENT")
}
