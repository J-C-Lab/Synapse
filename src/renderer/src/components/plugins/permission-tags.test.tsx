import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { PermissionTagList } from "./permission-tags"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  }),
}))

describe("permissionTagList", () => {
  it("deduplicates and sorts permissions", () => {
    render(
      <PermissionTagList permissions={["system:open-url", "clipboard:read", "clipboard:read"]} />
    )

    expect(screen.getAllByText(/:/).map((item) => item.textContent)).toEqual([
      "clipboard:read",
      "system:open-url",
    ])
  })

  it("shows an empty label when no permissions are requested", () => {
    render(<PermissionTagList emptyLabel="No permissions" permissions={[]} />)

    expect(screen.getByText("No permissions")).toBeInTheDocument()
  })
})
