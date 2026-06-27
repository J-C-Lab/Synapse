import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { DeclaredTriggersPanel } from "@/components/plugins/declared-triggers-panel"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === "plugins.triggers.budgetLine") return `${options?.max}/${options?.period}`
      if (key === "plugins.triggers.handler") return String(options?.handler)
      if (key === "plugins.triggers.contentTypes") return String(options?.types)
      return key
    },
  }),
}))

describe("declaredTriggersPanel", () => {
  it("shows clipboard surveillance disclosure and trigger uses", () => {
    render(
      <DeclaredTriggersPanel
        triggers={[
          {
            id: "on-clip",
            type: "clipboard",
            handler: "triggers.onClip",
            scope: { contentTypes: ["text"] },
            uses: [{ capability: "clipboard:read", budget: { maxCalls: 20, period: "1h" } }],
          },
        ]}
      />
    )
    expect(screen.getByText("plugins.triggers.clipboardDisclosureTitle")).toBeInTheDocument()
    expect(screen.getByText("clipboard:read: 20/1h")).toBeInTheDocument()
  })
})
