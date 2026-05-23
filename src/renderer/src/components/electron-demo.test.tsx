import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ElectronDemo } from "./electron-demo"
import "@/i18n"

// The tests only exercise `greet`; the rest of the launcher surface is
// irrelevant here. Stub by casting through `unknown` so we don't have to
// mock every method on Window.electronAPI.
function installApi(greet: (name: string) => Promise<string>): void {
  window.electronAPI = { greet } as unknown as Window["electronAPI"]
}

describe("<ElectronDemo />", () => {
  afterEach(() => {
    cleanup()
    delete window.electronAPI
  })

  it("renders nothing when not running inside Electron", () => {
    const { container } = render(<ElectronDemo />)
    expect(container).toBeEmptyDOMElement()
  })

  describe("inside Electron", () => {
    it("renders the trigger button", () => {
      installApi(vi.fn().mockResolvedValue("Hello, World!"))
      render(<ElectronDemo />)
      expect(screen.getByRole("button", { name: /call electron greet/i })).toBeInTheDocument()
    })

    it("displays the message returned by greet()", async () => {
      const user = userEvent.setup()
      installApi(vi.fn().mockResolvedValue("Hello, World!"))
      render(<ElectronDemo />)
      await user.click(screen.getByRole("button", { name: /call electron greet/i }))
      expect(await screen.findByText("Hello, World!")).toBeInTheDocument()
    })

    it("surfaces a thrown error from greet()", async () => {
      const user = userEvent.setup()
      installApi(vi.fn().mockRejectedValue(new Error("boom")))
      render(<ElectronDemo />)
      await user.click(screen.getByRole("button", { name: /call electron greet/i }))
      expect(await screen.findByText("boom")).toBeInTheDocument()
    })

    it("stringifies non-Error rejections", async () => {
      const user = userEvent.setup()
      installApi(vi.fn().mockRejectedValue("plain string"))
      render(<ElectronDemo />)
      await user.click(screen.getByRole("button", { name: /call electron greet/i }))
      expect(await screen.findByText("plain string")).toBeInTheDocument()
    })
  })
})
