import type { RenderablePluginView } from "@/components/plugins/view-types"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { ViewRenderer } from "@/components/plugins/view-renderer"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: "en" },
  }),
}))

describe("viewRenderer", () => {
  it("renders list items and sends the selected item with row actions", async () => {
    const user = userEvent.setup()
    const onAction = vi.fn()
    const view: RenderablePluginView = {
      type: "list",
      items: [
        {
          id: "copy-hello",
          title: "Copy hello",
          subtitle: "Copies a test value",
          actions: [{ type: "copy", value: "hello" }],
        },
      ],
    }

    render(<ViewRenderer view={view} onAction={onAction} />)
    await user.click(screen.getByRole("button", { name: /copy hello/i }))

    expect(screen.getByText("Copies a test value")).toBeInTheDocument()
    expect(onAction).toHaveBeenCalledWith(view.items?.[0].actions?.[0], {
      item: view.items?.[0],
    })
  })

  it("submits form values through the submit action", async () => {
    const user = userEvent.setup()
    const onAction = vi.fn()
    const view: RenderablePluginView = {
      type: "form",
      fields: [
        {
          id: "name",
          type: "text",
          label: "Name",
          default: "initial",
        },
      ],
      submitLabel: "Save",
      actions: [{ type: "submit", label: "Save" }],
    }

    render(<ViewRenderer view={view} onAction={onAction} />)
    await user.clear(screen.getByLabelText("Name"))
    await user.type(screen.getByLabelText("Name"), "DesKit")
    await user.click(screen.getByRole("button", { name: /save/i }))

    expect(onAction).toHaveBeenCalledWith(view.actions?.[0], {
      values: { name: "DesKit" },
    })
  })
})
