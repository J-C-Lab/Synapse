import type { ToolResult } from "@synapse/plugin-sdk"
import type { WorkspacePolicy } from "./workspace-policy"
import { promises as fs } from "node:fs"

export async function applyPatch(policy: WorkspacePolicy, input: unknown): Promise<ToolResult> {
  const args = asRecord(input)
  const rootId = requireString(args.rootId, "rootId")
  const patch = requireString(args.patch, "patch")
  const hunks = parsePatch(patch)
  const touched: string[] = []

  for (const hunk of hunks) {
    const resolved = await policy.resolvePath(rootId, hunk.path)
    touched.push(resolved.relativePath)
    if (hunk.kind === "add") {
      await fs.mkdir(pathDir(resolved.absolutePath), { recursive: true })
      await fs.writeFile(resolved.absolutePath, hunk.content)
      continue
    }
    if (hunk.kind === "delete") {
      await fs.rm(resolved.absolutePath, { force: true })
      continue
    }
    const original = await fs.readFile(resolved.absolutePath, "utf8")
    const updated = applyUpdate(original, hunk.lines)
    await fs.writeFile(resolved.absolutePath, updated)
  }

  return json({ applied: true, files: touched })
}

type PatchHunk =
  | { kind: "add"; path: string; content: string }
  | { kind: "update"; path: string; lines: UpdateLine[] }
  | { kind: "delete"; path: string }

interface UpdateLine {
  type: "context" | "remove" | "add"
  text: string
}

function parsePatch(patch: string): PatchHunk[] {
  const lines = patch.replace(/\r\n/g, "\n").split("\n")
  if (!lines[0]?.startsWith("*** Begin Patch")) throw new Error("Invalid patch header")
  const hunks: PatchHunk[] = []
  let index = 1
  while (index < lines.length) {
    const line = lines[index]
    if (line === "*** End Patch") break
    if (line?.startsWith("*** Add File: ")) {
      const filePath = line.slice("*** Add File: ".length).trim()
      index += 1
      const contentLines: string[] = []
      while (index < lines.length && lines[index]?.startsWith("+")) {
        contentLines.push(lines[index]!.slice(1))
        index += 1
      }
      hunks.push({ kind: "add", path: filePath, content: contentLines.join("\n") })
      continue
    }
    if (line?.startsWith("*** Update File: ")) {
      const filePath = line.slice("*** Update File: ".length).trim()
      index += 1
      const updateLines: UpdateLine[] = []
      while (index < lines.length && !lines[index]?.startsWith("*** ")) {
        const current = lines[index]!
        if (current.startsWith("@@")) {
          index += 1
          continue
        }
        if (current.startsWith(" ")) updateLines.push({ type: "context", text: current.slice(1) })
        else if (current.startsWith("-"))
          updateLines.push({ type: "remove", text: current.slice(1) })
        else if (current.startsWith("+")) updateLines.push({ type: "add", text: current.slice(1) })
        else if (current.length > 0) throw new Error(`Invalid update line: ${current}`)
        index += 1
      }
      hunks.push({ kind: "update", path: filePath, lines: updateLines })
      continue
    }
    if (line?.startsWith("*** Delete File: ")) {
      hunks.push({ kind: "delete", path: line.slice("*** Delete File: ".length).trim() })
      index += 1
      continue
    }
    throw new Error(`Unknown patch section: ${line}`)
  }
  return hunks
}

function applyUpdate(original: string, lines: UpdateLine[]): string {
  const hadTrailingNewline = original.endsWith("\n")
  const source = original.replace(/\r\n/g, "\n").split("\n")
  if (source.length > 0 && source[source.length - 1] === "") source.pop()

  const anchor = lines.filter(
    (line): line is UpdateLine & { type: "context" | "remove" } =>
      line.type === "context" || line.type === "remove"
  )
  if (anchor.length === 0) {
    throw new Error("Patch update must include at least one context or remove line")
  }

  const start = findAnchorStart(source, anchor)
  let cursor = start
  const output = source.slice(0, start)

  for (const line of lines) {
    if (line.type === "context" || line.type === "remove") {
      const expected = line.text
      const actual = source[cursor]
      if (actual !== expected) {
        throw new Error(
          `Patch context mismatch at line ${cursor + 1}: expected ${JSON.stringify(expected)}`
        )
      }
      if (line.type === "context") output.push(actual)
      cursor += 1
      continue
    }
    output.push(line.text)
  }

  output.push(...source.slice(cursor))
  const joined = output.join("\n")
  return hadTrailingNewline ? `${joined}\n` : joined
}

function findAnchorStart(
  source: string[],
  anchor: Array<{ type: "context" | "remove"; text: string }>
): number {
  const needle = anchor.map((line) => line.text)
  for (let start = 0; start <= source.length - needle.length; start++) {
    let matches = true
    for (let index = 0; index < needle.length; index++) {
      if (source[start + index] !== needle[index]) {
        matches = false
        break
      }
    }
    if (matches) return start
  }
  throw new Error("Patch context not found in file")
}

function pathDir(filePath: string): string {
  const index = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"))
  return index >= 0 ? filePath.slice(0, index) : "."
}

function json(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${field}`)
  return value
}
