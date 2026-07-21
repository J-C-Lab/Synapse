import { Buffer } from "node:buffer"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { discoverSkills } from "./skill-discovery"
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

async function writeSkill(root: string, dirName: string, frontmatterExtra = ""): Promise<void> {
  const dir = path.join(root, dirName)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${dirName}\ndescription: does ${dirName} things.\n${frontmatterExtra}---\nbody\n`,
    "utf-8"
  )
}

const ampleDisk = async () => ({
  freeBytes: 100 * 1024 * 1024 * 1024,
  totalBytes: 1024 * 1024 * 1024 * 1024,
})

async function newStore(): Promise<SkillPackageStore> {
  const baseDir = await tempDir("synapse-skill-discovery-store-")
  return new SkillPackageStore(baseDir, { statDiskSpace: ampleDisk })
}

describe("discoverSkills", () => {
  it("discovers a skill from the user root with user-authored trust", async () => {
    const userRoot = await tempDir("synapse-skill-user-")
    await writeSkill(userRoot, "my-skill")
    const store = await newStore()

    const result = await discoverSkills([{ source: "user", rootDir: userRoot }], store)

    expect(result.diagnostics).toEqual([])
    expect(result.descriptors).toHaveLength(1)
    const descriptor = result.descriptors[0]!
    expect(descriptor.id).toBe("user:my-skill")
    expect(descriptor.name).toBe("my-skill")
    expect(descriptor.source).toBe("user")
    expect(descriptor.trust).toBe("user-authored")
    expect(descriptor.instructionsPath).toBe("SKILL.md")
    expect(descriptor.packageRef.fileCount).toBe(1)
  })

  it("discovers a skill from the workspace root with workspace-content trust", async () => {
    const workspaceRoot = await tempDir("synapse-skill-workspace-")
    await writeSkill(workspaceRoot, "repo-skill")
    const store = await newStore()

    const result = await discoverSkills([{ source: "workspace", rootDir: workspaceRoot }], store)

    expect(result.descriptors).toHaveLength(1)
    expect(result.descriptors[0]!.id).toBe("workspace:repo-skill")
    expect(result.descriptors[0]!.trust).toBe("workspace-content")
  })

  it("ingests the discovered package's bytes into the given store", async () => {
    const userRoot = await tempDir("synapse-skill-user-")
    await writeSkill(userRoot, "my-skill")
    const store = await newStore()

    const result = await discoverSkills([{ source: "user", rootDir: userRoot }], store)
    const descriptor = result.descriptors[0]!

    const bytes = await store.read(descriptor.packageRef.packageHash, "SKILL.md")
    expect(Buffer.from(bytes).toString("utf-8")).toContain("name: my-skill")
  })

  it("returns an empty result (no diagnostic) when a root does not exist yet", async () => {
    const store = await newStore()

    const result = await discoverSkills(
      [{ source: "user", rootDir: path.join(os.tmpdir(), "does-not-exist-synapse-skills") }],
      store
    )

    expect(result.descriptors).toEqual([])
    expect(result.diagnostics).toEqual([])
  })

  it("skips a plain file sitting at the root without a diagnostic", async () => {
    const userRoot = await tempDir("synapse-skill-user-")
    await fs.writeFile(path.join(userRoot, "notes.txt"), "not a skill", "utf-8")
    await writeSkill(userRoot, "my-skill")
    const store = await newStore()

    const result = await discoverSkills([{ source: "user", rootDir: userRoot }], store)

    expect(result.descriptors).toHaveLength(1)
    expect(result.diagnostics).toEqual([])
  })

  it("records a diagnostic for an invalid candidate but keeps discovering the rest", async () => {
    const userRoot = await tempDir("synapse-skill-user-")
    await fs.mkdir(path.join(userRoot, "broken-skill"), { recursive: true })
    await fs.writeFile(
      path.join(userRoot, "broken-skill", "README.md"),
      "no SKILL.md here",
      "utf-8"
    )
    await writeSkill(userRoot, "good-skill")
    const store = await newStore()

    const result = await discoverSkills([{ source: "user", rootDir: userRoot }], store)

    expect(result.descriptors).toHaveLength(1)
    expect(result.descriptors[0]!.id).toBe("user:good-skill")
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toMatchObject({
      source: "user",
      dirName: "broken-skill",
      reason: "missing_skill_md",
    })
  })

  it("records a diagnostic for a junction-linked candidate directory", async () => {
    const userRoot = await tempDir("synapse-skill-user-")
    const escapeTarget = await tempDir("synapse-skill-escape-target-")
    await writeSkill(escapeTarget, "not-really-here")
    await fs.symlink(
      path.join(escapeTarget, "not-really-here"),
      path.join(userRoot, "linked"),
      "junction"
    )
    const store = await newStore()

    const result = await discoverSkills([{ source: "user", rootDir: userRoot }], store)

    expect(result.descriptors).toEqual([])
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toMatchObject({
      dirName: "linked",
      reason: "symlink_not_allowed",
    })
  })

  it("assigns distinct ids to same-named skill directories from different sources", async () => {
    const userRoot = await tempDir("synapse-skill-user-")
    const workspaceRoot = await tempDir("synapse-skill-workspace-")
    await writeSkill(userRoot, "shared-name")
    await writeSkill(workspaceRoot, "shared-name")
    const store = await newStore()

    const result = await discoverSkills(
      [
        { source: "user", rootDir: userRoot },
        { source: "workspace", rootDir: workspaceRoot },
      ],
      store
    )

    expect(result.descriptors).toHaveLength(2)
    const ids = result.descriptors.map((d) => d.id).sort()
    expect(ids).toEqual(["user:shared-name", "workspace:shared-name"])
  })

  it("carries optional frontmatter fields through to the descriptor", async () => {
    const userRoot = await tempDir("synapse-skill-user-")
    await writeSkill(
      userRoot,
      "rich-skill",
      'version: 2.0.0\nallowed-tools:\n  - read_file\ncompatibility: "synapse>=1"\n'
    )
    const store = await newStore()

    const result = await discoverSkills([{ source: "user", rootDir: userRoot }], store)
    const descriptor = result.descriptors[0]!

    expect(descriptor.version).toBe("2.0.0")
    expect(descriptor.allowedTools).toEqual(["read_file"])
    expect(descriptor.compatibility).toBe("synapse>=1")
  })
})
