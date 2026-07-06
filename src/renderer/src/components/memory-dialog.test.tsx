import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { MemoryDialog } from "@/components/memory-dialog"
import * as electron from "@/lib/electron"

vi.mock("@/lib/electron", () => ({
  isElectron: () => true,
  droppedFilePath: vi.fn(() => "/tmp/guide.md"),
  listMemorySources: vi.fn(),
  listMemories: vi.fn(),
  ingestMemoryDocument: vi.fn().mockResolvedValue({ source: "x", chunks: 3 }),
  ingestMemoryDocumentFromPath: vi.fn().mockResolvedValue({ source: "x", chunks: 3 }),
  deleteMemory: vi.fn().mockResolvedValue(true),
  deleteMemorySource: vi.fn().mockResolvedValue(2),
}))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const listMemorySources = vi.mocked(electron.listMemorySources)
const listMemories = vi.mocked(electron.listMemories)

beforeEach(() => {
  vi.clearAllMocks()
  listMemorySources.mockResolvedValue([])
  listMemories.mockResolvedValue([])
})

describe("memoryDialog", () => {
  it("lists imported documents with their chunk counts", async () => {
    listMemorySources.mockResolvedValue([{ source: "guide.md", count: 7 }])
    render(<MemoryDialog open onOpenChange={() => {}} />)
    expect(await screen.findByText("guide.md")).toBeInTheDocument()
    expect(screen.getByText(/7/)).toBeInTheDocument()
  })

  it("deletes a document by source and refreshes", async () => {
    listMemorySources.mockResolvedValue([{ source: "guide.md", count: 7 }])
    render(<MemoryDialog open onOpenChange={() => {}} />)
    await screen.findByText("guide.md")

    const del = screen.getByRole("button", { name: /memory.delete/ })
    await userEvent.click(del)
    const confirm = await screen.findByRole("button", { name: /memory.deleteConfirm/ })
    await userEvent.click(confirm)
    expect(electron.deleteMemorySource).toHaveBeenCalledWith("guide.md")
    await waitFor(() => expect(listMemorySources).toHaveBeenCalledTimes(2))
  })

  it("shows standalone facts (non-document memories) separately", async () => {
    listMemories.mockResolvedValue([
      {
        id: "1",
        text: "the api base is example.com",
        tags: [],
        createdAt: 1,
        scope: { visibility: "workspace", workspaceId: "repo" },
      },
      {
        id: "2",
        text: "a document chunk",
        tags: ["source:guide.md"],
        createdAt: 2,
        scope: { visibility: "global" },
      },
    ])
    render(<MemoryDialog open onOpenChange={() => {}} />)
    expect(await screen.findByText("the api base is example.com")).toBeInTheDocument()
    expect(screen.getByText("workspace:repo")).toBeInTheDocument()
    // The chunk belongs to a document, so it is not shown in the facts list.
    expect(screen.queryByText("a document chunk")).not.toBeInTheDocument()
  })
})
