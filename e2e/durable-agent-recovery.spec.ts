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
// Deliberately scoped down from "resumes from snapshot/event cursor and does
// not duplicate a tool card": that phrasing describes a chat-page mid-
// conversation reconnect, which needs a seeded conversation plus an
// in-progress tool-call UI to prove non-duplication against — a much larger
// fixture with no deterministic-LLM-injection hook available for the real
// app. What's proven here is the layer underneath that UI: the durable store
// on disk really is what the renderer's recovery panel reads and mutates
// through real IPC, with no in-memory state bridging the two.

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

/** A minimal, schema-valid AgentRunCheckpointV1 as raw JSON — deliberately
 *  NOT imported from src/main/ai/runs/checkpoint-schema.ts, since that module
 *  (like the rest of main) is reached through `@synapse/*` tsconfig path
 *  aliases that Playwright's own module resolution has no reason to know
 *  about. Mirrors the shape durable-run-child.ts's minimalCheckpoint()
 *  already proves the real store accepts. `origin: "background-agent"` is
 *  deliberate: main/index.ts's buildClassifierInput compares that origin's
 *  frozen authority against itself (a documented limitation, see Task 15),
 *  so this fixture only needs to be internally consistent, never needs to
 *  match "real" live tool/capability state to classify as recoverable. The
 *  context snapshot's hashes are real sha256 (not placeholders) because
 *  classifyRunRecovery's contextSnapshotIsIntact check re-derives them. */
function seedCheckpointJson(runId: string): Record<string, unknown> {
  const systemPromptText = "You are helpful."
  const baseSha = sha256(systemPromptText)
  return {
    schemaVersion: 1,
    revision: 1,
    identity: { runId, rootRunId: runId, origin: "background-agent" },
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
        principal: { kind: "internal-agent", actor: "background" },
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
  }
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
      tools: [],
      integrityHash: "h",
    },
  }
  checkpoint.messages = [
    { messageId: "u1", message: { role: "user", content: [{ type: "text", text: "go" }] } },
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
  await fs.writeFile(path.join(runDir, "checkpoint.json"), JSON.stringify(checkpoint), "utf-8")

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
