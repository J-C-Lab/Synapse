import type { JsonSchema } from "@synapse/plugin-manifest"
import { describe, expect, it } from "vitest"
import { validateToolInput } from "./tool-input-validation"

const schema: JsonSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    count: { type: "integer" },
    unit: { type: "string", enum: ["s", "ms"] },
    tags: { type: "array", items: { type: "string" } },
    nested: {
      type: "object",
      properties: { flag: { type: "boolean" } },
      required: ["flag"],
    },
  },
  required: ["name"],
}

describe("validateToolInput", () => {
  it("accepts valid input", () => {
    expect(
      validateToolInput(schema, {
        name: "x",
        count: 3,
        unit: "s",
        tags: ["a", "b"],
        nested: { flag: true },
      })
    ).toEqual([])
  })

  it("reports a missing required property", () => {
    const issues = validateToolInput(schema, { count: 1 })
    expect(issues).toContain("input.name: required")
  })

  it("reports a wrong primitive type", () => {
    const issues = validateToolInput(schema, { name: 5 })
    expect(issues.some((issue) => issue.startsWith("input.name: expected string"))).toBe(true)
  })

  it("rejects non-integers for integer fields", () => {
    const issues = validateToolInput(schema, { name: "x", count: 1.5 })
    expect(issues.some((issue) => issue.startsWith("input.count: expected integer"))).toBe(true)
  })

  it("enforces enum membership", () => {
    const issues = validateToolInput(schema, { name: "x", unit: "h" })
    expect(issues.some((issue) => issue.startsWith("input.unit: must be one of"))).toBe(true)
  })

  it("recurses into array items and nested objects", () => {
    const issues = validateToolInput(schema, {
      name: "x",
      tags: ["ok", 2],
      nested: {},
    })
    expect(issues).toContain("input.nested.flag: required")
    expect(issues.some((issue) => issue.startsWith("input.tags[1]: expected string"))).toBe(true)
  })

  it("flags a non-object root", () => {
    const issues = validateToolInput(schema, "not an object")
    expect(issues.some((issue) => issue.startsWith("input: expected object"))).toBe(true)
  })
})
