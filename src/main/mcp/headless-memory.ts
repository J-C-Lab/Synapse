import { MemoryService } from "../ai/memory/memory-service"
import { aiMemoryFilePath, MemoryStore } from "../ai/memory/memory-store"
import { OpenAiEmbeddingProvider } from "../ai/memory/openai-embedding-provider"

// The headless MCP process cannot decrypt the interactive process's stored
// OpenAI key: `osSecretProtector()` (index.ts) wraps Electron's `safeStorage`,
// and stdio-entry.ts runs as ELECTRON_RUN_AS_NODE=1, under which
// `require("electron")` never yields the real module. So headless memory is
// lexical-only (BM25) by construction, not as an error fallback — this is
// the same no-key code path MemoryService already documents and handles.
export function createHeadlessMemoryService(userDataDir: string): MemoryService {
  return new MemoryService(
    new MemoryStore(aiMemoryFilePath(userDataDir)),
    new OpenAiEmbeddingProvider({ getApiKey: () => Promise.resolve(undefined) })
  )
}
