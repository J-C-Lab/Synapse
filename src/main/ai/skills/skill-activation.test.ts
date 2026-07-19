import type { FrozenToolAuthority } from "../runs/authority-snapshot"
import type { AgentRunCheckpointV1 } from "../runs/checkpoint-schema"
import type { SkillDescriptor } from "./skill-types"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ArtifactStore } from "../artifacts/artifact-store"
import { AgentRunStore } from "../runs/agent-run-store"
import { sealCheckpointIntegrity } from "../runs/checkpoint-schema"
import {
  activateSkill,
  activeSkillEffectiveToolNames,
  buildActiveSkillInstructionContextText,
  computeEffectiveToolNames,
  SkillActivationError,
} from "./skill-activation"
import { discoverSkills } from "./skill-discovery"
import { SkillPackageLeaseStore } from "./skill-package-leases"
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

const ampleDisk = async () => ({
  freeBytes: 100 * 1024 * 1024 * 1024,
  totalBytes: 1024 * 1024 * 1024 * 1024,
})

async function writeSkill(
  root: string,
  dirName: string,
  opts: { allowedTools?: string[] } = {}
): Promise<string> {
  const dir = path.join(root, dirName)
  await fs.mkdir(dir, { recursive: true })
  const allowedToolsYaml = opts.allowedTools
    ? `allowed-tools: [${opts.allowedTools.join(", ")}]\n`
    : ""
  const content =
    `---\nname: ${dirName}\ndescription: does ${dirName} things.\n${allowedToolsYaml}---\n` +
    `# ${dirName}\n\nDo the ${dirName} workflow.\n`
  await fs.writeFile(path.join(dir, "SKILL.md"), content, "utf-8")
  return content
}

function frozenTool(fqName: string, safeName: string): FrozenToolAuthority {
  return {
    fqName,
    safeName,
    provenance: "host",
    ownerId: "synapse-host",
    ownerVersion: "0.2.0",
    modelSchemaHash: `hash-${safeName}`,
    annotationsHash: "hash-ann",
    invocationAdapterId: "host-tool",
    invocationAdapterVersion: "1",
    replayGuarantee: "none",
  }
}

function minimalCheckpoint(runId: string, tools: FrozenToolAuthority[] = []): AgentRunCheckpointV1 {
  return sealCheckpointIntegrity({
    schemaVersion: 1,
    revision: 0,
    identity: { runId, rootRunId: runId, origin: "interactive" },
    status: "running",
    recovery: { kind: "automatic" },
    createdAt: 1,
    updatedAt: 1,
    config: {
      schemaVersion: 1,
      providerId: "fake",
      model: "fake-model",
      resolvedProfile: {
        profileId: "p1",
        providerId: "fake",
        modelPattern: "*",
        contextWindowTokens: 100_000,
        defaultMaxOutputTokens: 1024,
        supportsPromptCaching: false,
        supportsParallelToolCalls: false,
        supportsReasoningStream: false,
        tokenBudgeting: {
          upperBoundEstimatorId: "byte-upper-bound",
          upperBoundEstimatorVersion: "1",
          providerFramingReserveTokens: 10,
        },
        contextPolicy: {
          summarizeAtFraction: 0.75,
          keepRecentFraction: 0.5,
          hardReserveTokens: 100,
        },
      },
      maxOutputTokens: 256,
      maxSteps: 10,
      contextCompression: {
        enabled: false,
        thresholdTokens: 0,
        keepRecentFraction: 0.5,
        hardReserveTokens: 0,
      },
      workspaceBinding: { bindingRevision: 0, rootIds: [], rootSetHash: "h" },
      authority: {
        schemaVersion: 1,
        principal: { kind: "interactive", actor: "user" },
        capabilities: [],
        tools,
        integrityHash: "h",
      },
      context: {
        schemaVersion: 1,
        baseSystemPrompt: { normalizedText: "You are helpful.", sha256: "h" },
        workspaceInstructions: [],
        skillCatalog: [],
        skillCatalogHash: "h",
        aggregateHash: "h",
      },
    },
    messages: [
      { messageId: "m1", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
    ],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    nextStep: 0,
    modelSteps: [],
    toolBatches: [],
    activatedSkills: [],
  })
}

interface Harness {
  runStore: AgentRunStore
  artifactStore: ArtifactStore
  packageStore: SkillPackageStore
  leaseStore: SkillPackageLeaseStore
  now: () => number
  newId: () => string
}

async function newHarness(): Promise<Harness> {
  const dir = await tempDir("synapse-skill-activation-")
  const runStore = new AgentRunStore(path.join(dir, "runs"))
  const artifactStore = new ArtifactStore(path.join(dir, "artifacts"))
  const packageStore = new SkillPackageStore(path.join(dir, "skill-packages"), {
    statDiskSpace: ampleDisk,
  })
  const leaseStore = new SkillPackageLeaseStore(path.join(dir, "skill-package-leases.json"))
  let counter = 0
  return {
    runStore,
    artifactStore,
    packageStore,
    leaseStore,
    now: () => 1000,
    newId: () => `activation-${++counter}`,
  }
}

async function resolveDescriptor(
  h: Harness,
  root: string,
  dirName: string,
  source: "user" | "workspace" = "user"
): Promise<SkillDescriptor> {
  const result = await discoverSkills([{ source, rootDir: root }], h.packageStore)
  const descriptor = result.descriptors.find((d) => d.id === `${source}:${dirName}`)
  if (!descriptor) throw new Error(`fixture skill ${dirName} not discovered`)
  return descriptor
}

describe("activateSkill", () => {
  it("captures instructions, acquires a lease, and commits a narrowed activation", async () => {
    const h = await newHarness()
    const root = await tempDir("synapse-skill-src-")
    const content = await writeSkill(root, "my-skill", { allowedTools: ["tool_a"] })
    const descriptor = await resolveDescriptor(h, root, "my-skill")

    const tools = [
      frozenTool("execution:core/tool_a", "tool_a"),
      frozenTool("execution:core/tool_b", "tool_b"),
    ]
    const checkpoint = await h.runStore.create(minimalCheckpoint("run-1", tools))

    const result = await activateSkill(
      {
        packageStore: h.packageStore,
        leaseStore: h.leaseStore,
        artifactStore: h.artifactStore,
        runStore: h.runStore,
        now: h.now,
        newId: h.newId,
      },
      { runId: checkpoint.identity.runId, descriptor }
    )

    expect(result.kind).toBe("activated")
    expect(result.checkpoint.activatedSkills).toHaveLength(1)
    const activation = result.activation
    expect(activation.skillId).toBe("user:my-skill")
    expect(activation.packageHash).toBe(descriptor.packageRef.packageHash)
    expect(activation.trust).toBe("user-authored")
    expect(activation.effectiveToolNames).toEqual(["execution:core/tool_a"])
    expect(activation.instructionsArtifact.kind).toBe("skill-instructions")

    // Lease durably recorded.
    expect(await h.leaseStore.hasActiveLease(descriptor.packageRef.packageHash)).toBe(true)

    // Artifact durably captured with the exact original SKILL.md bytes.
    const text = await buildActiveSkillInstructionContextText(h.artifactStore, result.checkpoint)
    expect(text).toContain(content.trim().split("\n")[0])
    expect(text).toContain("Do the my-skill workflow.")
  })

  it("is idempotent when the same skillId is already active", async () => {
    const h = await newHarness()
    const root = await tempDir("synapse-skill-src-")
    await writeSkill(root, "dup-skill")
    const descriptor = await resolveDescriptor(h, root, "dup-skill")
    const checkpoint = await h.runStore.create(minimalCheckpoint("run-2"))

    const deps = {
      packageStore: h.packageStore,
      leaseStore: h.leaseStore,
      artifactStore: h.artifactStore,
      runStore: h.runStore,
      now: h.now,
      newId: h.newId,
    }
    const first = await activateSkill(deps, { runId: checkpoint.identity.runId, descriptor })
    expect(first.kind).toBe("activated")

    const second = await activateSkill(deps, { runId: checkpoint.identity.runId, descriptor })
    expect(second.kind).toBe("already-active")
    expect(second.activation.activationId).toBe(first.activation.activationId)
    expect(second.checkpoint.activatedSkills).toHaveLength(1)
  })

  it("never adds a tool that is not already run-visible even if allowedTools names it", async () => {
    const h = await newHarness()
    const root = await tempDir("synapse-skill-src-")
    await writeSkill(root, "wide-skill", { allowedTools: ["tool_not_visible", "tool_a"] })
    const descriptor = await resolveDescriptor(h, root, "wide-skill")
    const tools = [frozenTool("execution:core/tool_a", "tool_a")]
    const checkpoint = await h.runStore.create(minimalCheckpoint("run-3", tools))

    const result = await activateSkill(
      {
        packageStore: h.packageStore,
        leaseStore: h.leaseStore,
        artifactStore: h.artifactStore,
        runStore: h.runStore,
        now: h.now,
        newId: h.newId,
      },
      { runId: checkpoint.identity.runId, descriptor }
    )

    expect(result.kind).toBe("activated")
    expect(result.activation.effectiveToolNames).toEqual(["execution:core/tool_a"])
    expect(result.activation.effectiveToolNames).not.toContain("tool_not_visible")
  })

  it("releases the lease it just acquired when instructions capture fails", async () => {
    const h = await newHarness()
    const root = await tempDir("synapse-skill-src-")
    await writeSkill(root, "broken-skill")
    const descriptor = await resolveDescriptor(h, root, "broken-skill")
    const checkpoint = await h.runStore.create(minimalCheckpoint("run-4"))

    // Force capture to fail by using an artifact store that always throws.
    const failingArtifactStore = {
      ...h.artifactStore,
      capture: async () => {
        throw new Error("boom")
      },
    } as unknown as ArtifactStore

    await expect(
      activateSkill(
        {
          packageStore: h.packageStore,
          leaseStore: h.leaseStore,
          artifactStore: failingArtifactStore,
          runStore: h.runStore,
          now: h.now,
          newId: h.newId,
        },
        { runId: checkpoint.identity.runId, descriptor }
      )
    ).rejects.toThrow(SkillActivationError)

    expect(await h.leaseStore.hasActiveLease(descriptor.packageRef.packageHash)).toBe(false)
    const reloaded = await h.runStore.load(checkpoint.identity.runId)
    expect(reloaded.ok && reloaded.checkpoint.activatedSkills).toEqual([])
  })

  it("leaves a recovered run using the original frozen instructions after the source file changes", async () => {
    const h = await newHarness()
    const root = await tempDir("synapse-skill-src-")
    await writeSkill(root, "mutable-skill")
    const descriptor = await resolveDescriptor(h, root, "mutable-skill")
    const checkpoint = await h.runStore.create(minimalCheckpoint("run-5"))

    const result = await activateSkill(
      {
        packageStore: h.packageStore,
        leaseStore: h.leaseStore,
        artifactStore: h.artifactStore,
        runStore: h.runStore,
        now: h.now,
        newId: h.newId,
      },
      { runId: checkpoint.identity.runId, descriptor }
    )
    expect(result.kind).toBe("activated")

    const before = await buildActiveSkillInstructionContextText(h.artifactStore, result.checkpoint)

    // Edit, then delete, the original source SKILL.md after activation.
    await fs.writeFile(
      path.join(root, "mutable-skill", "SKILL.md"),
      "---\nname: mutable-skill\ndescription: edited.\n---\ncompletely different body\n",
      "utf-8"
    )
    await fs.rm(path.join(root, "mutable-skill"), { recursive: true, force: true })

    const after = await buildActiveSkillInstructionContextText(h.artifactStore, result.checkpoint)
    // The envelope's nonce is random per call (untrusted-content.ts), so
    // compare the underlying instruction body rather than the exact string.
    const stripNonce = (s: string) => s.replace(/untrusted-[0-9a-f]+/g, "untrusted-NONCE")
    expect(stripNonce(after)).toBe(stripNonce(before))
    expect(after).toContain("Do the mutable-skill workflow.")
    expect(after).not.toContain("completely different body")
  })
})

describe("computeEffectiveToolNames", () => {
  const tools = [
    frozenTool("execution:core/tool_a", "tool_a"),
    frozenTool("execution:core/tool_b", "tool_b"),
  ]

  it("returns every run-visible tool when allowedTools is absent", () => {
    expect(computeEffectiveToolNames(tools, undefined)).toEqual([
      "execution:core/tool_a",
      "execution:core/tool_b",
    ])
  })

  it("narrows to the intersection when allowedTools is present", () => {
    expect(computeEffectiveToolNames(tools, ["tool_a"])).toEqual(["execution:core/tool_a"])
  })

  it("matches by fqName as well as safeName", () => {
    expect(computeEffectiveToolNames(tools, ["execution:core/tool_b"])).toEqual([
      "execution:core/tool_b",
    ])
  })

  it("never adds a tool absent from the run-visible set", () => {
    expect(computeEffectiveToolNames(tools, ["tool_a", "tool_never_visible"])).toEqual([
      "execution:core/tool_a",
    ])
  })

  it("returns an empty list when allowedTools matches nothing visible", () => {
    expect(computeEffectiveToolNames(tools, ["tool_never_visible"])).toEqual([])
  })
})

describe("activeSkillEffectiveToolNames", () => {
  it("is undefined when no skill is active", () => {
    expect(activeSkillEffectiveToolNames([])).toBeUndefined()
  })

  it("unions effectiveToolNames across every active skill", () => {
    const union = activeSkillEffectiveToolNames([
      {
        activationId: "a1",
        skillId: "user:s1",
        packageHash: "h1",
        instructionsHash: "i1",
        trust: "user-authored",
        effectiveToolNames: ["tool_a"],
        packageLeaseId: "l1",
        instructionsArtifact: {
          uri: "artifact://run/r1/a1",
          kind: "skill-instructions",
          mediaType: "text/markdown",
          capturedBytes: 1,
          complete: true,
        },
        activatedAt: 1,
      },
      {
        activationId: "a2",
        skillId: "user:s2",
        packageHash: "h2",
        instructionsHash: "i2",
        trust: "user-authored",
        effectiveToolNames: ["tool_b"],
        packageLeaseId: "l2",
        instructionsArtifact: {
          uri: "artifact://run/r1/a2",
          kind: "skill-instructions",
          mediaType: "text/markdown",
          capturedBytes: 1,
          complete: true,
        },
        activatedAt: 2,
      },
    ])
    expect(union && [...union].sort()).toEqual(["tool_a", "tool_b"])
  })
})
