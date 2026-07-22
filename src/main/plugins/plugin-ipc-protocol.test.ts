import { describe, expect, it } from "vitest"
import { deserializeError, nextCallId, serializeError } from "./plugin-ipc-protocol"

describe("nextCallId", () => {
  it("returns a distinct id on every call, prefixed as requested", () => {
    const a = nextCallId("cmd")
    const b = nextCallId("cmd")
    expect(a).not.toBe(b)
    expect(a.startsWith("cmd-")).toBe(true)
    expect(b.startsWith("cmd-")).toBe(true)
  })
})

describe("serializeError", () => {
  it("extracts message and stack from a real Error", () => {
    const err = new Error("boom")
    const serialized = serializeError(err)
    expect(serialized.message).toBe("boom")
    expect(serialized.stack).toBe(err.stack)
  })

  it("duck-types a message off a non-Error object (errors thrown across the child process boundary aren't real Error instances)", () => {
    const serialized = serializeError({ message: "duck-typed" })
    expect(serialized).toEqual({ message: "duck-typed", stack: undefined })
  })

  it("falls back to String() for a value with no message", () => {
    expect(serializeError("just a string").message).toBe("just a string")
    expect(serializeError(42).message).toBe("42")
  })
})

describe("deserializeError", () => {
  it("reconstructs an Error with the original message and stack", () => {
    const err = deserializeError({ message: "boom", stack: "Error: boom\n    at somewhere" })
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe("boom")
    expect(err.stack).toBe("Error: boom\n    at somewhere")
  })

  it("still produces a usable Error when no stack was captured", () => {
    const err = deserializeError({ message: "boom" })
    expect(err.message).toBe("boom")
  })
})
