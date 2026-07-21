import type { ToolCaller } from "@synapse/plugin-sdk"
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
    const source = new ArtifactToolSource({ store: makeStore() })
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
    const source = new ArtifactToolSource({ store })

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
    const source = new ArtifactToolSource({ store })

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
    const source = new ArtifactToolSource({ store })

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

  it("resolves and reads a command-stdout-style artifact captured with no checkpoint involved (Task 18 interop)", async () => {
    // run_command (execution-tool-host.ts, Task 18) never touches
    // ChatContentBlock.tool_result.artifact — it embeds its stdout/stderr
    // artifact uris as plain JSON text inside its own bespoke payload. This
    // is exactly that shape: a raw store.capture() with kind
    // "command-stdout", nothing durably referencing it from any checkpoint
    // message. read_artifact must still be able to resolve and read it.
    const store = makeStore()
    const stdout = "$ pnpm build\n...\nbuild succeeded\n"
    const ref = await store.capture(
      new TextEncoder().encode(stdout),
      {
        runId: "run-1",
        owner: owner(),
        kind: "command-stdout",
        mediaType: "text/plain; charset=utf-8",
      },
      { abort: () => {} }
    )
    const source = new ArtifactToolSource({ store })

    const result = await source.invokeTool(READ_ARTIFACT_FQ, { uri: ref.uri }, { caller: caller() })

    expect(result.isError).toBeUndefined()
    const payload = JSON.parse((result.content[0] as { text: string }).text)
    expect(payload.kind).toBe("command-stdout")
    expect(payload.content).toBe(stdout)
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
    const source = new ArtifactToolSource({ store })

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
    source = new ArtifactToolSource({ store })
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

  it("rejects a uri with no captured artifact as artifact_missing", async () => {
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
  it("does not treat a subagent caller with an omitted principal as a later interactive turn", async () => {
    const store = makeStore()
    const ref = await store.capture(
      new TextEncoder().encode("child result"),
      {
        runId: "child-run",
        owner: {
          runId: "child-run",
          rootRunId: "old-root",
          parentRunId: "old-parent",
          conversationId: "conv-1",
          workspaceId: "ws-1",
          principal: { kind: "subagent", parentRunId: "old-parent" },
        },
        kind: "child-result",
        mediaType: "text/plain",
        delegateToConversationIds: ["conv-1"],
      },
      { abort: () => {} }
    )
    const result = await new ArtifactToolSource({ store }).invokeTool(
      READ_ARTIFACT_FQ,
      { uri: ref.uri },
      {
        caller: {
          kind: "subagent",
          runId: "sibling-run",
          parentRunId: "old-parent",
          conversationId: "conv-1",
          workspaceId: "ws-1",
        },
      }
    )
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toMatch(/artifact_forbidden/)
  })

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
    const source = new ArtifactToolSource({ store })

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
    const source = new ArtifactToolSource({ store })

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
    const source = new ArtifactToolSource({ store })

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

    // Simulate a process restart: fresh ArtifactStore instance (no shared
    // in-memory state) over the same on-disk directory, fresh
    // ArtifactToolSource. No checkpoint/message-history fixture is involved
    // at all — resolve() reads the manifest straight off disk by id.
    const restartedStore = new ArtifactStore(dir, { statDiskSpace: ampleDisk })
    const restartedSource = new ArtifactToolSource({ store: restartedStore })

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
