import { describe, expect, it } from "vitest"
import { parseCancelFrame } from "./approval-cancel-frame"

describe("parseCancelFrame", () => {
  it("parses a valid cancel frame with reason 'cancelled'", () => {
    const result = parseCancelFrame(
      { type: "cancel", requestId: "abc", reason: "cancelled" },
      "abc"
    )
    expect(result).toEqual({ type: "cancel", requestId: "abc", reason: "cancelled" })
  })

  it("parses a valid cancel frame with reason 'timed-out'", () => {
    const result = parseCancelFrame(
      { type: "cancel", requestId: "abc", reason: "timed-out" },
      "abc"
    )
    expect(result?.reason).toBe("timed-out")
  })

  it("rejects a frame whose requestId does not match the expected one", () => {
    expect(
      parseCancelFrame({ type: "cancel", requestId: "wrong", reason: "cancelled" }, "abc")
    ).toBeUndefined()
  })

  it("rejects a frame with an invalid reason", () => {
    expect(
      parseCancelFrame({ type: "cancel", requestId: "abc", reason: "bogus" }, "abc")
    ).toBeUndefined()
  })

  it("rejects a non-cancel-typed value", () => {
    expect(parseCancelFrame({ allow: true }, "abc")).toBeUndefined()
  })

  it("rejects a non-object value", () => {
    expect(parseCancelFrame("not an object", "abc")).toBeUndefined()
    expect(parseCancelFrame(null, "abc")).toBeUndefined()
    expect(parseCancelFrame(undefined, "abc")).toBeUndefined()
  })
})
