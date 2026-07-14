import { Buffer } from "node:buffer"
import { gzipSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import { buildStatusJson } from "./eval-nightly-report.mjs"
import {
  buildManifest,
  buildReleaseBody,
  buildReleaseContext,
  buildSigningStatus,
  checkArtifactManifest,
  checkEvalSignal,
  checkPackageVersionConsistency,
  checkReleaseModeGate,
  checkTagVersion,
  computeSigningStatus,
  parseReleaseMode,
  RELEASE_PROFILE,
  validateSingleFileFeed,
  validateWindowsBlockmap,
  verifyManifest,
} from "./release-admission-gate.mjs"

function baseArgs(overrides = {}) {
  return {
    runList: [
      {
        databaseId: 100,
        headSha: "sha-old",
        status: "completed",
        createdAt: "2026-07-10T07:00:00Z",
      },
    ],
    statusJson: {
      schemaVersion: 1,
      state: "clean",
      runId: "100",
      headSha: "sha-released",
      completedAt: "2026-07-11T00:00:00Z",
    },
    runView: { headSha: "sha-released", conclusion: "success" },
    issues: [
      {
        number: 44,
        title: "Eval Nightly Status",
        body: "## Eval Nightly Status\n✅ clean\n[Workflow run](https://github.com/o/r/actions/runs/100)",
      },
    ],
    releasedSha: "sha-released",
    now: () => new Date("2026-07-11T06:00:00Z"),
    ...overrides,
  }
}

describe("checkEvalSignal", () => {
  it("passes when everything lines up", () => {
    expect(checkEvalSignal(baseArgs())).toEqual({ ok: true })
  })

  it("accepts the status JSON emitted by the nightly reporter", () => {
    const statusJson = buildStatusJson({
      state: "clean",
      runId: 100,
      headSha: "sha-released",
      now: () => new Date("2026-07-11T00:00:00Z"),
    })
    expect(checkEvalSignal(baseArgs({ statusJson }))).toEqual({ ok: true })
  })

  it("fails when there is no completed run", () => {
    const result = checkEvalSignal(
      baseArgs({
        runList: [{ databaseId: 1, status: "in_progress", createdAt: "2026-07-11T00:00:00Z" }],
      })
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("no completed")
  })

  it("fails when the issue count is not exactly one", () => {
    const result = checkEvalSignal(baseArgs({ issues: [] }))
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("exactly one")
  })

  it("fails when the issue title is wrong", () => {
    const result = checkEvalSignal(
      baseArgs({ issues: [{ number: 1, title: "Wrong Title", body: "" }] })
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("title")
  })

  it("fails when the issue references a different run", () => {
    const result = checkEvalSignal(
      baseArgs({
        issues: [
          {
            number: 44,
            title: "Eval Nightly Status",
            body: "[Workflow run](https://github.com/o/r/actions/runs/999)",
          },
        ],
      })
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("does not reference")
  })

  it("fails on a missing schemaVersion", () => {
    const result = checkEvalSignal(
      baseArgs({ statusJson: { ...baseArgs().statusJson, schemaVersion: 2 } })
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("schemaVersion")
  })

  it("fails on an invalid completedAt", () => {
    const result = checkEvalSignal(
      baseArgs({ statusJson: { ...baseArgs().statusJson, completedAt: "not-a-date" } })
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("valid ISO")
  })

  it("fails when completedAt is in the future beyond clock skew", () => {
    const result = checkEvalSignal(
      baseArgs({ statusJson: { ...baseArgs().statusJson, completedAt: "2026-07-11T08:00:00Z" } })
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("future")
  })

  it("fails when the JSON runId does not match the downloaded run", () => {
    const result = checkEvalSignal(
      baseArgs({ statusJson: { ...baseArgs().statusJson, runId: "999" } })
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("does not match the run it was downloaded from")
  })

  it("fails when the JSON headSha does not match gh run view's own record", () => {
    const result = checkEvalSignal(
      baseArgs({ runView: { headSha: "sha-different", conclusion: "success" } })
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("does not match GitHub's own run record")
  })

  it("fails when the run's conclusion was not success", () => {
    const result = checkEvalSignal(
      baseArgs({ runView: { headSha: "sha-released", conclusion: "failure" } })
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("concluded")
  })

  it("fails when state is not clean", () => {
    const result = checkEvalSignal(
      baseArgs({ statusJson: { ...baseArgs().statusJson, state: "regressed" } })
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('"regressed"')
  })

  it("fails when headSha does not match the released commit (anti-TOCTOU)", () => {
    const result = checkEvalSignal(baseArgs({ releasedSha: "sha-not-evaluated" }))
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("does not match the commit being released")
  })

  it("fails when completedAt is more than 48 hours old", () => {
    const result = checkEvalSignal(baseArgs({ now: () => new Date("2026-07-13T02:00:00Z") }))
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("48 hours")
  })
})

describe("checkPackageVersionConsistency", () => {
  const baseFeeds = {
    "latest.yml": { version: "1.2.3" },
  }
  const baseFilenames = ["Synapse-Setup-1.2.3.exe", "Synapse-1.2.3.msi"]

  it("passes when package.json, the Windows feed, and every installer filename agree", () => {
    const result = checkPackageVersionConsistency({
      packageVersion: "1.2.3",
      feeds: baseFeeds,
      installerFilenames: baseFilenames,
    })
    expect(result).toEqual({ ok: true })
  })

  it("fails when the feed's version disagrees", () => {
    const result = checkPackageVersionConsistency({
      packageVersion: "1.2.3",
      feeds: { "latest.yml": { version: "1.2.2" } },
      installerFilenames: baseFilenames,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("latest.yml")
  })

  it("fails when an installer filename does not contain the exact expected version", () => {
    const result = checkPackageVersionConsistency({
      packageVersion: "1.2.3",
      feeds: baseFeeds,
      installerFilenames: ["Synapse-Setup-1.2.2.exe"],
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("Synapse-Setup-1.2.2.exe")
  })

  it("rejects a version that only contains the expected version as a substring", () => {
    const result = checkPackageVersionConsistency({
      packageVersion: "1.2.3",
      feeds: baseFeeds,
      installerFilenames: ["Synapse-11.2.30.exe"],
    })
    expect(result.ok).toBe(false)
  })
})

describe("checkTagVersion", () => {
  it("passes when the tag matches package.json", () => {
    expect(checkTagVersion({ tagVersion: "1.2.3", packageVersion: "1.2.3" })).toEqual({ ok: true })
  })

  it("fails when the tag does not match package.json", () => {
    const result = checkTagVersion({ tagVersion: "1.2.4", packageVersion: "1.2.3" })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("tag version")
  })
})

describe("parseReleaseMode", () => {
  it('accepts "dry-run"', () => {
    expect(parseReleaseMode("dry-run")).toEqual({ ok: true, mode: "dry-run" })
  })

  it('accepts "release"', () => {
    expect(parseReleaseMode("release")).toEqual({ ok: true, mode: "release" })
  })

  it("fails closed on a missing mode", () => {
    const result = parseReleaseMode(undefined)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("undefined")
  })

  it("fails closed on an unrecognized mode", () => {
    const result = parseReleaseMode("production")
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("production")
  })
})

describe("checkReleaseModeGate", () => {
  const evalSignalInputs = baseArgs()

  it("release mode passes when tag and eval-signal inputs are present and healthy", () => {
    const result = checkReleaseModeGate({
      mode: "release",
      tagVersion: "1.2.3",
      packageVersion: "1.2.3",
      evalSignalInputs,
    })
    expect(result).toEqual({ ok: true, mode: "release" })
  })

  it("release mode fails closed when the tag version is omitted", () => {
    const result = checkReleaseModeGate({
      mode: "release",
      packageVersion: "1.2.3",
      evalSignalInputs,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("tag version")
  })

  it("release mode fails closed when the eval-signal inputs are omitted", () => {
    const result = checkReleaseModeGate({
      mode: "release",
      tagVersion: "1.2.3",
      packageVersion: "1.2.3",
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("eval-signal")
  })

  it("release mode still enforces the tag check", () => {
    const result = checkReleaseModeGate({
      mode: "release",
      tagVersion: "1.2.4",
      packageVersion: "1.2.3",
      evalSignalInputs,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("tag version")
  })

  it("release mode still enforces the eval-signal check", () => {
    const result = checkReleaseModeGate({
      mode: "release",
      tagVersion: "1.2.3",
      packageVersion: "1.2.3",
      evalSignalInputs: { ...evalSignalInputs, releasedSha: "sha-not-evaluated" },
    })
    expect(result.ok).toBe(false)
  })

  it("dry-run mode skips both checks even when tag/eval inputs are omitted", () => {
    const result = checkReleaseModeGate({ mode: "dry-run", packageVersion: "1.2.3" })
    expect(result).toEqual({ ok: true, mode: "dry-run", skipped: ["tagVersion", "evalSignal"] })
  })

  it("fails closed on an invalid mode regardless of other inputs", () => {
    const result = checkReleaseModeGate({
      mode: "production",
      packageVersion: "1.2.3",
      tagVersion: "1.2.3",
      evalSignalInputs,
    })
    expect(result.ok).toBe(false)
  })
})

describe("release profile (RELEASE_PROFILE)", () => {
  it("declares exactly the Windows x64 NSIS/MSI target", () => {
    expect(RELEASE_PROFILE).toEqual({
      schemaVersion: 1,
      targets: [
        {
          platform: "windows",
          arch: "x64",
          packages: ["nsis", "msi"],
          updaterFeed: "latest.yml",
        },
      ],
    })
  })
})

describe("buildReleaseContext", () => {
  it("builds a schema-version-1 context for a valid dry run", () => {
    const result = buildReleaseContext({
      mode: "dry-run",
      commitSha: "abc123",
      workflowRunId: "999",
    })
    expect(result).toEqual({
      ok: true,
      context: {
        schemaVersion: 1,
        mode: "dry-run",
        commitSha: "abc123",
        workflowRunId: "999",
      },
    })
  })

  it("builds a schema-version-1 context for a valid release", () => {
    const result = buildReleaseContext({
      mode: "release",
      commitSha: "abc123",
      workflowRunId: "999",
    })
    expect(result).toEqual({
      ok: true,
      context: {
        schemaVersion: 1,
        mode: "release",
        commitSha: "abc123",
        workflowRunId: "999",
      },
    })
  })

  it("rejects an invalid mode", () => {
    const result = buildReleaseContext({
      mode: "production",
      commitSha: "abc123",
      workflowRunId: "999",
    })
    expect(result.ok).toBe(false)
  })

  it("rejects an empty commitSha", () => {
    const result = buildReleaseContext({ mode: "dry-run", commitSha: "", workflowRunId: "999" })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("commitSha")
  })

  it("rejects a missing workflowRunId", () => {
    const result = buildReleaseContext({ mode: "dry-run", commitSha: "abc123", workflowRunId: "" })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("workflowRunId")
  })
})

function validContainers() {
  return {
    "electron-windows-x64-nsis": [
      "Synapse-Setup-1.2.3.exe",
      "Synapse-Setup-1.2.3.exe.blockmap",
      "latest.yml",
    ],
    "electron-windows-x64-msi": ["Synapse-1.2.3.msi"],
  }
}

describe("checkArtifactManifest", () => {
  it("passes on the exact Windows NSIS + MSI container set", () => {
    expect(checkArtifactManifest(validContainers())).toEqual({ ok: true })
  })

  it("fails when the NSIS container is missing", () => {
    const containers = validContainers()
    delete containers["electron-windows-x64-nsis"]
    const result = checkArtifactManifest(containers)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("electron-windows-x64-nsis")
  })

  it("fails when the MSI container is missing", () => {
    const containers = validContainers()
    delete containers["electron-windows-x64-msi"]
    const result = checkArtifactManifest(containers)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("electron-windows-x64-msi")
  })

  it("fails when a container has the wrong file count", () => {
    const containers = validContainers()
    containers["electron-windows-x64-msi"] = ["a.msi", "b.msi"]
    const result = checkArtifactManifest(containers)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("electron-windows-x64-msi")
  })

  it("fails when a container's file doesn't match the expected extension", () => {
    const containers = validContainers()
    containers["electron-windows-x64-msi"] = ["Synapse-1.2.3.exe"]
    const result = checkArtifactManifest(containers)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("electron-windows-x64-msi")
  })

  it("fails when an electron-macos-* container appears", () => {
    const containers = validContainers()
    containers["electron-macos-x64-zip"] = ["Synapse-1.2.3-x64-mac.zip"]
    const result = checkArtifactManifest(containers)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("electron-macos-x64-zip")
  })

  it("fails when an electron-linux-* container appears", () => {
    const containers = validContainers()
    containers["electron-linux-x64-deb"] = ["Synapse-1.2.3.deb"]
    const result = checkArtifactManifest(containers)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("electron-linux-x64-deb")
  })

  it("fails when an unrelated container appears", () => {
    const containers = validContainers()
    containers["test-results"] = ["report.xml"]
    const result = checkArtifactManifest(containers)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("test-results")
  })
})

describe("validateSingleFileFeed", () => {
  const real = { filename: "Synapse-Setup-1.2.3.exe", sha512: "WINHASH", size: 300 }
  const feed = {
    version: "1.2.3",
    files: [{ url: "Synapse-Setup-1.2.3.exe", sha512: "WINHASH", size: 300 }],
  }

  it("passes when the feed matches the real NSIS installer exactly", () => {
    const result = validateSingleFileFeed(feed, real, "latest.yml")
    expect(result.ok).toBe(true)
    expect(result.entry).toEqual(feed.files[0])
  })

  it("fails when files does not have exactly one entry", () => {
    expect(validateSingleFileFeed({ ...feed, files: [] }, real, "latest.yml").ok).toBe(false)
    expect(
      validateSingleFileFeed({ ...feed, files: [feed.files[0], feed.files[0]] }, real, "latest.yml")
        .ok
    ).toBe(false)
  })

  it("fails when the referenced filename does not match the real file", () => {
    const result = validateSingleFileFeed(
      { ...feed, files: [{ ...feed.files[0], url: "wrong-name.exe" }] },
      real,
      "latest.yml"
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("wrong-name.exe")
  })

  it("fails on a sha512 mismatch", () => {
    const result = validateSingleFileFeed(
      { ...feed, files: [{ ...feed.files[0], sha512: "WRONG" }] },
      real,
      "latest.yml"
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("sha512")
  })

  it("fails on a size mismatch", () => {
    const result = validateSingleFileFeed(
      { ...feed, files: [{ ...feed.files[0], size: 999 }] },
      real,
      "latest.yml"
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("size")
  })
})

describe("validateWindowsBlockmap", () => {
  const installerName = "Synapse-Setup-1.2.3.exe"
  const blockmapName = "Synapse-Setup-1.2.3.exe.blockmap"
  const validBytes = gzipSync(JSON.stringify({ version: 2, files: [] }))

  it("passes for the matching name and nonempty gzip JSON", () => {
    expect(validateWindowsBlockmap(installerName, blockmapName, validBytes)).toEqual({ ok: true })
  })

  it("fails when the blockmap name is missing", () => {
    const result = validateWindowsBlockmap(installerName, undefined, validBytes)
    expect(result.ok).toBe(false)
  })

  it("fails when the blockmap name does not match the installer name", () => {
    const result = validateWindowsBlockmap(installerName, "wrong-name.exe.blockmap", validBytes)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("wrong-name.exe.blockmap")
  })

  it("fails on empty bytes", () => {
    const result = validateWindowsBlockmap(installerName, blockmapName, Buffer.alloc(0))
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("empty")
  })

  it("fails on non-gzip bytes", () => {
    const result = validateWindowsBlockmap(installerName, blockmapName, Buffer.from("not gzip"))
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("gzip")
  })

  it("fails when the gzip payload contains invalid JSON", () => {
    const bytes = gzipSync("not json")
    const result = validateWindowsBlockmap(installerName, blockmapName, bytes)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("JSON")
  })

  it("fails when the gzip JSON is not an object", () => {
    const bytes = gzipSync(JSON.stringify([1, 2, 3]))
    const result = validateWindowsBlockmap(installerName, blockmapName, bytes)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("object")
  })

  it("fails when the gzip JSON is a bare primitive", () => {
    const bytes = gzipSync(JSON.stringify(42))
    const result = validateWindowsBlockmap(installerName, blockmapName, bytes)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("object")
  })
})

describe("computeSigningStatus", () => {
  it("passes as unsigned-unverified when no credentials and no verification", () => {
    expect(computeSigningStatus(false, "not-performed")).toEqual({
      ok: true,
      releaseClaim: "unsigned-unverified",
    })
  })

  it("passes as signed-and-verified when credentials configured and verified", () => {
    expect(computeSigningStatus(true, "verified")).toEqual({
      ok: true,
      releaseClaim: "signed-and-verified",
    })
  })

  it("fails when credentials are configured but verification was not performed", () => {
    const result = computeSigningStatus(true, "not-performed")
    expect(result.ok).toBe(false)
  })

  it("fails when credentials are configured but verification failed", () => {
    const result = computeSigningStatus(true, "failed")
    expect(result.ok).toBe(false)
  })

  it("fails on the contradictory state: verified with no credentials configured", () => {
    const result = computeSigningStatus(false, "verified")
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("contradictory")
  })
})

describe("buildManifest", () => {
  it("builds a manifest covering every given file", () => {
    const manifest = buildManifest([
      { name: "a.exe", sha512: "HASHA" },
      { name: "b.msi", sha512: "HASHB" },
    ])
    expect(manifest).toEqual({
      schemaVersion: 1,
      files: { "a.exe": { sha512: "HASHA" }, "b.msi": { sha512: "HASHB" } },
    })
  })
})

describe("verifyManifest", () => {
  const manifest = buildManifest([
    { name: "a.exe", sha512: "HASHA" },
    { name: "b.msi", sha512: "HASHB" },
  ])

  it("passes when the actual files match the manifest exactly", () => {
    const result = verifyManifest(manifest, [
      { name: "a.exe", sha512: "HASHA" },
      { name: "b.msi", sha512: "HASHB" },
    ])
    expect(result).toEqual({ ok: true })
  })

  it("fails on a hash mismatch", () => {
    const result = verifyManifest(manifest, [
      { name: "a.exe", sha512: "WRONG" },
      { name: "b.msi", sha512: "HASHB" },
    ])
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("a.exe")
  })

  it("fails when a file is missing from the actual set", () => {
    const result = verifyManifest(manifest, [{ name: "a.exe", sha512: "HASHA" }])
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("missing")
  })

  it("fails when an extra, unlisted file is present", () => {
    const result = verifyManifest(manifest, [
      { name: "a.exe", sha512: "HASHA" },
      { name: "b.msi", sha512: "HASHB" },
      { name: "c.dmg", sha512: "HASHC" },
    ])
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("extra")
  })
})

describe("release profile and context serialization", () => {
  it("serializes RELEASE_PROFILE deterministically across calls", () => {
    const first = JSON.stringify(RELEASE_PROFILE, null, 2)
    const second = JSON.stringify(RELEASE_PROFILE, null, 2)
    expect(first).toBe(second)
    expect(JSON.parse(first)).toEqual(RELEASE_PROFILE)
  })

  it("serializes a release context deterministically across calls", () => {
    const { context } = buildReleaseContext({
      mode: "release",
      commitSha: "abc123",
      workflowRunId: "999",
    })
    const first = JSON.stringify(context, null, 2)
    const second = JSON.stringify(context, null, 2)
    expect(first).toBe(second)
    expect(JSON.parse(first)).toEqual(context)
  })
})

describe("buildSigningStatus", () => {
  it("keeps schemaVersion 1 and includes only platformCodeSigning.windows", () => {
    const status = buildSigningStatus({
      credentialsConfigured: false,
      verification: "not-performed",
      releaseClaim: "unsigned-unverified",
    })
    expect(status.schemaVersion).toBe(1)
    expect(Object.keys(status.platformCodeSigning)).toEqual(["windows"])
    expect(status.platformCodeSigning.windows).toEqual({
      credentialsConfigured: false,
      verification: "not-performed",
      releaseClaim: "unsigned-unverified",
    })
    expect(status.githubArtifactAttestation).toEqual({ required: true })
  })
})

describe("buildReleaseBody", () => {
  const releaseContext = {
    schemaVersion: 1,
    mode: "release",
    commitSha: "abc123",
    workflowRunId: "999",
  }
  const signingStatus = buildSigningStatus({
    credentialsConfigured: false,
    verification: "not-performed",
    releaseClaim: "unsigned-unverified",
  })

  it("renders 'Windows x64 (NSIS, MSI)' from RELEASE_PROFILE", () => {
    const body = buildReleaseBody({
      releaseProfile: RELEASE_PROFILE,
      releaseContext,
      signingStatus,
      attestationUrl: "https://example.com/attestation",
      repoOwner: "acme",
    })
    expect(body).toContain("Windows x64 (NSIS, MSI)")
  })

  it("starts a dry-run body with the DRY RUN marker", () => {
    const body = buildReleaseBody({
      releaseProfile: RELEASE_PROFILE,
      releaseContext: { ...releaseContext, mode: "dry-run" },
      signingStatus,
      attestationUrl: "https://example.com/attestation",
      repoOwner: "acme",
    })
    expect(body.startsWith("DRY RUN — NOT A RELEASE")).toBe(true)
  })

  it("has no dry-run marker for a release-mode body", () => {
    const body = buildReleaseBody({
      releaseProfile: RELEASE_PROFILE,
      releaseContext,
      signingStatus,
      attestationUrl: "https://example.com/attestation",
      repoOwner: "acme",
    })
    expect(body).not.toContain("DRY RUN")
  })

  it("iterates the signing-status platform map without assuming a macOS key", () => {
    const body = buildReleaseBody({
      releaseProfile: RELEASE_PROFILE,
      releaseContext,
      signingStatus,
      attestationUrl: "https://example.com/attestation",
      repoOwner: "acme",
    })
    expect(body).toContain("**windows**")
    expect(body).not.toContain("macos")
    expect(body).not.toContain("**macOS**")
  })

  it("renders the signed-and-verified claim wording, not the unsigned wording", () => {
    const verifiedSigningStatus = buildSigningStatus({
      credentialsConfigured: true,
      verification: "verified",
      releaseClaim: "signed-and-verified",
    })
    const body = buildReleaseBody({
      releaseProfile: RELEASE_PROFILE,
      releaseContext,
      signingStatus: verifiedSigningStatus,
      attestationUrl: "https://example.com/attestation",
      repoOwner: "acme",
    })
    expect(body).toContain(
      "This artifact was signed with a configured platform credential, and CI verified the signature."
    )
    expect(body).not.toContain(
      "CI has neither a configured platform code-signing credential nor has it performed a platform signature verification on this artifact."
    )
  })

  it("fails closed on an unrecognized releaseClaim instead of rendering an optimistic claim", () => {
    const bogusSigningStatus = buildSigningStatus({
      credentialsConfigured: true,
      verification: "verified",
      releaseClaim: "some-future-claim",
    })
    expect(() =>
      buildReleaseBody({
        releaseProfile: RELEASE_PROFILE,
        releaseContext,
        signingStatus: bogusSigningStatus,
        attestationUrl: "https://example.com/attestation",
        repoOwner: "acme",
      })
    ).toThrow(/unrecognized releaseClaim/)
  })
})

describe("approved-bundle manifest coverage", () => {
  function bundleFiles() {
    return [
      { name: "Synapse-Setup-1.2.3.exe", sha512: "EXEHASH" },
      { name: "Synapse-Setup-1.2.3.exe.blockmap", sha512: "BLOCKMAPHASH" },
      { name: "Synapse-1.2.3.msi", sha512: "MSIHASH" },
      { name: "latest.yml", sha512: "FEEDHASH" },
      { name: "release-profile.json", sha512: "PROFILEHASH" },
      { name: "release-context.json", sha512: "CONTEXTHASH" },
      { name: "signing-status.json", sha512: "SIGNINGHASH" },
    ]
  }

  it("covers the EXE, blockmap, MSI, feed, and every proof file", () => {
    const manifest = buildManifest(bundleFiles())
    expect(Object.keys(manifest.files).sort()).toEqual(
      [
        "Synapse-Setup-1.2.3.exe",
        "Synapse-Setup-1.2.3.exe.blockmap",
        "Synapse-1.2.3.msi",
        "latest.yml",
        "release-profile.json",
        "release-context.json",
        "signing-status.json",
      ].sort()
    )
    expect(verifyManifest(manifest, bundleFiles())).toEqual({ ok: true })
  })

  it("fails verification when blockmap bytes change without rebuilding the manifest", () => {
    const manifest = buildManifest(bundleFiles())
    const tamperedFiles = bundleFiles().map((f) =>
      f.name === "Synapse-Setup-1.2.3.exe.blockmap"
        ? { ...f, sha512: "DIFFERENT-BLOCKMAP-HASH" }
        : f
    )
    const result = verifyManifest(manifest, tamperedFiles)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("Synapse-Setup-1.2.3.exe.blockmap")
  })
})
