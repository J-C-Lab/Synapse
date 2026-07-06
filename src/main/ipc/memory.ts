import type { IpcMain, IpcMainInvokeEvent } from "electron"
import type { IngestDocumentResult, MemoryService, MemorySource } from "../ai/memory/memory-service"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { logger } from "../logging"

// IPC surface for managing long-term memory from the renderer: import a document
// (chunked + embedded by MemoryService), list the imported documents, and delete
// an individual memory or a whole document. The agent still reaches memory
// through its tools (memory:*); this is the direct, user-driven management path.
// Embeddings never cross to the renderer — only the human-readable fields do.

export interface MemoryEntryView {
  id: string
  text: string
  tags: string[]
  createdAt: number
}

export interface RegisterMemoryIpcOptions {
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean
}

export function registerMemoryIpc(
  ipcMain: IpcMain,
  memory: MemoryService,
  options: RegisterMemoryIpcOptions
): void {
  const guard = (event: IpcMainInvokeEvent, channel: string): void => {
    if (options.isTrustedSender(event)) return
    logger.child("memory-ipc").warn("rejected untrusted sender", { channel })
    throw new Error("Untrusted IPC sender.")
  }

  ipcMain.handle("ai:memory:list", async (event): Promise<MemoryEntryView[]> => {
    guard(event, "ai:memory:list")
    const entries = await memory.list()
    return entries.map((entry) => ({
      id: entry.id,
      text: entry.text,
      tags: entry.tags,
      createdAt: entry.createdAt,
    }))
  })

  ipcMain.handle("ai:memory:sources", (event): Promise<MemorySource[]> => {
    guard(event, "ai:memory:sources")
    return memory.listSources()
  })

  ipcMain.handle("ai:memory:ingest", (event, payload: unknown): Promise<IngestDocumentResult> => {
    guard(event, "ai:memory:ingest")
    return memory.ingestDocument(coerceIngest(payload))
  })

  ipcMain.handle(
    "ai:memory:ingest-path",
    async (event, payload: unknown): Promise<IngestDocumentResult> => {
      guard(event, "ai:memory:ingest-path")
      const { source, filePath } = coerceIngestPath(payload)
      const text = await readFile(filePath, "utf8")
      return memory.ingestDocument({ source, text })
    }
  )

  ipcMain.handle("ai:memory:delete", (event, id: unknown): Promise<boolean> => {
    guard(event, "ai:memory:delete")
    return memory.delete(requireString(id, "id"))
  })

  ipcMain.handle("ai:memory:delete-source", (event, source: unknown): Promise<number> => {
    guard(event, "ai:memory:delete-source")
    return memory.deleteSource(requireString(source, "source"))
  })
}

export function coerceIngest(payload: unknown): { source: string; text: string } {
  if (!payload || typeof payload !== "object") throw new Error("ingest payload must be an object.")
  const v = payload as Record<string, unknown>
  return { source: requireString(v.source, "source"), text: requireString(v.text, "text") }
}

export function coerceIngestPath(payload: unknown): { source: string; filePath: string } {
  if (!payload || typeof payload !== "object")
    throw new Error("ingest-path payload must be an object.")
  const v = payload as Record<string, unknown>
  const filePath = requireString(v.filePath, "filePath")
  if (!path.isAbsolute(filePath)) throw new Error("filePath must be an absolute path.")
  return { source: requireString(v.source, "source"), filePath }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a string.`)
  return value
}
