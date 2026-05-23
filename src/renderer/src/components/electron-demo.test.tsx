import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ElectronDemo } from "./electron-demo"
import "@/i18n"

type ElectronWindow = Window & {
  electronAPI?: { greet: (name: string) => Promise<string> }
}

const win = window as ElectronWindow

describe("<ElectronDemo />", () => {
  afterEach(() => {
    cleanup()
    delete win.electronAPI
  })

  it("renders nothing when not running inside Electron", () => {
    const { container } = render(<ElectronDemo />)
    expect(container).toBeEmptyDOMElement()
  })

  describe("inside Electron", () => {
    it("renders the trigger button", () => {
      win.electronAPI = { greet: vi.fn().mockResolvedValue("Hello, World!") }
      render(<ElectronDemo />)
      expect(screen.getByRole("button", { name: /call electron greet/i })).toBeInTheDocument()
    })

    it("displays the message returned by greet()", async () => {
      const user = userEvent.setup()
      win.electronAPI = { greet: vi.fn().mockResolvedValue("Hello, World!") }
      render(<ElectronDemo />)
      await user.click(screen.getByRole("button", { name: /call electron greet/i }))
      expect(await screen.findByText("Hello, World!")).toBeInTheDocument()
    })

    it("surfaces a thrown error from greet()", async () => {
      const user = userEvent.setup()
      win.electronAPI = { greet: vi.fn().mockRejectedValue(new Error("boom")) }
      render(<ElectronDemo />)
      await user.click(screen.getByRole("button", { name: /call electron greet/i }))
      expect(await screen.findByText("boom")).toBeInTheDocument()
    })

    it("stringifies non-Error rejections", async () => {
      const user = userEvent.setup()
      win.electronAPI = { greet: vi.fn().mockRejectedValue("plain string") }
      render(<ElectronDemo />)
      await user.click(screen.getByRole("button", { name: /call electron greet/i }))
      expect(await screen.findByText("plain string")).toBeInTheDocument()
    })
  })
})
