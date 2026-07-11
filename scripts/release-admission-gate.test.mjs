import { MacUpdater } from "electron-updater"
import { describe, expect, it } from "vitest"
import { buildStatusJson } from "./eval-nightly-report.mjs"
import {
  buildManifest,
  checkArtifactManifest,
  checkEvalSignal,
  checkFeedFiles,
  checkVersionConsistency,
  computeSigningStatus,
  mergeMacFeeds,
  validateSingleFileFeed,
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

describe("checkVersionConsistency", () => {
  const baseFeeds = {
    "latest.yml": { version: "1.2.3" },
    "latest-linux.yml": { version: "1.2.3" },
    "latest-mac.yml (merged)": { version: "1.2.3" },
  }
  const baseFilenames = [
    "Synapse-Setup-1.2.3.exe",
    "Synapse-1.2.3.msi",
    "Synapse-1.2.3-x64-mac.zip",
    "Synapse-1.2.3-arm64-mac.zip",
    "Synapse-1.2.3-x64.dmg",
    "Synapse-1.2.3-arm64.dmg",
    "Synapse-1.2.3.AppImage",
    "Synapse-1.2.3.deb",
  ]

  it("passes when tag, package.json, every feed, and every filename agree", () => {
    const result = checkVersionConsistency({
      tagVersion: "1.2.3",
      packageVersion: "1.2.3",
      feeds: baseFeeds,
      installerFilenames: baseFilenames,
    })
    expect(result).toEqual({ ok: true })
  })

  it("fails when the tag does not match package.json", () => {
    const result = checkVersionConsistency({
      tagVersion: "1.2.4",
      packageVersion: "1.2.3",
      feeds: baseFeeds,
      installerFilenames: baseFilenames,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("tag version")
  })

  it("fails when a feed file's version disagrees", () => {
    const result = checkVersionConsistency({
      tagVersion: "1.2.3",
      packageVersion: "1.2.3",
      feeds: { ...baseFeeds, "latest.yml": { version: "1.2.2" } },
      installerFilenames: baseFilenames,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("latest.yml")
  })

  it("fails when an installer filename does not contain the exact expected version", () => {
    const result = checkVersionConsistency({
      tagVersion: "1.2.3",
      packageVersion: "1.2.3",
      feeds: baseFeeds,
      installerFilenames: ["Synapse-Setup-1.2.2.exe"],
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("Synapse-Setup-1.2.2.exe")
  })

  it("rejects a version that only contains the expected version as a substring", () => {
    const result = checkVersionConsistency({
      tagVersion: "1.2.3",
      packageVersion: "1.2.3",
      feeds: baseFeeds,
      installerFilenames: ["Synapse-11.2.30.exe"],
    })
    expect(result.ok).toBe(false)
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
    "electron-macos-x64-zip": [
      "Synapse-1.2.3-x64-mac.zip",
      "Synapse-1.2.3-x64-mac.zip.blockmap",
      "latest-mac.yml",
    ],
    "electron-macos-arm64-zip": [
      "Synapse-1.2.3-arm64-mac.zip",
      "Synapse-1.2.3-arm64-mac.zip.blockmap",
      "latest-mac.yml",
    ],
    "electron-macos-x64-dmg": ["Synapse-1.2.3-x64.dmg"],
    "electron-macos-arm64-dmg": ["Synapse-1.2.3-arm64.dmg"],
    "electron-linux-x64-appimage": ["Synapse-1.2.3.AppImage", "latest-linux.yml"],
    "electron-linux-x64-deb": ["Synapse-1.2.3.deb"],
  }
}

describe("checkArtifactManifest", () => {
  it("passes when every container has exactly its expected files", () => {
    expect(checkArtifactManifest(validContainers())).toEqual({ ok: true })
  })

  it("fails when a container is missing entirely", () => {
    const containers = validContainers()
    delete containers["electron-linux-x64-deb"]
    const result = checkArtifactManifest(containers)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("electron-linux-x64-deb")
  })

  it("fails when a container has the wrong file count", () => {
    const containers = validContainers()
    containers["electron-windows-x64-msi"] = ["a.msi", "b.msi"]
    const result = checkArtifactManifest(containers)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("electron-windows-x64-msi")
  })

  it("fails when a container appears that isn't in the table", () => {
    const containers = validContainers()
    containers["test-results"] = ["report.xml"]
    const result = checkArtifactManifest(containers)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("test-results")
  })

  it("fails when a container's file doesn't match the expected pattern", () => {
    const containers = validContainers()
    containers["electron-windows-x64-msi"] = ["Synapse-1.2.3.exe"]
    const result = checkArtifactManifest(containers)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("electron-windows-x64-msi")
  })
})

describe("validateSingleFileFeed", () => {
  const real = { filename: "Synapse-1.2.3-x64-mac.zip", sha512: "AAA", size: 100, blockMapSize: 10 }
  const feed = {
    version: "1.2.3",
    files: [{ url: "Synapse-1.2.3-x64-mac.zip", sha512: "AAA", size: 100, blockMapSize: 10 }],
  }

  it("passes when the feed matches the real file exactly", () => {
    const result = validateSingleFileFeed(feed, real, "test feed")
    expect(result.ok).toBe(true)
    expect(result.entry).toEqual(feed.files[0])
  })

  it("fails when files does not have exactly one entry", () => {
    expect(validateSingleFileFeed({ ...feed, files: [] }, real, "test feed").ok).toBe(false)
    expect(
      validateSingleFileFeed({ ...feed, files: [feed.files[0], feed.files[0]] }, real, "test feed")
        .ok
    ).toBe(false)
  })

  it("fails when the referenced filename does not match the real file", () => {
    const result = validateSingleFileFeed(
      { ...feed, files: [{ ...feed.files[0], url: "wrong-name.zip" }] },
      real,
      "test feed"
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("wrong-name.zip")
  })

  it("fails on a sha512 mismatch", () => {
    const result = validateSingleFileFeed(
      { ...feed, files: [{ ...feed.files[0], sha512: "WRONG" }] },
      real,
      "test feed"
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("sha512")
  })

  it("fails on a size mismatch", () => {
    const result = validateSingleFileFeed(
      { ...feed, files: [{ ...feed.files[0], size: 999 }] },
      real,
      "test feed"
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("size")
  })

  it("fails on a blockMapSize mismatch when the field is present", () => {
    const result = validateSingleFileFeed(
      { ...feed, files: [{ ...feed.files[0], blockMapSize: 999 }] },
      real,
      "test feed"
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("blockMapSize")
  })

  it("does not require blockMapSize when the feed entry omits it", () => {
    const { blockMapSize: _drop, ...entryWithoutBlockMapSize } = feed.files[0]
    const result = validateSingleFileFeed(
      { ...feed, files: [entryWithoutBlockMapSize] },
      real,
      "test feed"
    )
    expect(result.ok).toBe(true)
  })
})

describe("mergeMacFeeds", () => {
  const x64Real = { filename: "Synapse-1.2.3-x64-mac.zip", sha512: "X64HASH", size: 100 }
  const arm64Real = { filename: "Synapse-1.2.3-arm64-mac.zip", sha512: "ARM64HASH", size: 200 }
  const x64Feed = {
    version: "1.2.3",
    releaseDate: "2026-07-11T00:00:00.000Z",
    files: [{ url: "Synapse-1.2.3-x64-mac.zip", sha512: "X64HASH", size: 100 }],
  }
  const arm64Feed = {
    version: "1.2.3",
    releaseDate: "2026-07-11T00:00:00.000Z",
    files: [{ url: "Synapse-1.2.3-arm64-mac.zip", sha512: "ARM64HASH", size: 200 }],
  }

  it("merges two valid single-arch feeds into one canonical feed", () => {
    const result = mergeMacFeeds({ x64Feed, arm64Feed, x64Real, arm64Real })
    expect(result.ok).toBe(true)
    expect(result.merged).toEqual({
      version: "1.2.3",
      files: [x64Feed.files[0], arm64Feed.files[0]],
      path: "Synapse-1.2.3-x64-mac.zip",
      sha512: "X64HASH",
      releaseDate: "2026-07-11T00:00:00.000Z",
    })
  })

  it("fails when x64 and arm64 versions disagree", () => {
    const result = mergeMacFeeds({
      x64Feed,
      arm64Feed: { ...arm64Feed, version: "1.2.4" },
      x64Real,
      arm64Real,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("disagree")
  })

  it("fails when both entries have the same URL", () => {
    const collidingArm64Real = { ...arm64Real, filename: "Synapse-1.2.3-x64-mac.zip" }
    const collidingArm64Feed = {
      ...arm64Feed,
      files: [{ ...arm64Feed.files[0], url: "Synapse-1.2.3-x64-mac.zip" }],
    }
    const result = mergeMacFeeds({
      x64Feed,
      arm64Feed: collidingArm64Feed,
      x64Real,
      arm64Real: collidingArm64Real,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("colliding")
  })

  it('fails when the "arm64" leg does not contain "arm64" in its URL', () => {
    const wrongReal = { ...arm64Real, filename: "Synapse-1.2.3-mac.zip" }
    const wrongFeed = {
      ...arm64Feed,
      files: [{ ...arm64Feed.files[0], url: "Synapse-1.2.3-mac.zip" }],
    }
    const result = mergeMacFeeds({ x64Feed, arm64Feed: wrongFeed, x64Real, arm64Real: wrongReal })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('"arm64"')
  })
})

describe("checkFeedFiles", () => {
  const windowsReal = { filename: "Synapse-Setup-1.2.3.exe", sha512: "WINHASH", size: 300 }
  const linuxReal = { filename: "Synapse-1.2.3.AppImage", sha512: "LINUXHASH", size: 400 }
  const windowsFeed = {
    version: "1.2.3",
    files: [{ url: "Synapse-Setup-1.2.3.exe", sha512: "WINHASH", size: 300 }],
  }
  const linuxFeed = {
    version: "1.2.3",
    files: [{ url: "Synapse-1.2.3.AppImage", sha512: "LINUXHASH", size: 400 }],
  }

  it("passes when both feeds match their real files", () => {
    expect(checkFeedFiles({ windowsFeed, windowsReal, linuxFeed, linuxReal })).toEqual({ ok: true })
  })

  it("fails when the windows feed doesn't match", () => {
    const result = checkFeedFiles({
      windowsFeed: { ...windowsFeed, files: [{ ...windowsFeed.files[0], sha512: "WRONG" }] },
      windowsReal,
      linuxFeed,
      linuxReal,
    })
    expect(result.ok).toBe(false)
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

describe("mac merge / electron-updater contract", () => {
  it("the real MacUpdater.filterFilesForArch resolves each arch to the correct merged entry", () => {
    const x64Real = { filename: "Synapse-1.2.3-x64-mac.zip", sha512: "X64HASH", size: 100 }
    const arm64Real = { filename: "Synapse-1.2.3-arm64-mac.zip", sha512: "ARM64HASH", size: 200 }
    const x64Feed = {
      version: "1.2.3",
      files: [{ url: "Synapse-1.2.3-x64-mac.zip", sha512: "X64HASH", size: 100 }],
    }
    const arm64Feed = {
      version: "1.2.3",
      files: [{ url: "Synapse-1.2.3-arm64-mac.zip", sha512: "ARM64HASH", size: 200 }],
    }

    const { merged } = mergeMacFeeds({ x64Feed, arm64Feed, x64Real, arm64Real })
    const files = merged.files.map((f) => ({
      ...f,
      url: { pathname: f.url },
      info: { url: f.url },
    }))

    const arm64Resolved = MacUpdater.filterFilesForArch(files, true)
    expect(arm64Resolved).toHaveLength(1)
    expect(arm64Resolved[0].url.pathname).toBe("Synapse-1.2.3-arm64-mac.zip")

    const x64Resolved = MacUpdater.filterFilesForArch(files, false)
    expect(x64Resolved).toHaveLength(1)
    expect(x64Resolved[0].url.pathname).toBe("Synapse-1.2.3-x64-mac.zip")
  })
})
