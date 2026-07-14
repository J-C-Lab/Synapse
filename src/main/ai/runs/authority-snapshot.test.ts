import type { RegisteredToolDescriptor } from "../../plugins/types"
import type { ProviderToolSchema } from "../providers/types"
import type { FrozenCapabilityGrant } from "./authority-snapshot"
import { describe, expect, it } from "vitest"
import { PLUGIN_HOST_VERSION } from "../../plugins/types"
import {
  compareCapabilityGrant,
  compareToolAuthority,
  effectiveReplayGuarantee,
  freezeAuthoritySnapshot,
  freezeToolAuthority,
  principalMatches,
} from "./authority-snapshot"

function schemaFor(name: string): ProviderToolSchema {
  return { name, description: `desc for ${name}`, inputSchema: { type: "object" } }
}

function hostDescriptor(
  overrides: Partial<RegisteredToolDescriptor> = {}
): RegisteredToolDescriptor {
  return {
    fqName: "read_file",
    pluginId: "host",
    provenance: "host",
    manifestTool: {
      name: "read_file",
      description: "Read a file",
      inputSchema: { type: "object" },
    },
    ...overrides,
  }
}

describe("freezeToolAuthority", () => {
  it("derives host owner identity and a non-upgraded replay guarantee", () => {
    const frozen = freezeToolAuthority({
      descriptor: hostDescriptor(),
      safeName: "read_file",
      modelSchema: schemaFor("read_file"),
    })
    expect(frozen.provenance).toBe("host")
    expect(frozen.ownerId).toBe("synapse-host")
    expect(frozen.ownerVersion).toBe(PLUGIN_HOST_VERSION)
    expect(frozen.replayGuarantee).toBe("none")
    expect(frozen.requiredCapabilities).toBeUndefined()
  })

  it("derives plugin owner identity from pluginId", () => {
    const frozen = freezeToolAuthority({
      descriptor: hostDescriptor({
        fqName: "com.example.tool/greet",
        pluginId: "com.example.tool",
        provenance: "plugin",
      }),
      safeName: "external_plugin_abc",
      modelSchema: schemaFor("external_plugin_abc"),
    })
    expect(frozen.provenance).toBe("plugin")
    expect(frozen.ownerId).toBe("com.example.tool")
  })

  it("derives an mcp owner id from the mcp:<serverId>/<tool> fqName", () => {
    const frozen = freezeToolAuthority({
      descriptor: hostDescriptor({
        fqName: "mcp:serverA/toolX",
        pluginId: "serverA",
        provenance: "mcp-client",
      }),
      safeName: "external_mcp_abc",
      modelSchema: schemaFor("external_mcp_abc"),
    })
    expect(frozen.provenance).toBe("mcp")
    expect(frozen.ownerId).toBe("mcp:serverA")
  })

  it("freezes a declared per-tool capability's canonical scope", () => {
    const frozen = freezeToolAuthority({
      descriptor: hostDescriptor({
        manifestTool: {
          name: "read_file",
          description: "Read a file",
          inputSchema: { type: "object" },
          capabilities: [{ id: "fs:read", scope: { paths: ["~/Documents/**"] } }],
        },
      }),
      safeName: "read_file",
      modelSchema: schemaFor("read_file"),
    })
    expect(frozen.requiredCapabilities).toEqual([
      {
        id: "fs:read",
        canonicalScope: { paths: ["~/Documents/**"] },
        scopeAdapterId: "fs-path-declared-v1",
        scopeAdapterVersion: "1",
      },
    ])
  })

  it("changes modelSchemaHash and annotationsHash when those inputs change", () => {
    const base = freezeToolAuthority({
      descriptor: hostDescriptor(),
      safeName: "read_file",
      modelSchema: schemaFor("read_file"),
    })
    const changedSchema = freezeToolAuthority({
      descriptor: hostDescriptor(),
      safeName: "read_file",
      modelSchema: { ...schemaFor("read_file"), description: "a different description" },
    })
    expect(changedSchema.modelSchemaHash).not.toBe(base.modelSchemaHash)

    const changedAnnotations = freezeToolAuthority({
      descriptor: hostDescriptor({
        manifestTool: {
          name: "read_file",
          description: "Read a file",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
      }),
      safeName: "read_file",
      modelSchema: schemaFor("read_file"),
    })
    expect(changedAnnotations.annotationsHash).not.toBe(base.annotationsHash)
  })
})

describe("freezeAuthoritySnapshot", () => {
  it("produces the same integrityHash regardless of input array order", () => {
    const toolA = {
      descriptor: hostDescriptor(),
      safeName: "read_file",
      modelSchema: schemaFor("read_file"),
    }
    const toolB = {
      descriptor: hostDescriptor({
        fqName: "write_file",
        manifestTool: { ...hostDescriptor().manifestTool, name: "write_file" },
      }),
      safeName: "write_file",
      modelSchema: schemaFor("write_file"),
    }
    const principal = { kind: "interactive", actor: "user" as const }

    const snapshotAB = freezeAuthoritySnapshot({
      principal,
      capabilities: [
        { id: "fs:read", scope: { paths: ["~/Documents/**"] } },
        { id: "notification" },
      ],
      tools: [toolA, toolB],
    })
    const snapshotBA = freezeAuthoritySnapshot({
      principal,
      capabilities: [
        { id: "notification" },
        { id: "fs:read", scope: { paths: ["~/Documents/**"] } },
      ],
      tools: [toolB, toolA],
    })

    expect(snapshotAB.integrityHash).toBe(snapshotBA.integrityHash)
    expect(snapshotAB.tools.map((t) => t.fqName)).toEqual(["read_file", "write_file"])
  })
})

describe("compareCapabilityGrant — equal hash is not the containment test", () => {
  it("accepts a narrower current fs path scope even though its hash differs", () => {
    const frozen = {
      id: "fs:read",
      canonicalScope: { paths: ["~/Documents/**"] },
      scopeAdapterId: "fs-path-declared-v1",
      scopeAdapterVersion: "1",
    }
    const narrowerCurrent = {
      ...frozen,
      canonicalScope: { paths: ["~/Documents/Reports/**"] },
    }
    expect(narrowerCurrent.canonicalScope).not.toEqual(frozen.canonicalScope)
    expect(compareCapabilityGrant(frozen, narrowerCurrent)).toBe("narrowed")
  })

  it("accepts a narrower current network:https host list", () => {
    const frozen = {
      id: "network:https",
      canonicalScope: {
        hosts: ["api.example.com", "www.example.com"],
        methods: ["GET"],
        paths: ["/**"],
      },
      scopeAdapterId: "network-https-declared-v1",
      scopeAdapterVersion: "1",
    }
    const narrowerCurrent = {
      ...frozen,
      canonicalScope: { hosts: ["api.example.com"], methods: ["GET"], paths: ["/**"] },
    }
    expect(compareCapabilityGrant(frozen, narrowerCurrent)).toBe("narrowed")
  })

  it("does not widen the run when the current scope is broader than frozen", () => {
    const frozen = {
      id: "fs:read",
      canonicalScope: { paths: ["~/Documents/Reports/**"] },
      scopeAdapterId: "fs-path-declared-v1",
      scopeAdapterVersion: "1",
    }
    const broaderCurrent = { ...frozen, canonicalScope: { paths: ["~/Documents/**"] } }
    expect(compareCapabilityGrant(frozen, broaderCurrent)).toBe("unchanged-or-wider")
  })

  it("reports revoked when the capability is no longer granted", () => {
    const frozen = {
      id: "fs:read",
      canonicalScope: { paths: ["~/Documents/**"] },
      scopeAdapterId: "fs-path-declared-v1",
      scopeAdapterVersion: "1",
    }
    expect(compareCapabilityGrant(frozen, undefined)).toBe("revoked")
  })

  it("treats an unscoped capability as unchanged-or-wider whenever still granted", () => {
    const frozen = { id: "notification", scopeAdapterId: "none", scopeAdapterVersion: "1" }
    expect(compareCapabilityGrant(frozen, { ...frozen })).toBe("unchanged-or-wider")
  })

  it("fails closed with adapter-missing for an unregistered scope-enforced capability id", () => {
    const frozen = {
      id: "synthetic:unregistered",
      canonicalScope: { anything: true },
      scopeAdapterId: "synthetic-v1",
      scopeAdapterVersion: "1",
    }
    expect(compareCapabilityGrant(frozen, { ...frozen })).toBe("adapter-missing")
  })

  it("fails closed with adapter-version-mismatch when the frozen adapter version is stale", () => {
    const frozen = {
      id: "fs:read",
      canonicalScope: { paths: ["~/Documents/**"] },
      scopeAdapterId: "fs-path-declared-v1",
      scopeAdapterVersion: "999",
    }
    expect(compareCapabilityGrant(frozen, { ...frozen })).toBe("adapter-version-mismatch")
  })
})

describe("compareToolAuthority", () => {
  const baseFrozen = freezeToolAuthority({
    descriptor: hostDescriptor({
      manifestTool: {
        name: "read_file",
        description: "Read a file",
        inputSchema: { type: "object" },
        capabilities: [{ id: "fs:read", scope: { paths: ["~/Documents/**"] } }],
      },
    }),
    safeName: "read_file",
    modelSchema: schemaFor("read_file"),
  })

  function capsMap(paths: string[]): ReadonlyMap<string, FrozenCapabilityGrant> {
    return new Map([
      [
        "fs:read",
        {
          id: "fs:read",
          canonicalScope: { paths },
          scopeAdapterId: "fs-path-declared-v1",
          scopeAdapterVersion: "1",
        },
      ],
    ])
  }

  it("reports removed when the tool is no longer present", () => {
    expect(compareToolAuthority(baseFrozen, undefined, capsMap(["~/Documents/**"]))).toEqual({
      kind: "removed",
    })
  })

  it("reports unchanged when the current tool and capabilities match exactly", () => {
    expect(compareToolAuthority(baseFrozen, baseFrozen, capsMap(["~/Documents/**"]))).toEqual({
      kind: "unchanged",
    })
  })

  it("reports changed when the model schema hash drifts", () => {
    const changed = { ...baseFrozen, modelSchemaHash: "different" }
    expect(compareToolAuthority(baseFrozen, changed, capsMap(["~/Documents/**"]))).toEqual({
      kind: "changed",
    })
  })

  it("reports narrowed when the tool's required capability was narrowed", () => {
    expect(
      compareToolAuthority(baseFrozen, baseFrozen, capsMap(["~/Documents/Reports/**"]))
    ).toEqual({ kind: "narrowed" })
  })

  it("reports removed when the tool's required capability was revoked", () => {
    expect(compareToolAuthority(baseFrozen, baseFrozen, new Map())).toEqual({ kind: "removed" })
  })

  it("reports blocked when a required capability's adapter is incompatible", () => {
    const badMap = new Map([
      [
        "fs:read",
        {
          id: "fs:read",
          canonicalScope: { paths: ["~/Documents/**"] },
          scopeAdapterId: "fs-path-declared-v1",
          scopeAdapterVersion: "999",
        },
      ],
    ])
    expect(compareToolAuthority(baseFrozen, baseFrozen, badMap)).toEqual({
      kind: "blocked",
      reason: "adapter-incompatible",
    })
  })

  it("reports unchanged for a tool that inherits the plugin's full grant (no declared capabilities)", () => {
    const noCapsFrozen = freezeToolAuthority({
      descriptor: hostDescriptor(),
      safeName: "read_file",
      modelSchema: schemaFor("read_file"),
    })
    expect(compareToolAuthority(noCapsFrozen, noCapsFrozen, new Map())).toEqual({
      kind: "unchanged",
    })
  })
})

describe("effectiveReplayGuarantee — never upgrades from the frozen value", () => {
  it("keeps dedupe-and-result-replay only when both sides still guarantee it", () => {
    expect(effectiveReplayGuarantee("dedupe-and-result-replay", "dedupe-and-result-replay")).toBe(
      "dedupe-and-result-replay"
    )
  })

  it("downgrades to none when the current adapter no longer guarantees replay", () => {
    expect(effectiveReplayGuarantee("dedupe-and-result-replay", "none")).toBe("none")
  })

  it("never upgrades a frozen none to the current adapter's stronger guarantee", () => {
    expect(effectiveReplayGuarantee("none", "dedupe-and-result-replay")).toBe("none")
  })

  it("stays none when both sides are none", () => {
    expect(effectiveReplayGuarantee("none", "none")).toBe("none")
  })
})

describe("principalMatches", () => {
  it("requires exact principal identity, not a subset relationship", () => {
    const a = { kind: "interactive", actor: "user" as const, subjectId: "u1" }
    expect(principalMatches(a, { ...a })).toBe(true)
    expect(principalMatches(a, { ...a, subjectId: "u2" })).toBe(false)
    expect(principalMatches(a, { ...a, actor: "background" as const })).toBe(false)
  })
})
