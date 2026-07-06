import { describe, expect, it } from "vitest"
import { sandboxCommandEnv } from "./command-env"

describe("sandboxCommandEnv", () => {
  it("strips common secret-bearing variables", () => {
    const env = sandboxCommandEnv({
      PATH: "/usr/bin",
      OPENAI_API_KEY: "sk-secret",
      GITHUB_TOKEN: "ghp_secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      MY_APP_TOKEN: "token",
      SAFE_FLAG: "1",
    })
    expect(env).toEqual({
      PATH: "/usr/bin",
      SAFE_FLAG: "1",
    })
  })
})
