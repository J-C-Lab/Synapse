import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ExecutionLogStore } from "./execution-log-store"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe("executionLogStore", () => {
  it("appends audit events and reloads them", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-exec-log-"))
    tempDirs.push(dir)
    const file = path.join(dir, "execution-log.json")
    const store = new ExecutionLogStore(file)
    await store.append({
      id: "e1",
      conversationId: "c1",
      toolName: "execution:repo/run_command",
      decision: "deny",
      startedAt: 1,
      endedAt: 2,
      inputPreview: "rm -rf /",
      outputPreview: "",
      errorPreview: "matches forbidden command policy",
    })
    await expect(new ExecutionLogStore(file).list()).resolves.toHaveLength(1)
  })
})
