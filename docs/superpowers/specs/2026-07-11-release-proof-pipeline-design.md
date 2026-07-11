# S03 — Release Proof Pipeline

> Date: 2026-07-11 · Status: draft, pending review
> Third of a four-phase, ten-spec roadmap (S01-S10), last item in Phase 1.
> Independent of S01/S02's own subject matter, but reaches back into S01's
> `eval-nightly.yml`/`eval-nightly-report.mjs` to add a machine-readable
> status artifact the release gate consumes.

## Why this is needed

Verified against the real repo, not assumed:

- **`create-release` publishes a draft from unverified inputs.** Reading
  `.github/workflows/release.yml`: `quality`/`test`/`build-electron` all
  have to pass, but nothing checks the *contents* of what
  `build-electron` produced before `create-release` globs
  `artifacts/**/*.{AppImage,deb,msi,exe,dmg,zip,blockmap}` and
  `artifacts/**/latest*.yml` straight into a draft GitHub Release. A
  draft still requires a human to click publish, but nothing today tells
  that human whether the draft is actually complete or correct.
- **The Linux leg of the build matrix has never run.** `build-electron.yml`'s
  matrix only lists `windows-latest` and `macos-latest` (twice, for
  x64/arm64) — confirmed by `grep -n "platform:"` against the file,
  three matches, none `ubuntu-latest`. The file's own "Smoke-test built
  app (Linux)" and "Upload Linux artifacts" steps are gated on
  `if: matrix.platform == 'ubuntu-latest'`, which is dead code: that
  value never appears in the matrix, so those steps have never executed
  even once. `package.json`'s `build.linux` target (AppImage + deb) is
  fully configured and `release.yml`'s file glob already expects
  `*.AppImage`/`*.deb` — the pipeline has been silently missing an
  entire platform's release artifacts.
- **`if-no-files-found: warn` lets a silent build failure through.**
  Every "Upload ... artifacts" step in `build-electron.yml` uses `warn`,
  not `error` — a matrix leg whose pack step produces zero matching
  files doesn't fail the job, it just logs a warning and `create-release`
  proceeds with whatever partial artifact set actually got uploaded.
- **Building macOS x64 and arm64 as two separate matrix jobs produces two
  colliding `latest-mac.yml` files, and this has never been exercised.**
  Confirmed against the actually-locked `electron-updater@6.8.9` source
  (`node_modules/.pnpm/.../electron-updater/out/providers/Provider.js:104-123`,
  `.../MacUpdater.js:27-34`): `getFileList()` prefers `UpdateInfo.files`
  whenever it's non-empty (falling back to the legacy top-level
  `path`/`sha512` only when `files` is absent), and `MacUpdater
  .filterFilesForArch()` picks an architecture's file by checking
  whether the URL's pathname `.includes("arm64")`. electron-builder's
  default artifact name template (no override exists for mac zip/dmg in
  this repo's config) is `"${productName}-${version}-${arch}.${ext}"`
  (`app-builder-lib/out/platformPackager.js:475`), so the x64 leg's
  `latest-mac.yml` names its file `Synapse-<version>-x64-mac.zip` and the
  arm64 leg's names its `Synapse-<version>-arm64-mac.zip` — but each leg
  writes its OWN single-arch `latest-mac.yml` under the same filename,
  and `release.yml`'s `artifacts/**/latest*.yml` glob would try to
  publish both to the same GitHub Release, which cannot hold two assets
  with the same name. **This has zero live user impact today**: `grep`
  for `updateService.check()` across `src/main` finds exactly one call
  site (`src/main/index.ts:1280-1284`), gated by
  `shouldAutoCheckOnStartup()`, which returns `false` for `darwin`
  specifically because macOS ships unsigned and Squirrel.Mac rejects
  unsigned updates — and no IPC/menu path calls `.download()`/`.install()`
  at all. Fixing the merge is about making the pipeline's *output*
  correct (a "proof pipeline" that publishes a broken feed file isn't
  proving anything) and about not leaving a landmine for whenever macOS
  signing + auto-update eventually ship, not about a bug affecting users
  today.
- **Nothing connects a release to S01's eval health signal.** A tag can
  be pushed and released regardless of whether the most recent nightly
  eval run was clean, regressed, or never configured at all — the two
  pipelines are entirely disconnected today.
- **No verifiable integrity for anything downloaded.** The only hashes
  that exist anywhere are electron-builder's own `latest*.yml` sha512
  entries, which `electron-updater` uses internally for delta-update
  integrity — nothing is published for a human who downloads an
  installer directly (not through the updater) to verify it's genuine.
- **Signing status is an unstated fact, not a declared one.** Both
  Windows and macOS code signing are fully wired in `build-electron.yml`
  but commented out — the pipeline ships unsigned binaries today with no
  release-time statement saying so.

## Guiding principle

**Don't publish what hasn't been proven.** A new `release-admission-gate`
job sits between `build-electron` and `create-release`. It is the *only*
thing standing between "artifacts exist somewhere in CI" and "a draft
release exists" — if any check fails, the job fails hard and **no draft
is created**, matching the same philosophy S01 already established for
the eval signal: an unhealthy state doesn't get to pass through silently.

**The gate produces what gets published; it doesn't just approve what
already exists.** Earlier drafts of this design had the gate validate
raw build artifacts and let `create-release` re-glob them directly — this
was scrapped because the raw artifacts *themselves* contain the
publish-breaking mac feed collision. Instead the gate assembles a single
new artifact, `release-approved-bundle`, containing the canonical
(merged, validated) feed files, the actual binaries, a signing-status
declaration, and a manifest — and `create-release` downloads and
publishes *only* that bundle. Attestation runs against the bundle's
final contents, so what gets attested is exactly what gets published,
not an intermediate/raw state.

**Fail-closed on signing status, not just informational.** "We ship
unsigned today" is an accepted, non-blocking state. "A signing
credential is configured but nothing verified the resulting binary is
actually signed" is not — that gap is exactly the kind of thing that lets
a broken signing setup ship silently. The gate's signing-status logic is
a real state machine with real failure modes, built now, even though the
credentials it reacts to don't exist yet.

## Non-goals (explicitly deferred)

- **Acquiring real code-signing certificates** (Apple Developer Program
  enrollment + notarization, a Windows Authenticode certificate) — an
  independent account/budget decision, not something this spec does.
  S03 only makes the *current* unsigned state an explicit, verified
  declaration instead of a silent fact, and builds the failure mode that
  activates automatically the day real credentials show up (§6).
- **Implementing `codesign --verify`/Windows Authenticode signature
  validation tooling.** No certificates exist to test this logic
  against, and the right tool/runner split (macOS needs a `macos-latest`
  runner for `codesign`; Windows needs either a `windows-latest` runner
  or `osslsigncode` cross-platform) depends on decisions that can't be
  made responsibly without real credentials in hand. §6 builds the
  fail-closed *state machine* around this now; the actual verification
  step is explicitly parked (§12) with a concrete trigger condition, not
  silently deferred.
- **A real `electron-updater` integration test** (spin up a built app
  against a local feed server, drive an actual check→download→install
  cycle). §10's testing section validates the feed *files* structurally —
  field completeness, version/tag/package.json agreement, sha512 actually
  matching the real artifact bytes, the mac merge's arch-filtering
  contract — which catches everything this spec's admission gate needs
  to catch, without the cost/flakiness of booting a real Electron app in
  CI for this purpose.
- **Wiring reusable-workflow `secrets:` passthrough for
  `build-electron.yml`.** `release.yml` calls `build-electron.yml` via
  `uses:` (a `workflow_call` trigger) — GitHub Actions does not
  auto-forward the caller's secrets to a called reusable workflow unless
  the callee declares `on: workflow_call: secrets: ...` and the caller
  either lists them explicitly or uses `secrets: inherit`. Neither exists
  today. This has no effect right now (no signing secrets exist to
  forward), but is a real, documented trap for whenever signing gets
  enabled — parked in §12 with the exact fix required at that time.

## §1 Architecture

```
quality ──┐
test ─────┼─→ build-electron ─→ release-admission-gate ─→ create-release
          │     (per-platform        (verify + assemble        (downloads +
          └─────  matrix build)       release-approved-bundle    publishes ONLY
                                       + attest)                  the bundle)
```

`release-admission-gate`'s `needs: [build-electron]`; `create-release`'s
`needs` gains `release-admission-gate` alongside the existing
`[quality, test, build-electron]`. The gate runs on `ubuntu-latest` (no
platform-specific tooling is needed for any of its checks today — see
§6/§12 for why real signature verification, if it existed, would change
this).

The gate is one job with several ordered steps, implemented as a single
new script, `scripts/release-admission-gate.mjs`, following the same
split S01 established in `eval-nightly-report.mjs`: pure, independently
unit-tested decision functions (version matching, artifact-manifest
matching, mac-feed merging, signing-state-machine transitions, eval-signal
validation logic) plus a thin `main()` that does the actual `gh`/file
I/O and calls those functions with already-fetched data. Same
`if (process.argv[1] === fileURLToPath(import.meta.url)) main()` guard so
the test file can import the pure functions without triggering real I/O.

The sections below (§2-§6) are organized by *concern*, not by the gate's
actual runtime order — §3 checks the canonical merged `latest-mac.yml`
that §5 produces, so §5 has to run first. Real execution order inside
`main()`: §4 (artifact identity — nothing downstream can proceed without
knowing the raw files are the right ones) → §5 (mac merge, produces the
canonical feed) → §3 (version consistency, now checking canonical feeds)
→ §2 (eval-signal — independent of the artifacts, can run any time, but
checked before assembly so a failure here doesn't waste time building a
bundle that won't ship) → §6 (signing declaration — independent,
computed last since it only needs the two boolean env values) → §8
(bundle assembly, only once 2-6 all passed) → §7 (attestation, against
the finished bundle).

## §2 S01 eval-signal verification

The `eval-nightly-status` GitHub issue is a human-facing projection —
its body is emoji-and-prose, and its `updatedAt` can be changed by any
edit (including a manual one), so neither is trustworthy as a release
gate's evidence on its own. Two changes to S01's own files, plus new gate
logic:

**`eval-nightly.yml`** gains a step that uploads a new named artifact,
`eval-nightly-status-json`, containing:

```json
{
  "schemaVersion": 1,
  "state": "clean",
  "runId": "<github.run_id>",
  "headSha": "<github.sha>",
  "completedAt": "<ISO 8601 timestamp>"
}
```

**`eval-nightly-report.mjs`**'s `main()` writes this file right after
computing `renderStatus()`'s result — `state` is the same value already
computed, not re-derived.

**Gate verification, in order** (verified against real `gh` output —
`gh run view <id> --json headSha,...` and `gh run list
--workflow=eval-nightly.yml --json databaseId,headSha,status,createdAt`
both confirmed working and exposing exactly these fields against this
repo's real run history):

1. `gh run list --workflow=eval-nightly.yml --json
   databaseId,headSha,status,createdAt --limit 5`, take the most recent
   entry with `status: "completed"`.
2. `gh run download <that databaseId> -n eval-nightly-status-json -D
   <tmpdir>` — pinned to a specific, immutable run, not "whatever the
   latest artifact happens to be."
3. `gh issue list --label eval-nightly-status --state open --json
   number,title,body`: must return **exactly one** issue; its title must
   be `"Eval Nightly Status"`; the run ID is extracted from its body via
   `/\/actions\/runs\/(\d+)/` (matching the exact URL shape
   `eval-nightly-report.mjs` already constructs:
   `${{ github.server_url }}/${{ github.repository }}/actions/runs/${{
   github.run_id }}`) and must equal the run ID found in step 1. (Catches
   the reporter script itself being broken — a newer clean run existing
   that the issue never got updated to reflect is itself a signal
   something is wrong with the pipeline, not something to silently work
   around.)
4. Parse the downloaded JSON and validate its shape before trusting any
   field: `schemaVersion === 1`; `completedAt` parses as a valid ISO 8601
   timestamp; `completedAt` is not in the future beyond a small clock-skew
   tolerance (5 minutes — protects against a malformed or malicious
   future-dated timestamp making a stale run look fresh under check 8).
5. `gh run view <databaseId> --json headSha,conclusion` — cross-check
   GitHub's own authoritative run record against the JSON's *self-reported*
   `runId`/`headSha` fields: the JSON's `runId` must equal `databaseId`
   (the run it was actually downloaded from, not just whatever the file
   happens to claim), and the JSON's `headSha` must equal this same `gh
   run view` call's `headSha`. A JSON artifact's own content is written by
   a script, not GitHub itself — cross-checking it against GitHub's
   independent record is what makes the identity check meaningful rather
   than trusting a file to accurately describe itself.
6. `conclusion !== "success"` → fail. Belt-and-suspenders alongside
   `status: "completed"` from step 1: S01's own design keeps the job
   green even through a real eval regression (`continue-on-error`), so
   this doesn't duplicate check 7's `state` check — it catches the
   different failure mode of the *pipeline itself* breaking (the JSON
   upload step failing outright, infrastructure failures) independent of
   whether the eval scores looked clean.
7. `state !== "clean"` → fail.
8. `headSha !== <the commit actually being released>` → fail. This is
   the anti-TOCTOU check: a "clean" result within the staleness window
   could otherwise be for a different, earlier commit than the one being
   released — new code landed on `main` after the last nightly run,
   immediately tagged, never actually evaluated. "The commit actually
   being released" is **not** read as the raw `github.sha` context
   value alone — after `actions/checkout@v7` has checked out the tag,
   the gate also runs `git rev-parse HEAD` and asserts it equals
   `github.sha`, using that (cross-checked) value as the authoritative
   comparison target. This avoids depending on an assumption about
   whether `github.sha` dereferences an *annotated* tag object to its
   target commit identically to how it resolves a *lightweight* tag —
   `git rev-parse HEAD` on an actual checkout is unambiguous either way,
   and the assertion against `github.sha` still catches the (separate,
   real) case where the two legitimately disagree.
9. `completedAt` older than 48 hours (nightly runs daily at 07:00 UTC;
   48h tolerates one missed day) → fail. Independent from check 8: a SHA
   match only proves *that exact commit* was once evaluated, not
   *recently* — an old commit resurrected via a late tag on a stale
   branch would pass check 8 but should still fail here.
10. On failure from 8 or 9, the gate's error message names the exact
    fix: `gh workflow run eval-nightly.yml --ref <tag>`, then retry the
    release once that run completes clean.

## §3 Version consistency

Every feed file the build produced — `latest.yml`, `latest-linux.yml`,
and the canonical merged `latest-mac.yml` (§5) — gets parsed, and each
one's `version` field must equal both the tag (stripped of a leading `v`)
and `package.json`'s `version`. This does not rely on "electron-builder
derives the feed version from package.json, so they must already agree"
— that reasoning proves nothing about a matrix leg that silently built
from the wrong commit (a stale checkout, a caching bug) while still
producing a structurally complete, correctly-named output. Each
installer's own filename (`Synapse-Setup-<version>.exe`, etc.) is also
regex-checked against the expected version, since the check is already
parsing these files and the extra assertion is free.

## §4 Artifact identity and cardinality

**The download must be scoped to `electron-*` artifacts, not every
artifact the run produced.** `release.yml`'s `test` job calls
`test.yml` as a reusable workflow — confirmed by reading `test.yml`
directly: it uploads `test-results` and `coverage-report` via
`actions/upload-artifact@v7` with `if: always()`
(`test.yml:112-124`). Both become part of the same overall `release.yml`
run's artifact set. An unscoped `download-artifact@v8` call (no `name`/
`pattern` filter) would pull these in alongside the `build-electron`
containers, and a manifest that rejects "any container not in this
table" would then reject *every single release attempt* on artifacts
that were never release candidates in the first place — this isn't a
hypothetical edge case, it's the gate's default, permanent, un-passable
state as originally specced. The download step:

```yaml
- uses: actions/download-artifact@v8
  with:
    pattern: electron-*
    merge-multiple: false
    path: artifacts/
```

(`pattern`/`merge-multiple` confirmed as real, documented inputs of
`download-artifact@v8` via its current README.) Only the `electron-*`
containers are ever visible to the manifest check below — `test-results`/
`coverage-report` are simply never downloaded, not filtered out after
the fact.

`path: artifacts/` downloads each named GitHub Actions artifact into its
own subdirectory — the gate uses this directly rather than globbing
extensions across the whole tree. A manifest maps each expected artifact
container name to its exact expected file set:

| Container | Expected files |
| --- | --- |
| `electron-windows-x64-nsis` | one `*.exe`, one `*.blockmap`, one `latest.yml` |
| `electron-windows-x64-msi` | one `*.msi` |
| `electron-macos-x64-zip` | one `*-x64-mac.zip`, one `*.blockmap`, one `latest-mac.yml` |
| `electron-macos-arm64-zip` | one `*-arm64-mac.zip`, one `*.blockmap`, one `latest-mac.yml` |
| `electron-macos-x64-dmg` | one `*.dmg` |
| `electron-macos-arm64-dmg` | one `*.dmg` |
| `electron-linux-x64-appimage` | one `*.AppImage`, one `latest-linux.yml` |
| `electron-linux-x64-deb` | one `*.deb` |

Any container missing, any container present with the wrong count, any
file inside a container not matching its expected pattern, or any
container appearing that isn't in this table at all → fail. This
directly replaces "does at least one `.zip` exist somewhere" with "does
exactly the right file exist in exactly the right named container,"
closing the gap where a wrong-count, misnamed, or unexpected extra file
could slip through a looser check.

## §5 macOS feed merge

Verified against the locked `electron-updater@6.8.9` source, not an
arbitrary convention:

- `getFileList()` (`providers/Provider.js:104-123`) uses `UpdateInfo
  .files` whenever it's non-empty, and only falls back to the legacy
  top-level `path`/`sha512` fields when `files` is absent. A merged
  `files` array is authoritative; the legacy fields are inert as long as
  `files` is present.
- `MacUpdater.filterFilesForArch()` (`MacUpdater.js:27-34`) selects an
  architecture's file by checking `file.url.pathname.includes("arm64")`
  — arm64 Macs prefer arm64-tagged files when present, x64 Macs exclude
  them.
- electron-builder's default artifact name template (no override exists
  for mac zip/dmg in `package.json`'s `build` config) is
  `"${productName}-${version}-${arch}.${ext}"`
  (`app-builder-lib/platformPackager.js:475`), so the two matrix legs'
  real output filenames are `Synapse-<version>-x64-mac.zip` and
  `Synapse-<version>-arm64-mac.zip` — the arm64 filename reliably
  contains the substring `"arm64"` and the x64 filename reliably does
  not.

**Pre-merge, each leg's raw `latest-mac.yml` independently:**

- `files` contains **exactly one** entry — not zero, not multiple.
- That entry's `url`'s basename equals the actual `.zip` filename present
  in this same artifact container (§4) — catches a feed referencing a
  different filename than what was actually uploaded.
- `sha512` matches the real `.zip` file's bytes.
- `size` matches the real `.zip` file's byte size.
- `blockMapSize`, if the field is present, matches the real `.blockmap`
  file's byte size.

**Post-merge, on the combined result:**

- Exactly two entries in the final `files` array — not more, not fewer.
- Both URLs unique (a collision here means the per-leg naming assumption
  broke, and the merge fails loudly rather than silently dropping an
  entry).
- Exactly one entry's URL contains `"arm64"`, exactly one does not (a
  locked contract test in §10 — not a re-implementation of this check,
  see §10 — pins this assumption against the actual installed
  `electron-updater` version, so a future dependency bump that changes
  `filterFilesForArch`'s matching logic gets caught by CI rather than
  discovered live).
- The legacy top-level `path`/`sha512` fields are set by copying the x64
  entry, and are asserted to be pair-consistent with it (the `path`'s
  basename and the `sha512` value both correspond to the same chosen
  entry — trivially true if the copy is implemented correctly, but
  worth asserting explicitly rather than assuming). This convention is
  arbitrary but consistent, and inert per the `getFileList()` behavior
  above — documented here as "verified against locked source, not yet
  validated via a packaged macOS updater E2E," since no live macOS
  update path exists to test against today per the "Why this is needed"
  section.

Any failure in either phase excludes the release the same way every
other gate check does — no partial or best-effort merge.

## §6 Signing status — a real, fail-closed state machine

The gate reads two booleans, forwarded from the workflow's `env:` block
the same way S01's `key-check` step forwards `EVAL_JUDGE_KEY`
configuration:

```yaml
env:
  APPLE_CERT_CONFIGURED: ${{ secrets.APPLE_CERTIFICATE != '' }}
  WINDOWS_CERT_CONFIGURED: ${{ secrets.WINDOWS_CERTIFICATE != '' }}
```

For each platform, the gate computes a `verification` result. Today this
is hardcoded to `"not-performed"` — no tool exists yet to produce
`"verified"` or `"failed"` (§12 parks that tooling explicitly). The
combination of `credentialsConfigured` and `verification` drives a strict
table, decided now specifically so nothing about it needs to change when
real verification tooling eventually lands:

| `credentialsConfigured` | `verification` | Gate result |
| --- | --- | --- |
| `false` | `not-performed` | **pass** — declare `unsigned-unverified` |
| `true` | `verified` | **pass** — declare `signed-and-verified` |
| `true` | `not-performed` | **fail** |
| `true` | `failed` | **fail** |
| `false` | `verified` | **fail** (contradictory state — shouldn't be reachable, defensive check) |

This closes the exact gap a looser "just report whatever the secret flag
says" design would leave open: the day someone adds a real signing
secret without also wiring up the verification step, the very next
release attempt fails hard instead of silently shipping something that
*looks* configured but was never actually checked.

The declaration written into the approved bundle as `signing-status.json`,
at the point in §8's step sequence *before* attestation has run:

```json
{
  "schemaVersion": 1,
  "platformCodeSigning": {
    "windows": {
      "credentialsConfigured": false,
      "verification": "not-performed",
      "releaseClaim": "unsigned-unverified"
    },
    "macos": {
      "credentialsConfigured": false,
      "verification": "not-performed",
      "releaseClaim": "unsigned-unverified"
    }
  },
  "githubArtifactAttestation": {
    "required": true
  }
}
```

**`githubArtifactAttestation` never claims `"status": "verified"` inside
this file.** `actions/attest@v4` *creates* an attestation — it doesn't
verify one, and more to the point, this JSON is written in §8 step 2,
before step 4 (where attestation actually runs) has executed at all — a
file cannot truthfully assert the outcome of a step that hasn't happened
yet when the file was written. `signing-status.json` only ever states
that attestation is `required` (a fixed, load-bearing declaration of
intent this pipeline makes for every release); the *actual* outcome is
expressed entirely outside this file — by `actions/attest@v4`'s own
step succeeding or failing (a failure is a gate failure, §8 step 4), and
by the real `attestation-url` it produces, captured into
`release-body.md` in step 5. A reader verifying a release checks the
attestation itself (`gh attestation verify`), not a self-report inside
a file the attestation covers.

`unsigned-unverified`'s precise meaning, stated in the release notes
verbatim rather than left to interpretation: *"CI has neither a
configured platform code-signing credential nor has it performed a
platform signature verification on this artifact."* Not "verified
unsigned" — the absence of a credential doesn't prove the binary carries
no signature by some other means, so the claim only asserts what CI
actually did (nothing), not a conclusion about the binary itself.

`githubArtifactAttestation` is a **separate** top-level field from
`platformCodeSigning` — a successful GitHub build-provenance attestation
(§7) proves "this came from this repository's CI run," a materially
different guarantee from "this binary is signed by an OS-recognized
identity," and the two must never be collapsed into one status.

## §7 GitHub artifact attestation

**`actions/attest@v4`, not `attest-build-provenance`.** Confirmed by
fetching the real, current READMEs of both
(`gh api repos/actions/attest-build-provenance/readme` and
`repos/actions/attest/readme`): *"As of version 4,
`actions/attest-build-provenance` is simply a wrapper on top of
`actions/attest`. Existing applications may continue to use the
`attest-build-provenance` action, but new implementations should use
`actions/attest` instead."* This spec targets `actions/attest` directly.

`actions/attest`'s own README states its required permissions
explicitly:

```yaml
permissions:
  id-token: write
  attestations: write
  artifact-metadata: write
```

The `release-admission-gate` job's full permissions block combines these
with what the gate's other steps need (§2's `gh run`/`gh issue` calls,
checkout):

```yaml
permissions:
  contents: read
  actions: read
  issues: read
  id-token: write
  attestations: write
  artifact-metadata: write
```

`subject-path` accepts a glob or a list of paths in one call (confirmed:
*"May contain a glob pattern or list of paths (total subject count
cannot exceed 1024)"*) — the bundle's file count is nowhere close to that
limit, so one `actions/attest` step covers every file in `assets/` (§8)
at once. Its `attestation-url` output ("URL for the attestation summary")
gets captured and written into `release-body.md` (§8) — this is the
concrete mechanism that makes §6's "verbatim in the release notes" claim
actually true, rather than an assertion with no corresponding
implementation step.

No secrets required (OIDC-based Sigstore signing). No separate
attestation file needs to be uploaded as a release asset — a user who
downloads a released binary verifies it directly with
`gh attestation verify <file> --owner sunzrnobug`, since GitHub's
attestation store is keyed by the artifact's digest and repository
owner, not by the release itself.

## §8 The approved bundle and `create-release` changes

**Bundle layout** — split so `create-release` never has to guess which
files are publishable release assets and which are gate-internal
bookkeeping:

```
release-approved-bundle/
├─ assets/                 # the ONLY directory create-release uploads
│  ├─ Synapse-Setup-<version>.exe
│  ├─ Synapse-<version>.msi
│  ├─ *.blockmap
│  ├─ latest.yml / latest-linux.yml / latest-mac.yml (merged)
│  ├─ *.AppImage / *.deb / *.dmg / *.zip
│  ├─ manifest.json         # excludes its own hash — see step 3
│  └─ signing-status.json   # §6
└─ release-body.md          # used as body_path — never uploaded as an asset
```

**The gate's steps, after §2-§6's checks all pass** (real execution
order — attestation runs against local runner-filesystem files *before*
`release-approved-bundle` is uploaded as its own artifact, not after;
`actions/attest`'s `subject-path` reads local files, it has no notion of
an already-uploaded GitHub Actions artifact):

1. Copy every binary from the raw per-container artifact directories,
   plus the merged `latest-mac.yml` (§5) and the untouched
   `latest.yml`/`latest-linux.yml`, into `release-approved-bundle/assets/`.
2. Write `assets/signing-status.json` (§6).
3. Two separate, independent invariants — not one blanket rule, because
   not every file in `assets/` has a feed-file counterpart to check
   against:

   - **`assets/manifest.json`** covers **every** other file in `assets/`
     (the installers, blockmaps, feed files, `signing-status.json`)
     with its sha512, recomputed from the actual bytes. It excludes its
     own hash (a file cannot correctly contain the hash of itself). This
     is the complete, unconditional inventory — every file that exists
     must appear here, full stop.
   - **The feed verifier** (already run in §5's pre-merge phase for the
     mac zips, and equivalently applied here to the Windows NSIS `.exe`
     and the Linux `.AppImage` — the only other two files any
     `latest*.yml` actually references) checks that each of those
     specific files' real `sha512`/`size` match what their feed entry
     claims.
   - **Everything else** — the MSI, the DMG, the `.deb`, every
     `.blockmap`, `signing-status.json` — has **no** feed-file
     counterpart at all: electron-updater's feed files only ever
     describe the one artifact each platform's auto-updater actually
     fetches (the NSIS installer, the mac zip, the AppImage), never the
     direct-download-only formats or the blockmap's own hash. These
     files' only requirements are: present in `manifest.json`, hash
     matches real bytes (which `manifest.json`'s own construction
     already guarantees, since it's computed from those same bytes), and
     covered by attestation (§7, which globs everything in `assets/`
     regardless of feed-file status). Requiring a feed-file match for
     files no feed file ever mentions is not a stricter check — it's an
     unsatisfiable one that would fail every release.
4. Run `actions/attest@v4` with `subject-path: release-approved-bundle/assets/*`
   against the finished `assets/` directory. Confirm the step succeeds
   before proceeding — an attestation failure here is a gate failure,
   same as any other check.
5. Write `release-body.md`: the platform signing declaration (§6, the
   verbatim `unsigned-unverified`/`signed-and-verified` sentence per
   platform), the attestation URL (step 4's `attestation-url` output),
   the exact `gh attestation verify <file> --owner sunzrnobug` command a
   user should run, and a one-line pointer to `manifest.json` for
   offline hash verification.
6. Upload `release-approved-bundle` (both `assets/` and `release-body.md`)
   as a single new named GitHub Actions artifact.

**`create-release` changes:**

- Downloads *only* the `release-approved-bundle` artifact (not the raw
  per-leg artifacts `actions/download-artifact@v8` currently pulls with
  no `name:` filter).
- Re-runs the same manifest-hash verification function from step 3
  (imported from `release-admission-gate.mjs`, not reimplemented) against
  the freshly-downloaded `assets/`, before publishing anything — defense
  in depth against corruption or tampering in the artifact upload/download
  round-trip. A mismatch here fails the job with no release created,
  exactly like a gate failure. This re-check also asserts **set
  equality** between `manifest.json`'s listed files and the actual files
  present in `assets/` (excluding `manifest.json` itself) — not just that
  every *listed* file's hash matches, but that no *unlisted* file is
  present either. Without this, a file added to `assets/` after
  `manifest.json` was written (a bug, or a bundle-assembly step added
  later without updating step 3) would still get published via the
  `assets/*` glob despite never having been hashed, inventoried, or
  covered by this specific check — the file would still be inside the
  `attestation`'s subject-path glob and thus still attested, but silently
  absent from the human/machine-readable manifest a user might rely on.
- `softprops/action-gh-release`'s `files:` glob narrows from the current
  `artifacts/**/*.{AppImage,deb,msi,exe,dmg,zip,blockmap}` /
  `artifacts/**/latest*.yml` to `release-approved-bundle/assets/*` —
  it can no longer accidentally re-encounter the raw per-leg mac feed
  collision, because it never sees the raw per-leg artifacts at all —
  and gains `body_path: release-approved-bundle/release-body.md` (step
  5's content; confirmed via the real README that when
  `generate_release_notes: true` is also set, "the body will be
  pre-pended to the automatically generated notes," not overwritten by
  them) plus `fail_on_unmatched_files: true` (confirmed real input:
  "Indicator of whether to fail if any of the `files` globs match
  nothing" — the corresponding gap in `if-no-files-found: warn`'s
  original per-glob looseness, §9, applied here too).

## §9 CI fixes bundled into this spec

- **Linux added to the build matrix**: `build-electron.yml` gains
  `- platform: ubuntu-latest, arch: x64, build_flag: --linux` — this
  activates the already-written (but never-executed) Linux smoke-test
  and artifact-upload steps without changing them.
- **`if-no-files-found: warn` → `error`** on all six upload-artifact
  steps. Scoped honestly: this only fails a step when its *entire*
  combined glob resolves to zero files — if `*.exe` matches one file but
  `latest.yml` (bundled in the same `path:` block) matches zero, the
  step still succeeds under `error` just as it would under `warn`. This
  is a fast, free "did this leg produce literally nothing" tripwire, not
  a substitute for §4's manifest check, which is the actual source of
  per-file completeness proof.

## §10 Testing

**Pure functions, keyless unit tests** (`scripts/release-admission-gate.test.mjs`):
version-matching logic; the artifact-manifest matcher (missing container,
wrong count, unexpected container, wrong filename pattern — one test
each); the mac-feed-merge function (valid pair merges correctly; a URL
collision fails; an arm64 entry without `"arm64"` in its URL fails; the
version-mismatch-between-legs case fails); the signing state-machine
table (all five rows from §6, one test each); the eval-signal decision
logic (state !== clean, headSha mismatch, staleness, issue-count !== 1,
issue title mismatch, issue-referenced-run !== newest-run — each as an
isolated case against a hand-built fake `gh`-shaped input, not a real
`gh` call).

**Contract test pinning current `electron-updater` behavior**: a small
test that `import { MacUpdater } from "electron-updater"` and calls
`MacUpdater.filterFilesForArch(...)` **directly** — confirmed real and
importable this way, since `electron-updater`'s package entry
(`out/main.js`) re-exports `MacUpdater` from `./MacUpdater`. This must
call the actual, installed dependency's real function — not a
re-implementation of its matching logic against the same fixture shape.
The distinction matters precisely because it's the whole point of the
test: a re-implementation only proves the *test's own copy* of the logic
behaves as expected, and would keep passing unchanged even if a future
`electron-updater` version bump changed the real `filterFilesForArch`'s
actual matching behavior — silently defeating the "dependency bump
guard" this test exists to be. Given the merged `files` array this
spec's merge function produces, assert an arm64-simulated environment
resolves to the arm64 entry and an x64-simulated environment resolves to
the x64 entry, calling the real, imported function both times.

**Manual verification** (requires real GitHub Actions + repo write
access, adapted from S01's Task 8 pattern — higher stakes here since a
real tag push fires the real release pipeline):

1. On a disposable branch (not `main`), create one commit that bumps
   `package.json`'s `version` to a scratch value (e.g.
   `0.0.0-s03-test.1` — deliberately identifiable as this spec's own
   verification artifact, not a plausible-looking real version) and
   push it.
2. `gh workflow run eval-nightly.yml --ref <scratch-branch>`, wait for
   completion, confirm it's clean — this is required *before* the
   success-path test, since the scratch commit has never been evaluated
   and §2's SHA-match check would otherwise fail it.
3. Tag that commit `v0.0.0-s03-test.1` **as an annotated tag**
   (`git tag -a v0.0.0-s03-test.1 -m "S03 pipeline verification"`, not a
   lightweight tag) and push it — this specifically exercises §2 check
   8's `git rev-parse HEAD`-based SHA comparison against an annotated
   tag object, the case that motivated not trusting `github.sha` alone.
   Confirm: the gate passes, `release-approved-bundle` is produced with
   a correctly merged `latest-mac.yml`, and a draft release is created
   with all expected platforms present (including Linux, confirming
   §9's matrix fix actually works), the `unsigned-unverified`
   declaration in its body, and a real, working attestation URL.
   - **Run the real `actions/attest@v4` step — do not skip it.** §8
     defines attestation as a mandatory, gate-blocking step; a test
     pass that skips it isn't exercising the real pipeline, and
     `release-body.md`'s generation (step 5) has nothing to reference
     without a real `attestation-url`. `gh attestation` has no
     delete/revoke subcommand (confirmed via `gh attestation --help`),
     so this test run's attestation permanently exists in the repo's
     attestation record with no clean-up path — accepted deliberately,
     not worked around: an attestation is an append-only provenance
     record by design ("this artifact really was produced by this
     workflow run" stays true forever, including for a test run), and a
     bypass mechanism that skips a mandatory security check for
     "test-labeled" tags is itself a real gate-bypass surface — even if
     nominally scoped to test-looking tags, a draft release produced
     through a bypassed check could still be manually published. The
     `0.0.0-s03-test.1` version string, `release-body.md`'s content
     (labeled "S03 pipeline verification artifact" — an explicit
     addition to step 5's generation logic when the version matches a
     recognizable test pattern is *not* required; simply noting the
     purpose by hand in this manual verification's own record is
     sufficient), and this test's resulting `attestation-url` (recorded
     in the implementation PR's description) are what keep this
     specific attestation identifiable as a test artifact after the
     fact, not any pipeline-level special-casing.
4. On a second disposable commit, deliberately leave `package.json`'s
   version mismatched with the tag about to be pushed. Push that tag.
   Confirm: the gate fails hard on the version-consistency check, no
   `release-approved-bundle` and no draft release are created.
5. Cleanup: `git push --delete origin v0.0.0-s03-test.1
   <second-scratch-tag>`, delete the draft release(s) via
   `gh release delete`, delete the scratch branch. The attestation
   record from step 3 is **not** deleted (it can't be, and shouldn't be
   — see step 3).
6. **`gh workflow run eval-nightly.yml --ref main`, wait for completion,
   confirm the `eval-nightly-status` issue now points at *this* run
   (its linked run URL's ID matches, per §2 check 3) before considering
   verification complete.** Required, not optional cleanup:
   `gh run list --workflow=eval-nightly.yml` sorts by recency across
   *all* branches, not just `main` — step 2's scratch-branch run would
   otherwise remain the "most recent completed" entry §2 step 1 finds,
   and the very next real release attempt would compare a real tag's
   `main` commit against that scratch run's `headSha`, fail the
   anti-TOCTOU check, and block a legitimate release with no actual
   problem in the code being released.

## §11 Completion criteria

- `release-admission-gate` job exists, wired between `build-electron`
  and `create-release`, hard-fails on any check in §2-§6.
- `eval-nightly.yml`/`eval-nightly-report.mjs` produce and upload
  `eval-nightly-status-json`.
- Linux is a real leg of `build-electron.yml`'s matrix; its
  previously-dead smoke-test/upload steps run for real.
- `create-release` consumes only `release-approved-bundle`, never the
  raw per-leg artifacts, and re-verifies the manifest (hash match *and*
  file-set equality) after its own download before publishing anything.
- `download-artifact@v8` in `release-admission-gate` is scoped to
  `pattern: electron-*`, and never encounters `test.yml`'s
  `test-results`/`coverage-report` artifacts.
- A real `v0.0.0-s03-test.1`-style manual verification pass (§10) has
  been run — including a real, un-skipped `actions/attest@v4` run
  against an *annotated* scratch tag — and both its success and failure
  paths confirmed, with cleanup completed (including re-running
  `eval-nightly.yml` on `main` and confirming the status issue points
  back to it) and documented in the implementation PR, including the
  test run's own `attestation-url`.
- All pure decision logic (§10) has unit test coverage, including the
  full signing state-machine table and the mac-merge arch-filtering
  contract test (calling the real, imported `MacUpdater
  .filterFilesForArch`, not a re-implementation of it).

## §12 Parked questions (surfaced, not solved)

- **Real platform signature verification tooling** (`codesign --verify`
  for macOS, Authenticode verification for Windows). Trigger for
  revisiting: the day real signing credentials are added to the repo.
  At that point this spec's §6 state machine already guarantees the
  release pipeline fails until the verification step is implemented and
  wired to actually flip `verification` to `"verified"` — so this isn't
  a silent gap, but it does require a follow-up spec addendum to decide
  the tool/runner split once real credentials exist to test against.
- **Reusable-workflow secrets passthrough for `build-electron.yml`**.
  When signing is enabled, `build-electron.yml`'s `on: workflow_call:`
  needs an explicit `secrets:` block, and `release.yml`'s `build-electron`
  job needs to either list them explicitly or add `secrets: inherit` —
  without this, the gate would see `credentialsConfigured: true` (the
  secret exists on the repo) while the actual `electron-builder` step
  never received it, silently producing an unsigned binary despite the
  gate believing signing was configured. Must be fixed in the same PR
  that first enables real signing, not discovered after the fact.
- **The mac merge's legacy `path`/`sha512` = "copy the x64 entry"
  convention** — verified as inert against the currently-locked
  `electron-updater` source (§5), but never exercised against a live,
  signed, auto-updating macOS install. Revisit once macOS signing +
  auto-update actually ship.
- **A per-plugin/per-artifact softer degrade path** — not applicable
  here; unlike S02's schema budgets, every check in this spec has a
  concrete, actionable fix (re-run eval, fix the version, wait for the
  right artifacts) rather than a size/complexity trade-off, so there's
  no analogous "maybe too strict" concern to park.
