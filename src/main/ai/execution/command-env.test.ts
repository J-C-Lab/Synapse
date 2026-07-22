import { describe, expect, it } from "vitest"
import { sandboxCommandEnv } from "./command-env"

describe("sandboxCommandEnv", () => {
  it("keeps every allowlisted variable", () => {
    const source: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HOME: "/home/user",
      USERPROFILE: "C:\\Users\\user",
      SystemRoot: "C:\\Windows",
      windir: "C:\\Windows",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      TEMP: "/tmp",
      TMP: "/tmp",
      COMSPEC: "C:\\Windows\\system32\\cmd.exe",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      LC_CTYPE: "en_US.UTF-8",
      LANGUAGE: "en_US",
    }
    expect(sandboxCommandEnv(source)).toEqual(source)
  })

  // The old implementation was a denylist of known secret-shaped names, which
  // missed anything that didn't match its exact-name/prefix/suffix patterns
  // (e.g. a `_KEY` suffix instead of `_SECRET`, or a name like `DB_PASS` that
  // isn't a recognized prefix at all). An allowlist can't miss a case like
  // this: anything not explicitly named is stripped, secret-shaped or not.
  it("strips every variable outside the allowlist, including previously-missed secret shapes", () => {
    const env = sandboxCommandEnv({
      PATH: "/usr/bin",
      FOO_SECRET_KEY: "leaked",
      DB_PASS: "leaked",
      PRIVATE_TOKEN: "leaked",
      SAFE_FLAG: "1",
      NODE_OPTIONS: "--require=malicious.js",
      PYTHONPATH: "/malicious",
      GIT_SSH_COMMAND: "malicious",
    })
    expect(env).toEqual({ PATH: "/usr/bin" })
  })

  it("omits an allowlisted key entirely when it is not set in the source", () => {
    expect(sandboxCommandEnv({ PATH: "/usr/bin" })).toEqual({ PATH: "/usr/bin" })
  })
})
