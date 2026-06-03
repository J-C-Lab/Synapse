import { describe, expect, it } from "vitest"
import { coerceApprove, coerceChat } from "./ai"

describe("coerceChat", () => {
  it("accepts a well-formed payload", () => {
    expect(coerceChat({ conversationId: "c1", text: "hello" })).toEqual({
      conversationId: "c1",
      text: "hello",
    })
  })

  it("rejects missing fields", () => {
    expect(() => coerceChat({ conversationId: "c1" })).toThrow(/text must be a string/)
    expect(() => coerceChat(null)).toThrow(/must be an object/)
  })
})

describe("coerceApprove", () => {
  it("defaults remember to once", () => {
    expect(coerceApprove({ approvalId: "a1", allow: true })).toEqual({
      approvalId: "a1",
      allow: true,
      remember: "once",
    })
  })

  it("accepts a valid remember scope", () => {
    expect(coerceApprove({ approvalId: "a1", allow: false, remember: "always" }).remember).toBe(
      "always"
    )
  })

  it("rejects a bad remember scope and non-boolean allow", () => {
    expect(() => coerceApprove({ approvalId: "a1", allow: true, remember: "forever" })).toThrow(
      /remember must be/
    )
    expect(() => coerceApprove({ approvalId: "a1", allow: "yes" })).toThrow(
      /allow must be a boolean/
    )
  })
})
