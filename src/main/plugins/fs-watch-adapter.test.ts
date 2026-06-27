import { rootIdForPattern } from "@synapse/plugin-manifest"
import { describe, expect, it, vi } from "vitest"
import { createFsWatchAdapter } from "./fs-watch-adapter"

const HOME = "/home/alice"

describe("fs watch adapter", () => {
  it("emits a root-relative safe event without absolute paths", async () => {
    const fired: unknown[] = []
    const adapter = createFsWatchAdapter({
      homeDir: HOME,
      now: () => 1000,
      io: {
        realpath: async (target) => target,
        lstat: async () => ({ isSymbolicLink: () => false, isFile: () => true, size: 12 }),
        readFile: async () => "",
      },
      watch: (dir, listener) => {
        expect(dir).toBe("/home/alice/Downloads")
        listener("change", "report.pdf")
        return { close: () => {} }
      },
    })

    adapter.register("p", "downloads", { paths: ["~/Downloads/**"], events: ["modify"] }, (event) =>
      fired.push(event)
    )

    await vi.waitFor(() => expect(fired).toHaveLength(1))
    expect(fired[0]).toEqual({
      rootId: rootIdForPattern("~/Downloads/**"),
      relativePath: "report.pdf",
      kind: "modify",
      timestamp: 1000,
      size: 12,
      ext: "pdf",
    })
    expect(JSON.stringify(fired[0])).not.toMatch(/home\/alice/i)
  })

  it("filters by declared events scope", async () => {
    const fired: unknown[] = []
    const adapter = createFsWatchAdapter({
      homeDir: HOME,
      watch: (_dir, listener) => {
        listener("change", "a.txt")
        return { close: () => {} }
      },
    })

    adapter.register(
      "p",
      "create-only",
      { paths: ["~/Downloads/**"], events: ["create"] },
      (event) => fired.push(event)
    )

    await new Promise((r) => setTimeout(r, 0))
    expect(fired).toHaveLength(0)
  })

  it("does not emit metadata for symlink paths", async () => {
    const fired: unknown[] = []
    const adapter = createFsWatchAdapter({
      homeDir: HOME,
      io: {
        realpath: async (target) => target,
        lstat: async () => ({ isSymbolicLink: () => true, isFile: () => false, size: 999 }),
        readFile: async () => "",
      },
      watch: (_dir, listener) => {
        listener("change", "leak")
        return { close: () => {} }
      },
    })

    adapter.register("p", "downloads", { paths: ["~/Downloads/**"], events: ["modify"] }, (event) =>
      fired.push(event)
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(fired).toHaveLength(0)
  })

  it("closes watchers on dispose", () => {
    const closed: string[] = []
    const adapter = createFsWatchAdapter({
      homeDir: HOME,
      watch: (dir) => {
        return { close: () => closed.push(dir) }
      },
    })

    const dispose = adapter.register("p", "x", { paths: ["~/Downloads/**"] }, () => {})
    dispose()
    expect(closed).toEqual(["/home/alice/Downloads"])
  })
})
