import type { AutoUpdaterPort } from "./update-service"
import { describe, expect, it, vi } from "vitest"
import { shouldAutoCheckOnStartup, UpdateService } from "./update-service"

// A fake of electron-updater's autoUpdater: records handlers so the test can
// drive the lifecycle, and counts the action calls.
function fakeUpdater() {
  const handlers = new Map<string, (...args: unknown[]) => void>()
  return {
    autoDownload: true,
    on(event: string, handler: (...args: unknown[]) => void) {
      handlers.set(event, handler)
    },
    checkForUpdates: vi.fn(async () => ({})),
    downloadUpdate: vi.fn(async () => ({})),
    quitAndInstall: vi.fn(),
    emit(event: string, ...args: unknown[]) {
      handlers.get(event)?.(...args)
    },
  } satisfies AutoUpdaterPort & { emit: (event: string, ...args: unknown[]) => void }
}

function service(updater: ReturnType<typeof fakeUpdater>, onChange = vi.fn()) {
  return {
    svc: new UpdateService({ updater, currentVersion: "0.3.0", onChange }),
    onChange,
  }
}

describe("updateService", () => {
  it("starts idle with the current version", () => {
    const { svc } = service(fakeUpdater())
    expect(svc.getState()).toEqual({ status: "idle", currentVersion: "0.3.0" })
  })

  it("defaults to manual download (does not auto-download on check)", () => {
    const updater = fakeUpdater()
    service(updater)
    expect(updater.autoDownload).toBe(false)
  })

  it("tracks the updater lifecycle and notifies on each change", () => {
    const updater = fakeUpdater()
    const { svc, onChange } = service(updater)

    updater.emit("checking-for-update")
    expect(svc.getState().status).toBe("checking")

    updater.emit("update-available", { version: "0.4.0" })
    expect(svc.getState()).toMatchObject({ status: "available", version: "0.4.0" })

    updater.emit("download-progress", { percent: 42 })
    expect(svc.getState()).toMatchObject({ status: "downloading", percent: 42 })

    updater.emit("update-downloaded", { version: "0.4.0" })
    expect(svc.getState()).toMatchObject({ status: "downloaded", version: "0.4.0" })

    expect(onChange).toHaveBeenCalledTimes(4)
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "downloaded", version: "0.4.0" })
    )
  })

  it("reports no update when none is available", () => {
    const updater = fakeUpdater()
    const { svc } = service(updater)
    updater.emit("update-not-available", { version: "0.3.0" })
    expect(svc.getState().status).toBe("not-available")
  })

  it("captures an updater error", () => {
    const updater = fakeUpdater()
    const { svc } = service(updater)
    updater.emit("error", new Error("network down"))
    expect(svc.getState()).toMatchObject({ status: "error", error: "network down" })
  })

  it("check() sets checking and asks the updater to check", async () => {
    const updater = fakeUpdater()
    const { svc } = service(updater)
    await svc.check()
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
    expect(svc.getState().status).toBe("checking")
  })

  it("check() surfaces a thrown error as error state", async () => {
    const updater = fakeUpdater()
    updater.checkForUpdates.mockRejectedValueOnce(new Error("offline"))
    const { svc } = service(updater)
    await svc.check()
    expect(svc.getState()).toMatchObject({ status: "error", error: "offline" })
  })

  it("download() asks the updater to download", async () => {
    const updater = fakeUpdater()
    const { svc } = service(updater)
    await svc.download()
    expect(updater.downloadUpdate).toHaveBeenCalledOnce()
  })

  it("install() quits and installs", () => {
    const updater = fakeUpdater()
    const { svc } = service(updater)
    svc.install()
    expect(updater.quitAndInstall).toHaveBeenCalledOnce()
  })
})

describe("shouldAutoCheckOnStartup", () => {
  it("checks on packaged Windows and Linux", () => {
    expect(shouldAutoCheckOnStartup("win32", true)).toBe(true)
    expect(shouldAutoCheckOnStartup("linux", true)).toBe(true)
  })

  it("never checks on macOS (we ship it unsigned, so updates can't install)", () => {
    expect(shouldAutoCheckOnStartup("darwin", true)).toBe(false)
  })

  it("never checks in dev (unpackaged)", () => {
    expect(shouldAutoCheckOnStartup("win32", false)).toBe(false)
    expect(shouldAutoCheckOnStartup("darwin", false)).toBe(false)
  })
})
