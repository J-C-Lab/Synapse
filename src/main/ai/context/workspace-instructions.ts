import { promises as fs } from "node:fs"
import * as path from "node:path"

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

export async function loadWorkspaceInstructions(
  workspaces: Array<{ id: string; root: string }>,
  options: LoadWorkspaceInstructionsOptions = {}
): Promise<WorkspaceInstruction[]> {
  const maxPerFile = options.maxCharsPerFile ?? 8_000
  const maxTotal = options.maxTotalChars ?? 16_000
  const out: WorkspaceInstruction[] = []
  let total = 0

  for (const workspace of workspaces) {
    for (const fileName of INSTRUCTION_FILES) {
      if (total >= maxTotal) return out
      try {
        const raw = await fs.readFile(path.join(workspace.root, fileName), "utf-8")
        const trimmed = raw.trim()
        if (!trimmed) continue
        const remaining = maxTotal - total
        const bounded = trimmed.slice(0, Math.min(maxPerFile, remaining))
        if (!bounded) return out
        out.push({ workspaceId: workspace.id, fileName, text: bounded })
        total += bounded.length
      } catch {
        // Most workspaces do not define instruction files.
      }
    }
  }

  return out
}
