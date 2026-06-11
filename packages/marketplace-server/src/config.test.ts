import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadConfig, loadDotEnvFile } from "./config"

describe("loadConfig security flags", () => {
  it("defaults to rate limiting on and the approve endpoint off", () => {
    const config = loadConfig({} as NodeJS.ProcessEnv)
    expect(config.RATE_LIMIT_ENABLED).toBe(true)
    expect(config.RATE_LIMIT_MAX).toBe(300)
    expect(config.ENABLE_DEVICE_APPROVE_ENDPOINT).toBe(false)
  })

  it("parses string booleans from the environment", () => {
    const config = loadConfig({
      RATE_LIMIT_ENABLED: "false",
      RATE_LIMIT_MAX: "25",
      ENABLE_DEVICE_APPROVE_ENDPOINT: "true",
    } as NodeJS.ProcessEnv)
    expect(config.RATE_LIMIT_ENABLED).toBe(false)
    expect(config.RATE_LIMIT_MAX).toBe(25)
    expect(config.ENABLE_DEVICE_APPROVE_ENDPOINT).toBe(true)
  })
})

describe("loadDotEnvFile", () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-market-env-"))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("loads key-value pairs from a local env file", async () => {
    const file = path.join(dir, ".env")
    await fs.writeFile(
      file,
      [
        "# local marketplace config",
        "DATABASE_URL=postgresql://user:pass@localhost/db",
        "GITHUB_CLIENT_ID=abc",
        'GITHUB_CLIENT_SECRET="secret value"',
      ].join("\n"),
      "utf-8"
    )
    const env: NodeJS.ProcessEnv = {}

    expect(loadDotEnvFile(file, env)).toBe(true)

    expect(env.DATABASE_URL).toBe("postgresql://user:pass@localhost/db")
    expect(env.GITHUB_CLIENT_ID).toBe("abc")
    expect(env.GITHUB_CLIENT_SECRET).toBe("secret value")
  })

  it("keeps existing environment values", async () => {
    const file = path.join(dir, ".env")
    await fs.writeFile(file, "DATABASE_URL=postgresql://from-file/db", "utf-8")
    const env: NodeJS.ProcessEnv = { DATABASE_URL: "postgresql://from-shell/db" }

    expect(loadDotEnvFile(file, env)).toBe(true)

    expect(env.DATABASE_URL).toBe("postgresql://from-shell/db")
  })

  it("returns false when the env file is absent", () => {
    expect(loadDotEnvFile(path.join(dir, ".env"), {})).toBe(false)
  })
})
