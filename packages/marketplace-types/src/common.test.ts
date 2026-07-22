import { describe, expect, it } from "vitest"
import { httpsUrlSchema } from "./common"

describe("httpsUrlSchema", () => {
  it("accepts an ordinary https url", () => {
    expect(httpsUrlSchema.safeParse("https://example.com/verify?code=ABC123").success).toBe(true)
  })

  it("rejects a non-https url", () => {
    expect(httpsUrlSchema.safeParse("http://example.com").success).toBe(false)
  })

  // A verificationUri containing shell metacharacters is passed to an OS
  // "open in browser" call downstream (packages/plugin-cli/src/cli.ts).
  // Rejecting them here is defense in depth so a malicious/compromised
  // marketplace server can never even get a schema-valid response accepted,
  // regardless of how the CLI later opens the URL.
  it.each([
    "https://example.com/verify?code=ABC123&calc.exe",
    "https://example.com/verify?code=ABC123|calc.exe",
    "https://example.com/verify?code=ABC123;calc.exe",
    "https://example.com/verify?code=`calc.exe`",
    "https://example.com/verify?code=ABC123\ncalc.exe",
  ])("rejects a url containing shell metacharacters: %s", (url) => {
    expect(httpsUrlSchema.safeParse(url).success).toBe(false)
  })
})
