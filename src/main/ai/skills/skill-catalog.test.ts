import type { SkillDescriptor } from "./skill-types"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  buildSkillCatalog,
  findNameConflicts,
  findSkillDescriptor,
  projectSkillCatalogForContext,
} from "./skill-catalog"
import { SkillPackageStore } from "./skill-package-store"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function writeSkill(root: string, dirName: string, name = dirName): Promise<void> {
  const dir = path.join(root, dirName)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: does ${name} things.\n---\nbody\n`,
    "utf-8"
  )
}

const ampleDisk = async () => ({
  freeBytes: 100 * 1024 * 1024 * 1024,
  totalBytes: 1024 * 1024 * 1024 * 1024,
})

function descriptor(overrides: Partial<SkillDescriptor> = {}): SkillDescriptor {
  return {
    id: "user:a",
    name: "a",
    description: "desc",
    source: "user",
    trust: "user-authored",
    sourceRef: "/tmp/a",
    contentHash: "0".repeat(64),
    packageRef: {
      uri: `skillpkg://sha256/${"1".repeat(64)}`,
      packageHash: "1".repeat(64),
      manifestHash: "2".repeat(64),
      capturedBytes: 10,
      fileCount: 1,
    },
    instructionsPath: "SKILL.md",
    ...overrides,
  }
}

describe("findNameConflicts", () => {
  it("returns no conflicts when every name is distinct", () => {
    const conflicts = findNameConflicts([
      descriptor({ id: "user:a", name: "a" }),
      descriptor({ id: "user:b", name: "b" }),
    ])
    expect(conflicts).toEqual([])
  })

  it("flags two descriptors sharing a frontmatter name from different sources", () => {
    const conflicts = findNameConflicts([
      descriptor({ id: "user:shared", name: "shared" }),
      descriptor({
        id: "workspace:shared",
        name: "shared",
        source: "workspace",
        trust: "workspace-content",
      }),
    ])
    expect(conflicts).toEqual([{ name: "shared", ids: ["user:shared", "workspace:shared"] }])
  })

  it("sorts conflicts by name and each conflict's ids", () => {
    const conflicts = findNameConflicts([
      descriptor({
        id: "workspace:zeta",
        name: "zeta",
        source: "workspace",
        trust: "workspace-content",
      }),
      descriptor({ id: "user:zeta", name: "zeta" }),
      descriptor({
        id: "workspace:alpha",
        name: "alpha",
        source: "workspace",
        trust: "workspace-content",
      }),
      descriptor({ id: "user:alpha", name: "alpha" }),
    ])
    expect(conflicts.map((c) => c.name)).toEqual(["alpha", "zeta"])
    expect(conflicts[0]!.ids).toEqual(["user:alpha", "workspace:alpha"])
  })

  it("does not flag the same id appearing twice as a conflict", () => {
    const same = descriptor({ id: "user:a", name: "a" })
    expect(findNameConflicts([same, same])).toEqual([])
  })
})

describe("projectSkillCatalogForContext", () => {
  it("projects only id, name, description, source, and trust", () => {
    const projected = projectSkillCatalogForContext([descriptor()])
    expect(projected).toEqual([
      { id: "user:a", name: "a", description: "desc", source: "user", trust: "user-authored" },
    ])
  })

  it("never includes packageRef, allowedTools, or instructionsPath", () => {
    const [entry] = projectSkillCatalogForContext([
      descriptor({ allowedTools: ["read_file"], compatibility: "synapse>=1" }),
    ])
    expect(entry).not.toHaveProperty("packageRef")
    expect(entry).not.toHaveProperty("allowedTools")
    expect(entry).not.toHaveProperty("instructionsPath")
    expect(entry).not.toHaveProperty("compatibility")
    expect(entry).not.toHaveProperty("contentHash")
  })

  it("sorts entries by id regardless of input order", () => {
    const projected = projectSkillCatalogForContext([
      descriptor({ id: "workspace:z" }),
      descriptor({ id: "user:a" }),
    ])
    expect(projected.map((e) => e.id)).toEqual(["user:a", "workspace:z"])
  })
})

describe("findSkillDescriptor", () => {
  it("finds a descriptor by id", () => {
    const list = [descriptor({ id: "user:a" }), descriptor({ id: "user:b" })]
    expect(findSkillDescriptor(list, "user:b")?.id).toBe("user:b")
  })

  it("returns undefined for an unknown id", () => {
    expect(findSkillDescriptor([descriptor()], "nope")).toBeUndefined()
  })
})

describe("buildSkillCatalog", () => {
  it("aggregates discovered descriptors and diagnostics, with conflicts across sources", async () => {
    const userRoot = await tempDir("synapse-skill-catalog-user-")
    const workspaceRoot = await tempDir("synapse-skill-catalog-workspace-")
    await writeSkill(userRoot, "shared-name")
    await writeSkill(workspaceRoot, "shared-name")
    await writeSkill(userRoot, "solo")
    const baseDir = await tempDir("synapse-skill-catalog-store-")
    const store = new SkillPackageStore(baseDir, { statDiskSpace: ampleDisk })

    const snapshot = await buildSkillCatalog(
      [
        { source: "user", rootDir: userRoot },
        { source: "workspace", rootDir: workspaceRoot },
      ],
      store
    )

    expect(snapshot.descriptors).toHaveLength(3)
    expect(snapshot.diagnostics).toEqual([])
    expect(snapshot.conflicts).toEqual([
      { name: "shared-name", ids: ["user:shared-name", "workspace:shared-name"] },
    ])
  })
})
