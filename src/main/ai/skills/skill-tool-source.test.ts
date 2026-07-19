import type { ToolCaller } from "@synapse/plugin-sdk"
import type { AgentRunCheckpointV1 } from "../runs/checkpoint-schema"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ArtifactStore } from "../artifacts/artifact-store"
import { AgentRunStore } from "../runs/agent-run-store"
import { sealCheckpointIntegrity } from "../runs/checkpoint-schema"
import { buildSkillCatalog } from "./skill-catalog"
import { SkillPackageLeaseStore } from "./skill-package-leases"
import { SkillPackageStore } from "./skill-package-store"
import { ACTIVATE_SKILL_FQ, LIST_SKILLS_FQ, SkillToolSource } from "./skill-tool-source"

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

async function writeSkill(root: string, dirName: string): Promise<void> {
  const dir = path.join(root, dirName)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${dirName}\ndescription: does ${dirName} things.\n---\nbody for ${dirName}\n`,
    "utf-8"
  )
}

function minimalCheckpoint(runId: string): AgentRunCheckpointV1 {
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
        tools: [],
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

async function newSource() {
  const dir = await tempDir("synapse-skill-tool-source-")
  const runStore = new AgentRunStore(path.join(dir, "runs"))
  const artifactStore = new ArtifactStore(path.join(dir, "artifacts"))
  const packageStore = new SkillPackageStore(path.join(dir, "skill-packages"), {
    statDiskSpace: ampleDisk,
  })
  const leaseStore = new SkillPackageLeaseStore(path.join(dir, "skill-package-leases.json"))
  const skillRoot = await tempDir("synapse-skill-tool-source-skills-")

  const source = new SkillToolSource({
    resolveCatalog: () => buildSkillCatalog([{ source: "user", rootDir: skillRoot }], packageStore),
    packageStore,
    leaseStore,
    artifactStore,
    runStore,
    now: () => 1000,
  })
  return { source, runStore, skillRoot, packageStore }
}

const caller = (runId: string): ToolCaller => ({ kind: "agent", runId })

describe("skillToolSource", () => {
  it("owns the skill: fqName prefix", async () => {
    const { source } = await newSource()
    expect(source.ownsTool(LIST_SKILLS_FQ)).toBe(true)
    expect(source.ownsTool(ACTIVATE_SKILL_FQ)).toBe(true)
    expect(source.ownsTool("execution:core/run_command")).toBe(false)
  })

  it("lists both tools with no declared capabilities and replayGuarantee none", async () => {
    const { source } = await newSource()
    const tools = source.listTools()
    expect(tools.map((t) => t.fqName).sort()).toEqual([ACTIVATE_SKILL_FQ, LIST_SKILLS_FQ].sort())
    for (const tool of tools) {
      expect(tool.replayGuarantee).toBe("none")
      expect(tool.manifestTool.capabilities).toEqual([])
    }
  })

  it("list_skills returns the bounded catalog projection", async () => {
    const { source, skillRoot } = await newSource()
    await writeSkill(skillRoot, "alpha")
    const result = await source.invokeTool(LIST_SKILLS_FQ, {}, { caller: caller("run-x") })
    expect(result.isError).toBeFalsy()
    const text = result.content[0]!.type === "text" ? result.content[0]!.text : ""
    const parsed = JSON.parse(text) as { skills: Array<{ id: string }> }
    expect(parsed.skills.map((s) => s.id)).toEqual(["user:alpha"])
  })

  it("activate_skill requires an active run", async () => {
    const { source } = await newSource()
    const result = await source.invokeTool(
      ACTIVATE_SKILL_FQ,
      { skillId: "user:alpha" },
      { caller: { kind: "user" } }
    )
    expect(result.isError).toBe(true)
  })

  it("activate_skill rejects an unknown skill id", async () => {
    const { source, runStore } = await newSource()
    const checkpoint = await runStore.create(minimalCheckpoint("run-1"))
    const result = await source.invokeTool(
      ACTIVATE_SKILL_FQ,
      { skillId: "user:does-not-exist" },
      { caller: caller(checkpoint.identity.runId) }
    )
    expect(result.isError).toBe(true)
  })

  it("activate_skill activates a real skill and commits it to the checkpoint", async () => {
    const { source, runStore, skillRoot } = await newSource()
    await writeSkill(skillRoot, "beta")
    const checkpoint = await runStore.create(minimalCheckpoint("run-2"))

    const result = await source.invokeTool(
      ACTIVATE_SKILL_FQ,
      { skillId: "user:beta" },
      { caller: caller(checkpoint.identity.runId) }
    )
    expect(result.isError).toBeFalsy()
    const text = result.content[0]!.type === "text" ? result.content[0]!.text : ""
    const parsed = JSON.parse(text) as { skillId: string; alreadyActive: boolean }
    expect(parsed.skillId).toBe("user:beta")
    expect(parsed.alreadyActive).toBe(false)

    const reloaded = await runStore.load(checkpoint.identity.runId)
    expect(reloaded.ok && reloaded.checkpoint.activatedSkills).toHaveLength(1)
  })

  it("activate_skill is a no-op the second time for the same skill", async () => {
    const { source, runStore, skillRoot } = await newSource()
    await writeSkill(skillRoot, "gamma")
    const checkpoint = await runStore.create(minimalCheckpoint("run-3"))
    const runId = checkpoint.identity.runId

    await source.invokeTool(ACTIVATE_SKILL_FQ, { skillId: "user:gamma" }, { caller: caller(runId) })
    const second = await source.invokeTool(
      ACTIVATE_SKILL_FQ,
      { skillId: "user:gamma" },
      { caller: caller(runId) }
    )
    const text = second.content[0]!.type === "text" ? second.content[0]!.text : ""
    const parsed = JSON.parse(text) as { alreadyActive: boolean }
    expect(parsed.alreadyActive).toBe(true)

    const reloaded = await runStore.load(runId)
    expect(reloaded.ok && reloaded.checkpoint.activatedSkills).toHaveLength(1)
  })
})
