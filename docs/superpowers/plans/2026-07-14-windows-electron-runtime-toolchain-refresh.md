# S11 Windows Electron Runtime & Packaging Toolchain Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:executing-plans` or `superpowers:subagent-driven-development` to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** Contract Synapse's active release pipeline to an explicit,
fail-closed Windows x64 profile; upgrade electron-builder 25→26 and Electron
33→43 in independently proven checkpoints; and demonstrate that packaged
startup, MCP stdio, installer/update behavior, and Electron-33 user data remain
safe under the new Windows runtime.

**Architecture:** Three merge-separated checkpoints. **R** changes release
scope only: one Windows build job, a machine-readable release profile/context,
Windows-only S03 admission, a real no-publish dry run, and Playwright packaged
readiness. **A** changes only electron-builder and retains an Electron-33
packaged baseline. **B** changes only Electron, then consumes the baseline in a
33→43 and 33→43→33 profile-compatibility rehearsal. The current release gate's
eval, version, manifest, signing, attestation, and fail-closed principles remain;
only the platform inventory changes.

**Tech Stack:** pnpm 11, Node 22.13.x tooling, Electron 33→43 (embedded Node
24.x), electron-builder 25→26, electron-updater 6.8.9, GitHub Actions,
`actions/attest@v4`, Vitest, Playwright Electron, PowerShell/Windows x64, NSIS,
MSI.

---

## Before you start

- Every path below is relative to `D:\Programs\A My Code\Synapse`.
- Read
  `docs/superpowers/specs/2026-07-14-windows-electron-runtime-toolchain-refresh-design.md`
  in full. It is normative when this plan abbreviates rationale.
- First complete Task 0 so the reviewed spec and implementation plan are tracked.
  Start R from the resulting clean worktree. Preserve unrelated user changes;
  never use `git reset --hard` or `git checkout --` to clean them.
- Do not combine dependency refreshes. Final target versions are:
  - Checkpoint R: Electron `33.4.11`, electron-builder `25.1.8` (unchanged).
  - Checkpoint A: Electron `33.4.11`, electron-builder `26.15.3` (or a later
    re-reviewed `26.x` patch).
  - Checkpoint B: Electron `43.1.0` (or the latest re-reviewed `43.x` patch),
    electron-builder from A.
  - electron-updater remains `6.8.9` throughout.
- Keep repository/CI Node at 22.13.x and `@types/node` on 22. Electron's
  packaged runtime becomes Node 24.x; do not conflate the two.
- R, A, and B are **separate PR/merge boundaries**, not merely commits:
  1. Merge R, dispatch the dry run from the default branch, and record its
     attestation before starting A.
  2. Merge A only after its Windows build/install proof and retained
     Electron-33 baseline exist.
  3. Start B from the merged A commit and do not merge until the profile,
     packaged, installer, MCP, and updater proof is complete.
- Reason for the hard R merge boundary: GitHub only accepts
  `workflow_dispatch` for a workflow that exists with that trigger on the
  default branch. A branch-only trigger is not sufficient proof.
- Run focused tests after each task. Run the full suite only at checkpoint
  gates; do not hide the first causal failure under a large batch.
- Stage only files named in each task. Do not commit generated `release/`,
  temporary profiles, unpacked compatibility artifacts, credentials, or local
  updater feeds.

---

## Preflight — preserve the reviewed design baseline

### Task 0: Commit the reviewed spec and implementation plan before execution

**Files:**

- Add: `docs/superpowers/specs/2026-07-14-windows-electron-runtime-toolchain-refresh-design.md`
- Add: `docs/superpowers/plans/2026-07-14-windows-electron-runtime-toolchain-refresh.md`

- [ ] **Step 1: Verify the two reviewed documents and repository state**

  ```bash
  pnpm exec prettier --check docs/superpowers/specs/2026-07-14-windows-electron-runtime-toolchain-refresh-design.md docs/superpowers/plans/2026-07-14-windows-electron-runtime-toolchain-refresh.md
  git diff --check
  git status --short
  ```

  Resolve or preserve unrelated work explicitly. Do not begin R while either
  reviewed document remains untracked.

- [ ] **Step 2: Commit only the reviewed design artifacts**

  ```bash
  git add docs/superpowers/specs/2026-07-14-windows-electron-runtime-toolchain-refresh-design.md docs/superpowers/plans/2026-07-14-windows-electron-runtime-toolchain-refresh.md
  git commit -m "docs(electron): plan Windows runtime and release refresh"
  git status --short
  ```

  Expected: the implementation branches share this documentation commit and the
  worktree is clean. If the documents were already committed after review,
  verify that commit and do not create a duplicate.

---

## Checkpoint R — Windows-only release profile, no dependency changes

### Task 1: Make Windows release/feed/blockmap contracts pure and testable

**Files:**

- Modify: `scripts/release-admission-gate.mjs`
- Modify: `scripts/release-admission-gate.test.mjs`

- [ ] **Step 1: Rewrite the failing artifact-manifest fixtures for Windows only**

  Change `validContainers()` to contain exactly:

  ```text
  electron-windows-x64-nsis:
    Synapse-Setup-1.2.3.exe
    Synapse-Setup-1.2.3.exe.blockmap
    latest.yml
  electron-windows-x64-msi:
    Synapse-1.2.3.msi
  ```

  Lock these cases:

  - exact Windows set passes;
  - missing NSIS or MSI container fails;
  - extra `electron-macos-*`, `electron-linux-*`, or unrelated container fails;
  - wrong count or extension fails.

- [ ] **Step 2: Add failing Windows blockmap tests**

  Export a pure `validateWindowsBlockmap` contract taking installer name,
  blockmap name, and bytes. Create valid bytes with
  `gzipSync(JSON.stringify(validObject))`. Test:

  - `<installer>.blockmap` + nonempty gzip JSON passes;
  - missing/mismatched name fails;
  - empty bytes fail;
  - non-gzip bytes fail;
  - gzip containing invalid JSON fails;
  - gzip JSON that is not an object fails.

  Do not claim `latest.yml` contains the blockmap name/hash. The blockmap is an
  adjacent updater asset whose bytes are bound independently by
  `manifest.json`.

- [ ] **Step 3: Split tag eligibility from artifact version consistency**

  Refactor the current combined version helper into testable pieces:

  - package version equals every Windows feed version and exact version segment
    in NSIS/MSI filenames — required in both modes;
  - tag version equals package version — required only in release mode;
  - latest-clean S01 eval signal matches the released SHA — required only in
    release mode.

  Add a `ReleaseMode = "dry-run" | "release"` parser/helper. Invalid/missing
  mode fails closed. Tests must prove release mode cannot omit tag/eval inputs;
  dry-run mode skips only those two checks and still runs every artifact/feed/
  signing/manifest contract.

- [ ] **Step 4: Add the machine-readable release constants**

  Export and test the exact `RELEASE_PROFILE` from the spec:

  ```js
  {
    schemaVersion: 1,
    targets: [{
      platform: "windows",
      arch: "x64",
      packages: ["nsis", "msi"],
      updaterFeed: "latest.yml"
    }]
  }
  ```

  Add a pure `buildReleaseContext({mode, commitSha, workflowRunId})` returning
  schema version 1 and rejecting empty identifiers.

- [ ] **Step 5: Remove obsolete macOS/Linux release-only test imports/cases**

  Remove `MacUpdater`, `mergeMacFeeds`, Linux feed fixtures, and their contract
  tests. Keep `validateSingleFileFeed`, signing-state, manifest, eval, and
  attestation-adjacent tests because Windows still uses them. Update
  `validateSingleFileFeed` expectations to EXE URL/sha512/size only; blockmap
  verification is now the separate helper above.

- [ ] **Step 6: Run focused tests**

  ```bash
  pnpm test scripts/release-admission-gate.test.mjs
  ```

  Expected: PASS, including extra-platform rejection and blockmap parsing.

- [ ] **Step 7: Commit**

  ```bash
  git add scripts/release-admission-gate.mjs scripts/release-admission-gate.test.mjs
  git commit -m "refactor(release): define Windows-only admission contracts"
  ```

---

### Task 2: Convert gate assembly and release proof to Windows only

**Files:**

- Modify: `scripts/release-admission-gate.mjs`
- Modify: `scripts/release-admission-gate.test.mjs`

- [ ] **Step 1: Add failing approved-bundle/release-body tests**

  Tests must prove:

  - release profile and release context are serialized deterministically;
  - signing status contains only `platformCodeSigning.windows` while retaining
    schema version 1;
  - release body renders `Windows x64 (NSIS, MSI)` from `RELEASE_PROFILE`;
  - dry-run body starts with `DRY RUN — NOT A RELEASE`;
  - release body has no dry-run marker;
  - body iteration does not assume a macOS signing key;
  - the manifest covers EXE, EXE blockmap, MSI, `latest.yml`,
    `release-profile.json`, `release-context.json`, and
    `signing-status.json`;
  - changing blockmap bytes without rebuilding the manifest fails verification.

- [ ] **Step 2: Delete macOS/Linux assembly from `main()`**

  Remove mac feed merge, Linux feed validation, Apple credential inspection,
  mac/Linux version filenames, copy operations, and generated
  `latest-mac.yml`/`latest-linux.yml`. Keep the broad `electron-*` artifact
  download pattern so an unexpected platform container is seen and rejected.

- [ ] **Step 3: Assemble only the approved Windows bundle**

  Read/validate:

  - NSIS EXE + `latest.yml` with `validateSingleFileFeed`;
  - exact adjacent EXE blockmap with `validateWindowsBlockmap`;
  - MSI filename/version;
  - package version and, in release mode, tag/eval eligibility;
  - Windows signing state.

  Copy only the two Windows containers, write the three proof JSON files,
  construct `manifest.json` from real bytes, and self-verify file-set equality.

- [ ] **Step 4: Make `buildReleaseBody` consume profile/context explicitly**

  Update its call signature and tests. Do not read global constants inside the
  renderer function: accepting `releaseProfile`/`releaseContext` makes the
  behavior unit-testable and prevents a dry-run/release mismatch.

- [ ] **Step 5: Run focused tests and static script import**

  ```bash
  pnpm test scripts/release-admission-gate.test.mjs
  node -e "import('./scripts/release-admission-gate.mjs').then(() => console.log('gate import ok'))"
  ```

  Expected: PASS; importing does not execute `main()`.

- [ ] **Step 6: Commit**

  ```bash
  git add scripts/release-admission-gate.mjs scripts/release-admission-gate.test.mjs
  git commit -m "feat(release): assemble Windows-only approved bundles"
  ```

---

### Task 3: Contract the reusable build workflow to one Windows x64 job

**Files:**

- Modify: `.github/workflows/build-electron.yml`
- Modify: `scripts/release-admission-gate.test.mjs`

- [ ] **Step 1: Add a failing YAML contract test**

  Parse `.github/workflows/build-electron.yml` with the existing `js-yaml`
  dependency. Assert:

  - `runs-on` is `windows-latest`;
  - no platform matrix/strategy remains;
  - builder command contains `--win --x64 --publish=never`;
  - exactly two `electron-*` upload container names exist and match
    `RELEASE_PROFILE` (`electron-windows-x64-nsis` and
    `electron-windows-x64-msi`);
  - both use `if-no-files-found: error`;
  - no `macos-latest`, `ubuntu-latest`, `--mac`, `--linux`, `latest-mac.yml`,
    or `latest-linux.yml` remains;
  - optional unpacked compatibility artifacts, if enabled, use a name beginning
    `compat-`, never `electron-`, so the admission gate cannot ingest them.

- [ ] **Step 2: Simplify the workflow**

  Replace the matrix job with one Windows x64 job. Keep checkout, pnpm/Node
  setup, frozen install, output verification, Electron/builder cache, Windows
  builder invocation, and two Windows uploads. Remove mac/Linux-only steps,
  comments, cache paths, and Apple-secret examples rather than leaving dead
  `if` branches.

- [ ] **Step 3: Add opt-in unpacked-baseline retention**

  Add boolean `retain_unpacked` inputs to both `workflow_call` and
  `workflow_dispatch`, default `false`. When true, upload
  `release/win-unpacked/**` as
  `compat-windows-x64-unpacked-${{ github.sha }}` with short retention (enough
  to finish B, e.g. 30 days). It is never a release input or release asset.

- [ ] **Step 4: Run the contract test**

  ```bash
  pnpm test scripts/release-admission-gate.test.mjs
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add .github/workflows/build-electron.yml scripts/release-admission-gate.test.mjs
  git commit -m "ci(release): build only Windows x64 artifacts"
  ```

---

### Task 4: Add real packaged-renderer and packaged-MCP Playwright proof

**Files:**

- Create: `e2e/electron-app-helpers.ts`
- Create: `e2e/packaged-smoke.spec.ts`
- Modify: `e2e/smoke.spec.ts` (share helpers only; preserve its dev-mode intent)
- Modify: `playwright.config.ts`
- Modify: `package.json`
- Modify: `.github/workflows/build-electron.yml`

- [ ] **Step 1: Extract a reusable Playwright launch/readiness helper**

  The helper must:

  - launch a supplied executable/repo target with a verified temporary
    `--user-data-dir`;
  - attach main-process collectors to every existing/subsequent BrowserWindow
    for `did-fail-load`, `preload-error`, and `render-process-gone`;
  - attach Playwright `pageerror`, `crash`, and error-console collectors;
  - find the no-hash main shell, require URL `app://app/index.html` in packaged
    mode, reveal it, wait for `[data-testid="app-shell"]`, and invoke
    `window.electronAPI.getSettings()`;
  - require the process to remain alive through the post-readiness observation
    window (approximately 12 seconds);
  - fail with collected event details/stdout/stderr;
  - close the application and delete only the verified temporary directory in
    `finally`.

  Early events that precede listener attachment are caught by the mandatory
  URL/DOM/preload-IPC readiness assertions. Do not add a production test IPC,
  environment-controlled marker file, or arbitrary-path write hook.

- [ ] **Step 2: Preserve the existing development E2E test**

  Refactor `e2e/smoke.spec.ts` to use the helper while still launching the repo
  root. Its existing shell + settings IPC assertions must remain.

- [ ] **Step 3: Add packaged smoke tests**

  Read an absolute executable path from `SYNAPSE_PACKAGED_EXE`; fail (not skip)
  when the explicit packaged script invokes the test without it. Tests:

  1. packaged shell readiness and clean diagnostic collectors;
  2. call `testMcpOnboardingConnection("default")` through the real preload
     bridge and assert numeric `toolCount`/`resourceCount` are returned. Zero is
     valid; handshake completion is the proof.

  This second test exercises packaged `Synapse.exe --mcp-stdio`,
  `ELECTRON_RUN_AS_NODE=1`, initialize, tools/list, resources/list, and child
  cleanup.

- [ ] **Step 4: Add a dedicated package script**

  Define independent Playwright projects/test matches:

  - the existing development project runs the ordinary E2E files and explicitly
    excludes `packaged-smoke.spec.ts`;
  - a packaged project matches only `packaged-smoke.spec.ts` and requires
    `SYNAPSE_PACKAGED_EXE`.

  Add `test:e2e:packaged` using the existing `cross-env` dependency, the
  packaged Playwright project, and the actual Windows unpacked executable.
  Ordinary `pnpm test:e2e` must keep running the development project without
  requiring a packaged build.

- [ ] **Step 5: Wire packaged proof after builder and before upload**

  Run `pnpm test:e2e:packaged` in `build-electron.yml` after electron-builder
  succeeds. A failure blocks artifact upload.

- [ ] **Step 6: Run on the current Electron-33 baseline**

  ```bash
  pnpm test:e2e
  pnpm electron:build:win
  pnpm test:e2e:packaged
  ```

  Expected: the refactored development shell/settings smoke and both packaged
  shell/MCP tests pass. Fix the harness before any dependency change if they do
  not.

- [ ] **Step 7: Run typecheck and commit**

  ```bash
  pnpm typecheck
  git add e2e/electron-app-helpers.ts e2e/packaged-smoke.spec.ts e2e/smoke.spec.ts playwright.config.ts package.json .github/workflows/build-electron.yml
  git commit -m "test(electron): prove packaged renderer and MCP readiness"
  ```

---

### Task 5: Add fail-closed `workflow_dispatch` dry-run mode

**Files:**

- Modify: `.github/workflows/release.yml`
- Modify: `scripts/release-admission-gate.mjs`
- Modify: `scripts/release-admission-gate.test.mjs`

- [ ] **Step 1: Add failing release-workflow contract tests**

  Parse `release.yml` and assert:

  - existing `push.tags: ["v*"]` remains;
  - `workflow_dispatch.inputs.dry_run` exists, is boolean, required, and defaults
    true;
  - an explicit invocation-validation job fails a manual run where dry_run is
    not true;
  - build/gate depend on invocation validation;
  - `create-release` requires a push event and `refs/tags/v*`, independent of
    user inputs;
  - release gate receives an explicit mode;
  - attestation runs in both modes over `release-approved-bundle/assets/*`;
  - dry-run and release proof artifacts use distinct names;
  - only release mode's artifact can reach `create-release`.

- [ ] **Step 2: Add the dispatch trigger and validation job**

  Manual dispatch is dry-run-only. Reject `dry_run=false` with a red job rather
  than silently skipping all work. Keep tag pushes as the only publication
  route.

- [ ] **Step 3: Thread explicit release mode into the gate**

  In dry-run:

  - log tag-version and S01 released-SHA eval checks as inapplicable/skipped;
  - still verify package/feed/filename agreement, artifact identity, blockmap,
    signing state, bundle, and manifest;
  - emit `release-context.json` with `mode: "dry-run"`.

  In release:

  - require real `v*` tag/package agreement;
  - require S01 latest-clean signal for the released SHA;
  - emit `mode: "release"`.

- [ ] **Step 4: Keep real attestation in both modes**

  Use the existing `actions/attest@v4` step once with the wildcard subject.
  Generate a dry-run-marked release body and upload the proof artifact as
  `release-approved-bundle-dry-run`. Never run `create-release` in this mode.
  Add workflow-summary output with SHA, run URL, versions, and attestation URL.

- [ ] **Step 5: Update release-body workflow wiring**

  Read `release-profile.json`, `release-context.json`, and
  `signing-status.json`, then call the new `buildReleaseBody` signature. On tag
  release, `create-release` continues to download/reverify only
  `release-approved-bundle`.

- [ ] **Step 6: Run focused tests and workflow syntax checks**

  ```bash
  pnpm test scripts/release-admission-gate.test.mjs
  pnpm exec prettier --check .github/workflows/release.yml .github/workflows/build-electron.yml
  ```

- [ ] **Step 7: Commit**

  ```bash
  git add .github/workflows/release.yml scripts/release-admission-gate.mjs scripts/release-admission-gate.test.mjs
  git commit -m "ci(release): add no-publish Windows proof dry run"
  ```

---

### Task 6: Update release documentation, run the R gate, and stop for merge

**Files:**

- Modify: `CI_CD.md`
- Modify: `README.md`
- Modify: `README_zh.md`
- Modify: `TESTING.md`

- [ ] **Step 1: Update user/developer release truth**

  Document:

  - public releases currently contain Windows x64 NSIS/MSI only;
  - macOS/Linux package scripts remain unsupported local build commands;
  - exact Windows release assets and proof files;
  - manual dry-run command and its permanent attestation residue;
  - tag release remains draft-first and eval-gated;
  - no macOS/Linux feed/update claim remains.

- [ ] **Step 2: Run Checkpoint R locally**

  ```bash
  pnpm format:check
  pnpm lint
  pnpm typecheck
  pnpm test
  pnpm eval
  pnpm electron:build:win
  pnpm test:e2e:packaged
  git diff --check
  ```

  Expected: all pass on Electron 33 + builder 25.

- [ ] **Step 3: Commit documentation**

  ```bash
  git add CI_CD.md README.md README_zh.md TESTING.md
  git commit -m "docs(release): declare Windows-only publication profile"
  ```

- [ ] **Step 4: Open and merge the Checkpoint R PR**

  PR scope must contain no Electron/builder version change. Review the full diff
  and require R tests/build. Merge before continuing; do not start A on an
  unmerged R branch.

- [ ] **Step 5: Dispatch the real dry run from merged `main`**

  ```bash
  gh workflow run release.yml --ref main -f dry_run=true
  gh run list --workflow release.yml --limit 3
  gh run watch <RUN_ID> --exit-status
  gh run download <RUN_ID> -n release-approved-bundle-dry-run -D .tmp/release-proof-r
  ```

  Verify:

  - no tag or draft release was created;
  - only Windows artifacts/proof files exist;
  - `release-context.json.mode == "dry-run"`;
  - manifest re-verifies;
  - attestation URL exists and is recorded in the PR/checkpoint notes;
  - the durable dry-run attestation is acknowledged (not treated as cleanup
    failure).

- [ ] **Step 6: Remove only downloaded temporary proof files**

  Resolve `.tmp/release-proof-r` under the workspace, verify it is the intended
  temporary directory, then remove it. Do not delete tags/releases because the
  dry run created none.

**STOP:** Checkpoint R is complete only after this merged-main dry run. Start A
from updated `main`.

---

## Checkpoint A — electron-builder 26, Electron remains 33

### Task 7: Upgrade only electron-builder and prove packaging output

**Files:**

- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify only if builder 26 proves it necessary: `package.json#build`
- Test: existing release-gate, packaged Playwright, and unit suites

- [ ] **Step 1: Create the A branch from merged/verified R**

  Confirm versions before editing:

  ```bash
  pnpm list electron electron-builder electron-updater --depth 0
  ```

  Expected: Electron 33.4.11, builder 25.1.8, updater 6.8.9.

- [ ] **Step 2: Bump builder only**

  ```bash
  pnpm add -D electron-builder@^26.15.3
  ```

  Inspect `package.json` and lockfile. Fail if Electron, electron-updater,
  electron-vite, Node types, or unrelated direct dependencies changed.

- [ ] **Step 3: Run static and unit proof**

  ```bash
  pnpm install --frozen-lockfile
  pnpm typecheck
  pnpm test scripts/release-admission-gate.test.mjs
  pnpm test
  ```

- [ ] **Step 4: Build and inspect real Windows outputs**

  ```bash
  pnpm electron:build:win
  pnpm test:e2e:packaged
  ```

  Verify exact files:

  - `Synapse-Setup-<version>.exe`;
  - `Synapse-Setup-<version>.exe.blockmap`;
  - `Synapse-<version>.msi`;
  - `latest.yml`.

  Parse the blockmap with gzip+JSON; compare `latest.yml` URL/sha512/size to the
  EXE; compute sha512 for EXE/blockmap/MSI. Do not accept filename drift without
  spec review.

- [ ] **Step 5: Apply only evidenced builder config fixes**

  If builder 26 rejects a setting, record the exact error and make the smallest
  documented fix. Do not change installer type, install scope, artifact naming,
  publish provider, signing behavior, or updater semantics to make the build
  green.

- [ ] **Step 6: Commit**

  ```bash
  git add package.json pnpm-lock.yaml
  # Add package.json build config only if it changed for an evidenced reason.
  git commit -m "build(electron): upgrade electron-builder to 26"
  ```

---

### Task 8: Rehearse both installers and retain the Electron-33 baseline

**Files:**

- No required source edit
- External evidence: Checkpoint A workflow run and PR notes

- [ ] **Step 1: Freeze the final A tip and dispatch one authoritative CI build**

  Finish all builder fixes and checkpoint tests first. Record the final A commit
  and tree SHA, then dispatch that exact branch tip. No source/config commit may
  be added between this run and merge without invalidating the run.

  ```bash
  git rev-parse HEAD
  git rev-parse HEAD^{tree}
  gh workflow run build-electron.yml --ref <A_BRANCH> -f retain_unpacked=true
  gh run watch <A_RUN_ID> --exit-status
  ```

  Download all three artifacts from this one run into a verified disposable
  directory:

  - `electron-windows-x64-nsis`;
  - `electron-windows-x64-msi`;
  - `compat-windows-x64-unpacked-<A_TIP_SHA>`.

  Do not substitute locally built files for any verification below. Hash the
  downloaded NSIS, MSI, and unpacked `Synapse.exe` before testing.

- [ ] **Step 2: Verify the downloaded NSIS and unpacked application**

  On a disposable Windows environment, install the exact downloaded NSIS,
  launch the installed app, and run the packaged shell/MCP checks against the
  exact downloaded `win-unpacked/Synapse.exe`. Verify Synapse identity/icon and
  per-user/custom-directory behavior, then uninstall and verify executable and
  uninstall-entry removal.

- [ ] **Step 3: Verify the downloaded MSI in a separate clean snapshot**

  Do not install over NSIS. Install the exact MSI from the same run, launch it,
  verify identity, uninstall through MSI, and confirm product/files are removed.

- [ ] **Step 4: Record the single-run evidence set**

  Record:

  - run ID/URL, A commit SHA, and A tree SHA;
  - artifact name `compat-windows-x64-unpacked-<SHA>`;
  - exact Electron `33.4.11` and builder `26.x` versions;
  - sha512 of the retained `Synapse.exe`, NSIS, and MSI;
  - the same run's NSIS artifact, retained for the Checkpoint B updater
    rehearsal;
  - NSIS/MSI rehearsal results.

- [ ] **Step 5: Merge Checkpoint A, compare trees, and stop**

  A PR contains builder/lock changes only (plus a narrowly evidenced builder
  config fix, if any). After merge, update local `main` and compare its tree SHA
  with the recorded A tree SHA:

  ```bash
  git rev-parse <A_TIP_SHA>^{tree}
  git rev-parse main^{tree}
  ```

  If they match, the recorded run remains authoritative. If they differ for any
  reason (merge conflict resolution, concurrent change, or post-proof edit),
  dispatch `build-electron.yml` from merged `main` with
  `retain_unpacked=true`, discard the old baseline designation, download the
  new run's NSIS/MSI/win-unpacked set, and repeat Steps 2–4 against that exact
  set. Confirm the authoritative artifacts will not expire before B's
  compatibility run.

**STOP:** Do not bump Electron until A is merged and the baseline artifact is
downloadable, its source tree matches merged A, and all recorded installer and
packaged checks refer to that same authoritative CI run.

---

## Checkpoint B — Electron 43 runtime

### Task 9: Upgrade only Electron and record the actual embedded runtime

**Files:**

- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify only for proven Electron-43 compatibility: affected source/tests

- [ ] **Step 1: Create B from merged A and bump Electron only**

  Re-check the live 43.x stable patch and support schedule. Stay on major 43.

  ```bash
  pnpm add -D electron@^43.1.0
  ```

  Inspect the lock diff. electron-builder/updater/electron-vite/Node types and
  unrelated direct dependencies must remain fixed.

- [ ] **Step 2: Run install/type/API compatibility checks**

  ```bash
  pnpm install --frozen-lockfile
  pnpm typecheck
  pnpm test
  pnpm eval
  ```

  Resolve real Electron type/runtime incompatibilities without blanket `any`,
  disabling sandbox/security settings, or opportunistic refactors. If a failure
  is unclear, temporarily test Electron 38/41 to locate the breaking interval;
  never commit an intermediate unsupported version.

- [ ] **Step 3: Build/package and run positive readiness**

  ```bash
  pnpm electron:build:win
  pnpm test:e2e:packaged
  ```

  Inspect logs for Electron/Chromium deprecations and verify the diagnostic
  collectors are empty.

- [ ] **Step 4: Record actual embedded versions**

  Run the packaged executable under `ELECTRON_RUN_AS_NODE=1` (or Playwright
  main-process evaluation) and record `process.versions.electron`,
  `.chrome`, and `.node`. The PR must report actual values from the chosen
  patch; for 43.1.0, Node is expected to be 24.18.0, not the earlier planned
  24.17.0.

- [ ] **Step 5: Commit runtime dependency and necessary compatibility fixes**

  ```bash
  git add package.json pnpm-lock.yaml <only-proven-compatibility-files>
  git commit -m "build(electron): upgrade Windows runtime to Electron 43"
  ```

---

### Task 10: Build a reusable Electron profile compatibility harness

**Files:**

- Create: `e2e/profile-compat.spec.ts`
- Modify: `e2e/electron-app-helpers.ts`
- Modify: `playwright.config.ts`
- Modify: `package.json`

- [ ] **Step 1: Define explicit two-executable inputs**

  The compatibility script requires absolute existing paths in:

  - `SYNAPSE_ELECTRON33_EXE` — retained A artifact;
  - `SYNAPSE_ELECTRON43_EXE` — B `win-unpacked` output.

  It fails clearly when either is missing or when their runtime-reported major
  versions are not 33 and 43. It runs only on Windows.

- [ ] **Step 2: Create the Electron-33 baseline through real app APIs**

  On one disposable Windows machine/account, launch 33 with `P33-original` and
  require `safeStorage.isEncryptionAvailable()`. Through preload IPC create
  fixed sentinel data:

  - nondefault settings;
  - active + archived workspace and an existing temporary workspace root;
  - conversation metadata;
  - AI provider/model configuration;
  - dummy AI credential via `setAiKey`;
  - built-in plugin enabled/disabled state and preference; add a grant/trigger
    instance when the fixture manifest exposes the needed declaration.

  Do not call real providers or write a real secret.

- [ ] **Step 3: Close before copying and create two independent clones**

  Close Electron 33 cleanly. Copy only after its process tree is gone:

  - `P-forward` for 33→43;
  - `P-rollback` for 33→43→33.

  Never open `P33-original` with 43. Verify every resolved profile path is under
  the test-owned temp root before recursive copy/removal.

- [ ] **Step 4: Implement reusable logical-state assertions**

  Through public preload APIs compare exact IDs/values for settings,
  workspaces, roots, conversations, AI status, and plugin state. Do not merely
  assert nonempty lists.

  For the dummy credential, use Playwright main-process evaluation to read
  `ai/credentials.json`, decrypt its base64 ciphertext with that runtime's real
  `safeStorage.decryptString`, compare to the sentinel inside main, and return
  only `true/false`. Never expose plaintext to renderer, logs, snapshots, or the
  compatibility report.

- [ ] **Step 5: Implement both directions**

  1. Launch 43 on `P-forward`; require readiness, logical equality, and decrypt
     success.
  2. Launch 43 on `P-rollback`; assert/close so Chromium may update its profile.
  3. Launch retained 33 on the same 43-touched `P-rollback`; require readiness,
     logical equality, and decrypt success again.

- [ ] **Step 6: Produce secret-free evidence and cleanup**

  Report executable hashes/runtime versions and boolean assertion outcomes.
  Clean all temporary profiles/roots in `finally`; do not retain credential
  archives as CI artifacts.

- [ ] **Step 7: Add/run the package script**

  Add `test:e2e:profile-compat` and run it with the two explicit executable
  paths after downloading/extracting A's retained artifact:

  ```powershell
  $env:SYNAPSE_ELECTRON33_EXE = '<absolute A artifact>\Synapse.exe'
  $env:SYNAPSE_ELECTRON43_EXE = '<repo>\release\win-unpacked\Synapse.exe'
  pnpm test:e2e:profile-compat
  ```

  Expected: forward and rollback cases pass on the same OS user.

- [ ] **Step 8: Commit**

  ```bash
  git add e2e/profile-compat.spec.ts e2e/electron-app-helpers.ts playwright.config.ts package.json
  git commit -m "test(electron): verify Electron 33 profile upgrade and rollback"
  ```

---

### Task 11: Complete Windows installer and runtime behavior rehearsal

**Files:**

- No required source edit
- External evidence: B PR checklist

- [ ] **Step 1: Repeat clean NSIS and MSI rehearsals with Electron 43**

  Use separate clean sequences. Verify install, installed-app readiness, app
  identity, uninstall, and file/registration removal.

- [ ] **Step 2: Run the installed-app behavior checklist**

  Verify:

  - app:// shell/preload/CSP;
  - title-bar drag/minimize/maximize/restore/close/theme;
  - second-instance routing and `.syn` association;
  - tray restore/quit;
  - global shortcut/search window;
  - Synapse native notification identity/icon;
  - governed clipboard and desktop-capture adapters;
  - save/restart/read of a new dummy credential (current-runtime sanity only);
  - Start Menu/Win32 and UWP discovery/launch;
  - Workspace Settings MCP connection test;
  - updater check reaches a terminal state.

- [ ] **Step 3: Record failures as blockers**

  Do not waive a failure because `pnpm dev`, process liveness, or unit tests pass.
  Do not disable sandbox, context isolation, feed integrity, or MCP Node re-exec
  to make a check pass.

---

### Task 12: Rehearse the real 33→43 NSIS updater transition

**Files:**

- No committed production source/config change
- Disposable build/feed output only

- [ ] **Step 1: Prepare two real packaged versions**

  Download the recorded Checkpoint A run's `electron-windows-x64-nsis`
  artifact and use that Electron-33 NSIS build as the installed old
  application.
  Build a disposable Electron-43 candidate with a strictly newer test version
  (for example `0.3.1-upgrade-smoke.0`) using electron-builder metadata/config
  overrides or a temporary worktree. Do not commit the scratch version.

- [ ] **Step 2: Build and re-verify a real manifest from the candidate bytes**

  Place the candidate EXE, exact adjacent `<exe>.blockmap`, and generated
  `latest.yml` into one verified disposable feed directory. Compute sha512 from
  those on-disk bytes, call the exported `buildManifest()` helper, and write
  `manifest.json`. Re-read every file, recompute its sha512, and require
  `verifyManifest()` to pass with exact file-set equality before starting the
  server.

  Also require `validateSingleFileFeed()` and `validateWindowsBlockmap()` to
  pass against these exact files. The resulting manifest must contain a real
  entry for `<exe>.blockmap`; a prose claim or hash copied from elsewhere is not
  evidence.

- [ ] **Step 3: Serve the already-manifested bytes from an isolated feed**

  Serve that same directory over loopback without copying, renaming, rebuilding,
  or mutating the EXE, blockmap, or `latest.yml` after manifest verification.
  Modify only the disposable installed old application's
  `resources/app-update.yml` to point to the generic feed. Do not add a source
  code preference/env hook that accepts arbitrary feeds.

- [ ] **Step 4: Execute the user-visible update flow**

  From installed Electron 33:

  ```text
  check → available → download → downloaded → quitAndInstall → Electron 43 starts
  ```

  Assert the final installed version/runtime, app/profile state, and no orphan
  updater/app process. Confirm `latest.yml` EXE URL/sha512/size, independently
  parse the adjacent blockmap, and re-run `verifyManifest()` against the served
  bytes after the update completes.

- [ ] **Step 5: Cleanup and record evidence**

  Stop the local server, uninstall the test app, and delete only verified
  disposable feed/worktree paths. Record versions, installer hashes, manifest
  hash/verification result, and environment — never the test
  credential/profile.

  Failure blocks the first Electron-43 production tag.

---

### Task 13: Update runtime documentation and run the final gate

**Files:**

- Modify: `CLAUDE.md`
- Modify: `README.md`
- Modify: `README_zh.md`
- Modify: `CI_CD.md`
- Modify: `TESTING.md`
- Modify if maintained during implementation: the S11 spec status/notes

- [ ] **Step 1: Update dependency/runtime truth**

  Replace Electron 33 references with the final 43.x patch/major. State that
  repository tooling is Node 22.13.x while packaged Electron/MCP Node is 24.x.
  Keep mac/Linux commands labelled unsupported local builds, not releases.

- [ ] **Step 2: Document durable verification commands**

  Add packaged smoke, profile compatibility, dry-run, retained baseline, and
  updater rehearsal instructions. Keep secrets/sentinel profiles out of docs.

- [ ] **Step 3: Run final automated verification**

  ```bash
  pnpm install --frozen-lockfile
  pnpm format:check
  pnpm lint
  pnpm typecheck
  pnpm typecheck:native
  pnpm test
  pnpm eval
  pnpm build
  pnpm test:e2e
  pnpm electron:build:win
  pnpm test:e2e:packaged
  pnpm test:e2e:profile-compat
  git diff --check
  ```

  `typecheck:native` is a sanity signal; stable `pnpm typecheck` remains
  authoritative. Profile compatibility requires the two executable environment
  variables from Task 10.

- [ ] **Step 4: Verify dependency closure**

  ```bash
  pnpm list electron electron-builder electron-updater electron-vite --depth 0
  pnpm why electron
  pnpm why electron-builder
  ```

  Expected: final Electron 43.x, builder 26.x, updater 6.8.9, electron-vite
  unchanged; no root Electron 33 resolution remains.

- [ ] **Step 5: Commit documentation**

  ```bash
  git add CLAUDE.md README.md README_zh.md CI_CD.md TESTING.md
  git commit -m "docs(electron): record Windows Electron 43 support and proof"
  ```

  The reviewed spec and implementation plan were already committed in Task 0;
  they must not remain as untracked files or be silently folded into this final
  runtime-documentation commit.

- [ ] **Step 6: Open the B PR with evidence**

  Include:

  - exact Electron/Chromium/Node/builder/updater versions;
  - packaged shell and MCP workflow run;
  - 33→43 and 33→43→33 secret-free compatibility report;
  - NSIS/MSI install/uninstall results;
  - updater transition result;
  - Windows-only release profile/dry-run attestation link from R;
  - explicit statement that no macOS/Linux artifact is built or published.

  Merge only after every required item passes. After merge, the next `v*` tag
  may publish a Windows-only draft release through the unchanged S01/S03 proof
  philosophy.

---

## Abort/rollback rules

- **R fails:** do not bump dependencies. Keep the existing release pipeline and
  resolve profile/gate/workflow proof first.
- **A fails:** revert builder/package lock to 25.1.8; do not start B.
- **B static/runtime fails:** revert only Electron/package lock to A's known-good
  Electron-33 + builder-26 state.
- **B rollback-profile case fails:** Electron 43 is not rollback-safe. Do not
  merge until the mutation is understood or the product explicitly abandons
  downgrade support in a reviewed spec amendment.
- **Updater rehearsal fails:** B may remain under review, but no Electron-43
  production tag is allowed. Never remove hash/blockmap/admission checks.
- Any rollback restores matching `package.json` and `pnpm-lock.yaml`; never
  hand-edit only one.
- No task authorizes publishing, deleting a release/tag, or merging a PR without
  the user's normal repository authority. External steps stop and report if
  that authority is unavailable.
