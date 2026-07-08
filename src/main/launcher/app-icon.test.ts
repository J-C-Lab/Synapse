import { app } from "electron"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { resolveAppIcon } from "./app-icon"

vi.mock("electron", () => ({
  app: { getFileIcon: vi.fn() },
}))

describe("resolveAppIcon", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns undefined when no icon path is given", async () => {
    expect(await resolveAppIcon(undefined)).toBeUndefined()
    expect(app.getFileIcon).not.toHaveBeenCalled()
  })

  it("returns a data URL for a resolvable icon", async () => {
    vi.mocked(app.getFileIcon).mockResolvedValue({
      isEmpty: () => false,
      toDataURL: () => "data:image/png;base64,abc",
    } as never)

    expect(await resolveAppIcon("C:\\app.exe")).toBe("data:image/png;base64,abc")
  })

  it("returns undefined when the resolved icon is empty", async () => {
    vi.mocked(app.getFileIcon).mockResolvedValue({
      isEmpty: () => true,
      toDataURL: () => "",
    } as never)

    expect(await resolveAppIcon("C:\\empty-icon.exe")).toBeUndefined()
  })

  it("returns undefined and swallows the error if getFileIcon rejects", async () => {
    vi.mocked(app.getFileIcon).mockRejectedValue(new Error("nope"))

    await expect(resolveAppIcon("C:\\missing.exe")).resolves.toBeUndefined()
  })

  it("caches the result so a repeat lookup does not call getFileIcon again", async () => {
    vi.mocked(app.getFileIcon).mockResolvedValue({
      isEmpty: () => false,
      toDataURL: () => "data:image/png;base64,cached",
    } as never)

    await resolveAppIcon("C:\\cached.exe")
    await resolveAppIcon("C:\\cached.exe")

    expect(app.getFileIcon).toHaveBeenCalledTimes(1)
  })
})
