import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { gunzipSync } from "node:zlib"
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
 * Every Windows feed file's version, and every installer filename, must
 * agree with package.json — never derived, always checked directly, so a
 * build that silently produced the wrong version (still structurally
 * complete and correctly named) can't slip through. Required in both
 * dry-run and release mode: package.json is always the source of truth
 * for what was actually built, regardless of whether a tag exists yet.
 */
export function checkPackageVersionConsistency({ packageVersion, feeds, installerFilenames }) {
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

/**
 * The tag is only meaningful once a release is actually being cut — a
 * dry-run branch dispatch has no tag at all. Kept separate from
 * `checkPackageVersionConsistency` so release-only eligibility can be
 * gated independently of the artifact/feed checks that must run every time.
 */
export function checkTagVersion({ tagVersion, packageVersion }) {
  if (tagVersion !== packageVersion) {
    return {
      ok: false,
      reason: `tag version "${tagVersion}" does not match package.json version "${packageVersion}"`,
    }
  }
  return { ok: true }
}

/** The gate's two supported execution modes (§Checkpoint R). Anything else
 *  — including a missing value — fails closed rather than defaulting. */
export function parseReleaseMode(rawMode) {
  if (rawMode === "dry-run" || rawMode === "release") {
    return { ok: true, mode: rawMode }
  }
  return {
    ok: false,
    reason: `unrecognized release mode "${rawMode}" — expected "dry-run" or "release"`,
  }
}

/**
 * The only two checks a branch dry run cannot perform (no tag, no
 * release-SHA nightly signal). Release mode must never be able to omit
 * either input — silently skipping them for a "release" is exactly the
 * TOCTOU gap `checkEvalSignal` and `checkTagVersion` exist to close.
 * Every other contract (artifact/feed/signing/manifest) is unconditional
 * and lives outside this gate.
 */
export function checkReleaseModeGate({ mode, tagVersion, packageVersion, evalSignalInputs }) {
  const modeResult = parseReleaseMode(mode)
  if (!modeResult.ok) return modeResult

  if (modeResult.mode === "dry-run") {
    return { ok: true, mode: "dry-run", skipped: ["tagVersion", "evalSignal"] }
  }

  if (typeof tagVersion !== "string" || tagVersion.length === 0) {
    return {
      ok: false,
      reason: "release mode requires a tag version; only dry-run may omit it",
    }
  }
  if (evalSignalInputs == null) {
    return {
      ok: false,
      reason: "release mode requires eval-signal inputs; only dry-run may omit them",
    }
  }

  const tagCheck = checkTagVersion({ tagVersion, packageVersion })
  if (!tagCheck.ok) return tagCheck

  const evalCheck = checkEvalSignal(evalSignalInputs)
  if (!evalCheck.ok) return evalCheck

  return { ok: true, mode: "release" }
}

/**
 * The one machine-readable statement of what this release actually
 * publishes (S11 Checkpoint R). Emitted verbatim as `release-profile.json`
 * in the approved bundle and rendered into the release body — never
 * duplicated as a second, independently-maintained platform list.
 */
export const RELEASE_PROFILE = {
  schemaVersion: 1,
  targets: [
    {
      platform: "windows",
      arch: "x64",
      packages: ["nsis", "msi"],
      updaterFeed: "latest.yml",
    },
  ],
}

/**
 * The dynamic counterpart to `RELEASE_PROFILE`: which commit/run produced
 * this bundle and under which mode, so an attested dry-run bundle can
 * never be mistaken for a real release. Rejects empty identifiers instead
 * of silently emitting a proof file that doesn't actually identify
 * anything.
 */
export function buildReleaseContext({ mode, commitSha, workflowRunId }) {
  const modeResult = parseReleaseMode(mode)
  if (!modeResult.ok) return modeResult

  if (typeof commitSha !== "string" || commitSha.length === 0) {
    return { ok: false, reason: "buildReleaseContext requires a non-empty commitSha" }
  }
  if (typeof workflowRunId !== "string" || workflowRunId.length === 0) {
    return { ok: false, reason: "buildReleaseContext requires a non-empty workflowRunId" }
  }

  return {
    ok: true,
    context: {
      schemaVersion: 1,
      mode: modeResult.mode,
      commitSha,
      workflowRunId,
    },
  }
}

/** Exactly the two containers the Windows-only release profile produces
 *  (S11 Checkpoint R — supersedes S03's multi-platform matrix). */
export const EXPECTED_ARTIFACT_MANIFEST = {
  "electron-windows-x64-nsis": [/\.exe$/, /\.blockmap$/, /^latest\.yml$/],
  "electron-windows-x64-msi": [/\.msi$/],
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
 * A feed file describing exactly one updater artifact must reference the
 * real file that actually exists, by name, hash, and size. Windows'
 * `latest.yml` is the only release feed now that S11 Checkpoint R has made
 * the release profile Windows-only, checked against the real NSIS installer
 * only — the blockmap is verified independently by `validateWindowsBlockmap()`
 * below, because standard `latest.yml` output carries no blockmap filename or
 * hash to compare.
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
  return { ok: true, entry }
}

/**
 * The NSIS blockmap is an adjacent updater asset, not a field inside
 * `latest.yml` — electron-updater's own differential-download code reads
 * it by gunzipping the file and parsing the result as JSON (locked
 * against the real `electron-updater@6.8.9` convention), so this proves
 * the bytes are structurally usable. `manifest.json` is what actually
 * binds this file's sha512 into the release; this contract only proves
 * the name and bytes are well-formed before that hash is taken.
 */
export function validateWindowsBlockmap(installerName, blockmapName, bytes) {
  const expectedName = `${installerName}.blockmap`
  if (blockmapName !== expectedName) {
    return {
      ok: false,
      reason: `blockmap filename "${blockmapName}" does not match expected "${expectedName}"`,
    }
  }
  if (!bytes || bytes.length === 0) {
    return { ok: false, reason: `blockmap "${blockmapName}" is empty` }
  }

  let decompressed
  try {
    decompressed = gunzipSync(bytes)
  } catch {
    return { ok: false, reason: `blockmap "${blockmapName}" is not valid gzip data` }
  }

  let parsed
  try {
    parsed = JSON.parse(decompressed.toString("utf8"))
  } catch {
    return { ok: false, reason: `blockmap "${blockmapName}" does not gunzip to valid JSON` }
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: `blockmap "${blockmapName}" JSON content is not an object` }
  }

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

/**
 * The one `signing-status.json` object written into the approved bundle.
 * Windows-only per S11 Checkpoint R: `platformCodeSigning` stays a map keyed
 * by platform (rather than a fixed windows+macos pair) so a future platform
 * can be added without a shape change, but today it contains exactly one
 * entry. Kept as a pure function, separate from the real `computeSigningStatus`
 * call in `main()`, so tests can lock the emitted shape without any gh/fs I/O.
 */
export function buildSigningStatus(windowsSigning) {
  return {
    schemaVersion: 1,
    platformCodeSigning: {
      windows: windowsSigning,
    },
    githubArtifactAttestation: { required: true },
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

  // Explicit execution mode (§Checkpoint R). release.yml's tag-push publish
  // path does not set RELEASE_MODE, so an absent value means a real release
  // rather than silently defaulting to the weaker dry-run checks; only the
  // dry-run dispatch workflow ever sets RELEASE_MODE=dry-run.
  const modeResult = parseReleaseMode(process.env.RELEASE_MODE ?? "release")
  if (!modeResult.ok) return fail(modeResult.reason)
  const mode = modeResult.mode

  // §4: artifact identity and cardinality — exactly the two Windows containers.
  const containers = downloadRawArtifacts()
  const manifestCheck = checkArtifactManifest(containers)
  if (!manifestCheck.ok) return fail(manifestCheck.reason)

  // §5: the approved Windows NSIS + MSI containers and their real files.
  const nsisDir = join(ARTIFACTS_DIR, "electron-windows-x64-nsis")
  const msiDir = join(ARTIFACTS_DIR, "electron-windows-x64-msi")
  const nsisFiles = containers["electron-windows-x64-nsis"]
  const msiFiles = containers["electron-windows-x64-msi"]

  const winExeName = nsisFiles.find((f) => f.endsWith(".exe"))
  const blockmapName = nsisFiles.find((f) => f.endsWith(".blockmap"))
  const msiName = msiFiles[0]

  const winFeed = readYaml(join(nsisDir, "latest.yml"))
  const feedCheck = validateSingleFileFeed(winFeed, realFileInfo(nsisDir, winExeName), "latest.yml")
  if (!feedCheck.ok) return fail(feedCheck.reason)

  const blockmapCheck = validateWindowsBlockmap(
    winExeName,
    blockmapName,
    readFileSync(join(nsisDir, blockmapName))
  )
  if (!blockmapCheck.ok) return fail(blockmapCheck.reason)

  // §3: version consistency — required in both modes.
  const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version
  const packageVersionCheck = checkPackageVersionConsistency({
    packageVersion,
    feeds: { "latest.yml": winFeed },
    installerFilenames: [winExeName, msiName],
  })
  if (!packageVersionCheck.ok) return fail(packageVersionCheck.reason)

  // §2/§3: tag version and S01 eval-signal eligibility — release mode only.
  const tagVersion = mode === "release" ? stripLeadingV(process.env.GITHUB_REF_NAME) : undefined
  const evalSignalInputs = mode === "release" ? fetchEvalSignalInputs(releasedSha) : undefined
  const modeGateCheck = checkReleaseModeGate({ mode, tagVersion, packageVersion, evalSignalInputs })
  if (!modeGateCheck.ok) return fail(modeGateCheck.reason)

  // §6: Windows signing status (hardcoded not-performed today — §12 parks real verification).
  const windowsCertConfigured = process.env.WINDOWS_CERT_CONFIGURED === "true"
  const winSigning = computeSigningStatus(windowsCertConfigured, "not-performed")
  if (!winSigning.ok) return fail(`Windows signing: ${winSigning.reason}`)

  // The dynamic release-context proof — which commit/run produced this
  // bundle and under which mode.
  const contextResult = buildReleaseContext({
    mode,
    commitSha: releasedSha,
    workflowRunId: process.env.GITHUB_RUN_ID ?? "",
  })
  if (!contextResult.ok) return fail(contextResult.reason)

  // §8: assemble release-approved-bundle/assets/ — only the two Windows
  // containers plus the generated proof files.
  const bundleDir = "release-approved-bundle"
  const assetsDir = join(bundleDir, "assets")
  mkdirSync(assetsDir, { recursive: true })

  copyContainerFiles(nsisDir, nsisFiles, assetsDir)
  copyContainerFiles(msiDir, msiFiles, assetsDir)

  writeFileSync(
    join(assetsDir, "release-profile.json"),
    `${JSON.stringify(RELEASE_PROFILE, null, 2)}\n`
  )
  writeFileSync(
    join(assetsDir, "release-context.json"),
    `${JSON.stringify(contextResult.context, null, 2)}\n`
  )

  const signingStatus = buildSigningStatus({
    credentialsConfigured: windowsCertConfigured,
    verification: "not-performed",
    releaseClaim: winSigning.releaseClaim,
  })
  writeFileSync(
    join(assetsDir, "signing-status.json"),
    `${JSON.stringify(signingStatus, null, 2)}\n`
  )

  // The independently-known expected file set — everything just copied or
  // written into assetsDir above — never derived from a directory listing.
  // Comparing this against the real on-disk contents (next) is what actually
  // catches an unexpected extra/missing file; hashing and verifying against
  // the same readdir() result would be a tautology.
  const expectedAssetNames = [
    ...nsisFiles,
    ...msiFiles,
    "release-profile.json",
    "release-context.json",
    "signing-status.json",
  ]
  const onDiskNames = readdirSync(assetsDir).filter((f) => f !== "manifest.json")
  const missingOnDisk = expectedAssetNames.filter((n) => !onDiskNames.includes(n))
  const unexpectedOnDisk = onDiskNames.filter((n) => !expectedAssetNames.includes(n))
  if (missingOnDisk.length > 0 || unexpectedOnDisk.length > 0) {
    return fail(
      `assets/ file set does not match what was written (missing: [${missingOnDisk}], unexpected: [${unexpectedOnDisk}])`
    )
  }

  const manifestFiles = expectedAssetNames.map((name) => ({
    name,
    sha512: sha512Of(join(assetsDir, name)),
  }))
  const manifest = buildManifest(manifestFiles)
  writeFileSync(join(assetsDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)

  // Defense in depth: re-read every asset from disk a second time,
  // independently of the hashes just used to build the manifest, and verify
  // against the manifest.json file that was actually written.
  const writtenManifest = JSON.parse(readFileSync(join(assetsDir, "manifest.json"), "utf8"))
  const reReadFiles = readdirSync(assetsDir)
    .filter((f) => f !== "manifest.json")
    .map((name) => ({ name, sha512: sha512Of(join(assetsDir, name)) }))
  const selfVerify = verifyManifest(writtenManifest, reReadFiles)
  if (!selfVerify.ok) return fail(`manifest self-check failed: ${selfVerify.reason}`)

  console.log(`release-admission-gate: assets/ assembled and manifest verified at ${assetsDir}`)
}

function capitalize(word) {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

/** Renders `RELEASE_PROFILE`'s targets as e.g. "Windows x64 (NSIS, MSI)" —
 *  the release body's platform statement is generated from this one object,
 *  never maintained as a second independent hardcoded platform list. */
function formatReleaseTargets(releaseProfile) {
  return releaseProfile.targets
    .map(
      (target) =>
        `${capitalize(target.platform)} ${target.arch} (${target.packages.map((p) => p.toUpperCase()).join(", ")})`
    )
    .join(", ")
}

/**
 * Exhaustive, fail-closed rendering of a platform's `releaseClaim` into the
 * prose actually shown in the published release body. An unrecognized claim
 * must never fall through to the strongest ("signed and verified") wording —
 * that would let a future third signing state silently ship an optimistic
 * security claim it never earned.
 */
function renderReleaseClaim(platform, releaseClaim) {
  if (releaseClaim === "unsigned-unverified") {
    return "CI has neither a configured platform code-signing credential nor has it performed a platform signature verification on this artifact."
  }
  if (releaseClaim === "signed-and-verified") {
    return "This artifact was signed with a configured platform credential, and CI verified the signature."
  }
  throw new Error(
    `buildReleaseBody: unrecognized releaseClaim "${releaseClaim}" for platform "${platform}" — refusing to render an unverified security claim`
  )
}

/**
 * Renders the release body from explicit `releaseProfile`/`releaseContext`
 * arguments rather than reading `RELEASE_PROFILE` or a global mode off the
 * environment — that keeps this function unit-testable and makes a
 * dry-run/release mismatch (attested profile vs. rendered body) structurally
 * impossible. `signingStatus.platformCodeSigning` is iterated as a map, so
 * this never assumes a macOS entry exists alongside Windows.
 */
export function buildReleaseBody({
  releaseProfile,
  releaseContext,
  signingStatus,
  attestationUrl,
  repoOwner,
}) {
  const platformLines = Object.entries(signingStatus.platformCodeSigning).map(
    ([platform, info]) => {
      const claim = renderReleaseClaim(platform, info.releaseClaim)
      return `- **${platform}**: ${claim}`
    }
  )

  const body = [
    "## Release Proof",
    "",
    `- **Release targets**: ${formatReleaseTargets(releaseProfile)}. No macOS or Linux artifacts are built, verified, or published by this pipeline.`,
    "",
    ...platformLines,
    "",
    `- **Attestation**: [${attestationUrl}](${attestationUrl})`,
    `  Verify locally with: \`gh attestation verify <downloaded-file> --owner ${repoOwner}\``,
    "- **Integrity**: every asset's sha512 is listed in `manifest.json`, included in this release.",
    "",
  ].join("\n")

  return releaseContext.mode === "dry-run" ? `DRY RUN — NOT A RELEASE\n\n${body}` : body
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
