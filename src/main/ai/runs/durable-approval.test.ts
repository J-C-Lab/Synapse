import { describe, expect, it } from "vitest"
import { decideDurableApproval } from "./durable-approval"

describe("decideDurableApproval", () => {
  it("auto-allows a read-only tool with no resolver configured", async () => {
    const decision = await decideDurableApproval({
      fqName: "host:read_file",
      safeName: "read_file",
      input: {},
      annotations: { readOnlyHint: true },
    })
    expect(decision).toBe("allow")
  })

  it("asks for an unannotated tool by default", async () => {
    const decision = await decideDurableApproval({
      fqName: "host:mystery",
      safeName: "mystery",
      input: {},
      annotations: undefined,
    })
    expect(decision).toBe("ask")
  })

  it("asks for a destructive tool when no resolver overrides it", async () => {
    const decision = await decideDurableApproval({
      fqName: "execution:run_command",
      safeName: "run_command",
      input: {},
      annotations: { destructiveHint: true },
    })
    expect(decision).toBe("ask")
  })

  it("still hard-denies a destructive tool when the resolver says deny", async () => {
    const decision = await decideDurableApproval(
      {
        fqName: "execution:run_command",
        safeName: "run_command",
        input: {},
        annotations: { destructiveHint: true },
      },
      () => "deny"
    )
    expect(decision).toBe("deny")
  })

  it("lets a resolver hard-deny ahead of the annotation heuristic", async () => {
    const decision = await decideDurableApproval(
      {
        fqName: "execution:run_command",
        safeName: "run_command",
        input: { command: "rm -rf /" },
        annotations: { readOnlyHint: true }, // would otherwise auto-allow
      },
      () => "deny"
    )
    expect(decision).toBe("deny")
  })

  it("lets a resolver hard-allow ahead of the annotation heuristic", async () => {
    const decision = await decideDurableApproval(
      {
        fqName: "execution:run_command",
        safeName: "run_command",
        input: { command: "ls" },
        annotations: { destructiveHint: true }, // would otherwise ask
      },
      () => "allow"
    )
    expect(decision).toBe("allow")
  })

  it("falls back to the annotation heuristic when the resolver abstains", async () => {
    const decision = await decideDurableApproval(
      {
        fqName: "host:read_file",
        safeName: "read_file",
        input: {},
        annotations: { readOnlyHint: true },
      },
      () => undefined
    )
    expect(decision).toBe("allow")
  })

  it("supports an async resolver", async () => {
    const decision = await decideDurableApproval(
      {
        fqName: "host:read_file",
        safeName: "read_file",
        input: {},
        annotations: { readOnlyHint: true },
      },
      async () => "deny" as const
    )
    expect(decision).toBe("deny")
  })
})
