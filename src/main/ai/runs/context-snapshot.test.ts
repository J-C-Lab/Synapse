import type { WorkspaceRootRecord } from "../execution/types"
import type { FrozenSkillCatalogEntrySnapshot } from "../skills/skill-catalog"
import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  assembleFromContextSnapshot,
  buildContextSnapshot,
  CONTEXT_SNAPSHOT_MAX_AGGREGATE_BYTES,
  contextSnapshotIntegrityMatches,
  ContextSnapshotTooLargeError,
  skillCatalogHash,
} from "./context-snapshot"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function tempWorkspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-context-snapshot-"))
  tempDirs.push(root)
  return root
}

function workspaceRoot(id: string, root: string): WorkspaceRootRecord {
  return { id, workspaceId: id, name: id, root, role: "primary", createdAt: 0 }
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

describe("buildContextSnapshot", () => {
  it("freezes the base system prompt with its own sha256", async () => {
    const snapshot = await buildContextSnapshot({
      baseSystemText: "You are Synapse.",
      instructionWorkspaces: [],
    })
    expect(snapshot.schemaVersion).toBe(1)
    expect(snapshot.baseSystemPrompt.normalizedText).toBe("You are Synapse.")
    expect(snapshot.baseSystemPrompt.sha256).toBe(sha256("You are Synapse."))
    expect(snapshot.workspaceInstructions).toEqual([])
    expect(snapshot.skillCatalog).toEqual([])
    expect(snapshot.skillCatalogHash).toBe(skillCatalogHash([]))
  })

  it("captures a workspace instruction already wrapped in its untrusted envelope", async () => {
    const root = await tempWorkspace()
    await fs.writeFile(path.join(root, "AGENTS.md"), "Run tests before committing.\n", "utf-8")

    const snapshot = await buildContextSnapshot({
      baseSystemText: "base",
      instructionWorkspaces: [workspaceRoot("repo", root)],
    })

    expect(snapshot.workspaceInstructions).toHaveLength(1)
    const [entry] = snapshot.workspaceInstructions
    expect(entry?.rootId).toBe("repo")
    expect(entry?.sourcePath).toBe("workspace:repo/AGENTS.md")
    expect(entry?.sourceKind).toBe("workspace-instruction")
    expect(entry?.trust).toBe("untrusted-workspace-instruction")
    expect(entry?.normalizedText).toContain("<untrusted-")
    expect(entry?.normalizedText).toContain("Run tests before committing.")
    expect(entry?.sha256).toBe(sha256(entry!.normalizedText))
  })

  it("only reads instruction files from primary-role workspaces", async () => {
    const root = await tempWorkspace()
    await fs.writeFile(path.join(root, "AGENTS.md"), "should not load", "utf-8")

    const snapshot = await buildContextSnapshot({
      baseSystemText: "base",
      instructionWorkspaces: [{ ...workspaceRoot("repo", root), role: "additional" }],
    })

    expect(snapshot.workspaceInstructions).toEqual([])
  })

  it("changes the aggregateHash when instruction content changes", async () => {
    // Each build wraps instruction text in a fresh, randomly-nonced untrusted
    // envelope (labelUntrustedContent), so even two builds of *identical*
    // content are not expected to hash equal to each other — only a given
    // snapshot's own hash reflects its own content deterministically. What
    // must hold is that changed content is always detected.
    const root = await tempWorkspace()
    await fs.writeFile(path.join(root, "AGENTS.md"), "v1", "utf-8")
    const first = await buildContextSnapshot({
      baseSystemText: "base",
      instructionWorkspaces: [workspaceRoot("repo", root)],
    })
    expect(first.aggregateHash).toBe(
      sha256(
        [
          first.baseSystemPrompt.sha256,
          ...first.workspaceInstructions.map((e) => e.sha256),
          first.skillCatalogHash,
        ].join("|")
      )
    )

    await fs.writeFile(path.join(root, "AGENTS.md"), "v2", "utf-8")
    const second = await buildContextSnapshot({
      baseSystemText: "base",
      instructionWorkspaces: [workspaceRoot("repo", root)],
    })
    expect(second.aggregateHash).not.toBe(first.aggregateHash)
    expect(second.workspaceInstructions[0]?.normalizedText).toContain("v2")
    expect(second.workspaceInstructions[0]?.normalizedText).not.toContain("v1")
  })

  it("fails rather than truncates when the aggregate exceeds the v1 limit", async () => {
    await expect(
      buildContextSnapshot({
        baseSystemText: "x".repeat(CONTEXT_SNAPSHOT_MAX_AGGREGATE_BYTES + 1),
        instructionWorkspaces: [],
      })
    ).rejects.toThrow(ContextSnapshotTooLargeError)
  })

  it("freezes the projected skill catalog and folds its hash into aggregateHash", async () => {
    const skillCatalog: FrozenSkillCatalogEntrySnapshot[] = [
      { id: "user:a", name: "a", description: "does a", source: "user", trust: "user-authored" },
      {
        id: "workspace:b",
        name: "b",
        description: "does b",
        source: "workspace",
        trust: "workspace-content",
      },
    ]
    const snapshot = await buildContextSnapshot({
      baseSystemText: "base",
      instructionWorkspaces: [],
      skillCatalog,
    })

    expect(snapshot.skillCatalog).toEqual(skillCatalog)
    expect(snapshot.skillCatalogHash).toBe(skillCatalogHash(skillCatalog))
    expect(contextSnapshotIntegrityMatches(snapshot)).toBe(true)
  })

  it("sorts the frozen skill catalog by id regardless of input order", async () => {
    const snapshot = await buildContextSnapshot({
      baseSystemText: "base",
      instructionWorkspaces: [],
      skillCatalog: [
        {
          id: "workspace:z",
          name: "z",
          description: "z",
          source: "workspace",
          trust: "workspace-content",
        },
        { id: "user:a", name: "a", description: "a", source: "user", trust: "user-authored" },
      ],
    })

    expect(snapshot.skillCatalog.map((e) => e.id)).toEqual(["user:a", "workspace:z"])
  })

  it("changes aggregateHash when the skill catalog changes but instructions do not", async () => {
    const withoutSkills = await buildContextSnapshot({
      baseSystemText: "base",
      instructionWorkspaces: [],
    })
    const withSkills = await buildContextSnapshot({
      baseSystemText: "base",
      instructionWorkspaces: [],
      skillCatalog: [
        { id: "user:a", name: "a", description: "does a", source: "user", trust: "user-authored" },
      ],
    })

    expect(withSkills.aggregateHash).not.toBe(withoutSkills.aggregateHash)
  })

  it("counts the serialized skill catalog toward the v1 aggregate byte limit", async () => {
    const hugeCatalog: FrozenSkillCatalogEntrySnapshot[] = Array.from({ length: 1 }, (_, i) => ({
      id: `user:${i}`,
      name: `skill-${i}`,
      description: "x".repeat(CONTEXT_SNAPSHOT_MAX_AGGREGATE_BYTES + 1),
      source: "user" as const,
      trust: "user-authored" as const,
    }))

    await expect(
      buildContextSnapshot({
        baseSystemText: "base",
        instructionWorkspaces: [],
        skillCatalog: hugeCatalog,
      })
    ).rejects.toThrow(ContextSnapshotTooLargeError)
  })
})

describe("contextSnapshotIntegrityMatches", () => {
  it("detects tampering with a frozen skill catalog entry", async () => {
    const snapshot = await buildContextSnapshot({
      baseSystemText: "base",
      instructionWorkspaces: [],
      skillCatalog: [
        { id: "user:a", name: "a", description: "does a", source: "user", trust: "user-authored" },
      ],
    })
    const tampered = {
      ...snapshot,
      skillCatalog: [{ ...snapshot.skillCatalog[0]!, description: "tampered" }],
    }
    expect(contextSnapshotIntegrityMatches(tampered)).toBe(false)
  })
})

describe("assembleFromContextSnapshot", () => {
  it("rebuilds system text and joined instruction context strictly from the snapshot", async () => {
    const root = await tempWorkspace()
    await fs.writeFile(path.join(root, "AGENTS.md"), "Run tests before committing.\n", "utf-8")
    await fs.writeFile(path.join(root, "CLAUDE.md"), "Prefer small commits.\n", "utf-8")

    const snapshot = await buildContextSnapshot({
      baseSystemText: "base system text",
      instructionWorkspaces: [workspaceRoot("repo", root)],
    })
    const assembled = assembleFromContextSnapshot(snapshot)

    expect(assembled.system).toBe("base system text")
    expect(assembled.instructionContextText).toBe(
      snapshot.workspaceInstructions.map((entry) => entry.normalizedText).join("\n\n")
    )
  })

  it("stays byte-identical after the source files are edited, deleted, added, and reordered", async () => {
    const rootA = await tempWorkspace()
    const rootB = await tempWorkspace()
    await fs.writeFile(path.join(rootA, "AGENTS.md"), "original A", "utf-8")
    await fs.writeFile(path.join(rootB, "AGENTS.md"), "original B", "utf-8")

    const snapshot = await buildContextSnapshot({
      baseSystemText: "base",
      instructionWorkspaces: [workspaceRoot("a", rootA), workspaceRoot("b", rootB)],
    })
    const before = assembleFromContextSnapshot(snapshot)

    // Edit, delete/replace, add, and reorder the underlying workspace state —
    // none of this may affect a snapshot already taken.
    await fs.writeFile(path.join(rootA, "AGENTS.md"), "edited A", "utf-8")
    await fs.rm(path.join(rootB, "AGENTS.md"))
    await fs.writeFile(path.join(rootB, "CLAUDE.md"), "new file B", "utf-8")
    const rootC = await tempWorkspace()
    await fs.writeFile(path.join(rootC, "AGENTS.md"), "new root C", "utf-8")

    const after = assembleFromContextSnapshot(snapshot)
    expect(after).toEqual(before)

    // A fresh snapshot of the mutated/reordered state is provably different —
    // proving the "unchanged" result above isn't a no-op assertion.
    const rebuilt = await buildContextSnapshot({
      baseSystemText: "base",
      instructionWorkspaces: [
        workspaceRoot("b", rootB),
        workspaceRoot("a", rootA),
        workspaceRoot("c", rootC),
      ],
    })
    expect(rebuilt.aggregateHash).not.toBe(snapshot.aggregateHash)
  })
})
