import { describe, expect, it } from "vitest"
import { networkHttpsAdapter as a } from "./network-scope"

describe("validate", () => {
  it("rejects empty hosts", () => expect(() => a.validate({ hosts: [] })).toThrow())
  it("rejects missing hosts", () => expect(() => a.validate({})).toThrow())
  it("rejects non-array hosts", () => expect(() => a.validate({ hosts: "x.com" })).toThrow())
  it("rejects IPv4 literal host", () =>
    expect(() => a.validate({ hosts: ["127.0.0.1"] })).toThrow())
  it("rejects localhost and .local", () => {
    expect(() => a.validate({ hosts: ["localhost"] })).toThrow()
    expect(() => a.validate({ hosts: ["printer.local"] })).toThrow()
  })
  it("rejects wildcard, scheme, port, path in host", () => {
    expect(() => a.validate({ hosts: ["*.github.com"] })).toThrow()
    expect(() => a.validate({ hosts: ["https://api.github.com"] })).toThrow()
    expect(() => a.validate({ hosts: ["api.github.com:8443"] })).toThrow()
    expect(() => a.validate({ hosts: ["api.github.com/x"] })).toThrow()
  })
  it("rejects bracketed IPv6 host", () => expect(() => a.validate({ hosts: ["[::1]"] })).toThrow())
  it("rejects non-bracketed IPv6 host", () =>
    expect(() => a.validate({ hosts: ["::1"] })).toThrow())
  it("rejects encoded IPv4 that normalizes to a loopback literal", () => {
    expect(() => a.validate({ hosts: ["2130706433"] })).toThrow()
    expect(() => a.validate({ hosts: ["0177.0.0.1"] })).toThrow()
    expect(() => a.validate({ hosts: ["0x7f.0.0.1"] })).toThrow()
  })
  it("rejects userinfo smuggling that normalizes to another host", () =>
    expect(() => a.validate({ hosts: ["x.com@evil.com"] })).toThrow())
  it("rejects localhost/.local regardless of case (normalized)", () => {
    expect(() => a.validate({ hosts: ["LOCALHOST"] })).toThrow()
    expect(() => a.validate({ hosts: ["printer.LOCAL"] })).toThrow()
  })
  it("rejects single-label host (no dot)", () =>
    expect(() => a.validate({ hosts: ["example"] })).toThrow())
  it("rejects bad methods", () =>
    expect(() => a.validate({ hosts: ["x.com"], methods: ["GE T"] })).toThrow())
  it("rejects bad path patterns", () => {
    expect(() => a.validate({ hosts: ["x.com"], paths: ["/a/../b"] })).toThrow()
    expect(() => a.validate({ hosts: ["x.com"], paths: ["/a/*/b"] })).toThrow()
    expect(() => a.validate({ hosts: ["x.com"], paths: ["/a?x=1"] })).toThrow()
    expect(() => a.validate({ hosts: ["x.com"], paths: ["/a#frag"] })).toThrow()
    expect(() => a.validate({ hosts: ["x.com"], paths: ["no-slash"] })).toThrow()
  })
  it("accepts trailing /** path", () =>
    expect(() => a.validate({ hosts: ["x.com"], paths: ["/repos/**"] })).not.toThrow())
  it("accepts a valid scope", () =>
    expect(() =>
      a.validate({
        hosts: ["api.github.com"],
        methods: ["get", "post"],
        paths: ["/repos/**", "/user"],
      })
    ).not.toThrow())
})

describe("canonicalize", () => {
  it("punycodes+lowercases hosts, uppercases+dedupes methods, defaults", () => {
    const c = a.canonicalize({ hosts: ["münchen.de"], methods: ["get", "get", "post"] }) as {
      hosts: string[]
      methods: string[]
      paths: string[]
    }
    expect(c.hosts).toEqual(["xn--mnchen-3ya.de"])
    expect(c.methods).toEqual(["GET", "POST"])
    expect(c.paths).toEqual(["/**"])
  })
  it("dedupes and sorts hosts and paths", () => {
    const c = a.canonicalize({
      hosts: ["b.com", "a.com", "a.com"],
      paths: ["/z", "/a", "/a"],
    }) as { hosts: string[]; paths: string[] }
    expect(c.hosts).toEqual(["a.com", "b.com"])
    expect(c.paths).toEqual(["/a", "/z"])
  })
})

describe("merge", () => {
  it("unions hosts/methods/paths across scopes and ignores null", () => {
    const m = a.merge([
      { hosts: ["a.com"], methods: ["GET"], paths: ["/x"] },
      null,
      { hosts: ["b.com"], methods: ["POST"], paths: ["/y"] },
    ]) as { hosts: string[]; methods: string[]; paths: string[] }
    expect(m.hosts).toEqual(["a.com", "b.com"])
    expect(m.methods).toEqual(["GET", "POST"])
    expect(m.paths).toEqual(["/x", "/y"])
  })
})

describe("contains", () => {
  const d = a.canonicalize({
    hosts: ["api.github.com"],
    methods: ["GET", "POST"],
    paths: ["/repos/**"],
  })
  it("matches host+method+prefix path", () =>
    expect(a.contains(d, { host: "api.github.com", method: "GET", path: "/repos/x/y" })).toBe(true))
  it("matches the bare prefix root", () =>
    expect(a.contains(d, { host: "api.github.com", method: "GET", path: "/repos" })).toBe(true))
  it("rejects undeclared host", () =>
    expect(a.contains(d, { host: "evil.com", method: "GET", path: "/repos/x" })).toBe(false))
  it("rejects undeclared method", () =>
    expect(a.contains(d, { host: "api.github.com", method: "DELETE", path: "/repos/x" })).toBe(
      false
    ))
  it("rejects path outside prefix", () =>
    expect(a.contains(d, { host: "api.github.com", method: "GET", path: "/users/x" })).toBe(false))
  it("does not let /repos prefix match /reposX", () =>
    expect(a.contains(d, { host: "api.github.com", method: "GET", path: "/reposX" })).toBe(false))
  it("exact path matches only exactly", () => {
    const e = a.canonicalize({ hosts: ["x.com"], paths: ["/user"] })
    expect(a.contains(e, { host: "x.com", method: "GET", path: "/user" })).toBe(true)
    expect(a.contains(e, { host: "x.com", method: "GET", path: "/user/2" })).toBe(false)
  })
})

describe("sanitize", () => {
  it("sanitizeScope drops url/path/query from a requested scope", () => {
    const out = a.sanitizeScope({
      url: "https://api.github.com/u?token=x",
      origin: "https://api.github.com",
      host: "api.github.com",
      method: "GET",
      path: "/u",
      matchedPathPattern: "/**",
    }) as Record<string, unknown>
    expect(JSON.stringify(out)).not.toContain("token")
    expect(JSON.stringify(out)).not.toContain("/u")
    expect(out).toEqual({ host: "api.github.com", method: "GET", matchedPathPattern: "/**" })
  })
  it("sanitizeScope passes a canonical declared scope through", () => {
    const d = a.canonicalize({ hosts: ["api.github.com"] })
    expect(a.sanitizeScope(d)).toEqual(d)
  })
  it("sanitizeOperation builds METHOD host+pattern", () => {
    expect(
      a.sanitizeOperation("x", {
        host: "api.github.com",
        method: "GET",
        matchedPathPattern: "/repos/**",
      })
    ).toBe("GET api.github.com/repos/**")
  })
  it("sanitizeOperation returns operation unchanged without a requested scope", () =>
    expect(a.sanitizeOperation("connect")).toBe("connect"))
  it("summarize mentions hosts", () =>
    expect(a.summarize(a.canonicalize({ hosts: ["api.github.com"] }))).toMatch(/api\.github\.com/))
})
