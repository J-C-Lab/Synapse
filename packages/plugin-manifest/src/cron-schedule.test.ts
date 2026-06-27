import { describe, expect, it } from "vitest"
import {
  nextCronFire,
  normalizeCronExpression,
  parseCronExpression,
  validateCronExpression,
} from "./cron-schedule"

describe("normalizeCronExpression", () => {
  it("accepts five fields with collapsed whitespace", () => {
    expect(normalizeCronExpression("  0   9  *  *  * ")).toBe("0 9 * * *")
  })

  it("rejects wrong field count", () =>
    expect(() => normalizeCronExpression("0 9 * *")).toThrow(/five fields/))
})

describe("parseCronExpression", () => {
  it("parses lists, ranges, and steps", () => {
    const fields = parseCronExpression("*/15 9-17 1,15 * 1-5")
    expect(fields.minute).toEqual([0, 15, 30, 45])
    expect(fields.hour).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17])
    expect(fields.dayOfMonth).toEqual([1, 15])
    expect(fields.dayOfWeek).toEqual([1, 2, 3, 4, 5])
  })

  it("maps Sunday 7 to 0", () => {
    expect(parseCronExpression("0 0 * * 7").dayOfWeek).toEqual([0])
  })
})

describe("nextCronFire", () => {
  it("finds the next daily fire", () => {
    const after = new Date(2025, 0, 1, 8, 59, 30).getTime()
    expect(nextCronFire(after, "0 9 * * *")).toBe(new Date(2025, 0, 1, 9, 0, 0).getTime())
  })

  it("skips to the next day after today’s slot has passed", () => {
    const after = new Date(2025, 0, 1, 10, 0, 0).getTime()
    expect(nextCronFire(after, "0 9 * * *")).toBe(new Date(2025, 0, 2, 9, 0, 0).getTime())
  })

  it("finds the next monthly fire on day-of-month only schedules", () => {
    const after = new Date(2025, 0, 2, 8, 0, 0).getTime()
    expect(nextCronFire(after, "0 9 1 * *")).toBe(new Date(2025, 1, 1, 9, 0, 0).getTime())
  })
})

describe("validateCronExpression", () => {
  it("accepts a daily schedule", () => {
    expect(() => validateCronExpression("0 9 * * *")).not.toThrow()
  })

  it("rejects invalid field values", () =>
    expect(() => validateCronExpression("60 0 * * *")).toThrow(/out of range/))
})

describe("summarize via normalize", () => {
  it("is stable for equivalent spacing", () => {
    expect(normalizeCronExpression("0 9 * * 1")).toBe("0 9 * * 1")
  })
})
