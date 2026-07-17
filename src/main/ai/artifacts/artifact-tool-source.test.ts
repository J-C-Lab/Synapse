import type { ToolCaller } from "@synapse/plugin-sdk"
import type { AgentRunCheckpointV1 } from "../runs/checkpoint-schema"
import type { ArtifactOwnerContext } from "./artifact-types"
import { Buffer } from "node:buffer"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ArtifactStore } from "./artifact-store"
import {
  ARTIFACT_FQ_PREFIX,
  ArtifactToolSource,
  findArtifactRefInCheckpoint,
  MAX_ARTIFACT_READ_BYTES,
  parseArtifactUri,
  READ_ARTIFACT_FQ,
} from "./artifact-tool-source"
import { artifactUri } from "./artifact-types"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "synapse-artifact-tool-source-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const ampleDisk = async () => ({
  freeBytes: 100 * 1024 * 1024 * 1024,
  totalBytes: 1024 * 1024 * 1024 * 1024,
})

function makeStore(): ArtifactStore {
  return new ArtifactStore(dir, { statDiskSpace: ampleDisk })
}

function owner(overrides: Partial<ArtifactOwnerContext> = {}): ArtifactOwnerContext {
  return {
    runId: "run-1",
    rootRunId: "run-1",
    principal: { kind: "internal-agent" },
    ...overrides,
  }
}

function caller(overrides: Partial<ToolCaller> = {}): ToolCaller {
  return { kind: "agent", runId: "run-1", ...overrides }
}

/** A checkpoint fixture minimal enough for findArtifactRefInCheckpoint's own
 *  needs (only `messages` is read) — cast rather than filled out in full,
 *  matching this file's narrow concern (resolving a uri to a ref), not the
 *  full checkpoint shape tool-batch-runner.test.ts already covers. */
function fakeCheckpoint(
  toolResultBlocks: Array<{ toolUseId: string; artifact?: unknown }>
): AgentRunCheckpointV1 {
  return {
    messages: [
      {
        messageId: "carrier-1",
        message: {
          role: "user",
          content: toolResultBlocks.map((b) => ({
            type: "tool_result",
            toolUseId: b.toolUseId,
            content: "preview",
            isError: false,
            artifact: b.artifact,
          })),
        },
      },
    ],
  } as unknown as AgentRunCheckpointV1
}

function checkpointLookup(checkpoints: Record<string, AgentRunCheckpointV1 | undefined>) {
  return {
    loadCheckpoint: async (runId: string) => checkpoints[runId],
  }
}

describe("parseArtifactUri", () => {
  it("extracts runId/artifactId from a well-formed uri", () => {
    expect(parseArtifactUri("artifact://run/run-1/artifact-1")).toEqual({
      runId: "run-1",
      artifactId: "artifact-1",
    })
  })

  it("rejects a malformed uri", () => {
    expect(parseArtifactUri("not-a-uri")).toBeUndefined()
    expect(parseArtifactUri("artifact://run/run-1")).toBeUndefined()
    expect(parseArtifactUri("artifact://run/run-1/id/extra")).toBeUndefined()
  })
})

describe("artifactToolSource — ownsTool / listTools", () => {
  it("owns every artifact: fqName and lists exactly read_artifact, read-only", () => {
    const source = new ArtifactToolSource({
      store: makeStore(),
      checkpoints: checkpointLookup({}),
    })
    expect(source.ownsTool(READ_ARTIFACT_FQ)).toBe(true)
    expect(source.ownsTool("artifact:core/anything")).toBe(true)
    expect(source.ownsTool("execution:core/read_file")).toBe(false)
    expect(READ_ARTIFACT_FQ.startsWith(ARTIFACT_FQ_PREFIX)).toBe(true)

    const tools = source.listTools()
    expect(tools).toHaveLength(1)
    expect(tools[0]?.fqName).toBe(READ_ARTIFACT_FQ)
    expect(tools[0]?.provenance).toBe("host")
    expect(tools[0]?.manifestTool.annotations?.readOnlyHint).toBe(true)
  })
})

describe("read_artifact — successful reads", () => {
  it("reads a byte range back exactly and reports capture metadata", async () => {
    const store = makeStore()
    const text = "hello artifact world, this is captured content for testing byte ranges."
    const ref = await store.capture(
      new TextEncoder().encode(text),
      { runId: "run-1", owner: owner(), kind: "tool-result", mediaType: "text/plain" },
      { abort: () => {} }
    )
    const checkpoint = fakeCheckpoint([{ toolUseId: "t1", artifact: ref }])
    const source = new ArtifactToolSource({
      store,
      checkpoints: checkpointLookup({ "run-1": checkpoint }),
    })

    const result = await source.invokeTool(
      READ_ARTIFACT_FQ,
      { uri: ref.uri, start: 6, end: 14 },
      { caller: caller() }
    )

    expect(result.isError).toBeUndefined()
    const payload = JSON.parse((result.content[0] as { text: string }).text)
    expect(payload.uri).toBe(ref.uri)
    expect(payload.encoding).toBe("utf-8")
    expect(payload.content).toBe(text.slice(6, 14))
    expect(payload.capturedBytes).toBe(ref.capturedBytes)
    expect(payload.complete).toBe(true)
    expect(payload.rangeClamped).toBe(false)
  })

  it("defaults to a window from byte 0 bounded by MAX_ARTIFACT_READ_BYTES when start/end are omitted", async () => {
    const store = makeStore()
    const text = "y".repeat(500)
    const ref = await store.capture(
      new TextEncoder().encode(text),
      { runId: "run-1", owner: owner(), kind: "tool-result", mediaType: "text/plain" },
      { abort: () => {} }
    )
    const source = new ArtifactToolSource({
      store,
      checkpoints: checkpointLookup({
        "run-1": fakeCheckpoint([{ toolUseId: "t1", artifact: ref }]),
      }),
    })

    const result = await source.invokeTool(READ_ARTIFACT_FQ, { uri: ref.uri }, { caller: caller() })
    const payload = JSON.parse((result.content[0] as { text: string }).text)
    expect(payload.content).toBe(text)
    expect(payload.range).toEqual({ start: 0, end: 500 })
  })

  it("reads a requested line range and reports the scanned window", async () => {
    const store = makeStore()
    const text = ["line0", "line1", "line2", "line3", "line4"].join("\n")
    const ref = await store.capture(
      new TextEncoder().encode(text),
      { runId: "run-1", owner: owner(), kind: "tool-result", mediaType: "text/plain" },
      { abort: () => {} }
    )
    const source = new ArtifactToolSource({
      store,
      checkpoints: checkpointLookup({
        "run-1": fakeCheckpoint([{ toolUseId: "t1", artifact: ref }]),
      }),
    })

    const result = await source.invokeTool(
      READ_ARTIFACT_FQ,
      { uri: ref.uri, rangeKind: "lines", start: 1, end: 3 },
      { caller: caller() }
    )
    const payload = JSON.parse((result.content[0] as { text: string }).text)
    expect(payload.content).toBe("line1\nline2")
    expect(payload.lineStart).toBe(1)
    expect(payload.lineEnd).toBe(3)
    expect(payload.allBytesScanned).toBe(true)
  })
})

describe("read_artifact — binary content", () => {
  it("returns base64-encoded content for a non-text mediaType, round-tripping exactly", async () => {
    const store = makeStore()
    const bytes = new Uint8Array([0, 1, 2, 255, 254, 253, 10, 13, 0, 128])
    const ref = await store.capture(
      bytes,
      {
        runId: "run-1",
        owner: owner(),
        kind: "tool-result",
        mediaType: "application/octet-stream",
      },
      { abort: () => {} }
    )
    const source = new ArtifactToolSource({
      store,
      checkpoints: checkpointLookup({
        "run-1": fakeCheckpoint([{ toolUseId: "t1", artifact: ref }]),
      }),
    })

    const result = await source.invokeTool(READ_ARTIFACT_FQ, { uri: ref.uri }, { caller: caller() })
    const payload = JSON.parse((result.content[0] as { text: string }).text)
    expect(payload.encoding).toBe("base64")
    expect(Buffer.from(payload.content, "base64")).toEqual(Buffer.from(bytes))
  })
})

describe("read_artifact — range validation", () => {
  let ref: Awaited<ReturnType<ArtifactStore["capture"]>>
  let source: ArtifactToolSource

  beforeEach(async () => {
    const store = makeStore()
    ref = await store.capture(
      new TextEncoder().encode("z".repeat(1000)),
      { runId: "run-1", owner: owner(), kind: "tool-result", mediaType: "text/plain" },
      { abort: () => {} }
    )
    source = new ArtifactToolSource({
      store,
      checkpoints: checkpointLookup({
        "run-1": fakeCheckpoint([{ toolUseId: "t1", artifact: ref }]),
      }),
    })
  })

  it("rejects a start beyond the artifact's captured length", async () => {
    const result = await source.invokeTool(
      READ_ARTIFACT_FQ,
      { uri: ref.uri, start: 5000 },
      { caller: caller() }
    )
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toMatch(/range_invalid/)
  })

  it("rejects end <= start", async () => {
    const result = await source.invokeTool(
      READ_ARTIFACT_FQ,
      { uri: ref.uri, start: 10, end: 10 },
      { caller: caller() }
    )
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toMatch(/range_invalid/)
  })

  it("clamps an oversized requested end to the strict per-call cap and reports rangeClamped", async () => {
    const result = await source.invokeTool(
      READ_ARTIFACT_FQ,
      { uri: ref.uri, start: 0, end: MAX_ARTIFACT_READ_BYTES + 1000 },
      { caller: caller() }
    )
    const payload = JSON.parse((result.content[0] as { text: string }).text)
    expect(payload.rangeClamped).toBe(true)
    expect(payload.range.end - payload.range.start).toBeLessThanOrEqual(MAX_ARTIFACT_READ_BYTES)
  })

  it("rejects a malformed uri", async () => {
    const result = await source.invokeTool(
      READ_ARTIFACT_FQ,
      { uri: "not-a-uri" },
      { caller: caller() }
    )
    expect(result.isError).toBe(true)
  })

  it("rejects a uri with no known checkpoint entry as artifact_missing", async () => {
    const result = await source.invokeTool(
      READ_ARTIFACT_FQ,
      { uri: artifactUri("run-1", "never-captured") },
      { caller: caller() }
    )
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toMatch(/artifact_missing/)
  })

  it("requires an active run — rejects a caller with no runId", async () => {
    const result = await source.invokeTool(
      READ_ARTIFACT_FQ,
      { uri: ref.uri },
      { caller: { kind: "mcp" } }
    )
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toMatch(/requires an active run/)
  })
})

describe("read_artifact — access control", () => {
  it("rejects a forged/unrelated caller with artifact_forbidden", async () => {
    const store = makeStore()
    const ref = await store.capture(
      new TextEncoder().encode("secret content"),
      {
        runId: "victim-run",
        owner: owner({ runId: "victim-run", rootRunId: "victim-run" }),
        kind: "tool-result",
        mediaType: "text/plain",
      },
      { abort: () => {} }
    )
    const checkpoint = fakeCheckpoint([{ toolUseId: "t1", artifact: ref }])
    const source = new ArtifactToolSource({
      store,
      checkpoints: checkpointLookup({ "victim-run": checkpoint }),
    })

    // An unrelated run trying to read it — no parent/child edge, no
    // delegation — must be rejected by the store's own access check.
    const result = await source.invokeTool(
      READ_ARTIFACT_FQ,
      { uri: ref.uri },
      { caller: { kind: "agent", runId: "attacker-run" } }
    )
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toMatch(/artifact_forbidden/)
  })

  it("allows a direct parent to read a child's explicitly delegated artifact", async () => {
    const store = makeStore()
    const childOwner: ArtifactOwnerContext = {
      runId: "child-run",
      rootRunId: "parent-run",
      parentRunId: "parent-run",
      principal: { kind: "internal-agent" },
    }
    const ref = await store.capture(
      new TextEncoder().encode("child result content"),
      {
        runId: "child-run",
        owner: childOwner,
        kind: "tool-result",
        mediaType: "text/plain",
        delegateToRunIds: ["parent-run"],
      },
      { abort: () => {} }
    )
    const checkpoint = fakeCheckpoint([{ toolUseId: "t1", artifact: ref }])
    const source = new ArtifactToolSource({
      store,
      checkpoints: checkpointLookup({ "child-run": checkpoint }),
    })

    const result = await source.invokeTool(
      READ_ARTIFACT_FQ,
      { uri: ref.uri },
      // principal must agree with childOwner.principal — checkArtifactAccess
      // requires it once a cross-run parent/child edge (not a same-run
      // short-circuit) is what's granting access.
      { caller: { kind: "agent", runId: "parent-run", principal: { kind: "internal-agent" } } }
    )

    expect(result.isError).toBeUndefined()
    const payload = JSON.parse((result.content[0] as { text: string }).text)
    expect(payload.content).toBe("child result content")
  })

  it("still rejects a same-tree sibling that was never explicitly delegated to", async () => {
    const store = makeStore()
    const childOwner: ArtifactOwnerContext = {
      runId: "child-a",
      rootRunId: "parent-run",
      parentRunId: "parent-run",
      principal: { kind: "internal-agent" },
    }
    const ref = await store.capture(
      new TextEncoder().encode("child-a private content"),
      { runId: "child-a", owner: childOwner, kind: "tool-result", mediaType: "text/plain" },
      { abort: () => {} }
    )
    const source = new ArtifactToolSource({
      store,
      checkpoints: checkpointLookup({
        "child-a": fakeCheckpoint([{ toolUseId: "t1", artifact: ref }]),
      }),
    })

    const result = await source.invokeTool(
      READ_ARTIFACT_FQ,
      { uri: ref.uri },
      // A sibling, not the parent — same root, no direct edge.
      { caller: { kind: "agent", runId: "child-b", parentRunId: "parent-run" } }
    )
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toMatch(/artifact_forbidden/)
  })
})

describe("read_artifact — restart reads", () => {
  it("reads back correctly through a brand-new store + source instance pointed at the same directory", async () => {
    const firstStore = makeStore()
    const text = "content captured before the (simulated) restart"
    const ref = await firstStore.capture(
      new TextEncoder().encode(text),
      { runId: "run-1", owner: owner(), kind: "tool-result", mediaType: "text/plain" },
      { abort: () => {} }
    )
    const checkpoint = fakeCheckpoint([{ toolUseId: "t1", artifact: ref }])

    // Simulate a process restart: fresh ArtifactStore instance (no shared
    // in-memory state) over the same on-disk directory, fresh
    // ArtifactToolSource, checkpoint re-"loaded" from what was durably
    // persisted (a plain object here, exactly as a real AgentRunStore.load
    // would hand back after re-reading its JSON file).
    const restartedStore = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    const restartedSource = new ArtifactToolSource({
      store: restartedStore,
      checkpoints: checkpointLookup({ "run-1": checkpoint }),
    })

    const result = await restartedSource.invokeTool(
      READ_ARTIFACT_FQ,
      { uri: ref.uri },
      { caller: caller() }
    )
    expect(result.isError).toBeUndefined()
    const payload = JSON.parse((result.content[0] as { text: string }).text)
    expect(payload.content).toBe(text)
  })
})

describe("findArtifactRefInCheckpoint", () => {
  it("finds the ref by uri among multiple tool_result blocks", () => {
    const refA = { uri: artifactUri("run-1", "a"), kind: "tool-result" } as never
    const refB = { uri: artifactUri("run-1", "b"), kind: "tool-result" } as never
    const checkpoint = fakeCheckpoint([
      { toolUseId: "t1", artifact: refA },
      { toolUseId: "t2", artifact: refB },
    ])
    expect(findArtifactRefInCheckpoint(checkpoint, artifactUri("run-1", "b"))).toBe(refB)
  })

  it("returns undefined when no block carries a matching artifact", () => {
    const checkpoint = fakeCheckpoint([{ toolUseId: "t1" }])
    expect(findArtifactRefInCheckpoint(checkpoint, artifactUri("run-1", "x"))).toBeUndefined()
  })
})
