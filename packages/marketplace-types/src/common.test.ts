import { describe, expect, it } from "vitest"
import { httpsUrlSchema } from "./common"

describe("httpsUrlSchema", () => {
  it("accepts an ordinary https url", () => {
    expect(httpsUrlSchema.safeParse("https://example.com/verify?code=ABC123").success).toBe(true)
  })

  it("rejects a non-https url", () => {
    expect(httpsUrlSchema.safeParse("http://example.com").success).toBe(false)
  })

  // Regression test: `&` is the standard query-param separator
  // (URLSearchParams.toString() joins with it), and any real multi-param
  // url has one — most notably GitHub's own OAuth authorize url, which is
  // exactly what flows through this schema as a device-code
  // `verificationUri`. An earlier version of this schema rejected `&` as a
  // "shell metacharacter" and broke device-code login outright.
  it("accepts a real multi-param url (e.g. GitHub's OAuth authorize url)", () => {
    const url =
      "https://github.com/login/oauth/authorize?client_id=abc&redirect_uri=https%3A%2F%2Fm.test%2Fcallback&scope=read%3Auser&state=XYZ123"
    expect(httpsUrlSchema.safeParse(url).success).toBe(true)
  })

  // A verificationUri containing shell metacharacters is passed to an OS
  // "open in browser" call downstream (packages/plugin-cli/src/cli.ts).
  // Rejecting them here is defense in depth so a malicious/compromised
  // marketplace server can never even get a schema-valid response accepted,
  // regardless of how the CLI later opens the URL.
  it.each([
    "https://example.com/verify?code=ABC123|calc.exe",
    "https://example.com/verify?code=ABC123;calc.exe",
    "https://example.com/verify?code=`calc.exe`",
    "https://example.com/verify?code=ABC123\ncalc.exe",
  ])("rejects a url containing shell metacharacters: %s", (url) => {
    expect(httpsUrlSchema.safeParse(url).success).toBe(false)
  })
})
