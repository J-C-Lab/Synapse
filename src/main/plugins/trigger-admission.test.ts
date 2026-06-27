import { describe, expect, it } from "vitest"
import { AdmissionBreaker } from "./trigger-admission"

const PLUGIN_A = "com.example.a"
const PLUGIN_B = "com.example.b"
const TRIGGER = "sync"

describe("admissionBreaker", () => {
  it("drops fires below the min interval (coalesce)", () => {
    let now = 0
    const b = new AdmissionBreaker(() => now)
    b.configure(PLUGIN_A, "t", { minIntervalMs: 1000, maxConcurrency: 4 })
    expect(b.admit(PLUGIN_A, "t")).toEqual({ ok: true })
    now = 500
    expect(b.admit(PLUGIN_A, "t")).toEqual({ ok: false, reason: "throttled" })
    now = 1000
    expect(b.admit(PLUGIN_A, "t")).toEqual({ ok: true })
  })

  it("rejects past the concurrency cap and recovers on release", () => {
    const b = new AdmissionBreaker(() => 0)
    b.configure(PLUGIN_A, "t", { minIntervalMs: 0, maxConcurrency: 1 })
    expect(b.admit(PLUGIN_A, "t").ok).toBe(true)
    expect(b.admit(PLUGIN_A, "t")).toEqual({ ok: false, reason: "throttled" })
    b.release(PLUGIN_A, "t")
    expect(b.admit(PLUGIN_A, "t").ok).toBe(true)
  })

  it("auto-pauses after consecutive faults and stays paused", () => {
    const b = new AdmissionBreaker(() => 0)
    b.configure(PLUGIN_A, "t", { minIntervalMs: 0, maxConcurrency: 8, faultThreshold: 2 })
    b.admit(PLUGIN_A, "t")
    b.recordFault(PLUGIN_A, "t")
    b.admit(PLUGIN_A, "t")
    b.recordFault(PLUGIN_A, "t")
    expect(b.admit(PLUGIN_A, "t")).toEqual({ ok: false, reason: "faulted" })
  })

  it("a success resets the fault counter", () => {
    const b = new AdmissionBreaker(() => 0)
    b.configure(PLUGIN_A, "t", { minIntervalMs: 0, maxConcurrency: 8, faultThreshold: 2 })
    b.admit(PLUGIN_A, "t")
    b.recordFault(PLUGIN_A, "t")
    b.admit(PLUGIN_A, "t")
    b.recordSuccess(PLUGIN_A, "t")
    b.admit(PLUGIN_A, "t")
    b.recordFault(PLUGIN_A, "t")
    expect(b.admit(PLUGIN_A, "t").ok).toBe(true)
  })

  it("manual pause/resume gates admission", () => {
    const b = new AdmissionBreaker(() => 0)
    b.configure(PLUGIN_A, "t", { minIntervalMs: 0, maxConcurrency: 8 })
    b.pause(PLUGIN_A, "t")
    expect(b.admit(PLUGIN_A, "t")).toEqual({ ok: false, reason: "paused" })
    b.resume(PLUGIN_A, "t")
    expect(b.admit(PLUGIN_A, "t").ok).toBe(true)
  })

  it("isolates admission state per plugin for the same trigger id", () => {
    const b = new AdmissionBreaker(() => 0)
    b.configure(PLUGIN_A, TRIGGER, { minIntervalMs: 0, maxConcurrency: 1 })
    b.configure(PLUGIN_B, TRIGGER, { minIntervalMs: 0, maxConcurrency: 1 })
    expect(b.admit(PLUGIN_A, TRIGGER).ok).toBe(true)
    b.remove(PLUGIN_A, TRIGGER)
    expect(b.admit(PLUGIN_B, TRIGGER).ok).toBe(true)
  })

  it("does not share fault state across plugins with the same trigger id", () => {
    const b = new AdmissionBreaker(() => 0)
    b.configure(PLUGIN_A, TRIGGER, { minIntervalMs: 0, maxConcurrency: 8, faultThreshold: 1 })
    b.configure(PLUGIN_B, TRIGGER, { minIntervalMs: 0, maxConcurrency: 8, faultThreshold: 1 })
    b.admit(PLUGIN_A, TRIGGER)
    b.recordFault(PLUGIN_A, TRIGGER)
    expect(b.admit(PLUGIN_A, TRIGGER)).toEqual({ ok: false, reason: "faulted" })
    expect(b.admit(PLUGIN_B, TRIGGER).ok).toBe(true)
  })
})
