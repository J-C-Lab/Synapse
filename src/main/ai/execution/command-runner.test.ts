import type { CommandRunResult } from "./command-runner"
import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import process from "node:process"
import { afterEach, describe, expect, it } from "vitest"
import { DEFAULT_ARTIFACT_QUOTA_LIMITS } from "../artifacts/artifact-quota"
import { ArtifactStore } from "../artifacts/artifact-store"
import { runCommand } from "./command-runner"
import { WorkspacePolicy } from "./workspace-policy"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function makeWorkspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-cmd-"))
  tempDirs.push(root)
  return root
}

async function makeArtifactsDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-cmd-artifacts-"))
  tempDirs.push(dir)
  return dir
}

const ampleDisk = async () => ({
  freeBytes: 100 * 1024 * 1024 * 1024,
  totalBytes: 1024 * 1024 * 1024 * 1024,
})

function owner(runId = "run-1") {
  return { runId, rootRunId: runId, principal: { kind: "internal-agent" as const } }
}

async function writeScript(dir: string, name: string, source: string): Promise<string> {
  const file = path.join(dir, name)
  await fs.writeFile(file, source)
  return file
}

describe("runCommand — legacy in-memory path (no artifacts option)", () => {
  it("runs a simple command with exit code 0", async () => {
    const root = await makeWorkspace()
    const policy = new WorkspacePolicy([{ id: "repo", root }])
    const command = process.platform === "win32" ? "Write-Output ok" : "echo ok"
    const result = await runCommand(policy, { rootId: "repo", command })
    expect(result.exitCode).toBe(0)
    expect(result.legacyStdout).toContain("ok")
    expect(result.stdout).toBeUndefined()
  })

  it("returns non-zero exit codes", async () => {
    const root = await makeWorkspace()
    const policy = new WorkspacePolicy([{ id: "repo", root }])
    const command = process.platform === "win32" ? "exit 3" : "exit 3"
    const result = await runCommand(policy, { rootId: "repo", command, timeoutMs: 5_000 })
    expect(result.exitCode).not.toBe(0)
  })

  it("times out long-running commands", async () => {
    const root = await makeWorkspace()
    const policy = new WorkspacePolicy([{ id: "repo", root }])
    const command = process.platform === "win32" ? "Start-Sleep -Seconds 5" : "sleep 5"
    const result = await runCommand(policy, {
      rootId: "repo",
      command,
      timeoutMs: 200,
    })
    expect(result.timedOut).toBe(true)
  }, 15_000)

  it("cancels via AbortSignal", async () => {
    const root = await makeWorkspace()
    const policy = new WorkspacePolicy([{ id: "repo", root }])
    const controller = new AbortController()
    const command = process.platform === "win32" ? "ping -n 60 127.0.0.1 >nul" : "sleep 60"
    const pending = runCommand(
      policy,
      { rootId: "repo", command, timeoutMs: 60_000 },
      controller.signal
    )
    controller.abort()
    const result = await pending
    expect(result.cancelled).toBe(true)
  }, 15_000)
})

describe("runCommand — artifact-backed capture path", () => {
  it("captures stdout as a durable, complete artifact with bounded head/tail previews", async () => {
    const root = await makeWorkspace()
    const policy = new WorkspacePolicy([{ id: "repo", root }])
    const artifactsDir = await makeArtifactsDir()
    const store = new ArtifactStore(artifactsDir, { statDiskSpace: ampleDisk })
    const command = process.platform === "win32" ? "Write-Output ok" : "echo ok"

    const result = await runCommand(policy, {
      rootId: "repo",
      command,
      artifacts: { store, owner: owner() },
    })

    expect(result.exitCode).toBe(0)
    expect(result.legacyStdout).toBeUndefined()
    expect(result.stdout?.artifact.complete).toBe(true)
    expect(result.stdout?.artifact.truncationReason).toBeUndefined()
    expect(result.stdout?.headPreview).toContain("ok")
    expect(result.stdout?.tailPreview).toContain("ok")
    expect(result.stdout?.artifact.uri).toBe(
      `artifact://run/run-1/${result.stdout?.artifact.artifactId}`
    )
    expect(result.stderr?.artifact.complete).toBe(true)
  })

  it("captures output above the legacy preview cap but below artifact limits, and survives a store restart", async () => {
    const root = await makeWorkspace()
    const policy = new WorkspacePolicy([{ id: "repo", root }])
    const artifactsDir = await makeArtifactsDir()
    const store = new ArtifactStore(artifactsDir, { statDiskSpace: ampleDisk })
    const size = 40_000 // > legacy 32,000-char cap, << the 64 MiB artifact ceiling
    const command =
      process.platform === "win32"
        ? `Write-Output ('a' * ${size})`
        : `node -e "process.stdout.write('a'.repeat(${size}))"`

    const result = await runCommand(policy, {
      rootId: "repo",
      command,
      artifacts: { store, owner: owner() },
    })

    expect(result.stdout?.artifact.complete).toBe(true)
    expect(result.stdout?.artifact.capturedBytes).toBeGreaterThanOrEqual(size)

    // Simulate a full process restart: a fresh ArtifactStore instance
    // pointed at the same baseDir must still be able to read the complete
    // artifact back, byte-for-byte and hash-for-hash.
    const restarted = new ArtifactStore(artifactsDir, { statDiskSpace: ampleDisk })
    const ref = result.stdout!.artifact
    const bytes = await restarted.read(ref, { start: 0 }, { ...owner() })
    expect(bytes.length).toBe(ref.capturedBytes)
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(ref.sha256)
  })

  it("kills the entire process tree when stdout exceeds its artifact quota, without deadlocking stderr's undrained pipe", async () => {
    const root = await makeWorkspace()
    const policy = new WorkspacePolicy([{ id: "repo", root }])
    const artifactsDir = await makeArtifactsDir()
    // A generous-relative-to-the-writes-but-still-small ceiling: stdout
    // writes a single ~500KB burst (blows straight through it), while
    // stderr trickles a handful of bytes on an interval and can never,
    // even over its full bounded run, approach this ceiling on its own.
    const store = new ArtifactStore(artifactsDir, {
      statDiskSpace: ampleDisk,
      quotaLimits: { ...DEFAULT_ARTIFACT_QUOTA_LIMITS, perArtifactBytes: 200_000 },
    })
    const scriptDir = await makeArtifactsDir()
    const script = await writeScript(
      scriptDir,
      "burst.js",
      [
        "process.stdout.write('O'.repeat(500000))",
        "let n = 0",
        "const t = setInterval(() => {",
        "  process.stderr.write('E'.repeat(5))",
        "  n += 1",
        "  if (n > 2000) clearInterval(t)",
        "}, 5)",
      ].join("\n")
    )
    const command = `node "${script}"`

    const TIMEOUT_SENTINEL = Symbol("deadlock-sentinel")
    const race = await Promise.race([
      runCommand(policy, {
        rootId: "repo",
        command,
        timeoutMs: 15_000,
        artifacts: { store, owner: owner() },
      }),
      new Promise((resolve) => setTimeout(resolve, 5_000, TIMEOUT_SENTINEL)),
    ])

    // A real deadlock would have left this Promise.race hanging on the
    // sentinel instead of resolving via runCommand's own result — this is
    // an active proof of no-deadlock within a bounded window, not a
    // reliance on Vitest's own (much longer) test timeout as the only
    // safety net.
    expect(race).not.toBe(TIMEOUT_SENTINEL)
    const result = race as CommandRunResult

    expect(result.stdout?.artifact.complete).toBe(false)
    expect(["artifact-limit", "run-limit"]).toContain(result.stdout?.artifact.truncationReason)

    // The crux of the coordination fix: stderr never came close to its
    // own quota, yet it must NOT report complete: true — it was cut off
    // by its sibling's abort, not by exhausting its own source normally.
    expect(result.stderr?.artifact.complete).toBe(false)
    expect(result.stderr?.artifact.truncationReason).toBe("producer-aborted")
  }, 20_000)
})
