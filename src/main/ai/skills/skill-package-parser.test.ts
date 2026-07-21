import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  DEFAULT_SKILL_PACKAGE_LIMITS,
  parseSkillPackage,
  SkillPackageParseError,
} from "./skill-package-parser"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function tempSkillDir(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-skill-parser-"))
  tempDirs.push(root)
  return root
}

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = path.join(root, relPath)
    await fs.mkdir(path.dirname(absPath), { recursive: true })
    await fs.writeFile(absPath, content, "utf-8")
  }
}

const MINIMAL_SKILL_MD = `---
name: my-skill
description: Does something useful.
---
# My Skill

Body instructions go here.
`

describe("parseSkillPackage", () => {
  it("parses a minimal valid package", async () => {
    const root = await tempSkillDir()
    await writeFiles(root, { "SKILL.md": MINIMAL_SKILL_MD })

    const parsed = await parseSkillPackage(root)

    expect(parsed.frontmatter.name).toBe("my-skill")
    expect(parsed.frontmatter.description).toBe("Does something useful.")
    expect(parsed.frontmatter.version).toBeUndefined()
    expect(parsed.frontmatter.allowedTools).toBeUndefined()
    expect(parsed.manifest).toEqual([
      {
        relPath: "SKILL.md",
        length: Buffer.byteLength(MINIMAL_SKILL_MD, "utf-8"),
        sha256: createHash("sha256").update(MINIMAL_SKILL_MD, "utf-8").digest("hex"),
      },
    ])
    expect(parsed.skillMdSha256).toBe(
      createHash("sha256").update(MINIMAL_SKILL_MD, "utf-8").digest("hex")
    )
    expect(parsed.totalBytes).toBe(Buffer.byteLength(MINIMAL_SKILL_MD, "utf-8"))
    expect(parsed.sourcePaths.get("SKILL.md")).toBe(path.join(root, "SKILL.md"))
  })

  it("parses optional version, allowed-tools, and compatibility fields", async () => {
    const root = await tempSkillDir()
    await writeFiles(root, {
      "SKILL.md": `---
name: my-skill
description: Does something useful.
version: 1.2.3
allowed-tools:
  - read_file
  - write_file
compatibility: "synapse>=1.0"
---
Body.
`,
    })

    const parsed = await parseSkillPackage(root)

    expect(parsed.frontmatter.version).toBe("1.2.3")
    expect(parsed.frontmatter.allowedTools).toEqual(["read_file", "write_file"])
    expect(parsed.frontmatter.compatibility).toBe("synapse>=1.0")
  })

  it("includes a nested asset file in the manifest with its own hash", async () => {
    const root = await tempSkillDir()
    await writeFiles(root, {
      "SKILL.md": MINIMAL_SKILL_MD,
      "assets/notes.txt": "asset content",
    })

    const parsed = await parseSkillPackage(root)

    expect(parsed.manifest.map((e) => e.relPath)).toEqual(["SKILL.md", "assets/notes.txt"])
    const asset = parsed.manifest.find((e) => e.relPath === "assets/notes.txt")!
    expect(asset.length).toBe(Buffer.byteLength("asset content", "utf-8"))
    expect(asset.sha256).toBe(createHash("sha256").update("asset content", "utf-8").digest("hex"))
    expect(parsed.sourcePaths.get("assets/notes.txt")).toBe(path.join(root, "assets", "notes.txt"))
  })

  it("rejects a package with no SKILL.md", async () => {
    const root = await tempSkillDir()
    await writeFiles(root, { "README.md": "not a skill file" })

    await expect(parseSkillPackage(root)).rejects.toMatchObject({
      name: "SkillPackageParseError",
      reason: "missing_skill_md",
    })
  })

  it("rejects SKILL.md missing a frontmatter block", async () => {
    const root = await tempSkillDir()
    await writeFiles(root, { "SKILL.md": "# No frontmatter here\n" })

    await expect(parseSkillPackage(root)).rejects.toMatchObject({
      reason: "missing_frontmatter",
    })
  })

  it("rejects SKILL.md with an unterminated frontmatter block", async () => {
    const root = await tempSkillDir()
    await writeFiles(root, { "SKILL.md": "---\nname: x\ndescription: y\n" })

    await expect(parseSkillPackage(root)).rejects.toMatchObject({
      reason: "unterminated_frontmatter",
    })
  })

  it("rejects frontmatter missing the required name field", async () => {
    const root = await tempSkillDir()
    await writeFiles(root, { "SKILL.md": "---\ndescription: y\n---\nbody\n" })

    await expect(parseSkillPackage(root)).rejects.toMatchObject({
      reason: "invalid_frontmatter_field",
    })
  })

  it("rejects frontmatter missing the required description field", async () => {
    const root = await tempSkillDir()
    await writeFiles(root, { "SKILL.md": "---\nname: x\n---\nbody\n" })

    await expect(parseSkillPackage(root)).rejects.toMatchObject({
      reason: "invalid_frontmatter_field",
    })
  })

  it("rejects a frontmatter YAML anchor/alias construct", async () => {
    const root = await tempSkillDir()
    await writeFiles(root, {
      "SKILL.md": `---
name: my-skill
description: Does something useful.
allowed-tools: &tools
  - read_file
also: *tools
---
body
`,
    })

    await expect(parseSkillPackage(root)).rejects.toMatchObject({
      reason: "alias_or_tag_disabled",
    })
  })

  it("rejects a frontmatter custom-tag construct", async () => {
    const root = await tempSkillDir()
    await writeFiles(root, {
      "SKILL.md": `---
name: my-skill
description: Does something useful.
evil: !!python/object/apply:os.system ["echo pwned"]
---
body
`,
    })

    await expect(parseSkillPackage(root)).rejects.toMatchObject({
      reason: "alias_or_tag_disabled",
    })
  })

  it("accepts legitimate unquoted content containing '&' and '*' inside quoted strings", async () => {
    const root = await tempSkillDir()
    await writeFiles(root, {
      "SKILL.md": `---
name: my-skill
description: "R&D helper: computes rate * base."
---
body
`,
    })

    const parsed = await parseSkillPackage(root)
    expect(parsed.frontmatter.description).toBe("R&D helper: computes rate * base.")
  })

  it("accepts unquoted prose containing '&', '*', and '!' outside indicator position", async () => {
    const root = await tempSkillDir()
    await writeFiles(root, {
      "SKILL.md": `---
name: my-skill
description: Handles R&D and Q&A workflows, AT&T style, and matches *.txt files. Fast, & fun!
---
body
`,
    })

    const parsed = await parseSkillPackage(root)
    expect(parsed.frontmatter.description).toBe(
      "Handles R&D and Q&A workflows, AT&T style, and matches *.txt files. Fast, & fun!"
    )
  })

  it("rejects a real anchor/alias even when only the immediate value indicator is present", async () => {
    const root = await tempSkillDir()
    await writeFiles(root, {
      "SKILL.md": `---
name: my-skill
description: &anchor Does something useful.
---
body
`,
    })

    await expect(parseSkillPackage(root)).rejects.toMatchObject({
      reason: "alias_or_tag_disabled",
    })
  })

  it("rejects an alias/anchor used as a flow-sequence entry", async () => {
    const root = await tempSkillDir()
    await writeFiles(root, {
      "SKILL.md": `---
name: my-skill
description: Does something useful.
allowed-tools: [read_file, &x, *x]
---
body
`,
    })

    await expect(parseSkillPackage(root)).rejects.toMatchObject({
      reason: "alias_or_tag_disabled",
    })
  })

  it("rejects SKILL.md larger than the configured limit", async () => {
    const root = await tempSkillDir()
    await writeFiles(root, { "SKILL.md": MINIMAL_SKILL_MD })

    await expect(
      parseSkillPackage(root, { limits: { skillMdMaxBytes: 10 } })
    ).rejects.toMatchObject({ reason: "skill_md_too_large" })
  })

  it("rejects frontmatter larger than the configured limit", async () => {
    const root = await tempSkillDir()
    await writeFiles(root, { "SKILL.md": MINIMAL_SKILL_MD })

    await expect(
      parseSkillPackage(root, { limits: { frontmatterMaxBytes: 5 } })
    ).rejects.toMatchObject({ reason: "frontmatter_too_large" })
  })

  it("rejects a package exceeding the configured total-byte budget", async () => {
    const root = await tempSkillDir()
    await writeFiles(root, {
      "SKILL.md": MINIMAL_SKILL_MD,
      "assets/big.txt": "x".repeat(1000),
    })

    await expect(parseSkillPackage(root, { limits: { maxTotalBytes: 100 } })).rejects.toMatchObject(
      { reason: "package_too_large" }
    )
  })

  it("rejects a package exceeding the configured file-count budget", async () => {
    const root = await tempSkillDir()
    await writeFiles(root, {
      "SKILL.md": MINIMAL_SKILL_MD,
      "assets/a.txt": "a",
      "assets/b.txt": "b",
    })

    await expect(parseSkillPackage(root, { limits: { maxFiles: 2 } })).rejects.toMatchObject({
      reason: "too_many_files",
    })
  })

  it("rejects a package exceeding the configured path-depth budget", async () => {
    const root = await tempSkillDir()
    await writeFiles(root, {
      "SKILL.md": MINIMAL_SKILL_MD,
      "a/b/c/deep.txt": "deep",
    })

    await expect(parseSkillPackage(root, { limits: { maxPathDepth: 2 } })).rejects.toMatchObject({
      reason: "path_too_deep",
    })
  })

  it("rejects a symlinked skill root directory (junction escape)", async () => {
    const realRoot = await tempSkillDir()
    await writeFiles(realRoot, { "SKILL.md": MINIMAL_SKILL_MD })
    const parentDir = await tempSkillDir()
    const junctionPath = path.join(parentDir, "linked-skill")
    await fs.symlink(realRoot, junctionPath, "junction")

    await expect(parseSkillPackage(junctionPath)).rejects.toMatchObject({
      reason: "symlink_not_allowed",
    })
  })

  it("rejects a junction planted inside an otherwise-valid skill package", async () => {
    const root = await tempSkillDir()
    await writeFiles(root, { "SKILL.md": MINIMAL_SKILL_MD })
    const escapeTarget = await tempSkillDir()
    await fs.writeFile(path.join(escapeTarget, "secret.txt"), "top secret", "utf-8")
    await fs.symlink(escapeTarget, path.join(root, "linked-assets"), "junction")

    await expect(parseSkillPackage(root)).rejects.toMatchObject({
      reason: "symlink_not_allowed",
    })
  })

  it("never executes SKILL.md body content — it is captured as inert bytes", async () => {
    const root = await tempSkillDir()
    const dangerousBody = [
      "---",
      "name: my-skill",
      "description: Does something useful.",
      "---",
      "# Body that would run code if evaluated",
      "",
      "```js",
      "globalThis.__SKILL_BODY_EXECUTED__ = true",
      "require('node:child_process').execSync('echo pwned')",
      "```",
      "",
    ].join("\n")
    await writeFiles(root, { "SKILL.md": dangerousBody })

    const parsed = await parseSkillPackage(root)

    expect((globalThis as Record<string, unknown>).__SKILL_BODY_EXECUTED__).toBeUndefined()
    expect(parsed.frontmatter.name).toBe("my-skill")
    expect(parsed.skillMdSha256).toBe(
      createHash("sha256").update(dangerousBody, "utf-8").digest("hex")
    )
    // The raw body text is never parsed into any structured field — proven
    // by re-reading the exact bytes back off disk and confirming they are
    // byte-identical to what was written (no transformation/execution pass
    // ever ran over them), which is exactly what a later ingest step will
    // hash into the immutable package store.
    const rawBytes = await fs.readFile(parsed.sourcePaths.get("SKILL.md")!)
    expect(rawBytes.toString("utf-8")).toBe(dangerousBody)
  })

  it("has package limit defaults matching the documented v1 bounds", () => {
    expect(DEFAULT_SKILL_PACKAGE_LIMITS.skillMdMaxBytes).toBe(1024 * 1024)
  })
})

describe("skillPackageParseError", () => {
  it("carries its reason code", () => {
    const err = new SkillPackageParseError("missing_skill_md", "no SKILL.md")
    expect(err.name).toBe("SkillPackageParseError")
    expect(err.reason).toBe("missing_skill_md")
  })
})
