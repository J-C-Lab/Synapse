import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import yaml from "js-yaml"

const STALE_MS = 48 * 60 * 60 * 1000
const CLOCK_SKEW_MS = 5 * 60 * 1000

/**
 * Verifies S01's eval signal actually proves the commit being released is
 * healthy — not just that *some* recent run was clean. Every input is
 * already-fetched data (no I/O in this function); see main() for the real
 * gh/fs calls that produce these.
 */
export function checkEvalSignal({
  runList,
  statusJson,
  runView,
  issues,
  releasedSha,
  now = () => new Date(),
}) {
  const completed = runList.filter((r) => r.status === "completed")
  if (completed.length === 0) {
    return { ok: false, reason: "no completed eval-nightly.yml run found" }
  }
  const chosenRun = completed.reduce((a, b) =>
    new Date(a.createdAt) > new Date(b.createdAt) ? a : b
  )

  if (issues.length !== 1) {
    return {
      ok: false,
      reason: `expected exactly one open eval-nightly-status issue, found ${issues.length}`,
    }
  }
  const issue = issues[0]
  if (issue.title !== "Eval Nightly Status") {
    return { ok: false, reason: `eval-nightly-status issue has unexpected title "${issue.title}"` }
  }
  const runIdMatch = /\/actions\/runs\/(\d+)/.exec(issue.body)
  if (!runIdMatch || Number(runIdMatch[1]) !== chosenRun.databaseId) {
    return {
      ok: false,
      reason: "eval-nightly-status issue does not reference the most recent completed run",
    }
  }

  if (statusJson?.schemaVersion !== 1) {
    return {
      ok: false,
      reason: "eval-nightly-status-json has an unexpected or missing schemaVersion",
    }
  }
  const completedAt = new Date(statusJson.completedAt)
  if (Number.isNaN(completedAt.getTime())) {
    return {
      ok: false,
      reason: "eval-nightly-status-json completedAt is not a valid ISO 8601 timestamp",
    }
  }
  const nowDate = now()
  if (completedAt.getTime() > nowDate.getTime() + CLOCK_SKEW_MS) {
    return { ok: false, reason: "eval-nightly-status-json completedAt is in the future" }
  }

  if (typeof statusJson.runId !== "string" || statusJson.runId !== String(chosenRun.databaseId)) {
    return {
      ok: false,
      reason: "eval-nightly-status-json runId does not match the run it was downloaded from",
    }
  }
  if (statusJson.headSha !== runView.headSha) {
    return {
      ok: false,
      reason: "eval-nightly-status-json headSha does not match GitHub's own run record",
    }
  }
  if (runView.conclusion !== "success") {
    return {
      ok: false,
      reason: `eval-nightly.yml run concluded "${runView.conclusion}", not "success"`,
    }
  }
  if (statusJson.state !== "clean") {
    return {
      ok: false,
      reason: `eval-nightly-status-json state is "${statusJson.state}", not "clean"`,
    }
  }
  if (statusJson.headSha !== releasedSha) {
    return {
      ok: false,
      reason:
        `eval-nightly-status-json headSha (${statusJson.headSha}) does not match the commit being released ` +
        `(${releasedSha}) — run "gh workflow run eval-nightly.yml --ref <tag>" and retry once it completes clean`,
    }
  }
  if (nowDate.getTime() - completedAt.getTime() > STALE_MS) {
    return {
      ok: false,
      reason:
        "eval-nightly-status-json completedAt is more than 48 hours old — run " +
        '"gh workflow run eval-nightly.yml --ref <tag>" and retry once it completes clean',
    }
  }

  return { ok: true }
}

/** Strips a leading "v" from a git tag ref, e.g. "v1.2.3" -> "1.2.3". */
export function stripLeadingV(tag) {
  return tag.startsWith("v") ? tag.slice(1) : tag
}

/**
 * Every feed file's version, and every installer filename, must agree
 * with both the tag and package.json — never derived, always checked
 * directly, so a matrix leg that silently built from the wrong commit
 * (still producing a structurally complete, correctly-named output)
 * can't slip through.
 */
export function checkVersionConsistency({ tagVersion, packageVersion, feeds, installerFilenames }) {
  if (tagVersion !== packageVersion) {
    return {
      ok: false,
      reason: `tag version "${tagVersion}" does not match package.json version "${packageVersion}"`,
    }
  }
  for (const [name, feed] of Object.entries(feeds)) {
    if (feed.version !== packageVersion) {
      return {
        ok: false,
        reason: `${name} version "${feed.version}" does not match package.json version "${packageVersion}"`,
      }
    }
  }
  for (const filename of installerFilenames) {
    if (!hasExactVersionSegment(filename, packageVersion)) {
      return {
        ok: false,
        reason: `installer filename "${filename}" does not contain exact version "${packageVersion}"`,
      }
    }
  }
  return { ok: true }
}

function hasExactVersionSegment(filename, version) {
  if (typeof filename !== "string") return false
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(?:^|[-_])${escapedVersion}(?=[-_.]|$)`).test(filename)
}

/** Exactly the platform/arch containers build-electron.yml's matrix
 *  produces (§4/§9 of the spec — includes the Linux leg this spec adds). */
export const EXPECTED_ARTIFACT_MANIFEST = {
  "electron-windows-x64-nsis": [/\.exe$/, /\.blockmap$/, /^latest\.yml$/],
  "electron-windows-x64-msi": [/\.msi$/],
  "electron-macos-x64-zip": [/-x64-mac\.zip$/, /\.blockmap$/, /^latest-mac\.yml$/],
  "electron-macos-arm64-zip": [/-arm64-mac\.zip$/, /\.blockmap$/, /^latest-mac\.yml$/],
  "electron-macos-x64-dmg": [/\.dmg$/],
  "electron-macos-arm64-dmg": [/\.dmg$/],
  "electron-linux-x64-appimage": [/\.AppImage$/, /^latest-linux\.yml$/],
  "electron-linux-x64-deb": [/\.deb$/],
}

/**
 * `downloadedContainers`: { [containerName]: string[] } — the actual
 * filenames present in each downloaded artifact's own subdirectory
 * (already scoped to `pattern: electron-*` by the caller, §4 — this
 * function never sees test.yml's test-results/coverage-report).
 */
export function checkArtifactManifest(downloadedContainers) {
  const expectedNames = Object.keys(EXPECTED_ARTIFACT_MANIFEST)
  const actualNames = Object.keys(downloadedContainers)

  for (const name of actualNames) {
    if (!expectedNames.includes(name)) {
      return {
        ok: false,
        reason: `unexpected artifact container "${name}" — not a release candidate input`,
      }
    }
  }
  for (const name of expectedNames) {
    const patterns = EXPECTED_ARTIFACT_MANIFEST[name]
    const files = downloadedContainers[name]
    if (!files) {
      return { ok: false, reason: `missing expected artifact container "${name}"` }
    }
    if (files.length !== patterns.length) {
      return {
        ok: false,
        reason: `container "${name}" has ${files.length} files, expected ${patterns.length}`,
      }
    }
    const remaining = [...files]
    for (const pattern of patterns) {
      const idx = remaining.findIndex((f) => pattern.test(f))
      if (idx === -1) {
        return { ok: false, reason: `container "${name}" is missing a file matching ${pattern}` }
      }
      remaining.splice(idx, 1)
    }
  }
  return { ok: true }
}

/**
 * Shared by both the mac pre-merge check and the Windows/Linux feed
 * check: a feed file describing exactly one updater artifact must
 * reference the real file that actually exists, by name, hash, and size.
 */
export function validateSingleFileFeed(feed, real, label) {
  if (!Array.isArray(feed.files) || feed.files.length !== 1) {
    return { ok: false, reason: `${label} must have exactly one files entry` }
  }
  const entry = feed.files[0]
  const basename = entry.url.split("/").pop()
  if (basename !== real.filename) {
    return {
      ok: false,
      reason: `${label} references "${basename}" but the real file is "${real.filename}"`,
    }
  }
  if (entry.sha512 !== real.sha512) {
    return { ok: false, reason: `${label} sha512 does not match the real file` }
  }
  if (entry.size !== real.size) {
    return { ok: false, reason: `${label} size does not match the real file` }
  }
  if (entry.blockMapSize !== undefined && entry.blockMapSize !== real.blockMapSize) {
    return { ok: false, reason: `${label} blockMapSize does not match the real blockmap file` }
  }
  return { ok: true, entry }
}

/**
 * Merges the two single-arch latest-mac.yml files build-electron.yml's
 * separate x64/arm64 matrix legs each independently produce into one
 * canonical feed — verified against the locked electron-updater@6.8.9
 * source (spec §5): MacUpdater.filterFilesForArch() picks an entry by
 * checking whether its URL contains "arm64", so the merged `files` array
 * must have exactly one entry that does and one that doesn't.
 */
export function mergeMacFeeds({ x64Feed, arm64Feed, x64Real, arm64Real }) {
  const x64Result = validateSingleFileFeed(x64Feed, x64Real, "x64 latest-mac.yml")
  if (!x64Result.ok) return x64Result
  const arm64Result = validateSingleFileFeed(arm64Feed, arm64Real, "arm64 latest-mac.yml")
  if (!arm64Result.ok) return arm64Result

  if (x64Feed.version !== arm64Feed.version) {
    return { ok: false, reason: "x64 and arm64 latest-mac.yml versions disagree" }
  }

  const x64Entry = x64Result.entry
  const arm64Entry = arm64Result.entry
  if (x64Entry.url === arm64Entry.url) {
    return { ok: false, reason: "x64 and arm64 latest-mac.yml entries have colliding URLs" }
  }
  if (!arm64Entry.url.includes("arm64")) {
    return { ok: false, reason: 'arm64 latest-mac.yml entry URL does not contain "arm64"' }
  }
  if (x64Entry.url.includes("arm64")) {
    return { ok: false, reason: 'x64 latest-mac.yml entry URL unexpectedly contains "arm64"' }
  }

  return {
    ok: true,
    merged: {
      version: x64Feed.version,
      files: [x64Entry, arm64Entry],
      path: x64Entry.url,
      sha512: x64Entry.sha512,
      releaseDate: x64Feed.releaseDate,
    },
  }
}

/** Windows and Linux each ship one arch, so their feeds get the same
 *  single-file check the mac pre-merge phase uses, with no merge step. */
export function checkFeedFiles({ windowsFeed, windowsReal, linuxFeed, linuxReal }) {
  const winResult = validateSingleFileFeed(windowsFeed, windowsReal, "latest.yml")
  if (!winResult.ok) return winResult
  const linuxResult = validateSingleFileFeed(linuxFeed, linuxReal, "latest-linux.yml")
  if (!linuxResult.ok) return linuxResult
  return { ok: true }
}

/**
 * Spec §6's fail-closed signing state machine. Decided now, before any
 * real signing credential exists, so that the day one is added without
 * also wiring up real signature verification, the very next release
 * fails hard instead of shipping something that looks configured but
 * was never actually checked.
 */
export function computeSigningStatus(credentialsConfigured, verification) {
  if (!credentialsConfigured && verification === "not-performed") {
    return { ok: true, releaseClaim: "unsigned-unverified" }
  }
  if (credentialsConfigured && verification === "verified") {
    return { ok: true, releaseClaim: "signed-and-verified" }
  }
  if (credentialsConfigured && verification === "not-performed") {
    return {
      ok: false,
      reason: "signing credentials are configured but no signature verification was performed",
    }
  }
  if (credentialsConfigured && verification === "failed") {
    return {
      ok: false,
      reason: "signing credentials are configured but signature verification failed",
    }
  }
  if (!credentialsConfigured && verification === "verified") {
    return {
      ok: false,
      reason: "contradictory signing state: verification succeeded with no credentials configured",
    }
  }
  return {
    ok: false,
    reason: `unrecognized signing state: credentialsConfigured=${credentialsConfigured}, verification=${verification}`,
  }
}

/** Every file in assets/ except manifest.json itself, with its sha512
 *  recomputed from real bytes (never copied from a feed file). */
export function buildManifest(files) {
  return {
    schemaVersion: 1,
    files: Object.fromEntries(files.map((f) => [f.name, { sha512: f.sha512 }])),
  }
}

/**
 * Re-verification used both by the gate (defense in depth right after
 * building the manifest) and by create-release (after its own download
 * round-trip, before publishing). Checks hash equality AND file-set
 * equality — a file added to assets/ after the manifest was written
 * would otherwise still get published via a glob despite never having
 * been hashed or inventoried.
 */
export function verifyManifest(manifest, actualFiles) {
  const manifestNames = Object.keys(manifest.files).sort()
  const actualNames = actualFiles.map((f) => f.name).sort()
  const manifestSet = new Set(manifestNames)
  const actualSet = new Set(actualNames)
  const missing = manifestNames.filter((n) => !actualSet.has(n))
  const extra = actualNames.filter((n) => !manifestSet.has(n))
  if (missing.length > 0 || extra.length > 0) {
    return {
      ok: false,
      reason: `manifest.json file set does not match assets/ contents (missing: [${missing}], extra: [${extra}])`,
    }
  }
  for (const file of actualFiles) {
    const expected = manifest.files[file.name]
    if (expected.sha512 !== file.sha512) {
      return { ok: false, reason: `sha512 mismatch for "${file.name}"` }
    }
  }
  return { ok: true }
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8" })
}

function sha512Of(path) {
  return createHash("sha512").update(readFileSync(path)).digest("base64")
}

function readYaml(path) {
  return yaml.load(readFileSync(path, "utf8"))
}

const ARTIFACTS_DIR = "artifacts"

function downloadRawArtifacts() {
  execFileSync("gh", [
    "run",
    "download",
    process.env.GITHUB_RUN_ID,
    "--pattern",
    "electron-*",
    "-D",
    ARTIFACTS_DIR,
  ])
  const containers = {}
  for (const name of readdirSync(ARTIFACTS_DIR)) {
    containers[name] = readdirSync(join(ARTIFACTS_DIR, name))
  }
  return containers
}

function realFileInfo(containerDir, filename) {
  const path = join(containerDir, filename)
  const blockmapPath = `${path}.blockmap`
  let blockMapSize
  try {
    blockMapSize = statSync(blockmapPath).size
  } catch {
    blockMapSize = undefined
  }
  return { filename, sha512: sha512Of(path), size: statSync(path).size, blockMapSize }
}

function fetchEvalSignalInputs(releasedSha) {
  const runList = JSON.parse(
    gh([
      "run",
      "list",
      "--workflow=eval-nightly.yml",
      "--json",
      "databaseId,headSha,status,createdAt",
      "--limit",
      "5",
    ])
  )
  const completed = runList.filter((r) => r.status === "completed")
  if (completed.length === 0) {
    return { runList, statusJson: null, runView: null, issues: [], releasedSha }
  }
  const chosenRun = completed.reduce((a, b) =>
    new Date(a.createdAt) > new Date(b.createdAt) ? a : b
  )

  const runView = JSON.parse(
    gh(["run", "view", String(chosenRun.databaseId), "--json", "headSha,conclusion"])
  )

  const statusDir = "eval-nightly-status-download"
  mkdirSync(statusDir, { recursive: true })
  execFileSync("gh", [
    "run",
    "download",
    String(chosenRun.databaseId),
    "-n",
    "eval-nightly-status-json",
    "-D",
    statusDir,
  ])
  const statusJson = JSON.parse(readFileSync(join(statusDir, "eval-nightly-status.json"), "utf8"))

  const issues = JSON.parse(
    gh([
      "issue",
      "list",
      "--label",
      "eval-nightly-status",
      "--state",
      "open",
      "--json",
      "number,title,body",
    ])
  )

  return { runList, statusJson, runView, issues, releasedSha }
}

function copyContainerFiles(srcDir, filenames, destDir) {
  for (const name of filenames) {
    writeFileSync(join(destDir, name), readFileSync(join(srcDir, name)))
  }
}

function fail(reason) {
  console.error(`release-admission-gate: ${reason}`)
  process.exit(1)
}

function main() {
  const releasedSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
  if (releasedSha !== process.env.GITHUB_SHA) {
    fail(
      `git rev-parse HEAD (${releasedSha}) does not match github.sha (${process.env.GITHUB_SHA})`
    )
    return
  }

  // §4: artifact identity and cardinality.
  const containers = downloadRawArtifacts()
  const manifestCheck = checkArtifactManifest(containers)
  if (!manifestCheck.ok) return fail(manifestCheck.reason)

  // §5: mac feed merge (pre-merge + post-merge).
  const winDir = join(ARTIFACTS_DIR, "electron-windows-x64-nsis")
  const macX64Dir = join(ARTIFACTS_DIR, "electron-macos-x64-zip")
  const macArm64Dir = join(ARTIFACTS_DIR, "electron-macos-arm64-zip")
  const linuxDir = join(ARTIFACTS_DIR, "electron-linux-x64-appimage")

  const winExeName = containers["electron-windows-x64-nsis"].find((f) => f.endsWith(".exe"))
  const macX64ZipName = containers["electron-macos-x64-zip"].find((f) => f.endsWith(".zip"))
  const macArm64ZipName = containers["electron-macos-arm64-zip"].find((f) => f.endsWith(".zip"))
  const macX64DmgName = containers["electron-macos-x64-dmg"].find((f) => f.endsWith(".dmg"))
  const macArm64DmgName = containers["electron-macos-arm64-dmg"].find((f) => f.endsWith(".dmg"))
  const appImageName = containers["electron-linux-x64-appimage"].find((f) =>
    f.endsWith(".AppImage")
  )
  const debName = containers["electron-linux-x64-deb"].find((f) => f.endsWith(".deb"))

  const mergeResult = mergeMacFeeds({
    x64Feed: readYaml(join(macX64Dir, "latest-mac.yml")),
    arm64Feed: readYaml(join(macArm64Dir, "latest-mac.yml")),
    x64Real: realFileInfo(macX64Dir, macX64ZipName),
    arm64Real: realFileInfo(macArm64Dir, macArm64ZipName),
  })
  if (!mergeResult.ok) return fail(mergeResult.reason)

  const winFeed = readYaml(join(winDir, "latest.yml"))
  const linuxFeed = readYaml(join(linuxDir, "latest-linux.yml"))
  const feedFilesCheck = checkFeedFiles({
    windowsFeed: winFeed,
    windowsReal: realFileInfo(winDir, winExeName),
    linuxFeed,
    linuxReal: realFileInfo(linuxDir, appImageName),
  })
  if (!feedFilesCheck.ok) return fail(feedFilesCheck.reason)

  // §3: version consistency.
  const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version
  const tagVersion = stripLeadingV(process.env.GITHUB_REF_NAME)
  const installerFilenames = [
    winExeName,
    containers["electron-windows-x64-msi"][0],
    macX64ZipName,
    macArm64ZipName,
    macX64DmgName,
    macArm64DmgName,
    appImageName,
    debName,
  ]
  const versionCheck = checkVersionConsistency({
    tagVersion,
    packageVersion,
    feeds: {
      "latest.yml": winFeed,
      "latest-linux.yml": linuxFeed,
      "latest-mac.yml (merged)": mergeResult.merged,
    },
    installerFilenames,
  })
  if (!versionCheck.ok) return fail(versionCheck.reason)

  // §2: eval-signal.
  const evalCheck = checkEvalSignal(fetchEvalSignalInputs(releasedSha))
  if (!evalCheck.ok) return fail(evalCheck.reason)

  // §6: signing status (hardcoded not-performed today — §12 parks real verification).
  const appleCertConfigured = process.env.APPLE_CERT_CONFIGURED === "true"
  const windowsCertConfigured = process.env.WINDOWS_CERT_CONFIGURED === "true"
  const macSigning = computeSigningStatus(appleCertConfigured, "not-performed")
  if (!macSigning.ok) return fail(`macOS signing: ${macSigning.reason}`)
  const winSigning = computeSigningStatus(windowsCertConfigured, "not-performed")
  if (!winSigning.ok) return fail(`Windows signing: ${winSigning.reason}`)

  // §8: assemble release-approved-bundle/assets/.
  const bundleDir = "release-approved-bundle"
  const assetsDir = join(bundleDir, "assets")
  mkdirSync(assetsDir, { recursive: true })

  copyContainerFiles(winDir, containers["electron-windows-x64-nsis"], assetsDir)
  copyContainerFiles(
    join(ARTIFACTS_DIR, "electron-windows-x64-msi"),
    containers["electron-windows-x64-msi"],
    assetsDir
  )
  copyContainerFiles(
    macX64Dir,
    containers["electron-macos-x64-zip"].filter((f) => !f.endsWith(".yml")),
    assetsDir
  )
  copyContainerFiles(
    macArm64Dir,
    containers["electron-macos-arm64-zip"].filter((f) => !f.endsWith(".yml")),
    assetsDir
  )
  copyContainerFiles(
    join(ARTIFACTS_DIR, "electron-macos-x64-dmg"),
    containers["electron-macos-x64-dmg"],
    assetsDir
  )
  copyContainerFiles(
    join(ARTIFACTS_DIR, "electron-macos-arm64-dmg"),
    containers["electron-macos-arm64-dmg"],
    assetsDir
  )
  copyContainerFiles(
    linuxDir,
    containers["electron-linux-x64-appimage"].filter((f) => !f.endsWith(".yml")),
    assetsDir
  )
  copyContainerFiles(
    join(ARTIFACTS_DIR, "electron-linux-x64-deb"),
    containers["electron-linux-x64-deb"],
    assetsDir
  )

  writeFileSync(join(assetsDir, "latest.yml"), yaml.dump(winFeed))
  writeFileSync(join(assetsDir, "latest-linux.yml"), yaml.dump(linuxFeed))
  writeFileSync(join(assetsDir, "latest-mac.yml"), yaml.dump(mergeResult.merged))

  const signingStatus = {
    schemaVersion: 1,
    platformCodeSigning: {
      windows: {
        credentialsConfigured: windowsCertConfigured,
        verification: "not-performed",
        releaseClaim: winSigning.releaseClaim,
      },
      macos: {
        credentialsConfigured: appleCertConfigured,
        verification: "not-performed",
        releaseClaim: macSigning.releaseClaim,
      },
    },
    githubArtifactAttestation: { required: true },
  }
  writeFileSync(
    join(assetsDir, "signing-status.json"),
    `${JSON.stringify(signingStatus, null, 2)}\n`
  )

  const manifestFiles = readdirSync(assetsDir)
    .filter((f) => f !== "manifest.json")
    .map((name) => ({ name, sha512: sha512Of(join(assetsDir, name)) }))
  const manifest = buildManifest(manifestFiles)
  const selfVerify = verifyManifest(manifest, manifestFiles)
  if (!selfVerify.ok) return fail(`manifest self-check failed: ${selfVerify.reason}`)
  writeFileSync(join(assetsDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)

  console.log(`release-admission-gate: assets/ assembled and manifest verified at ${assetsDir}`)
}

export function buildReleaseBody({ signingStatus, attestationUrl, repoOwner }) {
  const platformLines = Object.entries(signingStatus.platformCodeSigning).map(
    ([platform, info]) => {
      const claim =
        info.releaseClaim === "unsigned-unverified"
          ? "CI has neither a configured platform code-signing credential nor has it performed a platform signature verification on this artifact."
          : "This artifact was signed with a configured platform credential, and CI verified the signature."
      return `- **${platform}**: ${claim}`
    }
  )
  return [
    "## Release Proof",
    "",
    ...platformLines,
    "",
    `- **Attestation**: [${attestationUrl}](${attestationUrl})`,
    `  Verify locally with: \`gh attestation verify <downloaded-file> --owner ${repoOwner}\``,
    "- **Integrity**: every asset's sha512 is listed in `manifest.json`, included in this release.",
    "",
  ].join("\n")
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
