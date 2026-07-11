# S03 Release Proof Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make it impossible for `release.yml` to publish a draft GitHub Release that hasn't been proven — via a real, gate-blocking check — to be built from eval-healthy code, version-consistent across every feed file, complete across every declared platform/architecture, free of the macOS dual-arch feed collision, honestly labeled about its signing status, and covered by a real GitHub build-provenance attestation.

**Architecture:** A new `release-admission-gate` job runs between `build-electron` and `create-release`. It's driven by one new script, `scripts/release-admission-gate.mjs`, built the same way S01's `eval-nightly-report.mjs` was: a set of pure, independently-tested decision functions (no I/O) plus a thin `main()` that does the real `gh`/filesystem work and calls those functions with already-fetched data. The gate assembles a single `release-approved-bundle` artifact (canonical merged feeds, a manifest, a signing-status declaration, a generated release body) and runs `actions/attest@v4` against it; `create-release` is changed to consume *only* that bundle, never the raw per-platform build artifacts.

**Tech Stack:** Plain Node ESM (`.mjs`, matching S01's script style), Vitest, `js-yaml` (new devDependency — already present transitively via `electron-updater`/`electron-builder`, being added as an explicit one), `gh` CLI, GitHub Actions (`actions/download-artifact@v8`, `actions/attest@v4`, `softprops/action-gh-release`).

**Spec:** [docs/superpowers/specs/2026-07-11-release-proof-pipeline-design.md](../specs/2026-07-11-release-proof-pipeline-design.md) — read in full before starting. This plan builds the spec's pure decision functions first (Tasks 2-7), wires them into `main()` (Task 8), then updates the workflow YAML files (Tasks 1, 9-11), then closes with the contract test and manual verification (Tasks 12-13).

---

## Before you start

Run `pnpm test`, `pnpm typecheck`, and `pnpm lint` once so you have a
known-clean baseline. Task 13 (manual verification) requires real GitHub
Actions + repo write access and pushes real tags — read its steps in
full before starting the rest of this plan so you understand what it
will require at the end.

---

## Task 1: S01 changes — `eval-nightly-status.json`

**Files:**
- Modify: `.github/workflows/eval-nightly.yml`
- Modify: `scripts/eval-nightly-report.mjs`
- Modify: `scripts/eval-nightly-report.test.mjs`

- [ ] **Step 1: Write the failing test for the new pure function**

Add to `scripts/eval-nightly-report.test.mjs`:

```js
import { buildStatusJson } from "./eval-nightly-report.mjs"

describe("buildStatusJson", () => {
  it("builds the status JSON from the already-computed state and env context", () => {
    const result = buildStatusJson({
      state: "clean",
      runId: "123456",
      headSha: "abc123",
      now: () => new Date("2026-07-11T07:05:00Z"),
    })
    expect(result).toEqual({
      schemaVersion: 1,
      state: "clean",
      runId: "123456",
      headSha: "abc123",
      completedAt: "2026-07-11T07:05:00.000Z",
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run scripts/eval-nightly-report.test.mjs`
Expected: FAIL — `buildStatusJson` is not exported

- [ ] **Step 3: Implement `buildStatusJson()` and wire it into `main()`**

In `scripts/eval-nightly-report.mjs`, add near the top (alongside `renderStatus`):

```js
/** Builds the machine-readable status artifact main() writes alongside
 *  the human-facing issue body. `state` is the same value renderStatus()
 *  already computed — never re-derived. */
export function buildStatusJson({ state, runId, headSha, now = () => new Date() }) {
  return {
    schemaVersion: 1,
    state,
    runId,
    headSha,
    completedAt: now().toISOString(),
  }
}
```

In `main()`, after the existing `const { state, summary } = renderStatus(...)` line, add:

```js
  const statusJson = buildStatusJson({
    state,
    runId: process.env.GITHUB_RUN_ID ?? "",
    headSha: process.env.GITHUB_SHA ?? "",
  })
  writeFileSync("eval-nightly-status.json", `${JSON.stringify(statusJson, null, 2)}\n`)
```

(`writeFileSync` is already imported from `node:fs` at the top of this file per S01's existing `appendFileSync`/`readFileSync` imports — add `writeFileSync` to that same import line.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run scripts/eval-nightly-report.test.mjs`
Expected: PASS

- [ ] **Step 5: Add the artifact upload step to `eval-nightly.yml`**

In `.github/workflows/eval-nightly.yml`, after the existing "Report nightly status" step, add:

```yaml
      - name: Upload eval-nightly-status-json
        if: always()
        uses: actions/upload-artifact@v7
        with:
          name: eval-nightly-status-json
          path: eval-nightly-status.json
          retention-days: 90
          if-no-files-found: error
```

(90-day retention, longer than the 30 days used elsewhere in this repo's workflows — this file is read by every future release attempt for up to 48 hours after creation, and a wider retention window gives more slack if a release is delayed; `if-no-files-found: error` here is deliberate — if `eval-nightly-report.mjs`'s `main()` didn't write this file, that's a real bug worth failing loudly on, not silently continuing.)

- [ ] **Step 6: Run the full test suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/eval-nightly.yml scripts/eval-nightly-report.mjs scripts/eval-nightly-report.test.mjs
git commit -m "feat(eval): write a machine-readable eval-nightly-status.json artifact"
```

---

## Task 2: `release-admission-gate.mjs` skeleton + `checkEvalSignal()`

**Files:**
- Create: `scripts/release-admission-gate.mjs`
- Create: `scripts/release-admission-gate.test.mjs`

- [ ] **Step 1: Add `js-yaml` as an explicit devDependency**

Run: `pnpm add -D js-yaml`
Expected: adds `js-yaml` to `package.json`'s `devDependencies` — it's
already present in the pnpm store as a transitive dependency of
`electron-updater`/`electron-builder` (confirmed:
`node_modules/.pnpm/js-yaml@4.1.1`), so this should resolve instantly
without a new download.

- [ ] **Step 2: Write the failing tests for `checkEvalSignal()`**

```js
// scripts/release-admission-gate.test.mjs
import { describe, expect, it } from "vitest"
import { checkEvalSignal } from "./release-admission-gate.mjs"

function baseArgs(overrides = {}) {
  return {
    runList: [{ databaseId: 100, headSha: "sha-old", status: "completed", createdAt: "2026-07-10T07:00:00Z" }],
    statusJson: {
      schemaVersion: 1,
      state: "clean",
      runId: 100,
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

  it("fails when there is no completed run", () => {
    const result = checkEvalSignal(baseArgs({ runList: [{ databaseId: 1, status: "in_progress", createdAt: "2026-07-11T00:00:00Z" }] }))
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("no completed")
  })

  it("fails when the issue count is not exactly one", () => {
    const result = checkEvalSignal(baseArgs({ issues: [] }))
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("exactly one")
  })

  it("fails when the issue title is wrong", () => {
    const result = checkEvalSignal(baseArgs({ issues: [{ number: 1, title: "Wrong Title", body: "" }] }))
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("title")
  })

  it("fails when the issue references a different run", () => {
    const result = checkEvalSignal(
      baseArgs({
        issues: [{ number: 44, title: "Eval Nightly Status", body: "[Workflow run](https://github.com/o/r/actions/runs/999)" }],
      })
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("does not reference")
  })

  it("fails on a missing schemaVersion", () => {
    const result = checkEvalSignal(baseArgs({ statusJson: { ...baseArgs().statusJson, schemaVersion: 2 } }))
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("schemaVersion")
  })

  it("fails on an invalid completedAt", () => {
    const result = checkEvalSignal(baseArgs({ statusJson: { ...baseArgs().statusJson, completedAt: "not-a-date" } }))
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("valid ISO")
  })

  it("fails when completedAt is in the future beyond clock skew", () => {
    const result = checkEvalSignal(baseArgs({ statusJson: { ...baseArgs().statusJson, completedAt: "2026-07-11T08:00:00Z" } }))
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("future")
  })

  it("fails when the JSON runId does not match the downloaded run", () => {
    const result = checkEvalSignal(baseArgs({ statusJson: { ...baseArgs().statusJson, runId: 999 } }))
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("does not match the run it was downloaded from")
  })

  it("fails when the JSON headSha does not match gh run view's own record", () => {
    const result = checkEvalSignal(baseArgs({ runView: { headSha: "sha-different", conclusion: "success" } }))
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("does not match GitHub's own run record")
  })

  it("fails when the run's conclusion was not success", () => {
    const result = checkEvalSignal(baseArgs({ runView: { headSha: "sha-released", conclusion: "failure" } }))
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("concluded")
  })

  it("fails when state is not clean", () => {
    const result = checkEvalSignal(baseArgs({ statusJson: { ...baseArgs().statusJson, state: "regressed" } }))
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run scripts/release-admission-gate.test.mjs`
Expected: FAIL — `release-admission-gate.mjs` doesn't exist yet

- [ ] **Step 4: Implement `checkEvalSignal()`**

```js
// scripts/release-admission-gate.mjs
const STALE_MS = 48 * 60 * 60 * 1000
const CLOCK_SKEW_MS = 5 * 60 * 1000

/**
 * Verifies S01's eval signal actually proves the commit being released is
 * healthy — not just that *some* recent run was clean. Every input is
 * already-fetched data (no I/O in this function); see main() for the real
 * gh/fs calls that produce these.
 */
export function checkEvalSignal({ runList, statusJson, runView, issues, releasedSha, now = () => new Date() }) {
  const completed = runList.filter((r) => r.status === "completed")
  if (completed.length === 0) {
    return { ok: false, reason: "no completed eval-nightly.yml run found" }
  }
  const chosenRun = completed.reduce((a, b) => (new Date(a.createdAt) > new Date(b.createdAt) ? a : b))

  if (issues.length !== 1) {
    return { ok: false, reason: `expected exactly one open eval-nightly-status issue, found ${issues.length}` }
  }
  const issue = issues[0]
  if (issue.title !== "Eval Nightly Status") {
    return { ok: false, reason: `eval-nightly-status issue has unexpected title "${issue.title}"` }
  }
  const runIdMatch = /\/actions\/runs\/(\d+)/.exec(issue.body)
  if (!runIdMatch || Number(runIdMatch[1]) !== chosenRun.databaseId) {
    return { ok: false, reason: "eval-nightly-status issue does not reference the most recent completed run" }
  }

  if (statusJson?.schemaVersion !== 1) {
    return { ok: false, reason: "eval-nightly-status-json has an unexpected or missing schemaVersion" }
  }
  const completedAt = new Date(statusJson.completedAt)
  if (Number.isNaN(completedAt.getTime())) {
    return { ok: false, reason: "eval-nightly-status-json completedAt is not a valid ISO 8601 timestamp" }
  }
  const nowDate = now()
  if (completedAt.getTime() > nowDate.getTime() + CLOCK_SKEW_MS) {
    return { ok: false, reason: "eval-nightly-status-json completedAt is in the future" }
  }

  if (statusJson.runId !== chosenRun.databaseId) {
    return { ok: false, reason: "eval-nightly-status-json runId does not match the run it was downloaded from" }
  }
  if (statusJson.headSha !== runView.headSha) {
    return { ok: false, reason: "eval-nightly-status-json headSha does not match GitHub's own run record" }
  }
  if (runView.conclusion !== "success") {
    return { ok: false, reason: `eval-nightly.yml run concluded "${runView.conclusion}", not "success"` }
  }
  if (statusJson.state !== "clean") {
    return { ok: false, reason: `eval-nightly-status-json state is "${statusJson.state}", not "clean"` }
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run scripts/release-admission-gate.test.mjs`
Expected: PASS (13 tests)

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml scripts/release-admission-gate.mjs scripts/release-admission-gate.test.mjs
git commit -m "feat(release): add checkEvalSignal — the anti-TOCTOU eval-health gate"
```

---

## Task 3: `checkVersionConsistency()`

**Files:**
- Modify: `scripts/release-admission-gate.mjs`
- Modify: `scripts/release-admission-gate.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add to `scripts/release-admission-gate.test.mjs`:

```js
import { checkVersionConsistency } from "./release-admission-gate.mjs"

describe("checkVersionConsistency", () => {
  const baseFeeds = {
    "latest.yml": { version: "1.2.3" },
    "latest-linux.yml": { version: "1.2.3" },
    "latest-mac.yml (merged)": { version: "1.2.3" },
  }
  const baseFilenames = ["Synapse-Setup-1.2.3.exe", "Synapse-1.2.3.msi"]

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

  it("fails when an installer filename does not contain the expected version", () => {
    const result = checkVersionConsistency({
      tagVersion: "1.2.3",
      packageVersion: "1.2.3",
      feeds: baseFeeds,
      installerFilenames: ["Synapse-Setup-1.2.2.exe"],
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("Synapse-Setup-1.2.2.exe")
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run scripts/release-admission-gate.test.mjs`
Expected: FAIL — `checkVersionConsistency` is not exported

- [ ] **Step 3: Implement**

Add to `scripts/release-admission-gate.mjs`:

```js
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
    return { ok: false, reason: `tag version "${tagVersion}" does not match package.json version "${packageVersion}"` }
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
    if (!filename.includes(packageVersion)) {
      return { ok: false, reason: `installer filename "${filename}" does not contain expected version "${packageVersion}"` }
    }
  }
  return { ok: true }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run scripts/release-admission-gate.test.mjs`
Expected: PASS (17 tests total)

- [ ] **Step 5: Commit**

```bash
git add scripts/release-admission-gate.mjs scripts/release-admission-gate.test.mjs
git commit -m "feat(release): add checkVersionConsistency"
```

---

## Task 4: `checkArtifactManifest()`

**Files:**
- Modify: `scripts/release-admission-gate.mjs`
- Modify: `scripts/release-admission-gate.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add to `scripts/release-admission-gate.test.mjs`:

```js
import { checkArtifactManifest } from "./release-admission-gate.mjs"

function validContainers() {
  return {
    "electron-windows-x64-nsis": ["Synapse-Setup-1.2.3.exe", "Synapse-Setup-1.2.3.exe.blockmap", "latest.yml"],
    "electron-windows-x64-msi": ["Synapse-1.2.3.msi"],
    "electron-macos-x64-zip": ["Synapse-1.2.3-x64-mac.zip", "Synapse-1.2.3-x64-mac.zip.blockmap", "latest-mac.yml"],
    "electron-macos-arm64-zip": ["Synapse-1.2.3-arm64-mac.zip", "Synapse-1.2.3-arm64-mac.zip.blockmap", "latest-mac.yml"],
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run scripts/release-admission-gate.test.mjs`
Expected: FAIL — `checkArtifactManifest` is not exported

- [ ] **Step 3: Implement**

Add to `scripts/release-admission-gate.mjs`:

```js
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
      return { ok: false, reason: `unexpected artifact container "${name}" — not a release candidate input` }
    }
  }
  for (const name of expectedNames) {
    const patterns = EXPECTED_ARTIFACT_MANIFEST[name]
    const files = downloadedContainers[name]
    if (!files) {
      return { ok: false, reason: `missing expected artifact container "${name}"` }
    }
    if (files.length !== patterns.length) {
      return { ok: false, reason: `container "${name}" has ${files.length} files, expected ${patterns.length}` }
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run scripts/release-admission-gate.test.mjs`
Expected: PASS (22 tests total)

- [ ] **Step 5: Commit**

```bash
git add scripts/release-admission-gate.mjs scripts/release-admission-gate.test.mjs
git commit -m "feat(release): add checkArtifactManifest — exact container/cardinality checks"
```

---

## Task 5: `validateSingleFileFeed()`, `mergeMacFeeds()`, `checkFeedFiles()`

**Files:**
- Modify: `scripts/release-admission-gate.mjs`
- Modify: `scripts/release-admission-gate.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add to `scripts/release-admission-gate.test.mjs`:

```js
import { checkFeedFiles, mergeMacFeeds, validateSingleFileFeed } from "./release-admission-gate.mjs"

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
    expect(validateSingleFileFeed({ ...feed, files: [feed.files[0], feed.files[0]] }, real, "test feed").ok).toBe(false)
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
    const result = validateSingleFileFeed({ ...feed, files: [{ ...feed.files[0], sha512: "WRONG" }] }, real, "test feed")
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("sha512")
  })

  it("fails on a size mismatch", () => {
    const result = validateSingleFileFeed({ ...feed, files: [{ ...feed.files[0], size: 999 }] }, real, "test feed")
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("size")
  })

  it("fails on a blockMapSize mismatch when the field is present", () => {
    const result = validateSingleFileFeed({ ...feed, files: [{ ...feed.files[0], blockMapSize: 999 }] }, real, "test feed")
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("blockMapSize")
  })

  it("does not require blockMapSize when the feed entry omits it", () => {
    const { blockMapSize: _drop, ...entryWithoutBlockMapSize } = feed.files[0]
    const result = validateSingleFileFeed({ ...feed, files: [entryWithoutBlockMapSize] }, real, "test feed")
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
    const result = mergeMacFeeds({ x64Feed, arm64Feed: { ...arm64Feed, version: "1.2.4" }, x64Real, arm64Real })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("disagree")
  })

  it("fails when both entries have the same URL", () => {
    const collidingArm64Real = { ...arm64Real, filename: "Synapse-1.2.3-x64-mac.zip" }
    const collidingArm64Feed = { ...arm64Feed, files: [{ ...arm64Feed.files[0], url: "Synapse-1.2.3-x64-mac.zip" }] }
    const result = mergeMacFeeds({ x64Feed, arm64Feed: collidingArm64Feed, x64Real, arm64Real: collidingArm64Real })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("colliding")
  })

  it('fails when the "arm64" leg does not contain "arm64" in its URL', () => {
    const wrongReal = { ...arm64Real, filename: "Synapse-1.2.3-mac.zip" }
    const wrongFeed = { ...arm64Feed, files: [{ ...arm64Feed.files[0], url: "Synapse-1.2.3-mac.zip" }] }
    const result = mergeMacFeeds({ x64Feed, arm64Feed: wrongFeed, x64Real, arm64Real: wrongReal })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('"arm64"')
  })
})

describe("checkFeedFiles", () => {
  const windowsReal = { filename: "Synapse-Setup-1.2.3.exe", sha512: "WINHASH", size: 300 }
  const linuxReal = { filename: "Synapse-1.2.3.AppImage", sha512: "LINUXHASH", size: 400 }
  const windowsFeed = { version: "1.2.3", files: [{ url: "Synapse-Setup-1.2.3.exe", sha512: "WINHASH", size: 300 }] }
  const linuxFeed = { version: "1.2.3", files: [{ url: "Synapse-1.2.3.AppImage", sha512: "LINUXHASH", size: 400 }] }

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run scripts/release-admission-gate.test.mjs`
Expected: FAIL — none of the three functions are exported yet

- [ ] **Step 3: Implement**

Add to `scripts/release-admission-gate.mjs`:

```js
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
    return { ok: false, reason: `${label} references "${basename}" but the real file is "${real.filename}"` }
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run scripts/release-admission-gate.test.mjs`
Expected: PASS (33 tests total)

- [ ] **Step 5: Commit**

```bash
git add scripts/release-admission-gate.mjs scripts/release-admission-gate.test.mjs
git commit -m "feat(release): add validateSingleFileFeed, mergeMacFeeds, checkFeedFiles"
```

---

## Task 6: `computeSigningStatus()`

**Files:**
- Modify: `scripts/release-admission-gate.mjs`
- Modify: `scripts/release-admission-gate.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add to `scripts/release-admission-gate.test.mjs`:

```js
import { computeSigningStatus } from "./release-admission-gate.mjs"

describe("computeSigningStatus", () => {
  it("passes as unsigned-unverified when no credentials and no verification", () => {
    expect(computeSigningStatus(false, "not-performed")).toEqual({ ok: true, releaseClaim: "unsigned-unverified" })
  })

  it("passes as signed-and-verified when credentials configured and verified", () => {
    expect(computeSigningStatus(true, "verified")).toEqual({ ok: true, releaseClaim: "signed-and-verified" })
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run scripts/release-admission-gate.test.mjs`
Expected: FAIL — `computeSigningStatus` is not exported

- [ ] **Step 3: Implement**

Add to `scripts/release-admission-gate.mjs`:

```js
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
    return { ok: false, reason: "signing credentials are configured but no signature verification was performed" }
  }
  if (credentialsConfigured && verification === "failed") {
    return { ok: false, reason: "signing credentials are configured but signature verification failed" }
  }
  if (!credentialsConfigured && verification === "verified") {
    return { ok: false, reason: "contradictory signing state: verification succeeded with no credentials configured" }
  }
  return {
    ok: false,
    reason: `unrecognized signing state: credentialsConfigured=${credentialsConfigured}, verification=${verification}`,
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run scripts/release-admission-gate.test.mjs`
Expected: PASS (38 tests total)

- [ ] **Step 5: Commit**

```bash
git add scripts/release-admission-gate.mjs scripts/release-admission-gate.test.mjs
git commit -m "feat(release): add computeSigningStatus — fail-closed signing state machine"
```

---

## Task 7: `buildManifest()` and `verifyManifest()`

**Files:**
- Modify: `scripts/release-admission-gate.mjs`
- Modify: `scripts/release-admission-gate.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add to `scripts/release-admission-gate.test.mjs`:

```js
import { buildManifest, verifyManifest } from "./release-admission-gate.mjs"

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run scripts/release-admission-gate.test.mjs`
Expected: FAIL — `buildManifest`/`verifyManifest` are not exported

- [ ] **Step 3: Implement**

Add to `scripts/release-admission-gate.mjs`:

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run scripts/release-admission-gate.test.mjs`
Expected: PASS (43 tests total). All of `release-admission-gate.mjs`'s pure decision logic is now complete and tested.

- [ ] **Step 5: Run typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add scripts/release-admission-gate.mjs scripts/release-admission-gate.test.mjs
git commit -m "feat(release): add buildManifest/verifyManifest — hash and file-set proof"
```

---

## Task 8: `main()` — wire the gate together with real I/O

**Files:**
- Modify: `scripts/release-admission-gate.mjs`

This task has no new unit tests — `main()` is thin I/O orchestration
around the already-tested pure functions above (same split S01's
`eval-nightly-report.mjs` uses), and is exercised for real by Task 13's
manual verification.

- [ ] **Step 1: Add the imports and I/O helpers**

At the top of `scripts/release-admission-gate.mjs`, add:

```js
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import yaml from "js-yaml"

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8" })
}

function sha512Of(path) {
  return createHash("sha512").update(readFileSync(path)).digest("base64")
}

function readYaml(path) {
  return yaml.load(readFileSync(path, "utf8"))
}
```

- [ ] **Step 2: Write the artifact-download and container-inventory helper**

```js
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
```

(`gh run download <run-id> --pattern electron-* -D artifacts/` mirrors
spec §4's `actions/download-artifact@v8` `pattern`/`path` inputs — the
`gh` CLI's `run download` subcommand accepts the same `--pattern` flag
for the same purpose when downloading via a workflow step rather than a
separate action.)

- [ ] **Step 3: Write the eval-signal I/O wrapper**

```js
function fetchEvalSignalInputs(releasedSha) {
  const runList = JSON.parse(
    gh(["run", "list", "--workflow=eval-nightly.yml", "--json", "databaseId,headSha,status,createdAt", "--limit", "5"])
  )
  const completed = runList.filter((r) => r.status === "completed")
  if (completed.length === 0) {
    return { runList, statusJson: null, runView: null, issues: [], releasedSha }
  }
  const chosenRun = completed.reduce((a, b) => (new Date(a.createdAt) > new Date(b.createdAt) ? a : b))

  const runView = JSON.parse(gh(["run", "view", String(chosenRun.databaseId), "--json", "headSha,conclusion"]))

  const statusDir = "eval-nightly-status-download"
  mkdirSync(statusDir, { recursive: true })
  execFileSync("gh", ["run", "download", String(chosenRun.databaseId), "-n", "eval-nightly-status-json", "-D", statusDir])
  const statusJson = JSON.parse(readFileSync(join(statusDir, "eval-nightly-status.json"), "utf8"))

  const issues = JSON.parse(gh(["issue", "list", "--label", "eval-nightly-status", "--state", "open", "--json", "number,title,body"]))

  return { runList, statusJson, runView, issues, releasedSha }
}
```

- [ ] **Step 4: Write `main()`**

```js
function fail(reason) {
  console.error(`release-admission-gate: ${reason}`)
  process.exit(1)
}

function main() {
  const releasedSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
  if (releasedSha !== process.env.GITHUB_SHA) {
    fail(`git rev-parse HEAD (${releasedSha}) does not match github.sha (${process.env.GITHUB_SHA})`)
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
  const appImageName = containers["electron-linux-x64-appimage"].find((f) => f.endsWith(".AppImage"))

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
  ]
  const versionCheck = checkVersionConsistency({
    tagVersion,
    packageVersion,
    feeds: { "latest.yml": winFeed, "latest-linux.yml": linuxFeed, "latest-mac.yml (merged)": mergeResult.merged },
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
  copyContainerFiles(ARTIFACTS_DIR + "/electron-windows-x64-msi", containers["electron-windows-x64-msi"], assetsDir)
  copyContainerFiles(macX64Dir, containers["electron-macos-x64-zip"].filter((f) => !f.endsWith(".yml")), assetsDir)
  copyContainerFiles(macArm64Dir, containers["electron-macos-arm64-zip"].filter((f) => !f.endsWith(".yml")), assetsDir)
  copyContainerFiles(ARTIFACTS_DIR + "/electron-macos-x64-dmg", containers["electron-macos-x64-dmg"], assetsDir)
  copyContainerFiles(ARTIFACTS_DIR + "/electron-macos-arm64-dmg", containers["electron-macos-arm64-dmg"], assetsDir)
  copyContainerFiles(linuxDir, containers["electron-linux-x64-appimage"].filter((f) => !f.endsWith(".yml")), assetsDir)
  copyContainerFiles(ARTIFACTS_DIR + "/electron-linux-x64-deb", containers["electron-linux-x64-deb"], assetsDir)

  writeFileSync(join(assetsDir, "latest.yml"), yaml.dump(winFeed))
  writeFileSync(join(assetsDir, "latest-linux.yml"), yaml.dump(linuxFeed))
  writeFileSync(join(assetsDir, "latest-mac.yml"), yaml.dump(mergeResult.merged))

  const signingStatus = {
    schemaVersion: 1,
    platformCodeSigning: {
      windows: { credentialsConfigured: windowsCertConfigured, verification: "not-performed", releaseClaim: winSigning.releaseClaim },
      macos: { credentialsConfigured: appleCertConfigured, verification: "not-performed", releaseClaim: macSigning.releaseClaim },
    },
    githubArtifactAttestation: { required: true },
  }
  writeFileSync(join(assetsDir, "signing-status.json"), `${JSON.stringify(signingStatus, null, 2)}\n`)

  const manifestFiles = readdirSync(assetsDir)
    .filter((f) => f !== "manifest.json")
    .map((name) => ({ name, sha512: sha512Of(join(assetsDir, name)) }))
  const manifest = buildManifest(manifestFiles)
  const selfVerify = verifyManifest(manifest, manifestFiles)
  if (!selfVerify.ok) return fail(`manifest self-check failed: ${selfVerify.reason}`)
  writeFileSync(join(assetsDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)

  // §7: attestation, against the finished assets/ directory.
  execFileSync("gh", ["extension", "exec", "attest"], { stdio: "ignore" }).toString() // no-op placeholder removed below
}

function copyContainerFiles(srcDir, filenames, destDir) {
  for (const name of filenames) {
    writeFileSync(join(destDir, name), readFileSync(join(srcDir, name)))
  }
}
```

- [ ] **Step 5: Replace the attestation placeholder with the real `actions/attest@v4` invocation and finish `main()`**

`actions/attest` is a GitHub Action, not a CLI tool — it can't be
invoked with a shell command from inside this script. Remove the
placeholder line from Step 4 and instead have `main()` stop just before
attestation; the actual `actions/attest@v4` step runs as its own
workflow step in `release.yml` (Task 10), consuming this script's exit
status and `assets/` output. Replace the last two lines of `main()`
(the placeholder attestation call and the closing brace) with:

```js
  console.log(`release-admission-gate: assets/ assembled and manifest verified at ${assetsDir}`)
}
```

Then, after `main()`'s closing brace, add the function that generates
`release-body.md` — called from the workflow *after* the `actions/attest`
step (Task 10), since it needs that step's `attestation-url` output,
which doesn't exist yet at the point `main()` above runs:

```js
export function buildReleaseBody({ signingStatus, attestationUrl, repoOwner }) {
  const platformLines = Object.entries(signingStatus.platformCodeSigning).map(([platform, info]) => {
    const claim =
      info.releaseClaim === "unsigned-unverified"
        ? "CI has neither a configured platform code-signing credential nor has it performed a platform signature verification on this artifact."
        : "This artifact was signed with a configured platform credential, and CI verified the signature."
    return `- **${platform}**: ${claim}`
  })
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
```

- [ ] **Step 6: Add the module-execution guard**

At the very end of the file:

```js
if (process.argv[1] === fileURLToPath(import.meta.url)) main()
```

- [ ] **Step 7: Run typecheck and the full test suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS — `main()`/`buildReleaseBody()` are not directly unit
tested (pure I/O orchestration, same as S01's `eval-nightly-report.mjs`
`main()`), but must not break existing tests or typecheck.

- [ ] **Step 8: Commit**

```bash
git add scripts/release-admission-gate.mjs
git commit -m "feat(release): wire release-admission-gate.mjs's main() and buildReleaseBody()"
```

---

## Task 9: `build-electron.yml` — Linux matrix + `if-no-files-found` fixes

**Files:**
- Modify: `.github/workflows/build-electron.yml`

- [ ] **Step 1: Add the Linux matrix entry**

In `.github/workflows/build-electron.yml`, find the `matrix.include` list:

```yaml
    strategy:
      fail-fast: false
      matrix:
        include:
          - platform: windows-latest
            arch: x64
            build_flag: --win
          - platform: macos-latest
            arch: x64
            build_flag: --mac --x64
          - platform: macos-latest
            arch: arm64
            build_flag: --mac --arm64
```

Add a fourth entry:

```yaml
          - platform: ubuntu-latest
            arch: x64
            build_flag: --linux
```

- [ ] **Step 2: Change `if-no-files-found: warn` to `error` on all six upload steps**

In the same file, find each of the six `- name: Upload ... artifacts`
steps ("Upload Linux artifacts (AppImage)", "Upload Linux artifacts
(deb)", "Upload Windows artifacts (NSIS)", "Upload Windows artifacts
(MSI)", "Upload macOS artifacts (DMG)", "Upload macOS artifacts (ZIP)")
and change `if-no-files-found: warn` to `if-no-files-found: error` in
each.

- [ ] **Step 3: Verify the workflow YAML is well-formed**

Run: `cat .github/workflows/build-electron.yml | python3 -c "import sys,yaml; yaml.safe_load(sys.stdin)"` (or `actionlint .github/workflows/build-electron.yml` if installed)
Expected: no output / no errors

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/build-electron.yml
git commit -m "fix(ci): add the Linux matrix leg and fail loudly on empty artifact uploads"
```

---

## Task 10: `release.yml` — add the `release-admission-gate` job

**Files:**
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Add the job**

In `.github/workflows/release.yml`, after the `build-electron` job and
before `create-release`, add:

```yaml
  release-admission-gate:
    name: Release Admission Gate
    needs: [build-electron]
    runs-on: ubuntu-latest
    outputs:
      attestation-url: ${{ steps.attest.outputs.attestation-url }}
    permissions:
      contents: read
      actions: read
      issues: read
      id-token: write
      attestations: write
      artifact-metadata: write
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v6
        with:
          version: 11.0.8
      - uses: actions/setup-node@v6
        with:
          node-version: 22.13.x
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: Run release admission gate
        id: gate
        env:
          GH_TOKEN: ${{ github.token }}
          APPLE_CERT_CONFIGURED: ${{ secrets.APPLE_CERTIFICATE != '' }}
          WINDOWS_CERT_CONFIGURED: ${{ secrets.WINDOWS_CERTIFICATE != '' }}
        run: node scripts/release-admission-gate.mjs
      - name: Attest release-approved-bundle
        id: attest
        uses: actions/attest@v4
        with:
          subject-path: release-approved-bundle/assets/*
      - name: Write release body
        env:
          GITHUB_REPOSITORY_OWNER: ${{ github.repository_owner }}
        run: |
          node -e "
            const { buildReleaseBody } = await import('./scripts/release-admission-gate.mjs');
            const fs = await import('node:fs');
            const signingStatus = JSON.parse(fs.readFileSync('release-approved-bundle/assets/signing-status.json', 'utf8'));
            const body = buildReleaseBody({
              signingStatus,
              attestationUrl: '${{ steps.attest.outputs.attestation-url }}',
              repoOwner: process.env.GITHUB_REPOSITORY_OWNER,
            });
            fs.writeFileSync('release-approved-bundle/release-body.md', body);
          " --input-type=module
      - name: Upload release-approved-bundle
        uses: actions/upload-artifact@v7
        with:
          name: release-approved-bundle
          path: release-approved-bundle/
          retention-days: 90
          if-no-files-found: error
```

(The gate's `permissions:` block combines what `actions/attest@v4`
requires — `id-token`/`attestations`/`artifact-metadata: write`,
confirmed against its own current README — with `contents: read` for
checkout and `actions: read`/`issues: read` for the `gh run`/`gh issue`
calls inside `release-admission-gate.mjs`.)

- [ ] **Step 2: Verify the workflow YAML is well-formed**

Run: `cat .github/workflows/release.yml | python3 -c "import sys,yaml; yaml.safe_load(sys.stdin)"` (or `actionlint`)
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "feat(ci): add release-admission-gate job — verify, assemble, attest"
```

---

## Task 11: `release.yml` — `create-release` changes

**Files:**
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Add `release-admission-gate` to `create-release`'s `needs`, and change how it downloads artifacts**

Find the `create-release` job:

```yaml
  create-release:
    name: Create Release
    needs: [quality, test, build-electron]
    runs-on: ubuntu-latest

    permissions:
      contents: write

    steps:
      - name: Checkout code
        uses: actions/checkout@v7

      - name: Download all artifacts
        uses: actions/download-artifact@v8
        with:
          path: artifacts/
```

Replace with:

```yaml
  create-release:
    name: Create Release
    needs: [quality, test, build-electron, release-admission-gate]
    runs-on: ubuntu-latest

    permissions:
      contents: write

    steps:
      - name: Checkout code
        uses: actions/checkout@v7

      - uses: pnpm/action-setup@v6
        with:
          version: 11.0.8
      - uses: actions/setup-node@v6
        with:
          node-version: 22.13.x
          cache: pnpm
      - run: pnpm install --frozen-lockfile

      - name: Download release-approved-bundle
        uses: actions/download-artifact@v8
        with:
          name: release-approved-bundle
          path: release-approved-bundle/
```

- [ ] **Step 2: Add the re-verification step before the release step**

After the "Download release-approved-bundle" step and before "Display
structure of downloaded files", add:

```yaml
      - name: Re-verify manifest after download
        run: |
          node -e "
            const { verifyManifest } = await import('./scripts/release-admission-gate.mjs');
            const { createHash } = await import('node:crypto');
            const fs = await import('node:fs');
            const path = await import('node:path');
            const assetsDir = 'release-approved-bundle/assets';
            const manifest = JSON.parse(fs.readFileSync(path.join(assetsDir, 'manifest.json'), 'utf8'));
            const actualFiles = fs.readdirSync(assetsDir)
              .filter((f) => f !== 'manifest.json')
              .map((name) => ({
                name,
                sha512: createHash('sha512').update(fs.readFileSync(path.join(assetsDir, name))).digest('base64'),
              }));
            const result = verifyManifest(manifest, actualFiles);
            if (!result.ok) {
              console.error('re-verification failed:', result.reason);
              process.exit(1);
            }
            console.log('manifest re-verified after download round-trip.');
          " --input-type=module
```

- [ ] **Step 3: Update the release-creation step's file glob and add `body_path`/`fail_on_unmatched_files`**

Find:

```yaml
      - name: Create Release
        uses: softprops/action-gh-release@v3
        with:
          draft: true
          generate_release_notes: true
          files: |
            artifacts/**/*.AppImage
            artifacts/**/*.deb
            artifacts/**/*.msi
            artifacts/**/*.exe
            artifacts/**/*.dmg
            artifacts/**/*.zip
            artifacts/**/*.blockmap
            artifacts/**/latest*.yml
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Replace with:

```yaml
      - name: Create Release
        uses: softprops/action-gh-release@v3
        with:
          draft: true
          generate_release_notes: true
          body_path: release-approved-bundle/release-body.md
          fail_on_unmatched_files: true
          files: release-approved-bundle/assets/*
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

- [ ] **Step 4: Also remove the now-redundant "Display structure of downloaded files" step's old artifact path if it still references `artifacts/`**

Find:

```yaml
      - name: Display structure of downloaded files
        run: ls -R artifacts/
```

Replace with:

```yaml
      - name: Display structure of downloaded files
        run: ls -R release-approved-bundle/
```

- [ ] **Step 5: Verify the workflow YAML is well-formed**

Run: `cat .github/workflows/release.yml | python3 -c "import sys,yaml; yaml.safe_load(sys.stdin)"` (or `actionlint`)
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "feat(ci): create-release consumes only release-approved-bundle, re-verifies before publishing"
```

---

## Task 12: Contract test — real `MacUpdater.filterFilesForArch`

**Files:**
- Modify: `scripts/release-admission-gate.test.mjs`

- [ ] **Step 1: Write the failing test**

Add to `scripts/release-admission-gate.test.mjs`:

```js
import { MacUpdater } from "electron-updater"
import { mergeMacFeeds } from "./release-admission-gate.mjs"

describe("mac merge / electron-updater contract", () => {
  it("the real MacUpdater.filterFilesForArch resolves each arch to the correct merged entry", () => {
    const x64Real = { filename: "Synapse-1.2.3-x64-mac.zip", sha512: "X64HASH", size: 100 }
    const arm64Real = { filename: "Synapse-1.2.3-arm64-mac.zip", sha512: "ARM64HASH", size: 200 }
    const x64Feed = { version: "1.2.3", files: [{ url: "Synapse-1.2.3-x64-mac.zip", sha512: "X64HASH", size: 100 }] }
    const arm64Feed = { version: "1.2.3", files: [{ url: "Synapse-1.2.3-arm64-mac.zip", sha512: "ARM64HASH", size: 200 }] }

    const { merged } = mergeMacFeeds({ x64Feed, arm64Feed, x64Real, arm64Real })
    const files = merged.files.map((f) => ({ ...f, url: { pathname: f.url } }))

    const arm64Resolved = MacUpdater.filterFilesForArch(files, true)
    expect(arm64Resolved).toHaveLength(1)
    expect(arm64Resolved[0].url.pathname).toBe("Synapse-1.2.3-arm64-mac.zip")

    const x64Resolved = MacUpdater.filterFilesForArch(files, false)
    expect(x64Resolved).toHaveLength(1)
    expect(x64Resolved[0].url.pathname).toBe("Synapse-1.2.3-x64-mac.zip")
  })
})
```

(This calls the actual, installed `electron-updater` package's real
`MacUpdater.filterFilesForArch` — confirmed exported from the package's
main entry (`out/main.js` re-exports `MacUpdater` from `./MacUpdater`)
— not a re-implementation. A future `electron-updater` version bump
that changes this matching logic will break this test, which is exactly
the point: it's a dependency-bump guard, not just a snapshot of today's
behavior.)

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `pnpm vitest run scripts/release-admission-gate.test.mjs`
Expected: PASS immediately — this test doesn't require new production
code, it's a regression guard locking in the real dependency's behavior
against the shape `mergeMacFeeds()` already produces. If it fails,
`MacUpdater.filterFilesForArch`'s real signature/behavior differs from
what §5's design assumed — stop and re-read
`node_modules/.pnpm/electron-updater@6.8.9/node_modules/electron-updater/out/MacUpdater.js`
before proceeding, since that would mean the merge design itself needs
to change, not just this test.

- [ ] **Step 3: Run the full test suite and typecheck**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add scripts/release-admission-gate.test.mjs
git commit -m "test(release): lock the mac merge against electron-updater's real filterFilesForArch"
```

---

## Task 13 (manual, requires real GitHub Actions + repo write access): Verification

This task cannot be automated — it exercises the real release pipeline
end to end, including a real, unskippable `actions/attest@v4` run.

- [ ] **Step 1: Success path**

On a disposable branch (not `main`), create one commit bumping
`package.json`'s `version` to `0.0.0-s03-test.1` and push it.

Run: `gh workflow run eval-nightly.yml --ref <scratch-branch>`, wait for
completion (`gh run watch $(gh run list --workflow=eval-nightly.yml
--limit 1 --json databaseId --jq '.[0].databaseId')`), confirm it
completed clean.

Tag the scratch commit as an **annotated** tag and push it:
```bash
git tag -a v0.0.0-s03-test.1 -m "S03 pipeline verification"
git push origin v0.0.0-s03-test.1
```

Watch the resulting `release.yml` run. Confirm:
- `release-admission-gate` passes.
- `release-approved-bundle` contains all 8 expected files/feeds including
  Linux artifacts (confirming Task 9's matrix fix).
- The draft release's body shows the `unsigned-unverified` declaration
  for both platforms and a real, working attestation URL.
- `gh attestation verify <a downloaded asset> --owner sunzrnobug` succeeds
  locally against one of the downloaded release assets.

- [ ] **Step 2: Failure path**

On a second disposable commit, leave `package.json`'s version mismatched
with the tag about to be pushed. Push that tag. Confirm: the
`release-admission-gate` job fails, no `release-approved-bundle` artifact
and no draft release are created.

- [ ] **Step 3: Cleanup**

```bash
git push --delete origin v0.0.0-s03-test.1 <second-scratch-tag>
gh release delete v0.0.0-s03-test.1 --yes  # if a draft was created
git push --delete origin <scratch-branch>
```

The attestation from Step 1 is **not** deleted (`gh attestation` has no
delete/revoke subcommand, and this is by design — see the spec's §10).
Record its `attestation-url` in the implementation PR's description as
this task's evidence.

- [ ] **Step 4: Restore the eval-nightly-status issue to point at `main`**

```bash
gh workflow run eval-nightly.yml --ref main
gh run watch $(gh run list --workflow=eval-nightly.yml --limit 1 --json databaseId --jq '.[0].databaseId')
```

Confirm the `Eval Nightly Status` issue's linked run URL now points at
this run, not the scratch-branch run from Step 1. **Required, not
optional** — `gh run list` sorts by recency across all branches, so
skipping this leaves the scratch run as the "most recent completed"
entry `checkEvalSignal()` finds, which would fail the anti-TOCTOU check
on the very next real release attempt.

---

## Self-Review

**1. Spec coverage:**
- §1 (architecture, job graph, execution order) → Tasks 10-11's job
  wiring matches the spec's `build-electron → release-admission-gate →
  create-release` graph, and `main()` (Task 8) follows the spec's stated
  real execution order (§4 → §5 → §3 → §2 → §6 → assembly → attest). ✓
- §2 (eval-signal, all 10 checks) → Task 2's `checkEvalSignal()`. ✓
- §3 (version consistency) → Task 3. ✓
- §4 (artifact identity/cardinality, `pattern: electron-*` scoping) →
  Task 4, and Task 8 Step 2's `gh run download --pattern electron-*`. ✓
- §5 (mac merge, pre/post-merge, Windows/Linux feed check) → Task 5. ✓
- §6 (signing state machine) → Task 6. ✓
- §7 (`actions/attest@v4`, permissions, `attestation-url`) → Task 10. ✓
- §8 (bundle layout, manifest split, `create-release` re-verification +
  set equality) → Tasks 7-8 (build), Task 11 (re-verify + publish). ✓
- §9 (Linux matrix, `if-no-files-found`) → Task 9. ✓
- §10 (all testing: unit tests, contract test, manual verification) →
  Tasks 2-7 (unit), Task 12 (contract), Task 13 (manual). ✓
- §12 (parked questions) → correctly not implemented; no task needed.

**2. Placeholder scan:** Task 8 Step 4 briefly showed a literal
`// no-op placeholder removed below` line — this was deliberate scaffolding
inside the task's own narrative (Step 4 builds `main()` incrementally,
Step 5 explicitly replaces that exact line with the real logic) rather
than a plan-level placeholder left unresolved; by the end of Task 8,
`main()` contains no placeholder code. No other "TBD"/"handle
appropriately"-style gaps found elsewhere in the plan.

**3. Type consistency:** `checkEvalSignal`'s input shape (`runList`,
`statusJson`, `runView`, `issues`, `releasedSha`, `now`) is defined once
in Task 2 and used identically in Task 8's `fetchEvalSignalInputs()`.
`mergeMacFeeds`'s `{ x64Feed, arm64Feed, x64Real, arm64Real }` shape
(Task 5) matches exactly how Task 8 calls it. `buildManifest`/
`verifyManifest`'s `{ name, sha512 }` file-entry shape (Task 7) is reused
identically in both Task 8's `main()` and Task 11's re-verification step.
`computeSigningStatus`'s two-argument signature (`credentialsConfigured`,
`verification`) is called identically for both platforms in Task 8.

**Gap found and fixed during self-review:** Task 8's original draft
called `execFileSync("gh", ["extension", "exec", "attest"], ...)` as a
placeholder for running attestation from inside the script — this is
wrong: `actions/attest@v4` is a GitHub Action (a workflow step), not a
`gh` CLI subcommand, and cannot be invoked this way. Fixed by having
`main()` stop after assembling `assets/` and verifying the manifest,
with the real `actions/attest@v4` step running as its own step in
`release.yml` (Task 10), and `release-body.md`'s generation (which
needs that step's `attestation-url` output) happening in a separate
workflow step afterward, calling the newly-added `buildReleaseBody()`
pure function.

---

**Plan complete and saved to `docs/superpowers/plans/2026-07-11-release-proof-pipeline.md`.**

Per this session's standing instruction, I'm stopping here — this is
yours to implement; call me when it's done to review.
