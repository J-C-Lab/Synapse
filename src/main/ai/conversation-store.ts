import type { ChatMessage } from "./providers/types"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { readJsonFile, writeJsonFile } from "../lan/atomic-json-store"

// Conversation persistence as plain JSON, one file per conversation (decision
// §11.1 — no native deps). Reuses the LAN atomic-json helpers for crash-safe
// writes. Summaries power a sidebar without loading every message.

export interface StoredConversation {
  id: string
  title?: string
  messages: ChatMessage[]
  createdAt: number
  updatedAt: number
}

export interface ConversationSummary {
  id: string
  title?: string
  updatedAt: number
}

export class ConversationStore {
  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now
  ) {}

  async get(id: string): Promise<StoredConversation | undefined> {
    const value = await readJsonFile(this.filePath(id))
    return normalizeConversation(value) ?? undefined
  }

  /** Create or replace a conversation, stamping `updatedAt`. */
  async save(conversation: StoredConversation): Promise<StoredConversation> {
    const next = { ...conversation, updatedAt: this.now() }
    await writeJsonFile(this.filePath(conversation.id), next)
    return next
  }

  async delete(id: string): Promise<void> {
    try {
      await fs.unlink(this.filePath(id))
    } catch (err) {
      if (!isFileNotFound(err)) throw err
    }
  }

  /** All conversations as summaries, newest first. */
  async list(): Promise<ConversationSummary[]> {
    let files: string[]
    try {
      files = await fs.readdir(this.dir)
    } catch (err) {
      if (isFileNotFound(err)) return []
      throw err
    }

    const summaries: ConversationSummary[] = []
    for (const file of files) {
      if (!file.endsWith(".json")) continue
      const conversation = normalizeConversation(await readJsonFile(path.join(this.dir, file)))
      if (conversation) {
        summaries.push({
          id: conversation.id,
          title: conversation.title,
          updatedAt: conversation.updatedAt,
        })
      }
    }
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  private filePath(id: string): string {
    return path.join(this.dir, `${safeId(id)}.json`)
  }
}

function safeId(id: string): string {
  if (!/^[\w-]{1,128}$/.test(id)) {
    throw new Error(`Invalid conversation id: ${id}`)
  }
  return id
}

function normalizeConversation(value: unknown): StoredConversation | null {
  if (!value || typeof value !== "object") return null
  const v = value as Record<string, unknown>
  if (typeof v.id !== "string" || !Array.isArray(v.messages)) return null
  return {
    id: v.id,
    title: typeof v.title === "string" ? v.title : undefined,
    messages: v.messages as ChatMessage[],
    createdAt: typeof v.createdAt === "number" ? v.createdAt : 0,
    updatedAt: typeof v.updatedAt === "number" ? v.updatedAt : 0,
  }
}

function isFileNotFound(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "ENOENT")
}
