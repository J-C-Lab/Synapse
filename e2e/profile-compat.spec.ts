import type { LaunchedApp } from "./electron-app-helpers"
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { expect, test } from "@playwright/test"
import {
  assertPackagedHostSupported,
  awaitShellReadiness,
  copyVerifiedDir,
  fileSha256,
  launchSynapseAtProfile,
  removeVerifiedDirUnder,
  resolveExplicitExecutable,
} from "./electron-app-helpers"

// Task 10 (S11 Checkpoint B): reusable Electron-33 -> Electron-43 profile
// forward-upgrade / rollback compatibility rehearsal. Full 8-step sequence
// and secrecy/isolation invariants:
// docs/superpowers/specs/2026-07-14-windows-electron-runtime-toolchain-refresh-design.md
// section "Electron 33 profile forward/rollback compatibility rehearsal".
//
// Requires SYNAPSE_ELECTRON33_EXE (retained Checkpoint A win-unpacked
// Synapse.exe) and SYNAPSE_ELECTRON43_EXE (this checkpoint's win-unpacked
// Synapse.exe) as absolute, existing paths on the SAME Windows host/OS user.
// safeStorage/DPAPI ciphertext is user+machine bound, so copying a profile
// across users/machines would test the wrong property. Windows-only, and
// fails loudly (never skips) when either executable is missing.
//
// Sequence: create sentinel state on a fresh Electron-33 profile
// (P33-original) through real preload IPC, close 33, clone P33-original into
// two independent profiles (P-forward, P-rollback). P33-original itself is
// never opened by 43. Open P-forward with 43 and assert logical state +
// credential decrypt, open P-rollback with 43 (mutate + close cleanly so
// Chromium can update the profile), then reopen that same 43-touched
// P-rollback with the retained 33 and assert the same logical state +
// decrypt again. All comparisons are exact ID/value equality, never merely
// "list is non-empty".

const SENTINEL = {
  settingsPatch: {
    hotkey: "Alt+Shift+P",
    themeMode: "dark",
    accent: "violet",
    trustedSourcePolicy: "any-url",
    allowAgentShell: true,
  },
  activeWorkspaceName: "profile-compat-active",
  archivedWorkspaceName: "profile-compat-archived",
  workspaceRootName: "profile-compat-root",
  aiProvider: "openai",
  aiModel: "gpt-4.1-mini",
  // Fixed dummy key. Never a real credential, never sent to a real provider.
  aiKey: "sk-profile-compat-sentinel-DO-NOT-USE-1234567890",
  pluginId: "com.synapse.downloads-organizer",
} as const

interface LogicalState {
  settings: {
    hotkey: string
    themeMode: string
    accent: string
    trustedSourcePolicy: string
    allowAgentShell: boolean
  }
  activeWorkspaceId: string
  activeWorkspaceName: string
  activeWorkspaceArchived: boolean
  archivedWorkspaceId: string
  archivedWorkspaceName: string
  archivedWorkspaceArchived: boolean
  workspaceRootId: string
  workspaceRootName: string
  workspaceRootPath: string
  workspaceRootRole: string
  conversationId: string
  conversationWorkspaceId: string
  aiProvider: string
  aiModel: string
  aiHasKey: boolean
  // The registered discovery status a built-in plugin gets on every fresh
  // launch ("active"). NOT a persisted profile property: PluginRegistry
  // keeps enabled/disabled purely in-memory and re-discovers every builtin
  // plugin fresh on each process start (see plugin-registry.ts — `entries`
  // is a plain Map with no disk-backed store), so it resets on every relaunch
  // regardless of what a previous session set it to. Comparing it here still
  // verifies discovery behaves identically across Electron versions.
  pluginStatus: string
}

interface SentinelElectronAPI {
  updateSettings: (patch: Record<string, unknown>) => Promise<Record<string, unknown>>
  getSettings: () => Promise<Record<string, unknown>>
  createAiWorkspace: (name: string) => Promise<{ id: string; name: string; archived?: boolean }>
  archiveAiWorkspace: (id: string) => Promise<{ id: string; name: string; archived?: boolean }>
  listAiWorkspaces: (options?: {
    includeArchived?: boolean
  }) => Promise<{ id: string; name: string; archived?: boolean }[]>
  createWorkspaceRoot: (
    workspaceId: string,
    name: string,
    root: string,
    role: "primary" | "additional"
  ) => Promise<{ id: string; name: string; root: string; role: string }>
  listWorkspaceRoots: (
    workspaceId: string
  ) => Promise<{ id: string; name: string; root: string; role: string }[]>
  createAiConversation: (workspaceId: string) => Promise<{ id: string; workspaceId: string }>
  getAiConversation: (id: string) => Promise<{ id: string; workspaceId: string } | undefined>
  setAiProvider: (providerId: string) => Promise<void>
  setAiModel: (providerId: string, model: string) => Promise<void>
  setAiKey: (providerId: string, key: string) => Promise<void>
  getAiStatus: () => Promise<{
    provider: string
    model: string
    providers: { id: string; hasKey: boolean }[]
  }>
  setPluginEnabled: (pluginId: string, enabled: boolean) => Promise<{ ok: boolean }>
  getPlugin: (pluginId: string) => Promise<{
    ok: boolean
    data?: { status: string } | null
  }>
}

function majorVersion(fullVersion: string): number {
  const [major] = fullVersion.split(".")
  return Number.parseInt(major, 10)
}

/** Populate the fixed sentinel state on the Electron-33 baseline through real
 *  preload IPC only (design step 2). Runs once, against P33-original. */
async function populateSentinelState(
  shell: Awaited<ReturnType<typeof awaitShellReadiness>>["shell"],
  workspaceRootDir: string
): Promise<LogicalState> {
  return shell.evaluate(
    async ({ sentinel, workspaceRootDir }) => {
      const api = (window as unknown as { electronAPI: SentinelElectronAPI }).electronAPI

      const settings = await api.updateSettings(sentinel.settingsPatch)

      const active = await api.createAiWorkspace(sentinel.activeWorkspaceName)
      const archivedSeed = await api.createAiWorkspace(sentinel.archivedWorkspaceName)
      const archived = await api.archiveAiWorkspace(archivedSeed.id)

      const root = await api.createWorkspaceRoot(
        active.id,
        sentinel.workspaceRootName,
        workspaceRootDir,
        "primary"
      )

      const conversation = await api.createAiConversation(active.id)

      await api.setAiProvider(sentinel.aiProvider)
      await api.setAiModel(sentinel.aiProvider, sentinel.aiModel)
      await api.setAiKey(sentinel.aiProvider, sentinel.aiKey)
      const aiStatus = await api.getAiStatus()
      const providerEntry = aiStatus.providers.find((p) => p.id === sentinel.aiProvider)

      // Built-in plugin: the fresh-discovery baseline every launch reproduces
      // is "active" (see the LogicalState.pluginStatus doc comment) — capture
      // THAT as the cross-restart-comparable value. Then, as a same-session
      // smoke check only (not part of the comparison), prove the
      // enable/disable API round-trips: PluginRegistry keeps this in-memory
      // only, so it does not survive a relaunch either way.
      const pluginBaseline = await api.getPlugin(sentinel.pluginId)
      if (!pluginBaseline.ok || !pluginBaseline.data) {
        throw new Error(`Sentinel plugin ${sentinel.pluginId} not found after setup`)
      }
      await api.setPluginEnabled(sentinel.pluginId, false)
      const pluginToggled = await api.getPlugin(sentinel.pluginId)
      if (!pluginToggled.ok || pluginToggled.data?.status !== "disabled") {
        throw new Error(`setPluginEnabled(false) did not take effect for ${sentinel.pluginId}`)
      }

      return {
        settings: {
          hotkey: settings.hotkey,
          themeMode: settings.themeMode,
          accent: settings.accent,
          trustedSourcePolicy: settings.trustedSourcePolicy,
          allowAgentShell: settings.allowAgentShell,
        },
        activeWorkspaceId: active.id,
        activeWorkspaceName: active.name,
        activeWorkspaceArchived: Boolean(active.archived),
        archivedWorkspaceId: archived.id,
        archivedWorkspaceName: archived.name,
        archivedWorkspaceArchived: Boolean(archived.archived),
        workspaceRootId: root.id,
        workspaceRootName: root.name,
        workspaceRootPath: root.root,
        workspaceRootRole: root.role,
        conversationId: conversation.id,
        conversationWorkspaceId: conversation.workspaceId,
        aiProvider: aiStatus.provider,
        aiModel: aiStatus.model,
        aiHasKey: providerEntry?.hasKey ?? false,
        pluginStatus: pluginBaseline.data.status,
      } as LogicalState
    },
    { sentinel: SENTINEL, workspaceRootDir }
  )
}

/** Re-read the same logical state through public preload APIs only, and
 *  assert exact ID/value equality against what was captured on Electron 33
 *  (design step 4/6/7). Never merely "list is non-empty". */
async function assertLogicalState(
  shell: Awaited<ReturnType<typeof awaitShellReadiness>>["shell"],
  expected: LogicalState
): Promise<void> {
  const actual = await shell.evaluate(
    async ({ sentinel, expected }) => {
      const api = (window as unknown as { electronAPI: SentinelElectronAPI }).electronAPI

      const settings = await api.getSettings()

      const workspaces = await api.listAiWorkspaces({ includeArchived: true })
      const active = workspaces.find((w) => w.id === expected.activeWorkspaceId)
      const archived = workspaces.find((w) => w.id === expected.archivedWorkspaceId)
      if (!active) {
        throw new Error(`Active workspace ${expected.activeWorkspaceId} missing after relaunch`)
      }
      if (!archived) {
        throw new Error(`Archived workspace ${expected.archivedWorkspaceId} missing after relaunch`)
      }

      const roots = await api.listWorkspaceRoots(expected.activeWorkspaceId)
      const root = roots.find((r) => r.id === expected.workspaceRootId)
      if (!root) {
        throw new Error(`Workspace root ${expected.workspaceRootId} missing after relaunch`)
      }

      const conversation = await api.getAiConversation(expected.conversationId)
      if (!conversation) {
        throw new Error(`Conversation ${expected.conversationId} missing after relaunch`)
      }

      const aiStatus = await api.getAiStatus()
      const providerEntry = aiStatus.providers.find((p) => p.id === sentinel.aiProvider)

      const pluginResult = await api.getPlugin(sentinel.pluginId)
      if (!pluginResult.ok || !pluginResult.data) {
        throw new Error(`Sentinel plugin ${sentinel.pluginId} missing after relaunch`)
      }

      return {
        settings: {
          hotkey: settings.hotkey,
          themeMode: settings.themeMode,
          accent: settings.accent,
          trustedSourcePolicy: settings.trustedSourcePolicy,
          allowAgentShell: settings.allowAgentShell,
        },
        activeWorkspaceId: active.id,
        activeWorkspaceName: active.name,
        activeWorkspaceArchived: Boolean(active.archived),
        archivedWorkspaceId: archived.id,
        archivedWorkspaceName: archived.name,
        archivedWorkspaceArchived: Boolean(archived.archived),
        workspaceRootId: root.id,
        workspaceRootName: root.name,
        workspaceRootPath: root.root,
        workspaceRootRole: root.role,
        conversationId: conversation.id,
        conversationWorkspaceId: conversation.workspaceId,
        aiProvider: aiStatus.provider,
        aiModel: aiStatus.model,
        aiHasKey: providerEntry?.hasKey ?? false,
        pluginStatus: pluginResult.data.status,
      } as LogicalState
    },
    { sentinel: SENTINEL, expected }
  )

  expect(actual).toEqual(expected)
}

/** Main-process-only credential decrypt check (design step 5). The outer test
 *  process (a normal Node.js process with full `fs`/`import` support) reads
 *  `ai/credentials.json` and extracts the base64 CIPHERTEXT for the sentinel
 *  provider — that alone crosses no secrecy boundary, since it's still
 *  encrypted. Only that ciphertext is then handed into `app.evaluate`, which
 *  decrypts it with THAT runtime's real `safeStorage.decryptString` and
 *  compares it to the sentinel plaintext entirely inside the Electron main
 *  process. Only a boolean crosses back out — the plaintext never reaches the
 *  renderer, this test's own memory, logs, or the eventual report.
 *
 *  (`app.evaluate` callbacks run in a bare V8 context with neither a CJS
 *  `require` nor a registered dynamic-`import()` callback, so `fs`/`path`
 *  cannot be reached from inside the callback itself — only true JS globals
 *  like `Buffer` and the `safeStorage`/`app` objects Playwright injects.) */
async function assertCredentialDecrypts(launched: LaunchedApp, userDir: string): Promise<boolean> {
  const filePath = path.join(userDir, "ai", "credentials.json")
  let raw: string
  try {
    raw = readFileSync(filePath, "utf-8")
  } catch {
    return false
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return false
  }
  if (!parsed || typeof parsed !== "object") return false
  const encrypted = (parsed as Record<string, unknown>)[SENTINEL.aiProvider]
  if (typeof encrypted !== "string" || encrypted.length === 0) return false

  return launched.app.evaluate(
    ({ safeStorage }, args: { encrypted: string; expectedPlaintext: string }) => {
      try {
        // No require()/import() in this bare evaluate context (see the doc
        // comment above) — the global Buffer is the only way to reach it.
        // eslint-disable-next-line node/prefer-global/buffer
        const decrypted = safeStorage.decryptString(Buffer.from(args.encrypted, "base64"))
        return decrypted === args.expectedPlaintext
      } catch {
        return false
      }
    },
    { encrypted, expectedPlaintext: SENTINEL.aiKey }
  )
}

test.beforeAll(() => {
  assertPackagedHostSupported()
})

test("Electron 33 profile forward-upgrades to 43 and rolls back to 33 cleanly", async () => {
  test.setTimeout(420_000)

  const exe33 = resolveExplicitExecutable("SYNAPSE_ELECTRON33_EXE")
  const exe43 = resolveExplicitExecutable("SYNAPSE_ELECTRON43_EXE")

  // Test-owned root: every profile/root path this test creates, copies, or
  // deletes must resolve under this root before any destructive operation
  // (mirrors electron-app-helpers.ts's removeVerifiedTempDir pattern).
  const root = mkdtempSync(path.join(tmpdir(), "synapse-profile-compat-"))
  const workspaceRootDir = path.join(root, "workspace-root")
  const p33Original = path.join(root, "P33-original")
  const pForward = path.join(root, "P-forward")
  const pRollback = path.join(root, "P-rollback")
  mkdirSync(workspaceRootDir, { recursive: true })
  mkdirSync(p33Original, { recursive: true })

  // Secret-free evidence only: hashes, runtime versions, boolean outcomes.
  const evidence = {
    exe33: { path: exe33, sha256: fileSha256(exe33), runtimeVersion: "" },
    exe43: { path: exe43, sha256: fileSha256(exe43), runtimeVersion: "" },
    assertions: {} as Record<string, boolean>,
  }
  console.warn(`[profile-compat] exe33 sha256=${evidence.exe33.sha256}`)
  console.warn(`[profile-compat] exe43 sha256=${evidence.exe43.sha256}`)

  let expected: LogicalState | undefined

  try {
    // ---- Step 1/2: create the Electron-33 baseline through real app APIs ----
    const launched33Original = await launchSynapseAtProfile({
      executablePath: exe33,
      userDir: p33Original,
    })
    try {
      const version = await launched33Original.app.evaluate(() => process.versions.electron)
      evidence.exe33.runtimeVersion = version
      console.warn(`[profile-compat] Electron 33 baseline runtime=${version}`)
      expect(majorVersion(version)).toBe(33)

      const encryptionAvailable = await launched33Original.app.evaluate(({ safeStorage }) =>
        safeStorage.isEncryptionAvailable()
      )
      evidence.assertions.electron33EncryptionAvailable = encryptionAvailable
      expect(encryptionAvailable).toBe(true)

      const { shell } = await awaitShellReadiness(launched33Original, { mode: "packaged" })
      expected = await populateSentinelState(shell, workspaceRootDir)

      const decrypted = await assertCredentialDecrypts(launched33Original, p33Original)
      evidence.assertions.electron33OriginalDecrypt = decrypted
      console.warn(`[profile-compat] P33-original credential decrypt=${decrypted}`)
      expect(decrypted).toBe(true)
    } finally {
      // Step 3: close 33 cleanly BEFORE copying. P33-original is only ever
      // touched by 33 and stays immutable evidence after this point.
      await launched33Original.dispose()
    }

    if (!expected) throw new Error("Sentinel state was not captured on P33-original")

    // ---- Step 3: two independent clones, verified under the test root ----
    copyVerifiedDir(root, p33Original, pForward)
    copyVerifiedDir(root, p33Original, pRollback)

    // ---- Step 4/5: Electron 43 forward on P-forward ----
    const launched43Forward = await launchSynapseAtProfile({
      executablePath: exe43,
      userDir: pForward,
    })
    try {
      const version = await launched43Forward.app.evaluate(() => process.versions.electron)
      evidence.exe43.runtimeVersion = version
      console.warn(`[profile-compat] Electron 43 (forward) runtime=${version}`)
      expect(majorVersion(version)).toBe(43)

      const { shell } = await awaitShellReadiness(launched43Forward, { mode: "packaged" })
      await assertLogicalState(shell, expected)

      const decrypted = await assertCredentialDecrypts(launched43Forward, pForward)
      evidence.assertions.forward43Decrypt = decrypted
      console.warn(`[profile-compat] P-forward (43) credential decrypt=${decrypted}`)
      expect(decrypted).toBe(true)
    } finally {
      await launched43Forward.dispose()
    }

    // ---- Step 6: Electron 43 on P-rollback, then close cleanly ----
    const launched43Rollback = await launchSynapseAtProfile({
      executablePath: exe43,
      userDir: pRollback,
    })
    try {
      const version = await launched43Rollback.app.evaluate(() => process.versions.electron)
      console.warn(`[profile-compat] Electron 43 (rollback clone, touch) runtime=${version}`)
      expect(majorVersion(version)).toBe(43)

      const { shell } = await awaitShellReadiness(launched43Rollback, { mode: "packaged" })
      await assertLogicalState(shell, expected)

      const decrypted = await assertCredentialDecrypts(launched43Rollback, pRollback)
      evidence.assertions.rollback43TouchDecrypt = decrypted
      console.warn(`[profile-compat] P-rollback (43 touch) credential decrypt=${decrypted}`)
      expect(decrypted).toBe(true)
    } finally {
      // Close cleanly so Chromium/Electron 43 makes whatever normal profile
      // updates it would for a real user, before 33 reopens the same dir.
      await launched43Rollback.dispose()
    }

    // ---- Step 7: retained Electron 33 reopens the 43-touched P-rollback ----
    const launched33Rollback = await launchSynapseAtProfile({
      executablePath: exe33,
      userDir: pRollback,
    })
    try {
      const version = await launched33Rollback.app.evaluate(() => process.versions.electron)
      console.warn(`[profile-compat] Electron 33 (rollback) runtime=${version}`)
      expect(majorVersion(version)).toBe(33)

      const { shell } = await awaitShellReadiness(launched33Rollback, { mode: "packaged" })
      await assertLogicalState(shell, expected)

      const decrypted = await assertCredentialDecrypts(launched33Rollback, pRollback)
      evidence.assertions.rollback33Decrypt = decrypted
      console.warn(`[profile-compat] P-rollback (33 rollback) credential decrypt=${decrypted}`)
      expect(decrypted).toBe(true)
    } finally {
      await launched33Rollback.dispose()
    }

    console.warn(`[profile-compat] evidence summary: ${JSON.stringify(evidence, null, 2)}`)
  } finally {
    // Step 8: clean up every temporary profile/root. Never retain the
    // credential-bearing profile archives as CI artifacts.
    removeVerifiedDirUnder(root, root)
  }
})
