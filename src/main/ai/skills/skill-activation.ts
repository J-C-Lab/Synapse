import type { AgentArtifactStore, ArtifactCaller } from "../artifacts/artifact-types"
import type { EnvelopeTier } from "../guardrails/untrusted-content"
import type { AgentRunStore } from "../runs/agent-run-store"
import type { FrozenToolAuthority } from "../runs/authority-snapshot"
import type { AgentRunCheckpointV1, SkillActivationSnapshot } from "../runs/checkpoint-schema"
import type { SkillPackageLeaseStore } from "./skill-package-leases"
import type { SkillPackageStore } from "./skill-package-store"
import type { SkillDescriptor, SkillTrust } from "./skill-types"
import { createHash, randomUUID } from "node:crypto"
import { parseArtifactUri } from "../artifacts/artifact-tool-source"
import { toArtifactSummary } from "../artifacts/tool-result-capture"
import { deriveHistoryArtifactOwner } from "../context/history-artifact"
import { labelUntrustedContent } from "../guardrails/untrusted-content"

// Runtime activation of a discovered skill (Task 25, design §"Progressive
// disclosure"). Given a `SkillDescriptor` already resolved from the catalog
// (skill-tool-source.ts's job, not this module's — see skill-catalog.ts),
// this module: acquires a durable package lease, snapshots the exact
// SKILL.md bytes into a `skill-instructions` run artifact, computes a
// narrowed effective tool set, and durably records a `SkillActivationSnapshot`
// on the checkpoint — all BEFORE any instruction text or tool-visibility
// change ever reaches the model. Mirrors tool-result-capture.ts/
// history-artifact.ts's capture-before-checkpoint-commit ordering: a crash
// between the lease/artifact side effects and the checkpoint write merely
// orphans them (harmless — nothing in this checkpoint GCs on either yet),
// never the reverse (a checkpoint referencing bytes/a lease that were never
// actually captured/acquired).
//
// Recovery never re-reads this module: once `SkillActivationSnapshot` is
// checkpointed, every later model step (model-step-runner.ts's
// outgoingRequestContext) rebuilds instruction text solely from the frozen
// `instructionsArtifact` this module captured — never from the skill's
// current source file, even if it was edited or deleted after activation.

export class SkillActivationError extends Error {
  constructor(
    public readonly reason: string,
    message: string
  ) {
    super(message)
    this.name = "SkillActivationError"
  }
}

export interface ActivateSkillDeps {
  packageStore: SkillPackageStore
  leaseStore: SkillPackageLeaseStore
  artifactStore: AgentArtifactStore
  runStore: AgentRunStore
  now: () => number
  newId?: () => string
}

export interface ActivateSkillInput {
  runId: string
  descriptor: SkillDescriptor
}

export type ActivateSkillResult =
  | { kind: "activated"; activation: SkillActivationSnapshot; checkpoint: AgentRunCheckpointV1 }
  | {
      kind: "already-active"
      activation: SkillActivationSnapshot
      checkpoint: AgentRunCheckpointV1
    }

/**
 * Runs the whole activation sequence for one skill in one run. Fail-closed
 * throughout: any failure (lease, package read, artifact capture, checkpoint
 * write) throws `SkillActivationError` and leaves no partial trace reachable
 * from the checkpoint — a best-effort lease release is attempted on every
 * failure path after the lease was acquired, though it is not load-bearing
 * (an orphaned lease is harmless in v1; see skill-package-leases.ts).
 */
export async function activateSkill(
  deps: ActivateSkillDeps,
  input: ActivateSkillInput
): Promise<ActivateSkillResult> {
  const loaded = await deps.runStore.load(input.runId)
  if (!loaded.ok) {
    throw new SkillActivationError(
      "run-unavailable",
      `cannot activate skill for run ${input.runId}: checkpoint is ${loaded.reason}`
    )
  }
  const alreadyActive = loaded.checkpoint.activatedSkills.find(
    (a) => a.skillId === input.descriptor.id
  )
  if (alreadyActive) {
    return { kind: "already-active", activation: alreadyActive, checkpoint: loaded.checkpoint }
  }

  const activationId = deps.newId?.() ?? randomUUID()
  const packageHash = input.descriptor.packageRef.packageHash
  const now = deps.now()

  const lease = await deps.leaseStore.acquire({
    packageHash,
    runId: input.runId,
    activationId,
    now,
  })

  try {
    const bytes = await deps.packageStore.read(packageHash, input.descriptor.instructionsPath)
    const instructionsHash = createHash("sha256").update(bytes).digest("hex")

    const owner = deriveHistoryArtifactOwner(
      loaded.checkpoint.identity,
      loaded.checkpoint.config.authority.principal.actor
    )
    const ref = await deps.artifactStore.capture(
      bytes,
      {
        runId: input.runId,
        owner,
        kind: "skill-instructions",
        mediaType: "text/markdown; charset=utf-8",
        sourceBytes: bytes.byteLength,
      },
      // A plain in-memory Uint8Array capture has nothing live to cancel —
      // same rationale as tool-result-capture.ts/history-artifact.ts's
      // identical no-op abort.
      { abort: () => {} }
    )
    if (!ref.complete || ref.sourceBytes !== ref.capturedBytes) {
      throw new SkillActivationError(
        "instructions-capture-incomplete",
        `skill-instructions capture for skill ${input.descriptor.id} was incomplete or unverifiable`
      )
    }

    const effectiveToolNames = computeEffectiveToolNames(
      loaded.checkpoint.config.authority.tools,
      input.descriptor.allowedTools
    )

    const activation: SkillActivationSnapshot = {
      activationId,
      skillId: input.descriptor.id,
      packageHash,
      instructionsHash,
      trust: input.descriptor.trust,
      effectiveToolNames,
      packageLeaseId: lease.leaseId,
      instructionsArtifact: toArtifactSummary(ref),
      activatedAt: now,
    }

    const committed = await commitActivation(deps.runStore, input.runId, activation)
    return committed
  } catch (err) {
    // Best-effort: an orphaned lease is harmless in v1 (see
    // skill-package-leases.ts's top-of-file note) — never let a cleanup
    // failure mask the original activation error.
    await deps.leaseStore.release(lease.leaseId).catch(() => {})
    if (err instanceof SkillActivationError) throw err
    throw new SkillActivationError(
      "activation-failed",
      `failed to activate skill ${input.descriptor.id}: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/** Reloads fresh and commits — never reuses the revision the caller loaded
 *  earlier, since lease acquisition and artifact capture both did I/O in
 *  between (mirrors tool-batch-runner.ts's/run-finalizer.ts's
 *  mutateCheckpoint helper). Idempotent: if a concurrent call already added
 *  this exact skillId (only plausible via a retried invocation, since
 *  tool-batch-runner processes calls for one run strictly one at a time),
 *  the fresh entry is discarded rather than duplicated. */
async function commitActivation(
  runStore: AgentRunStore,
  runId: string,
  activation: SkillActivationSnapshot
): Promise<ActivateSkillResult> {
  const current = await runStore.load(runId)
  if (!current.ok) {
    throw new SkillActivationError(
      "run-unavailable",
      `cannot commit skill activation for run ${runId}: checkpoint is ${current.reason}`
    )
  }
  const existing = current.checkpoint.activatedSkills.find((a) => a.skillId === activation.skillId)
  if (existing) {
    return { kind: "already-active", activation: existing, checkpoint: current.checkpoint }
  }
  const checkpoint = await runStore.mutate(runId, current.checkpoint.revision, (cp) => ({
    ...cp,
    activatedSkills: [...cp.activatedSkills, activation],
    updatedAt: activation.activatedAt,
  }))
  return { kind: "activated", activation, checkpoint }
}

/**
 * `effective skill tools = run-visible tools ∩ skill.allowedTools ∩ caller
 * policy` (design §"Progressive disclosure"). `runVisibleTools` is already
 * `run-visible tools ∩ caller policy` — the run's frozen authority already
 * reflects whatever caller-specific restriction (e.g. a background trigger's
 * `allowedUses`) was in force at run creation, so intersecting with it here
 * is the entire formula. Absent `allowedTools` ⇒ no restriction (returns
 * every run-visible tool's fqName, unchanged). Matched against either a
 * tool's `fqName` or its `safeName` — a skill author may reasonably write
 * either — but the result can only ever be a subset of `runVisibleTools`:
 * an `allowedTools` entry naming a tool that isn't already run-visible is
 * silently dropped, never added.
 */
export function computeEffectiveToolNames(
  runVisibleTools: readonly FrozenToolAuthority[],
  allowedTools: readonly string[] | undefined
): string[] {
  // Only an OMITTED field means "no restriction" (design: "If allowedTools
  // is absent, activation does not change tool visibility"). An explicit
  // `allowed-tools: []` is a deliberately different, distinguishable input
  // — Task 24's frontmatter parser (optionalStringArray) already returns
  // `undefined` for an omitted field and `[]` for an explicitly empty one,
  // never collapsing the two — so a skill author who writes `allowed-tools:
  // []` to mean "this skill needs no additional tools" must get exactly
  // that (an empty effective set for its own contribution), never silently
  // upgraded to unrestricted access. Safe even as the sole active skill:
  // skill-tool-source.ts's SKILL_META_TOOL_FQ_NAMES exemption keeps
  // list_skills/activate_skill visible regardless, so the run is never
  // stranded.
  if (allowedTools === undefined) {
    return runVisibleTools.map((tool) => tool.fqName)
  }
  const allowedSet = new Set(allowedTools)
  return runVisibleTools
    .filter((tool) => allowedSet.has(tool.fqName) || allowedSet.has(tool.safeName))
    .map((tool) => tool.fqName)
}

/** The union of every currently-active skill's own (already narrowed-at-
 *  activation) effective tool set — `undefined` when no skill is active,
 *  meaning "no additional narrowing" rather than an empty set. Each
 *  activation's `effectiveToolNames` is itself already bounded to that
 *  run's visible tools (computeEffectiveToolNames above), so this union can
 *  never exceed the run's own frozen tool ceiling either — narrowing one
 *  active skill's restriction can only ever be relaxed by ANOTHER active
 *  skill that is itself narrower-or-equal to the run ceiling, never by
 *  anything wider than that ceiling. Consumed by model-step-runner.ts's
 *  frozenModelTools to further narrow what the model is offered per step. */
export function activeSkillEffectiveToolNames(
  activatedSkills: readonly SkillActivationSnapshot[]
): Set<string> | undefined {
  if (activatedSkills.length === 0) return undefined
  const union = new Set<string>()
  for (const activation of activatedSkills) {
    for (const name of activation.effectiveToolNames) union.add(name)
  }
  return union
}

/** Third-party/workspace skill text is never host-trusted (design
 *  §"Instruction precedence"): user-authored/built-in active skill guidance
 *  ranks just under a user request, so it gets the same unadorned "legacy"
 *  envelope workspace instructions already use; third-party/workspace-
 *  content skill guidance ranks below that (design: "third-party/workspace
 *  skill guidance") and gets the stronger reminder tool output uses (see
 *  agent-runtime.ts's envelopeTierForToolResult). `host` never occurs in
 *  v1 discovery (skill-discovery.ts only ever produces "user"/"workspace"
 *  sources) but is included for forward compatibility with the type union. */
function envelopeTierForSkillTrust(trust: SkillTrust): EnvelopeTier {
  return trust === "user-authored" || trust === "host" ? "legacy" : "strong"
}

/** Rebuilds the exact untrusted-context text every subsequent model request
 *  carries for the run's currently-active skills, sourced ENTIRELY from each
 *  activation's frozen `instructionsArtifact` — never the skill's current
 *  source file (design: "Recovery reads that run artifact ... it never
 *  rediscovers the current source file"). Returns "" when no skill is
 *  active, so a caller can unconditionally concatenate it with any other
 *  untrusted context text.
 *
 *  Called fresh on every `advanceModelStep` (activatedSkills is durable run
 *  state that accrues mid-run, not part of the frozen context snapshot —
 *  see model-step-runner.ts's ModelStepDeps.activeSkillInstructions), so the
 *  labeled text must be byte-identical across every call for the same
 *  activation, including after a crash-resume: `outgoingRequestContext`
 *  folds this text into `requestHash`, and a resumed call re-hashing a
 *  differently-labeled (but otherwise unchanged) skill text would trip
 *  callProviderAndStage's frozen-tool-catalog drift check
 *  (ToolCatalogDriftError) on a run where nothing actually changed. Each
 *  activation's own `activationId` — stable and durably persisted at
 *  activation time — seeds a deterministic nonce (labelUntrustedContent's
 *  `nonceSeed` option) instead of the default random one, so re-labeling the
 *  same frozen bytes always produces the same wrapped text. */
export async function buildActiveSkillInstructionContextText(
  artifactStore: AgentArtifactStore,
  checkpoint: AgentRunCheckpointV1
): Promise<string> {
  if (checkpoint.activatedSkills.length === 0) return ""
  const caller: ArtifactCaller = deriveHistoryArtifactOwner(
    checkpoint.identity,
    checkpoint.config.authority.principal.actor
  )
  const blocks: string[] = []
  for (const activation of checkpoint.activatedSkills) {
    const parsed = parseArtifactUri(activation.instructionsArtifact.uri)
    if (!parsed) {
      throw new SkillActivationError(
        "instructions-artifact-uri-invalid",
        `skill ${activation.skillId}'s activation references a malformed artifact uri`
      )
    }
    const ref = await artifactStore.resolve(parsed.runId, parsed.artifactId, caller)
    const bytes = await artifactStore.read(ref, { start: 0, end: ref.capturedBytes }, caller)
    const text = new TextDecoder("utf-8").decode(bytes)
    blocks.push(
      labelUntrustedContent(
        `skill:${activation.skillId}`,
        text,
        envelopeTierForSkillTrust(activation.trust),
        { nonceSeed: activation.activationId }
      )
    )
  }
  return blocks.join("\n\n")
}

/** Builds the `ModelStepDeps.activeSkillInstructions` accessor for a
 *  composition-root wiring site — `undefined` (never called) when no
 *  artifact store is wired, matching every other optional-artifact-backend
 *  convention in this codebase (e.g. durable-agent-driver.ts's own
 *  `artifactStore?`). */
export function activeSkillInstructionsReader(
  artifactStore: AgentArtifactStore | undefined
): ((checkpoint: AgentRunCheckpointV1) => Promise<string>) | undefined {
  if (!artifactStore) return undefined
  return (checkpoint) => buildActiveSkillInstructionContextText(artifactStore, checkpoint)
}
