import type { ToolResult } from "@synapse/plugin-sdk"
import type { WorkspacePolicy } from "./workspace-policy"
import { promises as fs } from "node:fs"
import * as path from "node:path"

const MAX_READ_BYTES = 128_000
const MAX_SEARCH_MATCHES = 100

export async function listFiles(policy: WorkspacePolicy, input: unknown): Promise<ToolResult> {
  const args = asRecord(input)
  const workspaceId = requireString(args.workspaceId, "workspaceId")
  const relativePath = typeof args.path === "string" ? args.path : "."
  const resolved = await policy.resolvePath(workspaceId, relativePath)
  const entries = await fs.readdir(resolved.absolutePath, { withFileTypes: true })
  const items = entries.map((entry) => ({
    name: entry.name,
    type: entry.isDirectory() ? "directory" : "file",
  }))
  return json({ path: resolved.relativePath, entries: items })
}

export async function readFile(policy: WorkspacePolicy, input: unknown): Promise<ToolResult> {
  const args = asRecord(input)
  const workspaceId = requireString(args.workspaceId, "workspaceId")
  const filePath = requireString(args.path, "path")
  const resolved = await policy.resolvePath(workspaceId, filePath)
  const buffer = await fs.readFile(resolved.absolutePath)
  const truncated = buffer.length > MAX_READ_BYTES
  const text = (truncated ? buffer.subarray(0, MAX_READ_BYTES) : buffer).toString("utf8")
  return json({
    path: resolved.relativePath,
    text,
    truncated,
    bytesRead: truncated ? MAX_READ_BYTES : buffer.length,
  })
}

export async function searchFiles(policy: WorkspacePolicy, input: unknown): Promise<ToolResult> {
  const args = asRecord(input)
  const workspaceId = requireString(args.workspaceId, "workspaceId")
  const query = requireString(args.query, "query")
  const searchPath = typeof args.path === "string" ? args.path : "."
  const resolved = await policy.resolvePath(workspaceId, searchPath)
  const matches: { path: string; line: number; text: string }[] = []
  await walk(resolved.absolutePath, resolved.root, async (absolute, relative) => {
    if (matches.length >= MAX_SEARCH_MATCHES) return
    const stat = await fs.stat(absolute)
    if (!stat.isFile() || stat.size > MAX_READ_BYTES) return
    const content = await fs.readFile(absolute, "utf8")
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      if (matches.length >= MAX_SEARCH_MATCHES) return
      if (line.includes(query)) {
        matches.push({ path: relative, line: index + 1, text: line.trim() })
      }
    }
  })
  return json({ query, matches, truncated: matches.length >= MAX_SEARCH_MATCHES })
}

async function walk(
  absolute: string,
  root: string,
  visit: (absolute: string, relative: string) => Promise<void>
): Promise<void> {
  const stat = await fs.stat(absolute)
  if (stat.isDirectory()) {
    const entries = await fs.readdir(absolute, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue
      const child = path.join(absolute, entry.name)
      const relative = path.relative(root, child).split(path.sep).join("/")
      if (entry.isDirectory()) await walk(child, root, visit)
      else await visit(child, relative)
    }
    return
  }
  const relative = path.relative(root, absolute).split(path.sep).join("/")
  await visit(absolute, relative)
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
