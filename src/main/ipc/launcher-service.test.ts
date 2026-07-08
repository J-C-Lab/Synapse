import type { AppEntry } from "../launcher/types"
import type { UserSettings } from "../settings/settings"
import { app } from "electron"
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

const loadSettingsMock = vi.fn<() => Promise<UserSettings>>()
const saveSettingsMock = vi.fn<(filePath: string, settings: UserSettings) => Promise<void>>()

vi.mock("../settings/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../settings/settings")>()
  return {
    ...actual,
    loadSettings: loadSettingsMock,
    saveSettings: saveSettingsMock,
  }
})

const { LauncherService } = await import("./launcher-service")
const { defaultSettings } = await import("../settings/settings")

function makeEntry(id: string, name = id): AppEntry {
  return { id, kind: "win32", name, nameLower: name.toLowerCase(), target: `C:\\${name}.exe` }
}

describe("launcherService usage tracking", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listMock.mockReturnValue([makeEntry("vscode", "VS Code"), makeEntry("chrome", "Chrome")])
    launchAppMock.mockResolvedValue(true)
    loadSettingsMock.mockResolvedValue({ ...defaultSettings })
    saveSettingsMock.mockResolvedValue(undefined)
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

  it("persists usage to disk after init, incrementing launchCount across repeated launches", async () => {
    const service = new LauncherService()
    await service.init()
    vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(2_000)

    await service.launchById("vscode")
    await service.launchById("vscode")

    expect(saveSettingsMock).toHaveBeenCalledTimes(2)
    const lastCall = saveSettingsMock.mock.calls.at(-1)
    expect(lastCall?.[1].appUsage.vscode).toEqual({ lastLaunchedAt: 2_000, launchCount: 2 })
    expect(service.getSettings().appUsage.vscode).toEqual({ lastLaunchedAt: 2_000, launchCount: 2 })
  })

  it("resolves the launch as successful even when persisting usage fails", async () => {
    saveSettingsMock.mockRejectedValueOnce(new Error("disk full"))
    const service = new LauncherService()
    await service.init()

    await expect(service.launchById("vscode")).resolves.toBe(true)
  })

  it("attaches a resolved icon data URL when the entry has an iconPath", async () => {
    listMock.mockReturnValue([{ ...makeEntry("vscode", "VS Code"), iconPath: "C:\\vscode.exe" }])
    vi.mocked(app.getFileIcon).mockResolvedValue({
      isEmpty: () => false,
      toDataURL: () => "data:image/png;base64,icon",
    } as never)
    const service = new LauncherService()
    vi.spyOn(Date, "now").mockReturnValue(1_000)

    await service.launchById("vscode")

    const [frequent] = await service.getFrequentApps()
    expect(frequent.iconDataUrl).toBe("data:image/png;base64,icon")
  })

  it("removes an app from the frequent list without touching other entries", async () => {
    const service = new LauncherService()
    vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(2_000)
    await service.launchById("vscode")
    await service.launchById("chrome")

    await service.removeFrequentApp("vscode")

    const frequent = await service.getFrequentApps()
    expect(frequent.map((row) => row.entry.id)).toEqual(["chrome"])
  })

  it("removeFrequentApp is a harmless no-op for an id with no usage record", async () => {
    const service = new LauncherService()

    await expect(service.removeFrequentApp("never-launched")).resolves.toBeUndefined()
  })
})
