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
      const filePath = path.join(workspace.root, fileName)
      try {
        const raw = await fs.readFile(filePath, "utf-8")
        const trimmed = raw.trim()
        if (!trimmed) continue
        let bounded =
          trimmed.length > maxPerFile
            ? `${trimmed.slice(0, maxPerFile)}\n[Synapse truncated ${fileName}]`
            : trimmed
        if (total + bounded.length > maxTotal) {
          bounded = bounded.slice(0, Math.max(0, maxTotal - total))
          if (bounded) out.push({ workspaceId: workspace.id, fileName, text: bounded })
          return out
        }
        out.push({ workspaceId: workspace.id, fileName, text: bounded })
        total += bounded.length
      } catch {
        // Missing instruction files are expected for most workspaces.
      }
    }
  }

  return out
}
