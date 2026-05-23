import { describe, expect, it } from "vitest"
import { greet } from "./greet"

describe("greet", () => {
  it("returns greeting for non-empty name", () => {
    expect(greet("World")).toBe("Hello, World! Welcome to DesKit.")
  })

  it("throws for empty string", () => {
    expect(() => greet("")).toThrow("name cannot be empty")
  })

  it("throws for whitespace-only string", () => {
    expect(() => greet("   ")).toThrow("name cannot be empty")
  })
})
