import type { TriggerDeclaration } from "./triggers"
import { describe, expect, it } from "vitest"
import {
  mergeDeclaredWithTriggerUses,
  normalizeTriggers,
  triggerDeclarationHash,
  validateTriggers,
} from "./triggers"

const VALID: TriggerDeclaration[] = [
  {
    id: "sync-5min",
    type: "timer",
    schedule: { intervalMs: 300000 },
    handler: "triggers.onSyncTick",
    uses: [
      {
        capability: "network:https",
        scope: { hosts: ["api.example.com"] },
        budget: { maxCalls: 10, period: "1h" as const },
      },
    ],
    limits: { minIntervalMs: 60000, maxConcurrency: 1 },
  },
]

describe("validateTriggers", () => {
  it("accepts a well-formed timer trigger", () => {
    expect(() => validateTriggers(VALID)).not.toThrow()
  })

  it("accepts a well-formed fs.watch trigger", () => {
    expect(() =>
      validateTriggers([
        {
          id: "watch-dls",
          type: "fs.watch",
          handler: "triggers.onDownloads",
          scope: { paths: ["~/Downloads/**"], events: ["create", "modify"] },
          uses: [
            {
              capability: "fs:read",
              scope: { paths: ["~/Downloads/**"] },
              budget: { maxCalls: 20, period: "1h" },
            },
          ],
        },
      ])
    ).not.toThrow()
  })

  it("rejects fs.watch without scope paths", () => {
    expect(() =>
      validateTriggers([
        {
          id: "bad",
          type: "fs.watch",
          handler: "triggers.onDownloads",
          uses: [{ capability: "fs:read", budget: { maxCalls: 1, period: "1h" } }],
        },
      ])
    ).toThrow()
  })

  it("mergeDeclaredWithTriggerUses adds fs:watch from trigger scope", () => {
    const merged = mergeDeclaredWithTriggerUses(
      [],
      [
        {
          id: "watch-dls",
          type: "fs.watch",
          handler: "triggers.onDownloads",
          scope: { paths: ["~/Downloads/**"] },
          uses: [{ capability: "fs:read", budget: { maxCalls: 1, period: "1h" } }],
        },
      ]
    )
    expect(merged.map((c) => c.id).sort()).toEqual(["fs:read", "fs:watch"])
  })

  it("accepts a well-formed hotkey trigger", () => {
    expect(() =>
      validateTriggers([
        {
          id: "quick",
          type: "hotkey",
          handler: "triggers.onQuick",
          scope: { accelerator: "CommandOrControl+Shift+K" },
          uses: [{ capability: "notification", budget: { maxCalls: 10, period: "1h" } }],
        },
      ])
    ).not.toThrow()
  })

  it("mergeDeclaredWithTriggerUses adds hotkey:global from trigger scope", () => {
    const merged = mergeDeclaredWithTriggerUses(
      [],
      [
        {
          id: "quick",
          type: "hotkey",
          handler: "triggers.onQuick",
          scope: { accelerator: "CmdOrCtrl+Shift+K" },
          uses: [{ capability: "notification", budget: { maxCalls: 1, period: "1h" } }],
        },
      ]
    )
    expect(merged.map((c) => c.id).sort()).toEqual(["hotkey:global", "notification"])
  })

  it("rejects hotkey without modifier", () => {
    expect(() =>
      validateTriggers([
        {
          id: "bad",
          type: "hotkey",
          handler: "triggers.onQuick",
          scope: { accelerator: "F5" },
          uses: [{ capability: "notification", budget: { maxCalls: 1, period: "1h" } }],
        },
      ])
    ).toThrow(/modifier/)
  })

  it("rejects system-reserved hotkey accelerators", () => {
    expect(() =>
      validateTriggers([
        {
          id: "steal",
          type: "hotkey",
          handler: "triggers.onCopy",
          scope: { accelerator: "CommandOrControl+C" },
          uses: [{ capability: "notification", budget: { maxCalls: 1, period: "1h" } }],
        },
      ])
    ).toThrow(/reserved/)
    expect(() =>
      validateTriggers([
        {
          id: "steal-ctrl",
          type: "hotkey",
          handler: "triggers.onCopy",
          scope: { accelerator: "Control+C" },
          uses: [{ capability: "notification", budget: { maxCalls: 1, period: "1h" } }],
        },
      ])
    ).toThrow(/reserved/)
  })

  it("accepts a well-formed cron trigger", () => {
    expect(() =>
      validateTriggers([
        {
          id: "daily",
          type: "cron",
          schedule: "0 9 * * *",
          handler: "triggers.onDaily",
          uses: [{ capability: "notification", budget: { maxCalls: 1, period: "1d" } }],
        },
      ])
    ).not.toThrow()
  })

  it("rejects cron with interval object schedule", () => {
    expect(() =>
      validateTriggers([
        {
          id: "bad",
          type: "cron",
          schedule: { intervalMs: 60_000 },
          handler: "triggers.onDaily",
          uses: [{ capability: "notification", budget: { maxCalls: 1, period: "1d" } }],
        },
      ])
    ).toThrow(/crontab string/)
  })

  it("rejects timer with crontab string schedule", () => {
    expect(() =>
      validateTriggers([
        {
          id: "bad",
          type: "timer",
          schedule: "0 9 * * *",
          handler: "triggers.onTick",
          uses: [{ capability: "notification", budget: { maxCalls: 1, period: "1h" } }],
        },
      ])
    ).toThrow(/intervalMs/)
  })

  it("rejects a duplicate trigger id", () => {
    expect(() => validateTriggers([VALID[0], VALID[0]])).toThrow(/duplicate trigger id/)
  })

  it("rejects a handler not under the triggers. namespace", () => {
    expect(() => validateTriggers([{ ...VALID[0], handler: "onSyncTick" }])).toThrow(/handler/)
  })

  it("rejects a trigger with no uses (cannot be reviewed at enable time)", () => {
    expect(() => validateTriggers([{ ...VALID[0], uses: [] }])).toThrow(/at least one `uses`/)
  })

  it("rejects an unknown trigger type", () => {
    expect(() => validateTriggers([{ ...VALID[0], type: "webhook" }])).toThrow(
      /unsupported trigger type/
    )
  })

  it("accepts a well-formed clipboard trigger", () => {
    expect(() =>
      validateTriggers([
        {
          id: "on-clip",
          type: "clipboard",
          handler: "triggers.onClip",
          scope: { contentTypes: ["text"] },
          uses: [{ capability: "clipboard:read", budget: { maxCalls: 10, period: "1h" } }],
        },
      ])
    ).not.toThrow()
  })

  it("rejects clipboard trigger with schedule", () => {
    expect(() =>
      validateTriggers([
        {
          id: "bad",
          type: "clipboard",
          schedule: { intervalMs: 1000 },
          handler: "triggers.onClip",
          uses: [{ capability: "clipboard:read", budget: { maxCalls: 1, period: "1h" } }],
        },
      ])
    ).toThrow(/must not declare `schedule`/)
  })

  it("rejects timer trigger with scope", () => {
    expect(() =>
      validateTriggers([
        {
          ...VALID[0],
          scope: { contentTypes: ["text"] },
        },
      ])
    ).toThrow(/must not declare `scope`/)
  })
})

describe("mergeDeclaredWithTriggerUses", () => {
  it("adds capabilities declared only under trigger uses", () => {
    const merged = mergeDeclaredWithTriggerUses(
      [],
      [
        {
          id: "clip",
          type: "clipboard",
          handler: "triggers.onClip",
          uses: [{ capability: "clipboard:read", budget: { maxCalls: 1, period: "1h" } }],
        },
      ]
    )
    expect(merged.map((c) => c.id)).toEqual(["clipboard:read"])
  })

  it("keeps manifest capabilities when the same id is also in uses", () => {
    const manifestScope = { hosts: ["api.example.com"], methods: ["GET"], paths: ["/**"] }
    const merged = mergeDeclaredWithTriggerUses(
      [{ id: "network:https", scope: manifestScope }],
      [
        {
          id: "sync",
          type: "timer",
          schedule: { intervalMs: 60_000 },
          handler: "triggers.onTick",
          uses: [
            {
              capability: "network:https",
              scope: { hosts: ["other.example.com"] },
              budget: { maxCalls: 1, period: "1h" },
            },
          ],
        },
      ]
    )
    expect(merged).toHaveLength(1)
    expect(merged[0]?.scope).toEqual(manifestScope)
  })
})

describe("normalizeTriggers + hash", () => {
  it("sorts triggers by id and is stable under key reordering", () => {
    const a = triggerDeclarationHash(VALID)
    const reordered: TriggerDeclaration[] = [
      { ...VALID[0]!, limits: { maxConcurrency: 1, minIntervalMs: 60000 } },
    ]
    expect(triggerDeclarationHash(reordered)).toBe(a)
    expect(normalizeTriggers(VALID)[0]?.id).toBe("sync-5min")
  })

  it("changes the hash when a use budget changes (grant invalidation)", () => {
    const widened: TriggerDeclaration[] = [
      {
        ...VALID[0]!,
        uses: [{ ...VALID[0]!.uses[0]!, budget: { maxCalls: 999, period: "1h" } }],
      },
    ]
    expect(triggerDeclarationHash(widened)).not.toBe(triggerDeclarationHash(VALID))
  })
})
