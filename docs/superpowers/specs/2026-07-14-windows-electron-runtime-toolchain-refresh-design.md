# S11 — Windows Electron Runtime & Packaging Toolchain Refresh (design)

> Date: 2026-07-14
> Status: Checkpoints R and A implemented and merged. Checkpoint B (Electron 43
> runtime upgrade, profile-compatibility harness, runtime documentation) is
> implemented and passing local verification; it still needs the hardware-only
> clean-install and updater rehearsal evidence (goals 9 and 13) before the
> Checkpoint B PR merges.
> Scope: Windows x64 runtime **and release publication** only. macOS/Linux local
> build configuration is retained, but neither platform is built or published by
> the release pipeline after this spec.

## Current real code state (verified against source and the package registry)

### The runtime is outside Electron's support window

The root [`package.json`](../../../package.json) declares:

```json
{
  "devDependencies": {
    "electron": "^33.2.0",
    "electron-builder": "^25.1.8"
  },
  "dependencies": {
    "electron-updater": "^6.8.9"
  }
}
```

The lockfile currently resolves Electron to `33.4.11`, electron-builder to
`25.1.8`, and electron-updater to `6.8.9`. Registry state verified on
2026-07-14:

- Electron's current stable line is `43.x` (`43.1.0` at verification time).
- electron-builder's current stable release is `26.15.3`.
- electron-updater `6.8.9` is already current and needs no upgrade.

Electron officially supports only the latest three stable major lines.
Electron 33 reached end-of-life on 2025-04-29; its embedded Chromium 130 and
Node 20.18 no longer receive Electron-line security fixes. Electron 43 is
stable, embeds Chromium 150 and Node 24.x, and is supported through 2027-01-05.
The exact embedded Node version varies by Electron patch (`43.1.0` currently
ships Node `24.18.0`; the schedule's `24.17.0` described the initial 43.0 line).
Electron 44 is prerelease until 2026-08-25 and is therefore not a target of this
spec. The implementation PR records the exact Chromium and Node versions from
the finally locked Electron patch rather than copying a planned schedule value.

Primary external references:

- [Electron release/support policy](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)
- [Electron release schedule and embedded dependency versions](https://releases.electronjs.org/schedule)
- [Electron breaking changes](https://www.electronjs.org/docs/latest/breaking-changes)
- [electron-builder 26.15.3 release](https://github.com/electron-userland/electron-builder/releases/tag/electron-builder%4026.15.3)

### The repository's Node floor already satisfies Electron 43's tooling floor

The repository declares Node `>=22.13.0`, and GitHub Actions uses Node
`22.13.x`. Electron 43's npm package requires Node `>=22.12.0`, so this upgrade
does not require changing the development/CI Node version. There are two
different runtimes after the upgrade and they must remain deliberately
distinguished:

- repository scripts, tests, electron-vite, and electron-builder run under the
  configured Node 22.13.x toolchain;
- the packaged Electron main process, and Synapse's
  `ELECTRON_RUN_AS_NODE=1` MCP child, run under Electron 43's embedded Node
  24.x.

`@types/node` remains on the Node 22 line in this spec. Raising it to Node 24
while repository scripts still execute on Node 22 would allow code to typecheck
against APIs that those scripts cannot actually call.

### Windows packaging has strong artifact checks but no packaged runtime smoke

[`package.json`](../../../package.json) builds Windows x64 as both NSIS and MSI.
[`build-electron.yml`](../../../.github/workflows/build-electron.yml) already:

- builds with `electron-builder --win --publish=never`;
- fails if the NSIS/MSI artifacts, blockmap, or `latest.yml` are absent;
- uploads NSIS and MSI in separate, explicitly named artifact containers.

S03's [`release-admission-gate.mjs`](../../../scripts/release-admission-gate.mjs)
then verifies the Windows container inventory, version consistency, and the
`latest.yml` file/hash/size contract before a tagged release can be assembled.

What is missing is a Windows equivalent of the workflow's Linux packaged-app
smoke test. A successful `electron-builder` exit proves that files were
created; it does not prove that the packaged `Synapse.exe` can initialize its
main process, custom protocol, preload, and renderer under the new Electron
runtime. NSIS/MSI install and uninstall behavior is also not exercised by CI.

### The Windows runtime surface is broader than a BrowserWindow

The upgrade must preserve these verified Windows production paths:

- sandboxed BrowserWindows with `contextIsolation: true`,
  `nodeIntegration: false`, and `webviewTag: false`;
- custom `app://` protocol, CSP, preload bridge, and custom title-bar overlay;
- single-instance behavior and `.syn` file association routing;
- tray, native notifications, clipboard, desktop capture, shell actions, and
  global shortcuts;
- Windows Start Menu/UWP application discovery and launching;
- `safeStorage`-backed credentials;
- manual `electron-updater` flow using the NSIS feed;
- packaged `Synapse.exe --mcp-stdio`, which re-execs `process.execPath` with
  `ELECTRON_RUN_AS_NODE=1` and inherits piped stdio.

No production source import of `sharp` exists. The repository deliberately
sets `npmRebuild`, `buildDependenciesFromSource`, and `nodeGypRebuild` to
`false`; no live Electron-side native addon has been found that requires an
ABI rebuild for Electron 43. This materially lowers the migration risk, but the
packaged runtime test remains the proof rather than the assumption.

## Problem statement

Electron 33 is no longer a defensible production runtime: remaining on it means
shipping an unsupported Chromium/Node bundle. A blind combined bump of
Electron and electron-builder would be hard to diagnose, however: when a build
or runtime regression appears, the change would not reveal whether the packager
or the embedded runtime caused it.

The work therefore needs three independently proven checkpoints:

1. contract the active release profile to Windows x64 while every dependency is
   still fixed, and prove the publication change by itself;
2. modernize the packaging tool while keeping Electron 33 fixed, and prove the
   Windows artifact/install contract is unchanged;
3. modernize the Electron runtime while keeping the now-proven packager fixed,
   and prove Windows runtime behavior under Electron 43.

## Guiding principles

**A supported browser runtime is a security boundary, not optional dependency
hygiene.** The completion target is a supported stable Electron line, not the
smallest version bump that makes `pnpm outdated` shorter.

**Change one independent layer at a time.** electron-builder produces and
describes the binaries; Electron runs them. Each layer receives its own
dependency diff, lockfile checkpoint, build evidence, and rollback point.

**Artifact existence is not runtime proof.** The upgraded Windows executable
must actually start from packaged output. The two installers must actually
install and uninstall on a clean Windows environment.

**The release profile must say what the product actually publishes.** This spec
does not merely ignore failing macOS/Linux matrix legs while continuing to put
their unverified artifacts in a release. The build workflow, admission gate,
approved bundle, signing declaration, attestation, and release body all become
explicitly Windows x64 only. Anything outside that profile is rejected, not
silently tolerated.

**Temporarily unsupported is not dormant release code.** Local macOS/Linux
builder targets remain available for future engineering work, but their old
release assembly/merge branches are removed from the active gate. Re-enabling a
platform later requires a fresh spec and tests against the then-current
Electron, electron-builder, updater, signing, and release contracts.

## Goals and completion criteria

This spec is complete when:

1. The only active release target is Windows x64, represented by one
   machine-readable release profile and enforced consistently by the build
   workflow and admission gate.
2. A release build produces and the approved bundle contains exactly the
   Windows NSIS installer, MSI installer, NSIS blockmap, `latest.yml`, release
   profile, release context, signing declaration, and integrity manifest — no
   macOS/Linux binary or feed — and that exact asset set is attested before
   publication.
3. `electron-builder` resolves to `26.15.3` (or a newer `26.x` patch explicitly
   re-reviewed at implementation time) and its Windows packaging checkpoint
   passes before Electron changes.
4. Electron resolves to `43.1.0` (or the latest `43.x` patch at implementation
   time) and no Electron 33 package remains in the root dependency graph.
5. electron-updater remains at `6.8.9`; its state-machine behavior and Windows
   feed contract remain unchanged.
6. `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`, and the
   keyless `pnpm eval` baseline pass on the final dependency set.
7. `pnpm electron:build:win` produces the expected Windows x64 NSIS installer,
   MSI installer, NSIS blockmap, and `latest.yml`.
8. A durable Playwright Windows packaged-app smoke test proves the hidden main
   BrowserWindow reaches `app://app/index.html`, the preload bridge exists, the
   renderer mounts `[data-testid="app-shell"]`, and a real settings IPC
   round-trip succeeds. Process survival alone is never a pass condition.
9. NSIS and MSI each pass a clean-environment install → launch → uninstall
   rehearsal, independently rather than installed over one another.
10. The packaged MCP onboarding connection test completes an actual
    `initialize` + `tools/list` + `resources/list` handshake, proving the
    Electron 43/Node 24.x `ELECTRON_RUN_AS_NODE` path.
11. The Windows runtime checklist in this spec is recorded as upgrade evidence
   on the implementation PR.
12. An Electron-33-created representative user profile passes both 33→43
    forward-read verification and, on an independent clone, 33→43→33 rollback
    verification, including `safeStorage` ciphertext decryption under both
    runtimes.
13. Before the first production Windows release using Electron 43, the existing
    NSIS updater path is rehearsed from a prior Electron-33-based build to the
    Electron-43 candidate, including download and `quitAndInstall`.

## Non-goals

- No macOS or Linux runtime testing, compatibility repair, signing, notarizing,
  installer verification, updater verification, artifact publication, or
  UI-layout work.
- No deletion of macOS/Linux source branches, `package.json#build.mac`,
  `package.json#build.linux`, or the local `electron:build:mac` /
  `electron:build:linux` commands. They remain developer-invoked, unsupported
  local build entry points; they are no longer release inputs.
- No code-signing certificate acquisition or Authenticode validation. Current
  Windows signing status remains explicitly declared by S03.
- No electron-updater upgrade; `6.8.9` is already current.
- No electron-vite, Vite, TypeScript, `@types/node`, or repository Node-engine
  upgrade unless a concrete Electron-43 incompatibility makes the runtime
  upgrade impossible. Such a finding stops this spec for review rather than
  silently widening it.
- No opportunistic Electron API refactor. Only changes proven necessary by
  Electron 43 types, startup behavior, or the required Windows checks belong in
  this work.
- No intentional Synapse-owned user-data schema migration. The runtime/toolchain
  bump must read existing settings, workspaces, run traces, credential records,
  and plugin state as-is. Chromium/Electron-owned profile files may still be
  rewritten merely by launching a newer runtime, so forward and rollback
  compatibility must be proven rather than inferred from the absence of a
  Synapse migration function.
- No permanent test-only feed override or insecure updater backdoor in
  production code.
- No compatibility promise for a locally built macOS/Linux application. The
  public release profile and release notes must say Windows x64 only.

## Architecture and migration sequence

### Checkpoint R — contract the release profile to Windows x64

This checkpoint changes no package version. It must pass with the existing
Electron 33 + electron-builder 25 lockfile before either dependency is bumped.

#### Build workflow

[`build-electron.yml`](../../../.github/workflows/build-electron.yml) becomes a
single Windows x64 job rather than a four-entry platform matrix:

- `runs-on: windows-latest`;
- `electron-builder --win --x64 --publish=never`;
- Windows packaged bootstrap smoke;
- upload `electron-windows-x64-nsis` containing exactly `.exe`, `.blockmap`,
  and `latest.yml`;
- upload `electron-windows-x64-msi` containing exactly `.msi`;
- keep `if-no-files-found: error` for both containers.

Remove the macOS/Linux matrix entries, platform-only steps, upload steps,
comments, cache paths, and Apple-secret examples from this release workflow.
Do not leave them behind under permanently-false `if` conditions. The local
package scripts/configuration listed in Non-goals remain untouched.

[`release.yml`](../../../.github/workflows/release.yml) continues to call the
same reusable workflow path, but its names/comments change from “all platforms”
to “Windows x64.” It stops passing `APPLE_CERT_CONFIGURED`; only
`WINDOWS_CERT_CONFIGURED` participates in release admission.

#### Machine-readable release profile

The gate owns one exported constant and emits it verbatim as
`release-profile.json` inside the approved bundle:

```js
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
```

This file is included in `manifest.json` and in the attested subject set. The
release body renders “Windows x64 (NSIS, MSI)” from this profile and explicitly
states that macOS/Linux artifacts are not included. The wording is generated
from the same profile object, not maintained as a second independent hardcoded
platform list.

The gate also emits a dynamic `release-context.json` proof file:

```js
{
  schemaVersion: 1,
  mode: "dry-run" | "release",
  commitSha: string,
  workflowRunId: string
}
```

It too is covered by `manifest.json` and the attestation. This keeps the static
target profile separate from the execution mode while making it impossible to
mistake an attested dry-run bundle for a release bundle.

#### S03 admission-gate amendment

S11 supersedes S03 only where S03 defined a multi-platform artifact inventory,
macOS feed merge, Linux feed validation, and dual-platform signing statement.
The eval-signal, version, manifest, attestation, approved-bundle, and
fail-closed principles remain unchanged.

[`release-admission-gate.mjs`](../../../scripts/release-admission-gate.mjs)
changes as follows:

- `EXPECTED_ARTIFACT_MANIFEST` contains exactly the two Windows containers;
- `gh run download --pattern electron-*` still downloads by broad prefix, and
  `checkArtifactManifest()` still rejects every unexpected container — a stale
  macOS/Linux upload therefore fails rather than leaking into the bundle;
- feed validation applies `validateSingleFileFeed()` to `latest.yml` and the
  real NSIS installer only: exact URL basename, installer sha512, installer
  size, and version;
- a separate Windows blockmap validator requires exactly
  `<installer-filename>.blockmap`, rejects an empty file, and uses the same
  `gunzipSync` + `JSON.parse` convention as the locked electron-updater to prove
  the bytes are parseable; `manifest.json` independently binds the blockmap's
  sha512 because standard `latest.yml` does not carry its filename/hash;
- version consistency covers `latest.yml`, NSIS, and MSI only;
- signing admission evaluates Windows only, and `signing-status.json` contains
  only `platformCodeSigning.windows`;
- bundle assembly copies only the two Windows containers plus generated proof
  files.

`signing-status.json` keeps `schemaVersion: 1`: its
`platformCodeSigning` field is already a map of platforms represented by the
release, not a promise that Windows and macOS keys always coexist. Tests lock
that the release body iterates the actual map rather than assuming a macOS
entry.

Remove the now-unreachable macOS feed merge and Linux feed branches and their
release-gate-only tests instead of preserving dormant code. Keep generic
helpers such as `validateSingleFileFeed()`, `computeSigningStatus()`, manifest
construction, and attestation verification because Windows still uses them.
When macOS/Linux publication returns, its new spec must reintroduce and
revalidate the then-correct updater/feed behavior.

Checkpoint R tests lock:

- missing or extra release container fails;
- an `electron-macos-*` or `electron-linux-*` container fails as unexpected;
- a contract test parses `build-electron.yml` with the repository's existing
  `js-yaml` dependency and proves its runner/build flag/upload-container set
  matches the Windows target represented by `RELEASE_PROFILE`;
- wrong Windows filename/cardinality/hash/size/version fails;
- a missing, misnamed, empty, non-gzip, or non-JSON blockmap fails, and changing
  blockmap bytes without rebuilding `manifest.json` fails manifest verification;
- the approved bundle's file set has no `.dmg`, `.zip`, `.AppImage`, `.deb`,
  `latest-mac.yml`, or `latest-linux.yml`;
- `release-profile.json`, `release-context.json`, `signing-status.json`, and
  every Windows asset appear in the integrity manifest;
- the release body names Windows x64 and explicitly excludes macOS/Linux;
- configured-but-unverified Windows signing remains fail-closed.

Checkpoint R is its own commit and preferably its own PR. The dry-run workflow
defined below must prove the gate assembles and attests a Windows-only approved
bundle before Checkpoint A.

#### Side-effect-safe release dry run

[`release.yml`](../../../.github/workflows/release.yml) gains a
`workflow_dispatch` entry with a required boolean `dry_run` input whose default
is `true`. Manual dispatch is **dry-run-only**: the workflow rejects a dispatched
run with `dry_run != true`, and `create-release` is guarded independently by
both `github.event_name == 'push'` and a `refs/tags/v*` ref. No input value can
turn a manual branch run into a publishing run.

The two modes are explicit:

| Check | `workflow_dispatch`, dry run | `v*` tag, release |
|---|---:|---:|
| quality/test/Windows build | required | required |
| Windows artifact/feed/signing admission | required | required |
| package ↔ installer/feed version | required | required |
| package ↔ Git tag version | not applicable; logged as skipped | required |
| S01 latest-clean eval signal for released SHA | not applicable; logged as skipped | required |
| approved-bundle assembly + manifest self-check | required | required |
| real GitHub build-provenance attestation | required | required |
| upload proof bundle as workflow artifact | `release-approved-bundle-dry-run` | `release-approved-bundle` |
| draft GitHub Release creation | forbidden | required after gate |

Dry-run mode is allowed to skip only the two checks whose inputs do not exist
for a branch dispatch: a release tag and the release-SHA nightly signal. This is
not a shared boolean threaded through arbitrary validators. The gate exposes an
explicit mode (`"dry-run" | "release"`), and tests prove that release mode can
never omit either check. Artifact identity, feed integrity, signing state,
version agreement with `package.json`, manifest verification, and attestation
remain identical in both modes.

The dry-run bundle's `release-context.json` and generated release body carry an
unmistakable `DRY RUN — NOT A RELEASE` marker. `create-release` never consumes
the dry-run artifact name. The workflow summary records the commit SHA, run
URL, selected Electron/builder versions, and attestation URL.

The repository's `actions/attest@v4` build-provenance step creates a durable attestation that GitHub does
not support deleting. Checkpoint R deliberately accepts one such dry-run
attestation as the cost of proving the real attestation path; it remains tied to
the dispatched commit and workflow run and is labelled as dry-run in the proof
bundle/summary. The uploaded dry-run bundle expires under normal Actions
artifact retention. There is no scratch tag or draft release to clean up.

### Checkpoint A — packaging toolchain only

Change only:

```json
{
  "devDependencies": {
    "electron-builder": "^26.15.3"
  }
}
```

Then regenerate `pnpm-lock.yaml` with the repository's declared pnpm version.
Electron stays at the currently locked `33.4.11` for this checkpoint.

Required proof before Checkpoint B begins:

- clean/frozen dependency install succeeds under Node 22.13.x;
- lint, typecheck, unit tests, and electron-vite build pass;
- `pnpm electron:build:win` succeeds;
- NSIS/MSI names remain `Synapse-Setup-<version>.exe` and
  `Synapse-<version>.msi`;
- `latest.yml` still references the real NSIS installer by exact URL basename,
  sha512, and size;
- the separately published blockmap is named `<installer>.blockmap`, is nonempty,
  gunzips to valid JSON using electron-updater's actual parsing convention, and
  receives its own sha512 entry in `manifest.json`;
- S03's existing Windows artifact/feed contract tests pass;
- NSIS and MSI can each install and uninstall in a disposable Windows
  environment.

No `package.json#build` setting is changed pre-emptively. If builder 26 rejects
or changes an existing setting, the implementation must record the exact error
or generated-output difference and make the smallest documented compatibility
change. Renaming artifacts, changing install scope, switching installer type,
or changing the publish provider is not an incidental compatibility fix and
requires separate review.

Checkpoint A should be its own commit and preferably its own PR. If the final
implementation uses one PR, Checkpoint A's commit must still be buildable and
reviewable independently.

### Checkpoint B — Electron runtime

With builder 26 already proven, change:

```json
{
  "devDependencies": {
    "electron": "^43.1.0"
  }
}
```

Regenerate `pnpm-lock.yaml` again. The implementation may select a later 43.x
patch if one exists at that time, but must not silently cross to Electron 44.
The chosen exact version and its support/EOL dates are recorded in the PR.

The committed result jumps directly to Electron 43. Intermediate Electron 38 or
41 installs are diagnostic checkpoints only: use them temporarily if a failure
must be localized to a smaller breaking-change interval, but do not commit or
ship an intermediate unsupported line.

The initial compatibility pass consists of:

- resolving Electron type errors without `any` casts that erase API contracts;
- checking startup logs for Electron/Chromium deprecation warnings;
- confirming the custom protocol is registered before renderer navigation;
- confirming every BrowserWindow retains the repository's security invariants;
- confirming preload IPC serialization still accepts only the typed bridge
  shapes;
- confirming the packaged app uses the intended executable and resources, not
  a development Electron binary;
- confirming Electron 43's on-demand binary installation behavior does not
  break frozen CI installs or the existing Electron cache key/paths.

### No mixed rollback state

If Checkpoint B fails irreducibly, revert only the Electron checkpoint and keep
the already-proven builder 26 checkpoint. If Checkpoint A itself is unstable,
revert it before attempting Electron 43. The two dependency changes must never
be squashed into a state where the last known-good combination cannot be
reconstructed.

Neither dependency checkpoint intentionally writes a Synapse-owned user-data
migration. Rollback therefore has no application schema down-migration step,
but is not declared safe until the 33→43→33 profile-copy rehearsal below proves
that Electron/Chromium-owned profile mutations do not prevent the old runtime
from starting and reading Synapse data.

## Durable Windows packaged-app smoke test

The existing [`e2e/smoke.spec.ts`](../../../e2e/smoke.spec.ts) already contains
the right positive proof for a development build: Playwright finds the hidden
main shell, reveals it, waits for `[data-testid="app-shell"]`, and performs a
real `window.electronAPI.getSettings()` IPC round-trip. Extend that pattern with
a dedicated packaged mode/test rather than replacing it with a bare
`child_process` liveness timer.

Invoke the packaged Playwright test in the single Windows job of
[`build-electron.yml`](../../../.github/workflows/build-electron.yml)
immediately after electron-builder succeeds and before artifacts are uploaded.
It is permanent regression coverage.

Required launch and isolation behavior:

1. Fail immediately on a non-Windows host.
2. Pass Playwright Electron's `executablePath` as the actual
   `release/win-unpacked/Synapse.exe`; do not launch the repository root,
   `node_modules/electron`, or an installed Synapse copy.
3. Launch with a unique temporary `--user-data-dir` so real state and the
   single-instance lock cannot affect the test.
4. Capture the Electron process's stdout/stderr and exit code for diagnostics.
5. In `finally`, close Playwright's `ElectronApplication`, force-clean only its
   remaining child process tree if graceful close fails, and remove only the
   verified temporary profile path.

Required positive readiness proof — every item must pass:

1. Playwright connects to the packaged Electron application and discovers the
   hidden main BrowserWindow.
2. The shell window URL is exactly `app://app/index.html` (allowing only the
   expected empty hash), proving the packaged custom protocol path rather than
   a dev-server/file fallback.
3. After revealing the hidden BrowserWindow through Playwright's main-process
   evaluation, `[data-testid="app-shell"]` mounts within the readiness deadline.
4. Renderer evaluation sees `window.electronAPI` and successfully awaits
   `getSettings()`; the response contains representative typed fields such as
   `hotkey` and `themeMode`. This one assertion jointly proves preload execution,
   contextBridge exposure, trusted IPC registration, and renderer execution.
5. The process remains alive through the approximately 12-second observation
   window. Liveness is an additional condition after readiness, never a
   substitute for readiness.

Required negative-signal collection:

- as soon as Playwright connects, attach collectors to every existing and
  subsequently created BrowserWindow for `did-fail-load`, `preload-error`, and
  `render-process-gone`;
- attach renderer `pageerror`, `crash`, and error-console collectors to every
  Playwright `Page`;
- fail if any collected event concerns the main shell, before or after the
  readiness assertion;
- include event details and captured process output in the failure report.

An error that occurs before collectors attach is still caught by the mandatory
URL/DOM/preload-IPC readiness proof. No production-only `renderer-ready` IPC,
environment-variable file marker, or arbitrary-path write hook is added merely
for this smoke test.

This test proves packaged main/protocol/preload/renderer initialization. It
does not replace the broader manual behavior checklist below.

The workflow no longer has a platform matrix after Checkpoint R, so this smoke
step needs no platform guard. It runs for every release candidate build.

## Windows verification matrix

### Automated merge evidence

Run on the final Electron 43 + builder 26 dependency set:

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm eval
pnpm electron:build:win
```

Also run `build-electron.yml` on the branch so the durable packaged smoke and
`if-no-files-found: error` upload contract execute outside the developer's
machine.

No test is weakened, skipped, or rewritten merely because a newer Electron
version exposes a failure. A test may change only when the old assertion was
about an intentionally changed upstream behavior and the new repository
behavior has been explicitly accepted in this spec or an amendment.

### Clean-environment installer rehearsal

Use Windows Sandbox, a disposable VM, or a clean GitHub-hosted Windows runner.
Run NSIS and MSI in separate clean snapshots/sequences so Windows Installer
product registration and one installer's files cannot make the other appear to
work.

For each installer:

1. install successfully using its normal installation mode;
2. launch the installed `Synapse.exe`, not `win-unpacked`;
3. verify the app identity/icon is Synapse rather than `electron.app.Electron`;
4. close the app and uninstall through the installer's supported path;
5. verify the executable and registered uninstall entry are removed;
6. record installer filename, sha512, exit result, and environment version in
   the implementation PR.

NSIS additionally verifies the existing per-user/custom-directory behavior.
MSI additionally verifies a normal MSI uninstall. Changing either installer's
scope or UX to make the test pass is outside this spec.

### Electron 33 profile forward/rollback compatibility rehearsal

Checkpoint A retains its packaged Electron-33 `win-unpacked` output as a named
CI artifact together with the commit SHA, exact Electron/builder versions, and
sha512 of `Synapse.exe`. Checkpoint B's compatibility test consumes that exact
baseline executable and the new Electron-43 executable on the **same disposable
Windows machine and OS user account**. A `safeStorage`/DPAPI profile must not be
copied across users or machines, which would test the wrong property.

Add a reusable Playwright profile-compatibility test (separate from the clean
bootstrap smoke) with this sequence:

1. Launch the Electron-33 packaged executable against a fresh temporary profile
   `P33-original` and assert `safeStorage.isEncryptionAvailable()`; absence is a
   hard environment failure, not a skipped credential assertion.
2. Populate representative state through real preload IPC/application paths:
   non-default settings; one active and one archived workspace; a workspace
   root; a conversation record; AI provider/model settings; a dummy AI API key;
   and persisted built-in plugin state (enabled/disabled plus a preference and,
   where declared by the fixture, a capability grant/trigger instance). Use
   fixed sentinel ids/names/values so every later read can be compared exactly.
3. Close Electron 33 cleanly and only then snapshot the expected logical state
   and recursively clone the profile twice: `P-forward` and `P-rollback`.
   `P33-original` is never opened by Electron 43 and remains immutable evidence.
4. Launch Electron 43 against `P-forward`. Through public preload APIs, assert
   every representative settings/workspace/conversation/plugin record is
   present with the same identity and value. Assert the AI credential is still
   reported as connected/present.
5. In a Playwright main-process evaluation — never renderer IPC — read the
   dummy AI credential ciphertext from `ai/credentials.json`, decrypt it with
   that runtime's real `safeStorage.decryptString`, compare it to the sentinel
   **inside the main process**, and return only a boolean. Never log or return
   the plaintext secret.
6. Launch Electron 43 against the independent `P-rollback` clone, repeat the
   forward assertions, and close it cleanly. This allows Chromium/Electron 43 to
   make whatever normal profile-file updates it would make for a real user.
7. Launch the retained Electron-33 executable against that same, now-43-touched
   `P-rollback`. Assert startup/readiness, all representative app-owned records,
   and the same main-process safeStorage decryption check again.
8. Clean up all three verified temporary profile paths in `finally`; retain the
   logical assertion report, executable hashes, and runtime versions as PR
   evidence, not the credential-bearing profile archives.

The forward run proves existing users can upgrade. The rollback clone proves
the spec's rollback claim under actual Chromium profile mutation. A newly
created Electron-43 credential followed by an Electron-43 restart remains in
the manual checklist as a current-runtime sanity check, but it is not evidence
for either compatibility direction.

### Manual packaged runtime checklist

Using an installed candidate, not `pnpm dev`:

- main window renders through `app://` with no CSP/preload error;
- minimize, maximize/restore, close, drag region, and title-bar theme all work;
- second launch routes to the existing instance rather than creating a
  conflicting process;
- tray menu opens/restores/quits the app;
- launcher global shortcut opens the expected window;
- native notification displays with the Synapse identity/icon;
- clipboard read/write and desktop-capture source enumeration work through the
  governed plugin adapters;
- a dummy credential can be stored, the app restarted, and the credential
  decrypted through `safeStorage`;
- Start Menu/Win32 and UWP discovery still return and launch entries;
- importing a test `.syn` file through shell association reaches the existing
  instance;
- Workspace Settings → MCP onboarding → **Test connection** succeeds and
  reports tools/resources, exercising the packaged `--mcp-stdio` re-exec path;
- update check reaches a terminal `available`, `not-available`, or actionable
  `error` state rather than hanging or crashing startup.

Any failure in this list blocks the Electron checkpoint. It is not reclassified
as a macOS/Linux issue merely because the underlying Electron breaking change
also affects other platforms.

## Updater proof and first-release boundary

The merge-time proof covers update-service unit tests, real Windows feed
metadata, and the packaged check path. A full updater transition requires two
real versions and therefore belongs to the first-release rehearsal, not a fake
unit test.

Before the first production Windows release based on Electron 43:

1. start from the last installable Electron-33-based Windows release (or a
   byte-equivalent retained candidate built by the old checkpoint);
2. expose an Electron-43 Windows candidate through an isolated scratch release
   or a local test feed assembled from real builder output;
3. verify check → available → download → downloaded → `quitAndInstall` → new
   version starts;
4. verify `latest.yml`'s URL/sha512/size against the actual NSIS asset; verify
   the adjacent `<installer>.blockmap` independently by gzip/JSON parsing and
   its `manifest.json` sha512 entry;
5. delete scratch release assets/feed state where the hosting mechanism permits
   it, and record any non-deletable attestation/release residue explicitly.

The rehearsal must not add a production code path that accepts an arbitrary
feed URL. If a local generic feed is used, alter only the disposable packaged
test output/configuration, never source defaults or a user-settable production
preference.

Failure blocks the first Electron-43 production tag but does not retroactively
invalidate a merge whose other Windows checks passed; the Electron checkpoint
can remain on `main` while the updater-specific release issue is fixed.

## Windows-only publication contract

After Checkpoint R, [`release.yml`](../../../.github/workflows/release.yml)
builds, admits, attests, and publishes only Windows x64. A successful S11 run is
therefore sufficient to authorize a Windows production tag once the updater
rehearsal also passes; no macOS/Linux validation is a prerequisite for that
Windows release.

The following invariants prevent the temporary release boundary from becoming
ambiguous:

- `release-profile.json` is the machine-readable statement of supported release
  targets for that bundle;
- the build workflow emits only the two named Windows containers;
- the gate rejects every extra `electron-*` container;
- the approved bundle and attestation contain no macOS/Linux payload;
- the generated release body tells users that the release is Windows x64 only;
- `package.json` retaining macOS/Linux local build targets does not make those
  targets supported or published.

Re-enabling macOS or Linux is not a one-line matrix edit. A future spec must add
the target to the release profile, restore its build/upload path, design its
current feed/signing validation, expand the approved bundle and release body,
and provide platform runtime evidence. Until all of those land together, the
gate must reject that platform's artifacts.

## Failure handling and rollback

- Release-profile test or scratch-gate failure at Checkpoint R: keep the current
  release pipeline unchanged and do not start either dependency upgrade.
- Dependency resolution/install failure at Checkpoint A: stop before touching
  Electron and either make a narrowly evidenced builder compatibility change or
  revert builder 26.
- Windows package creation/feed-contract failure at Checkpoint A: builder 26 is
  not accepted; do not compensate by weakening S03 or artifact expectations.
- Type/startup failure at Checkpoint B: first diagnose directly on Electron 43;
  temporarily test 38/41 only when needed to isolate the breaking interval.
- Packaged-only failure: treat `win-unpacked`/installer logs as authoritative;
  a passing `pnpm dev` is not a reason to waive it.
- MCP stdio failure: do not fall back to launching the GUI Electron process on
  piped stdin; preserve the S08 `ELECTRON_RUN_AS_NODE` architecture and repair
  compatibility at that boundary.
- Updater rehearsal failure: block the first Electron-43 tag; do not disable
  installer hash checks, blockmap parsing/manifest hashing, or S03 admission
  checks.
- Any rollback restores both `package.json` and `pnpm-lock.yaml` to the matching
  checkpoint. Hand-editing only one of them is not a rollback.

## Parked questions / follow-up work

- Reintroducing macOS publication: current-runtime certification,
  notification/signing/notarization, desktop capture, updater/feed, installer,
  release-profile, and admission-gate design.
- Reintroducing Linux publication: current-runtime Wayland/X11,
  frameless/WCO title bar, tray/hotkey, AppImage/deb, updater/feed,
  release-profile, and admission-gate design.
- Windows Authenticode certificate acquisition and real signature verification.
- Turning NSIS/MSI install/uninstall and two-version updater rehearsal into
  permanent CI. This spec requires the one-time evidence but adds permanently
  only the low-cost packaged bootstrap smoke.
- Upgrading electron-vite 3 to 5 and aligning the repository toolchain on a
  newer Node line. Neither is required by Electron 43 and combining them would
  erase the clean runtime-upgrade attribution this spec is designed to keep.
- Establishing a recurring Electron maintenance cadence so the application
  never again falls outside the latest-three-stable support window.
