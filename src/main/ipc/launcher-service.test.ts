import type { AppEntry } from "../launcher/types"
import { beforeEach, describe, expect, it, vi } from "vitest"

const listMock = vi.fn<() => readonly AppEntry[]>()
const refreshMock = vi.fn(async () => listMock())

vi.mock("../launcher/app-cache", () => ({
  AppCache: vi.fn().mockImplementation(() => ({
    list: listMock,
    refresh: refreshMock,
  })),
}))

const launchAppMock = vi.fn(async () => true)
vi.mock("../launcher/launch-app", () => ({
  launchApp: launchAppMock,
}))

const { LauncherService } = await import("./launcher-service")

function makeEntry(id: string, name = id): AppEntry {
  return { id, kind: "win32", name, nameLower: name.toLowerCase(), target: `C:\\${name}.exe` }
}

describe("launcherService usage tracking", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listMock.mockReturnValue([makeEntry("vscode", "VS Code"), makeEntry("chrome", "Chrome")])
    launchAppMock.mockResolvedValue(true)
  })

  it("records a launch's timestamp and count", async () => {
    const service = new LauncherService()
    vi.spyOn(Date, "now").mockReturnValue(1_000)

    await service.launchById("vscode")

    expect(await service.getFrequentApps()).toEqual([
      { entry: makeEntry("vscode", "VS Code"), lastLaunchedAt: 1_000 },
    ])
  })

  it("does not record usage when the launch fails", async () => {
    launchAppMock.mockResolvedValueOnce(false)
    const service = new LauncherService()

    await service.launchById("vscode")

    expect(await service.getFrequentApps()).toEqual([])
  })

  it("sorts by most recently launched first", async () => {
    const service = new LauncherService()
    vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(2_000)

    await service.launchById("vscode")
    await service.launchById("chrome")

    const frequent = await service.getFrequentApps()
    expect(frequent.map((row) => row.entry.id)).toEqual(["chrome", "vscode"])
  })

  it("drops apps no longer present in the cache (e.g. uninstalled)", async () => {
    const service = new LauncherService()
    await service.launchById("vscode")
    listMock.mockReturnValue([makeEntry("chrome", "Chrome")])

    expect(await service.getFrequentApps()).toEqual([])
  })

  it("respects the limit parameter", async () => {
    const service = new LauncherService()
    vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(2_000)
    await service.launchById("vscode")
    await service.launchById("chrome")

    expect(await service.getFrequentApps(1)).toHaveLength(1)
  })
})
