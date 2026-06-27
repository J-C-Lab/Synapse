import http from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import { startOAuthLoopback } from "./credential-oauth-loopback"

describe("credentialOAuthLoopback", () => {
  const handles: Array<{ close: () => void }> = []

  afterEach(() => {
    for (const h of handles.splice(0)) h.close()
  })

  it("captures code and state on the callback path", async () => {
    const loopback = await startOAuthLoopback({ timeoutMs: 5_000 })
    handles.push(loopback)
    const state = "expected-state"
    const wait = loopback.waitForCallback(state)
    await new Promise<void>((resolve, reject) => {
      const url = new URL(`${loopback.redirectUri}?code=abc&state=${state}`)
      http
        .get(url, (res) => {
          res.resume()
          res.on("end", () => resolve())
          res.on("error", reject)
        })
        .on("error", reject)
    })
    const result = await wait
    expect(result).toEqual({ code: "abc", state })
  })

  it("rejects state mismatches and fuses after the limit", async () => {
    const loopback = await startOAuthLoopback({ timeoutMs: 5_000, maxStateMismatches: 2 })
    handles.push(loopback)
    const wait = loopback.waitForCallback("good")
    void wait.catch(() => undefined)
    const hit = (state: string) =>
      new Promise<void>((resolve, reject) => {
        http
          .get(`${loopback.redirectUri}?code=x&state=${state}`, (res) => {
            res.resume()
            res.on("end", () => resolve())
            res.on("error", reject)
          })
          .on("error", reject)
      })
    await hit("bad-1")
    await hit("bad-2")
    await expect(wait).rejects.toThrow(/state mismatches/i)
  })
})
