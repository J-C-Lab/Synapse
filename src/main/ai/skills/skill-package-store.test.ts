import type { ParsedSkillPackage } from "./skill-package-parser"
import { Buffer } from "node:buffer"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { parseSkillPackage } from "./skill-package-parser"
import {
  computeSkillManifestHash,
  computeSkillPackageHash,
  SkillPackageQuotaExceededError,
  skillPackagesRoot,
  SkillPackageStore,
  SkillPackageStoreError,
} from "./skill-package-store"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = path.join(root, relPath)
    await fs.mkdir(path.dirname(absPath), { recursive: true })
    await fs.writeFile(absPath, content, "utf-8")
  }
}

const ampleDisk = async () => ({
  freeBytes: 100 * 1024 * 1024 * 1024,
  totalBytes: 1024 * 1024 * 1024 * 1024,
})

function skillMd(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`
}

async function parsedFixture(name = "my-skill", description = "desc"): Promise<ParsedSkillPackage> {
  const root = await tempDir("synapse-skill-fixture-")
  await writeFiles(root, { "SKILL.md": skillMd(name, description) })
  return parseSkillPackage(root)
}

describe("skillPackagesRoot", () => {
  it("nests under a 'skill-packages' directory of userDataDir", () => {
    expect(skillPackagesRoot("/tmp/user-data")).toBe(path.join("/tmp/user-data", "skill-packages"))
  })
})

describe("skillPackageStore.ingest", () => {
  it("ingests a package and returns a content-addressed ref", async () => {
    const baseDir = await tempDir("synapse-skill-store-")
    const store = new SkillPackageStore(baseDir, { statDiskSpace: ampleDisk })
    const parsed = await parsedFixture()

    const ref = await store.ingest(parsed)

    expect(ref.uri).toBe(`skillpkg://sha256/${ref.packageHash}`)
    expect(ref.packageHash).toMatch(/^[0-9a-f]{64}$/)
    expect(ref.manifestHash).toBe(
      computeSkillManifestHash({ schemaVersion: 1, entries: parsed.manifest })
    )
    expect(ref.packageHash).toBe(computeSkillPackageHash(ref.manifestHash))
    expect(ref.fileCount).toBe(1)
    expect(ref.capturedBytes).toBe(parsed.manifest[0]!.length)
  })

  it("stores bytes readable back out exactly via read()", async () => {
    const baseDir = await tempDir("synapse-skill-store-")
    const store = new SkillPackageStore(baseDir, { statDiskSpace: ampleDisk })
    const parsed = await parsedFixture("my-skill", "hello world")

    const ref = await store.ingest(parsed)
    const bytes = await store.read(ref.packageHash, "SKILL.md")

    expect(Buffer.from(bytes).toString("utf-8")).toBe(skillMd("my-skill", "hello world"))
  })

  it("is idempotent: re-ingesting identical content returns the same ref without erroring", async () => {
    const baseDir = await tempDir("synapse-skill-store-")
    const store = new SkillPackageStore(baseDir, { statDiskSpace: ampleDisk })
    const parsed = await parsedFixture()

    const first = await store.ingest(parsed)
    const second = await store.ingest(parsed)

    expect(second).toEqual(first)
  })

  it("produces a different packageHash for different content, and never mutates the earlier package", async () => {
    const baseDir = await tempDir("synapse-skill-store-")
    const store = new SkillPackageStore(baseDir, { statDiskSpace: ampleDisk })

    const root = await tempDir("synapse-skill-fixture-")
    await writeFiles(root, { "SKILL.md": skillMd("my-skill", "version one") })
    const firstParsed = await parseSkillPackage(root)
    const firstRef = await store.ingest(firstParsed)

    // Edit the source file "in place" and ingest again — matching the
    // design requirement that a source edit produces a new package hash
    // while the previous bytes stay readable and unchanged.
    await writeFiles(root, { "SKILL.md": skillMd("my-skill", "version two") })
    const secondParsed = await parseSkillPackage(root)
    const secondRef = await store.ingest(secondParsed)

    expect(secondRef.packageHash).not.toBe(firstRef.packageHash)

    const firstBytes = await store.read(firstRef.packageHash, "SKILL.md")
    expect(Buffer.from(firstBytes).toString("utf-8")).toBe(skillMd("my-skill", "version one"))
    const secondBytes = await store.read(secondRef.packageHash, "SKILL.md")
    expect(Buffer.from(secondBytes).toString("utf-8")).toBe(skillMd("my-skill", "version two"))
  })

  it("includes a nested asset file's bytes in the ingested payload", async () => {
    const baseDir = await tempDir("synapse-skill-store-")
    const store = new SkillPackageStore(baseDir, { statDiskSpace: ampleDisk })
    const root = await tempDir("synapse-skill-fixture-")
    await writeFiles(root, {
      "SKILL.md": skillMd("my-skill", "desc"),
      "assets/notes.txt": "asset bytes",
    })
    const parsed = await parseSkillPackage(root)

    const ref = await store.ingest(parsed)
    const assetBytes = await store.read(ref.packageHash, "assets/notes.txt")

    expect(Buffer.from(assetBytes).toString("utf-8")).toBe("asset bytes")
    expect(ref.fileCount).toBe(2)
  })

  it("rejects ingestion when the source bytes changed between validation and ingestion", async () => {
    const baseDir = await tempDir("synapse-skill-store-")
    const store = new SkillPackageStore(baseDir, { statDiskSpace: ampleDisk })
    const parsed = await parsedFixture()

    // Simulate a TOCTOU race: the manifest entry's recorded hash/length no
    // longer matches what is actually on disk at ingestion time.
    const tampered: ParsedSkillPackage = {
      ...parsed,
      manifest: parsed.manifest.map((entry) => ({ ...entry, sha256: "0".repeat(64) })),
    }

    await expect(store.ingest(tampered)).rejects.toThrow(SkillPackageStoreError)
  })

  it("rejects ingestion once the aggregate byte cap would be exceeded", async () => {
    const baseDir = await tempDir("synapse-skill-store-")
    const store = new SkillPackageStore(baseDir, {
      statDiskSpace: ampleDisk,
      maxAggregateBytes: 10,
    })
    const parsed = await parsedFixture()

    await expect(store.ingest(parsed)).rejects.toThrow(SkillPackageQuotaExceededError)
  })

  it("serializes concurrent ingests so the aggregate cap is never jointly exceeded", async () => {
    const baseDir = await tempDir("synapse-skill-store-")
    const rootA = await tempDir("synapse-skill-fixture-a-")
    const rootB = await tempDir("synapse-skill-fixture-b-")
    await writeFiles(rootA, { "SKILL.md": skillMd("skill-a", "desc") })
    await writeFiles(rootB, { "SKILL.md": skillMd("skill-b", "desc") })
    const parsedA = await parseSkillPackage(rootA)
    const parsedB = await parseSkillPackage(rootB)
    const sizeA = parsedA.manifest[0]!.length
    const sizeB = parsedB.manifest[0]!.length

    // The cap fits exactly one package but not both together — without an
    // in-process lock around check-then-write, two concurrent ingest()
    // calls could each see the (still-empty) aggregate total during their
    // own capacity check before either commits, letting both succeed and
    // jointly exceeding the cap.
    const store = new SkillPackageStore(baseDir, {
      statDiskSpace: ampleDisk,
      maxAggregateBytes: sizeA + sizeB - 1,
    })

    const [resultA, resultB] = await Promise.allSettled([
      store.ingest(parsedA),
      store.ingest(parsedB),
    ])

    const fulfilled = [resultA, resultB].filter((r) => r.status === "fulfilled")
    const rejected = [resultA, resultB].filter((r) => r.status === "rejected")
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      SkillPackageQuotaExceededError
    )
  })

  it("rejects ingestion when live disk headroom is below the reserve watermark", async () => {
    const baseDir = await tempDir("synapse-skill-store-")
    const store = new SkillPackageStore(baseDir, {
      statDiskSpace: async () => ({ freeBytes: 0, totalBytes: 1024 * 1024 * 1024 }),
    })
    const parsed = await parsedFixture()

    await expect(store.ingest(parsed)).rejects.toThrow(SkillPackageQuotaExceededError)
  })

  it("does not leave a staging directory behind after a failed ingest", async () => {
    const baseDir = await tempDir("synapse-skill-store-")
    const store = new SkillPackageStore(baseDir, {
      statDiskSpace: async () => ({ freeBytes: 0, totalBytes: 1024 * 1024 * 1024 }),
    })
    const parsed = await parsedFixture()

    await expect(store.ingest(parsed)).rejects.toThrow()

    const entries = await fs.readdir(baseDir).catch(() => [])
    expect(entries.filter((name) => name.startsWith(".tmp-"))).toEqual([])
  })
})

describe("skillPackageStore.reconcileStartup", () => {
  it("removes a leftover staging directory from a prior crashed ingest", async () => {
    const baseDir = await tempDir("synapse-skill-store-")
    await fs.mkdir(path.join(baseDir, ".tmp-crashed-ingest", "payload"), { recursive: true })
    await fs.writeFile(
      path.join(baseDir, ".tmp-crashed-ingest", "payload", "SKILL.md"),
      "x",
      "utf-8"
    )
    const store = new SkillPackageStore(baseDir, { statDiskSpace: ampleDisk })

    const result = await store.reconcileStartup()

    expect(result.removedStagingDirs).toBe(1)
    expect(await fs.readdir(baseDir)).toEqual([])
  })

  it("never removes a committed package directory", async () => {
    const baseDir = await tempDir("synapse-skill-store-")
    const store = new SkillPackageStore(baseDir, { statDiskSpace: ampleDisk })
    const parsed = await parsedFixture()
    const ref = await store.ingest(parsed)

    const result = await store.reconcileStartup()

    expect(result.removedStagingDirs).toBe(0)
    expect(await store.stat(ref.packageHash)).toEqual(ref)
  })

  it("returns zero when the base directory does not exist yet", async () => {
    const baseDir = path.join(os.tmpdir(), "synapse-skill-store-never-created")
    const store = new SkillPackageStore(baseDir, { statDiskSpace: ampleDisk })

    expect(await store.reconcileStartup()).toEqual({ removedStagingDirs: 0 })
  })
})

describe("skillPackageStore.stat", () => {
  it("returns undefined for an unknown package hash", async () => {
    const baseDir = await tempDir("synapse-skill-store-")
    const store = new SkillPackageStore(baseDir, { statDiskSpace: ampleDisk })

    expect(await store.stat("f".repeat(64))).toBeUndefined()
  })

  it("returns the ref for a known package hash", async () => {
    const baseDir = await tempDir("synapse-skill-store-")
    const store = new SkillPackageStore(baseDir, { statDiskSpace: ampleDisk })
    const parsed = await parsedFixture()
    const ref = await store.ingest(parsed)

    expect(await store.stat(ref.packageHash)).toEqual(ref)
  })
})

describe("skillPackageStore.read", () => {
  it("rejects an invalid package hash", async () => {
    const baseDir = await tempDir("synapse-skill-store-")
    const store = new SkillPackageStore(baseDir, { statDiskSpace: ampleDisk })

    await expect(store.read("not-a-hash", "SKILL.md")).rejects.toThrow(SkillPackageStoreError)
  })

  it("rejects an unknown file inside a valid package", async () => {
    const baseDir = await tempDir("synapse-skill-store-")
    const store = new SkillPackageStore(baseDir, { statDiskSpace: ampleDisk })
    const parsed = await parsedFixture()
    const ref = await store.ingest(parsed)

    await expect(store.read(ref.packageHash, "does-not-exist.txt")).rejects.toThrow(
      SkillPackageStoreError
    )
  })

  it("rejects a traversal attempt in the requested relative path", async () => {
    const baseDir = await tempDir("synapse-skill-store-")
    const store = new SkillPackageStore(baseDir, { statDiskSpace: ampleDisk })
    const parsed = await parsedFixture()
    const ref = await store.ingest(parsed)

    await expect(store.read(ref.packageHash, "../../etc/passwd")).rejects.toThrow()
  })
})
