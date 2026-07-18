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

  it("round-trips backend descriptor and artifact id metadata (Task 18)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-exec-log-"))
    tempDirs.push(dir)
    const file = path.join(dir, "execution-log.json")
    const store = new ExecutionLogStore(file)
    await store.append({
      id: "e1",
      conversationId: "c1",
      toolName: "execution:core/run_command",
      decision: "allow",
      startedAt: 1,
      endedAt: 2,
      inputPreview: "echo hi",
      outputPreview: "",
      errorPreview: "",
      backendId: "local-policy",
      backendIsolation: "none",
      backendReplayGuarantee: "none",
      stdoutArtifactId: "artifact-stdout-1",
      stderrArtifactId: "artifact-stderr-1",
    })
    const [event] = await new ExecutionLogStore(file).list()
    expect(event).toMatchObject({
      backendId: "local-policy",
      backendIsolation: "none",
      backendReplayGuarantee: "none",
      stdoutArtifactId: "artifact-stdout-1",
      stderrArtifactId: "artifact-stderr-1",
    })
  })

  it("still loads legacy events written before the backend/artifact fields existed", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-exec-log-"))
    tempDirs.push(dir)
    const file = path.join(dir, "execution-log.json")
    // Simulate an on-disk file from before this task, with no knowledge of
    // the new optional fields.
    await fs.writeFile(
      file,
      `${JSON.stringify(
        [
          {
            id: "legacy-1",
            toolName: "execution:core/run_command",
            decision: "deny",
            startedAt: 1,
            endedAt: 2,
            inputPreview: "rm -rf /",
            outputPreview: "",
            errorPreview: "matches forbidden command policy",
          },
        ],
        null,
        2
      )}\n`
    )
    const [event] = await new ExecutionLogStore(file).list()
    expect(event.id).toBe("legacy-1")
    expect(event.backendId).toBeUndefined()
    expect(event.stdoutArtifactId).toBeUndefined()
  })
})
