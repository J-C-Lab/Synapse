import { describe, expect, it } from "vitest"
import { formatRelativeTime } from "./format-relative-time"

describe("formatRelativeTime", () => {
  const now = new Date("2026-07-08T12:00:00Z").getTime()

  it("formats minutes ago", () => {
    expect(formatRelativeTime(now - 5 * 60 * 1000, "en", now)).toBe("5 minutes ago")
  })

  it("formats hours ago", () => {
    expect(formatRelativeTime(now - 2 * 60 * 60 * 1000, "en", now)).toBe("2 hours ago")
  })

  it("formats days ago", () => {
    expect(formatRelativeTime(now - 3 * 24 * 60 * 60 * 1000, "en", now)).toBe("3 days ago")
  })

  it("falls back to a 'this minute' bucket for anything under a minute", () => {
    expect(formatRelativeTime(now - 10 * 1000, "en", now)).toBe("this minute")
  })
})
