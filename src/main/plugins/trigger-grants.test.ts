import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { GrantStore, grantStoreFilePath } from "./grant-store"
import {
  grantTriggerUses,
  pendingCapabilityConfirmations,
  revokeTriggerUses,
} from "./trigger-grants"

const identity = {
  pluginId: "com.example.clip",
  publisherId: "unsigned",
  signingKeyFingerprint: "local:user",
  capabilityDeclarationHash: "abc",
}

const githubManifestBrokerScope = {
  credentialIds: ["github"],
  inject: [
    {
      credentialId: "github",
      scope: {
        hosts: ["api.github.com"],
        methods: ["GET", "PATCH", "PUT", "POST", "DELETE"],
        paths: ["/notifications/**", "/repos/**", "/user"],
      },
    },
  ],
} as const

const githubPollInboxTriggerUses = [
  {
    capability: "network:https",
    scope: {
      hosts: ["api.github.com"],
      methods: ["GET"],
      paths: ["/notifications/**", "/repos/**", "/user"],
    },
    budget: { maxCalls: 80, period: "1h" as const },
  },
  {
    capability: "credentials:broker",
    scope: githubManifestBrokerScope,
    budget: { maxCalls: 80, period: "1h" as const },
  },
] as const

const githubPollInboxTrigger = {
  id: "poll-inbox",
  type: "timer" as const,
  schedule: { intervalMs: 3_600_000 },
  handler: "triggers.onPollInbox",
  uses: [...githubPollInboxTriggerUses],
}

describe("grantTriggerUses", () => {
  it("grants fs:watch from fs.watch trigger scope", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "synapse-trigger-grants-fs-"))
    const store = new GrantStore(grantStoreFilePath(dir))
    await grantTriggerUses(store, identity, [
      {
        id: "watch-dls",
        type: "fs.watch",
        handler: "triggers.onDownloads",
        scope: { paths: ["~/Downloads/**"] },
        uses: [{ capability: "fs:read", budget: { maxCalls: 20, period: "1h" } }],
      },
    ])
    expect(await store.isGranted(identity, "fs:watch")).toBe(true)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("grants hotkey:global from hotkey trigger scope", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "synapse-trigger-grants-hotkey-"))
    const store = new GrantStore(grantStoreFilePath(dir))
    await grantTriggerUses(store, identity, [
      {
        id: "quick",
        type: "hotkey",
        handler: "triggers.onQuick",
        scope: { accelerator: "CommandOrControl+Shift+K" },
        uses: [{ capability: "notification", budget: { maxCalls: 10, period: "1h" } }],
      },
    ])
    expect(
      await store.isGranted(identity, "hotkey:global", {
        accelerator: "CommandOrControl+Shift+K",
      })
    ).toBe(true)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("grants non-auto capabilities listed in trigger uses", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "synapse-trigger-grants-"))
    const store = new GrantStore(grantStoreFilePath(dir))
    await grantTriggerUses(store, identity, [
      {
        id: "clip",
        type: "clipboard",
        handler: "triggers.onClip",
        uses: [
          { capability: "clipboard:read", budget: { maxCalls: 20, period: "1h" } },
          { capability: "fs:write", budget: { maxCalls: 5, period: "1h" } },
        ],
      },
    ])
    expect(await store.isGranted(identity, "clipboard:read")).toBe(true)
    expect(await store.isGranted(identity, "fs:write")).toBe(true)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("skips auto-tier capabilities such as notification", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "synapse-trigger-grants-"))
    const store = new GrantStore(grantStoreFilePath(dir))
    await grantTriggerUses(store, identity, [
      {
        id: "tick",
        type: "timer",
        schedule: { intervalMs: 60_000 },
        handler: "triggers.onTick",
        uses: [{ capability: "notification", budget: { maxCalls: 1, period: "1h" } }],
      },
    ])
    expect(await store.list(identity)).toHaveLength(0)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("grants credentials:broker trigger uses with inject scopes on a cold store", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "synapse-trigger-grants-cold-broker-"))
    const store = new GrantStore(grantStoreFilePath(dir))

    await grantTriggerUses(store, identity, [githubPollInboxTrigger])

    expect(
      await store.isGranted(identity, "credentials:broker", {
        credentialId: "github",
        host: "api.github.com",
        method: "GET",
        path: "/notifications/threads/1",
      })
    ).toBe(true)
    expect(
      await store.isGranted(identity, "credentials:broker", {
        credentialId: "github",
        host: "api.github.com",
        method: "POST",
        path: "/repos/synapse/desktop/issues/1/comments",
      })
    ).toBe(true)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("does not replace a broader credentials:broker grant with a narrower trigger use", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "synapse-trigger-grants-broker-"))
    const store = new GrantStore(grantStoreFilePath(dir))
    const manifestBrokerScope = githubManifestBrokerScope
    await store.grant(identity, "credentials:broker", "user", manifestBrokerScope)

    await grantTriggerUses(store, identity, [
      {
        ...githubPollInboxTrigger,
        uses: [
          {
            capability: "credentials:broker",
            scope: { credentialIds: ["github"] },
            budget: { maxCalls: 80, period: "1h" },
          },
        ],
      },
    ])

    const broker = (await store.list(identity)).find((r) => r.capabilityId === "credentials:broker")
    expect(broker?.grantScope).toEqual(manifestBrokerScope)
    expect(
      await store.isGranted(identity, "credentials:broker", {
        credentialId: "github",
        host: "api.github.com",
        method: "GET",
        path: "/notifications/threads/1",
      })
    ).toBe(true)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("does not replace a broader network:https grant with a narrower trigger use", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "synapse-trigger-grants-network-"))
    const store = new GrantStore(grantStoreFilePath(dir))
    const manifestNetworkScope = {
      hosts: ["api.github.com"],
      methods: ["GET", "PATCH", "PUT", "POST", "DELETE"],
      paths: ["/notifications/**", "/repos/**", "/user"],
    }
    await store.grant(identity, "network:https", "user", manifestNetworkScope)

    await grantTriggerUses(store, identity, [
      {
        ...githubPollInboxTrigger,
        uses: [githubPollInboxTriggerUses[0]],
      },
    ])

    const network = (await store.list(identity)).find((r) => r.capabilityId === "network:https")
    expect(network?.grantScope).toEqual(manifestNetworkScope)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("revokes non-auto trigger uses on disable", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "synapse-trigger-grants-"))
    const store = new GrantStore(grantStoreFilePath(dir))
    const triggers = [
      {
        id: "clip",
        type: "clipboard" as const,
        handler: "triggers.onClip",
        uses: [{ capability: "clipboard:read", budget: { maxCalls: 20, period: "1h" as const } }],
      },
    ]
    await grantTriggerUses(store, identity, triggers)
    expect(await store.isGranted(identity, "clipboard:read")).toBe(true)
    await revokeTriggerUses(store, identity, triggers)
    expect(await store.isGranted(identity, "clipboard:read")).toBe(false)
    await fs.rm(dir, { recursive: true, force: true })
  })
})

describe("grantTriggerUses — explicit-confirmation capabilities", () => {
  it("never auto-grants memory:read or execution:read", async () => {
    const granted: string[] = []
    const grants: Pick<GrantStore, "isGranted" | "grant" | "list"> = {
      isGranted: async () => false,
      grant: async (_identity, capabilityId) => {
        granted.push(capabilityId)
      },
      list: async () => [],
    }
    const triggers = [
      {
        id: "poll",
        type: "timer" as const,
        schedule: { intervalMs: 60_000 },
        handler: "triggers.onPoll",
        uses: [
          { capability: "memory:read", budget: { maxCalls: 10, period: "1h" as const } },
          { capability: "execution:read", budget: { maxCalls: 10, period: "1h" as const } },
          { capability: "clipboard:read", budget: { maxCalls: 10, period: "1h" as const } },
        ],
      },
    ]

    await grantTriggerUses(grants, identity, triggers)

    expect(granted).toEqual(["clipboard:read"])
  })
})

describe("pendingCapabilityConfirmations", () => {
  it("returns declared-but-ungranted explicit-confirmation capabilities, deduplicated by id", async () => {
    const triggers = [
      {
        id: "trigger-a",
        type: "timer" as const,
        schedule: { intervalMs: 60_000 },
        handler: "triggers.onA",
        uses: [{ capability: "memory:read", budget: { maxCalls: 10, period: "1h" as const } }],
      },
      {
        id: "trigger-b",
        type: "timer" as const,
        schedule: { intervalMs: 60_000 },
        handler: "triggers.onB",
        uses: [
          { capability: "memory:read", budget: { maxCalls: 5, period: "1h" as const } },
          { capability: "execution:read", budget: { maxCalls: 5, period: "1h" as const } },
        ],
      },
    ]

    const pending = await pendingCapabilityConfirmations(triggers, async () => false)

    expect(pending).toEqual(
      expect.arrayContaining([
        { capabilityId: "memory:read", triggerIds: ["trigger-a", "trigger-b"] },
        { capabilityId: "execution:read", triggerIds: ["trigger-b"] },
      ])
    )
    expect(pending).toHaveLength(2)
  })

  it("excludes an already-granted capability", async () => {
    const triggers = [
      {
        id: "trigger-a",
        type: "timer" as const,
        schedule: { intervalMs: 60_000 },
        handler: "triggers.onA",
        uses: [{ capability: "memory:read", budget: { maxCalls: 10, period: "1h" as const } }],
      },
    ]

    const pending = await pendingCapabilityConfirmations(
      triggers,
      async (id) => id === "memory:read"
    )

    expect(pending).toEqual([])
  })

  it("returns [] for undefined triggers", async () => {
    expect(await pendingCapabilityConfirmations(undefined, async () => false)).toEqual([])
  })
})
