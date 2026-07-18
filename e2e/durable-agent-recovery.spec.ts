import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { expect, test } from "@playwright/test"
import {
  assertNoShellDiagnostics,
  awaitShellReadiness,
  launchSynapseDevAtUserDir,
  removeVerifiedDirUnder,
} from "./electron-app-helpers"

// Checkpoint A crash matrix (Task 16), real-Electron-restart leg. Every other
// durable-recovery proof in this programme runs against an in-memory
// AgentRunStore/RootBudgetLedgerStore inside a Vitest process (Tasks 9-15) or
// spawns a bare Node child process directly against the driver
// (durable-run-restart.test.ts). This is the one that starts from the OTHER
// end: a checkpoint written to disk before the real, packaged-shape Electron
// app has ever run against this profile, proving the actual startup wiring
// (main/index.ts's AgentRunRecoveryService, the runs:listRecoverable /
// runs:resume / runs:abandon IPC handlers, and the renderer's run-observatory
// page) discovers and can act on it — not a mocked electron module, a real
// IPC round-trip.
//
// The first test proves the recovery-panel/control-plane leg. The companion
// test below proves the user-facing chat leg too: a seeded paused tool call
// hydrates from snapshot/event cursor after a real renderer reload without
// duplicating its tool card. Together they cover both halves of Task 16's
// Electron restart acceptance surface without a test-only IPC shortcut.

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

// Playwright does not resolve the main-process path aliases. This small
// fixture builder mirrors canonical-json.ts and sealCheckpointIntegrity().
function canonicalStringify(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number" || typeof value === "string") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`
  if (typeof value === "object" && value) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`)
      .join(",")}}`
  }
  throw new Error(`fixture canonical JSON cannot encode ${typeof value}`)
}

function canonicalHash(value: unknown): string {
  return sha256(`v1:${canonicalStringify(value)}`)
}

function sealFixtureCheckpoint(checkpoint: Record<string, unknown>): Record<string, unknown> {
  const config = checkpoint.config as Record<string, unknown>
  const authority = config.authority as Record<string, unknown>
  return {
    ...checkpoint,
    config: {
      ...config,
      authority: {
        ...authority,
        integrityHash: canonicalHash({
          schemaVersion: authority.schemaVersion,
          principal: authority.principal,
          capabilities: authority.capabilities,
          tools: authority.tools,
        }),
      },
    },
  }
}

/** A minimal, schema-valid AgentRunCheckpointV1 as raw JSON — deliberately
 *  NOT imported from src/main/ai/runs/checkpoint-schema.ts, since that module
 *  (like the rest of main) is reached through `@synapse/*` tsconfig path
 *  aliases that Playwright's own module resolution has no reason to know
 *  about. Mirrors the shape durable-run-child.ts's minimalCheckpoint()
 *  already proves the real store accepts. It is interactive deliberately:
 *  that is a real, source-complete automatic-recovery authority. A synthetic
 *  background run without its durable plugin/trigger identity must now block
 *  fail-closed, so using one here would test an invalid fixture rather than
 *  startup continuation. The context snapshot's hashes are real sha256 (not
 *  placeholders) because classifyRunRecovery re-derives them. */
function seedCheckpointJson(runId: string): Record<string, unknown> {
  const systemPromptText = "You are helpful."
  const baseSha = sha256(systemPromptText)
  return sealFixtureCheckpoint({
    schemaVersion: 1,
    revision: 1,
    identity: { runId, rootRunId: runId, origin: "interactive" },
    status: "waiting_approval",
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
      runBudgetTokens: 100_000,
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
        baseSystemPrompt: { normalizedText: systemPromptText, sha256: baseSha },
        workspaceInstructions: [],
        // Matches context-snapshot.ts's construction: sha256 of the joined
        // per-fragment hashes (no workspace instructions here, so it's just
        // the base prompt's own hash, re-hashed).
        aggregateHash: sha256(baseSha),
      },
    },
    messages: [
      { messageId: "u1", message: { role: "user", content: [{ type: "text", text: "go" }] } },
    ],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    nextStep: 1,
    modelSteps: [],
    toolBatches: [],
    activatedSkills: [],
  })
}

async function seedRun(userDir: string, runId: string): Promise<void> {
  const runDir = path.join(userDir, "ai", "runs", runId)
  await fs.mkdir(runDir, { recursive: true })
  await fs.writeFile(
    path.join(runDir, "checkpoint.json"),
    JSON.stringify(seedCheckpointJson(runId)),
    "utf-8"
  )
}

/** A paused interactive run whose tool outcome is deliberately unknown. Its
 * recovery disposition requires review, so startup must render it from the
 * durable checkpoint instead of attempting a provider call. This is the
 * deterministic real-Electron fixture for the chat reconnect path: no test
 * model or private IPC is involved. */
async function seedInteractiveToolRun(userDir: string, runId: string, conversationId: string) {
  const checkpoint = seedCheckpointJson(runId)
  checkpoint.identity = {
    runId,
    rootRunId: runId,
    origin: "interactive",
    conversationId,
    workspaceId: "default",
  }
  checkpoint.status = "suspended_unknown_tool_outcome"
  checkpoint.recovery = { kind: "requires_review", reason: "unknown-tool-outcome" }
  checkpoint.config = {
    ...(checkpoint.config as Record<string, unknown>),
    authority: {
      schemaVersion: 1,
      principal: { kind: "interactive", actor: "user" },
      capabilities: [],
      tools: [
        {
          fqName: "read_file",
          safeName: "read_file",
          provenance: "host",
          ownerId: "synapse-host",
          ownerVersion: "0.2.0",
          modelSchemaHash: canonicalHash({
            name: "read_file",
            description: "read_file",
            inputSchema: { type: "object" },
          }),
          annotationsHash: canonicalHash({}),
          invocationAdapterId: "host-tool",
          invocationAdapterVersion: "1",
          replayGuarantee: "none",
        },
      ],
      integrityHash: "",
    },
  }
  checkpoint.messages = [
    { messageId: "u1", message: { role: "user", content: [{ type: "text", text: "go" }] } },
    {
      messageId: "a1",
      message: { role: "assistant", content: [{ type: "text", text: "Reading" }] },
    },
  ]
  checkpoint.toolBatches = [
    {
      modelStep: 0,
      assistantMessageId: "a1",
      resultCarrierMessageId: "r1",
      calls: [
        {
          ordinal: 0,
          toolUseId: "tool-reconnect-1",
          safeName: "read_file",
          fqName: "read_file",
          input: {},
          annotations: {},
          replayGuarantee: "none",
          approval: { status: "resolved", allowed: true, remember: "once", resolvedAt: 1 },
          attempts: [
            {
              attemptId: "attempt-1",
              invocationId: "invoke-1",
              invocationFingerprint: "fingerprint-1",
              state: { status: "unknown", startedAt: 1, reason: "process-exit" },
            },
          ],
          resolution: { status: "unresolved" },
        },
      ],
    },
  ]

  const runDir = path.join(userDir, "ai", "runs", runId)
  await fs.mkdir(runDir, { recursive: true })
  await fs.writeFile(
    path.join(runDir, "checkpoint.json"),
    JSON.stringify(sealFixtureCheckpoint(checkpoint)),
    "utf-8"
  )

  const conversation = {
    schemaVersion: 2,
    id: conversationId,
    state: "active",
    recordRevision: 1,
    contentRevision: 0,
    deletionEpoch: 0,
    lastFencingToken: 0,
    title: "Recovery fixture",
    workspaceId: "default",
    messages: [],
    artifactUris: [],
    additionalArtifactUris: [],
    artifactIndexIntegrityHash: canonicalHash({
      artifactUris: [],
      derivedArtifactUris: [],
      additionalArtifactUris: [],
    }),
    artifactIndexVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  }
  const conversationsDir = path.join(userDir, "ai", "conversations")
  await fs.mkdir(conversationsDir, { recursive: true })
  await fs.writeFile(
    path.join(conversationsDir, `${conversationId}.json`),
    JSON.stringify(conversation),
    "utf-8"
  )
}

/** Checkpoint B artifact gate (Task 22). Seeds an artifact's manifest/data
 *  files directly under `<userDir>/artifacts/<runId>/<artifactId>/`,
 *  mirroring artifact-store.ts's exact on-disk layout (`manifest.json` +
 *  `data.bin`, envelopeVersion 1) byte-for-byte, and a conversation whose
 *  one message references that artifact's uri — the same
 *  bypass-the-real-store-code convention `seedRun`/`seedInteractiveToolRun`
 *  already use above (Playwright cannot resolve the `@synapse/*` main-process
 *  path aliases artifact-store.ts itself lives behind). Returns the seeded
 *  artifact's uri, content, and sha256 so the test can assert round-trip
 *  fidelity after a real Electron launch. */
async function seedReferencedArtifact(
  userDir: string,
  runId: string,
  artifactId: string,
  conversationId: string
): Promise<{ uri: string; content: string; sha256: string }> {
  const content = "Synapse e2e artifact recovery fixture: readable after a real restart.\n"
  const bytes = Buffer.from(content, "utf-8")
  const hash = sha256Bytes(bytes)
  const uri = `artifact://run/${runId}/${artifactId}`

  const artifactDir = path.join(userDir, "artifacts", runId, artifactId)
  await fs.mkdir(artifactDir, { recursive: true })
  await fs.writeFile(path.join(artifactDir, "data.bin"), bytes)
  const manifest = {
    envelopeVersion: 1,
    ref: {
      uri,
      runId,
      artifactId,
      kind: "tool-result",
      mediaType: "text/plain; charset=utf-8",
      capturedBytes: bytes.byteLength,
      complete: true,
      sha256: hash,
      createdAt: 1,
    },
    owner: {
      runId,
      rootRunId: runId,
      principal: { kind: "local-user" },
    },
    delegateToRunIds: [],
  }
  await fs.writeFile(path.join(artifactDir, "manifest.json"), JSON.stringify(manifest, null, 2))

  // A run whose artifact-store pin has already been released (terminal),
  // matching finalization's ordering rule ("release the run pin only after
  // conversation commit") — the strongest version of this proof: even a
  // terminal, pin-released run's artifact must survive real GC because the
  // conversation below still references it.
  const pinLedger = {
    schemaVersion: 1,
    releasedRuns: { [runId]: { finalizationId: "e2e-fin-1", releasedAt: 1 } },
  }
  await fs.writeFile(
    path.join(userDir, "artifacts", "run-pins.json"),
    JSON.stringify(pinLedger, null, 2)
  )

  const conversation = {
    schemaVersion: 2,
    id: conversationId,
    state: "active",
    recordRevision: 1,
    contentRevision: 1,
    deletionEpoch: 0,
    lastFencingToken: 0,
    title: "Artifact recovery fixture",
    workspaceId: "default",
    messages: [
      {
        messageId: "m1",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "t1",
              content: "preview",
              artifact: manifest.ref,
            },
          ],
        },
      },
    ],
    artifactUris: [uri],
    additionalArtifactUris: [],
    artifactIndexIntegrityHash: canonicalHash({
      artifactUris: [uri],
      derivedArtifactUris: [uri],
      additionalArtifactUris: [],
    }),
    artifactIndexVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  }
  const conversationsDir = path.join(userDir, "ai", "conversations")
  await fs.mkdir(conversationsDir, { recursive: true })
  await fs.writeFile(
    path.join(conversationsDir, `${conversationId}.json`),
    JSON.stringify(conversation),
    "utf-8"
  )

  return { uri, content, sha256: hash }
}

test("renderer discovers a run interrupted before this launch and resumes/abandons it via real IPC", async () => {
  const userDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-e2e-recovery-"))
  const resumeRunId = "e2e-recoverable-resume"
  const abandonRunId = "e2e-recoverable-abandon"

  try {
    await seedRun(userDir, resumeRunId)
    await seedRun(userDir, abandonRunId)

    const launched = await launchSynapseDevAtUserDir(userDir)
    try {
      const { shell } = await awaitShellReadiness(launched, { mode: "dev" })

      await shell.evaluate(() => {
        window.location.hash = "#/runs"
      })

      const panel = shell.getByTestId("recoverable-runs-panel")
      await panel.waitFor()
      await expect(panel).toContainText(resumeRunId)
      await expect(panel).toContainText(abandonRunId)
      // Startup recovery is now origin-aware: automatic runs are durably
      // reclassified, transitioned to running, and handed to the real
      // continuator before the renderer reaches this panel.
      await expect(panel).toContainText("running")

      const resumeRow = panel.locator("li", { hasText: resumeRunId })
      const abandonRow = panel.locator("li", { hasText: abandonRunId })

      // Resume is still a real IPC round-trip. It is idempotent for a run
      // startup already transitioned to running; the row remains a
      // non-terminal durable record while its continuation is in flight.
      await resumeRow.getByRole("button").first().click()
      await expect(resumeRow).toContainText("running")

      // Abandon: a real runs:abandon IPC round-trip through
      // AgentRunRecoveryService.abandon(), reusing the full six-phase
      // finalizeRun protocol with desiredStatus "cancelled" — the row must
      // disappear entirely once finalization completes.
      await abandonRow.getByRole("button").last().click()
      await expect(panel).not.toContainText(abandonRunId)

      await assertNoShellDiagnostics(launched, shell)

      // Confirm the mutations are durably on disk, not just optimistic
      // renderer state — the whole point of proving this through a real
      // process restart rather than a mocked electron module.
      const resumedOnDisk = JSON.parse(
        await fs.readFile(path.join(userDir, "ai", "runs", resumeRunId, "checkpoint.json"), "utf-8")
      ) as { status: string }
      expect(resumedOnDisk.status).toBe("running")

      const abandonedOnDisk = JSON.parse(
        await fs.readFile(
          path.join(userDir, "ai", "runs", abandonRunId, "checkpoint.json"),
          "utf-8"
        )
      ) as { status: string; finalization?: { phase?: string } }
      expect(abandonedOnDisk.status).toBe("cancelled")
      expect(abandonedOnDisk.finalization?.phase).toBe("complete")
    } finally {
      await launched.dispose()
    }
  } finally {
    removeVerifiedDirUnder(os.tmpdir(), userDir)
  }
})

test("durable agent recovery reconnects one tool card after a real renderer restart", async () => {
  const userDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-e2e-reconnect-"))
  const runId = "e2e-chat-reconnect"
  const conversationId = "e2e-conversation-reconnect"

  try {
    await seedInteractiveToolRun(userDir, runId, conversationId)
    const launched = await launchSynapseDevAtUserDir(userDir)
    try {
      const { shell } = await awaitShellReadiness(launched, { mode: "dev" })
      // This is the normal user-facing preload API, used only to let the
      // already-seeded paused run reach the chat UI rather than onboarding.
      await shell.evaluate(() => window.electronAPI.setAiKey("anthropic", "e2e-placeholder-key"))
      await shell.reload()
      await shell.getByText("Cortex", { exact: true }).first().click()
      await shell.getByRole("button", { name: "Recovery fixture" }).click()

      await expect(shell.getByText("read_file", { exact: true })).toHaveCount(1)

      // Reloading the actual renderer repeats snapshot + persisted event
      // cursor setup. The card must be recovered again, not appended beside
      // its old projection or a duplicate legacy-event projection.
      await shell.reload()
      await shell.getByText("Cortex", { exact: true }).first().click()
      await shell.getByRole("button", { name: "Recovery fixture" }).click()
      await expect(shell.getByText("read_file", { exact: true })).toHaveCount(1)
      await assertNoShellDiagnostics(launched, shell)
    } finally {
      await launched.dispose()
    }
  } finally {
    removeVerifiedDirUnder(os.tmpdir(), userDir)
  }
})

// Checkpoint B artifact gate (Task 22), real-Electron-restart leg. Every
// other artifact crash/restart proof in this programme (artifact-pressure
// .test.ts, artifact-retention.test.ts) runs against real ArtifactStore/
// ConversationStore instances inside a Vitest process. This is the one that
// starts from the OTHER end, exactly like the two tests above did for
// Checkpoint A's run/conversation stores: artifact bytes and a manifest
// written to disk as if by a PRIOR process, before the real, unpacked
// Electron app's first launch against that profile — proving the actual
// production wiring (src/main/index.ts's module-scope ArtifactStore backed
// by ConversationStore.collectReferencedArtifactUris, and the
// runs:getArtifactStatus / runs:readArtifactPreview /
// runs:collectArtifactGarbage IPC handlers) discovers, reads, and safely
// garbage-collects around it — not a mocked electron module, a real IPC
// round-trip.
test("a conversation-referenced artifact survives a real Electron restart and is read/GC-safe (artifact recovery)", async () => {
  const userDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-e2e-artifact-recovery-"))
  const runId = "e2e-artifact-recovery-run"
  const artifactId = "e2e-artifact-recovery-artifact"
  const conversationId = "e2e-artifact-recovery-conversation"

  try {
    const fixture = await seedReferencedArtifact(userDir, runId, artifactId, conversationId)
    const launched = await launchSynapseDevAtUserDir(userDir)
    try {
      const { shell } = await awaitShellReadiness(launched, { mode: "dev" })

      // Real IPC round-trip through the actual preload/main wiring — status
      // and a full content read — proving the on-disk artifact from a
      // "previous session" is discoverable and readable once this fresh
      // process constructs its own ArtifactStore, not merely present as
      // inert bytes on disk.
      const status = await shell.evaluate(
        (uri) => window.electronAPI.getArtifactStatus(uri),
        fixture.uri
      )
      expect(status).toMatchObject({
        status: "available",
        summary: {
          uri: fixture.uri,
          capturedBytes: Buffer.byteLength(fixture.content, "utf-8"),
          complete: true,
        },
      })

      const preview = await shell.evaluate(
        (uri) => window.electronAPI.readArtifactPreview(uri),
        fixture.uri
      )
      expect(preview).toMatchObject({
        status: "available",
        content: fixture.content,
        encoding: "utf-8",
      })

      // A real GC sweep through the actual runs:collectArtifactGarbage IPC
      // handler must not delete this artifact: its owning run's pin was
      // seeded as already released (terminal — the strongest version of this
      // proof), but the still-active conversation reference must protect it,
      // via the real ConversationStore/ArtifactStore wiring index.ts uses in
      // production, not a mocked predicate.
      const gcResult = await shell.evaluate(() => window.electronAPI.collectArtifactGarbage())
      expect(gcResult.deletedArtifacts).toBe(0)

      await assertNoShellDiagnostics(launched, shell)

      // Confirm durably on disk, not just optimistic IPC-response state.
      const manifestOnDisk = JSON.parse(
        await fs.readFile(
          path.join(userDir, "artifacts", runId, artifactId, "manifest.json"),
          "utf-8"
        )
      ) as { ref: { sha256: string; capturedBytes: number } }
      expect(manifestOnDisk.ref.sha256).toBe(fixture.sha256)
      expect(manifestOnDisk.ref.capturedBytes).toBe(Buffer.byteLength(fixture.content, "utf-8"))
      await expect(
        fs.access(path.join(userDir, "artifacts", runId, artifactId, "data.bin"))
      ).resolves.toBeUndefined()
    } finally {
      await launched.dispose()
    }
  } finally {
    removeVerifiedDirUnder(os.tmpdir(), userDir)
  }
})
