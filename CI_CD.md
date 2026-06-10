# CI/CD

This repo is built around GitHub Actions and local pnpm checks.

## Local checks

```bash
pnpm lint
pnpm typecheck
pnpm typecheck:native
pnpm test
pnpm build
pnpm electron:build
```

## What CI should enforce

- formatting and linting
- TypeScript type safety
- workspace SDK build output generated during CI (the SDK `dist/` is not committed)
- unit tests
- desktop build smoke checks

## Release flow

Releases are triggered by Git tags, not by release branches.

The release workflow runs when a tag matching `v*` is pushed:

```text
v0.3.0
v1.0.0
v1.2.3-beta.1
```

Recommended release steps:

1. Make sure `main` is green and contains the code to release.
2. Create a release pull request that updates `package.json` version.
3. Merge the release pull request into `main`.
4. Pull the latest `main` locally.
5. Create and push an annotated tag.

Example:

```bash
git switch main
git pull
git tag -a v0.3.0 -m "v0.3.0"
git push origin v0.3.0
```

After the tag is pushed, GitHub Actions will:

1. run quality checks
2. run tests
3. build Electron artifacts
4. create a draft GitHub Release

Review the draft release on GitHub, check the generated notes and artifacts, then publish it manually.

Do not create `v0.3.0` as a branch. Version-like names are reserved for tags.

### Cutting a release — step-by-step checklist

Replace `X.Y.Z` with the new version throughout. The tag must be `vX.Y.Z` and must match
`package.json`'s `version`.

**1. Pre-flight (on `main`)**

- [ ] `main` is green: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
- [ ] If the AI layer changed, the AI smoke checklist in [TESTING.md](TESTING.md) passed.
- [ ] `package.json` `version` is bumped to `X.Y.Z` (via a release PR) and merged to `main`.
- [ ] Locally: `git switch main && git pull`, working tree clean.

**2. Tag and build**

- [ ] Tag and push (see the example below).
- [ ] The **Release** workflow run for the tag is green (quality → test → build-electron →
      create-release).

```bash
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

**3. Review and publish the draft**

- [ ] Open the **draft** GitHub Release. Confirm the generated notes look right.
- [ ] Confirm the assets per platform. Windows/Linux need the installers **and** the
      electron-updater feed metadata; macOS ships plain downloads (auto-update is disabled):
  - Windows: `*.exe`, `*.exe.blockmap`, `latest.yml`
  - Linux: `*.AppImage`, `*.deb`, `latest-linux.yml`
  - macOS: `*.dmg`, `*.zip` (no feed metadata required)
- [ ] **Publish** the release (remove draft). Auto-update only reads **published** releases, so it
      stays invisible to users until this step.

**4. Post-publish verification**

- [ ] Download the installer for your platform onto a clean machine and confirm the app launches
      (Windows: dismiss the SmartScreen prompt; macOS: right-click → Open to clear Gatekeeper).
- [ ] **Auto-update upgrade smoke (Windows/Linux)**: with the _previous_ version installed and
      running, confirm it shows the update banner → **Download** → **Restart to update** → relaunches
      on `X.Y.Z`. (Easiest to verify on the release _after_ the first one that shipped the feed
      metadata. macOS has no auto-update, so there is nothing to verify there.)

**Rollback**

- [ ] If a release is bad, **unpublish or delete it** (including its `latest*.yml`) so the updater
      stops offering it, then ship a fixed, higher version. electron-updater never moves users
      backwards, so you cannot "downgrade" via a lower tag — always roll forward.

## Auto-update (electron-updater)

The app checks for updates on startup and surfaces an in-app banner: the user clicks **Download**,
then **Restart to update**. It never restarts itself. The flow lives in
[src/main/updates/update-service.ts](src/main/updates/update-service.ts) (state machine, unit-tested),
wired to electron-updater in [src/main/index.ts](src/main/index.ts) and shown by
[update-banner.tsx](src/renderer/src/components/update-banner.tsx).

**Auto-update runs on packaged Windows and Linux only.** macOS is shipped unsigned (see below) and
Squirrel.Mac rejects unsigned update packages, so the startup check is skipped on macOS
(`shouldAutoCheckOnStartup`) — the banner never appears there rather than promising an update that
cannot install. macOS users update by downloading a newer release manually.

The update feed is the project's **GitHub Releases** (configured under `build.publish` in
`package.json`). For the updater to find a new version, the GitHub Release must contain the
electron-builder metadata files alongside the installers:

- Windows: `latest.yml`, `*.exe`, `*.exe.blockmap`
- Linux: `latest-linux.yml`, `*.AppImage`

(macOS metadata is not required while macOS auto-update is disabled; the `.dmg`/`.zip` are shipped as
plain downloads.)

The release workflow already uploads these (see `build-electron.yml` and the `files:` list in
`release.yml`).

> electron-updater reads from **published** (non-draft) releases. The release is created as a draft,
> so updates only roll out once you publish it. To test an upgrade: ship `v0.3.0`, install it, then
> publish `v0.3.1` and confirm the running `v0.3.0` shows the update banner.

## Code signing

**Current policy: ship unsigned.** No code-signing certificate is configured, so builds are unsigned.
What that means per platform:

- **Windows**: the unsigned NSIS installer runs, but SmartScreen shows a "Windows protected your PC /
  unknown publisher" prompt on first install — the user clicks **More info → Run anyway**. In-app
  auto-update still works (it just inherits the same SmartScreen prompt).
- **Linux**: unaffected — AppImage/deb don't rely on signing. Auto-update works.
- **macOS**: distribute to **technical users only**. Gatekeeper blocks the unsigned app; the user
  bypasses it once, per build:
  - right-click the app → **Open** → **Open** in the dialog, or
  - run `xattr -dr com.apple.quarantine /Applications/Synapse.app`.
  - **Do not promise macOS auto-update** — it is disabled (see above). macOS users re-download to
    upgrade.

### Enabling signing later (optional)

electron-builder reads signing material from environment variables, so signing is opt-in: populate
the (currently commented) `env:` block on the "Build Electron app" step in `build-electron.yml` from
repository secrets.

- **Windows**: `CSC_LINK` (base64 `.pfx`) + `CSC_KEY_PASSWORD`. Removes the SmartScreen prompt.
- **macOS**: `CSC_LINK`/`CSC_KEY_PASSWORD` (or `APPLE_*` for an Apple Developer ID) plus
  notarization (`APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`). A valid Developer ID signature is
  **required** before macOS auto-update can be re-enabled — once signing is in place, drop the macOS
  guard in `shouldAutoCheckOnStartup`.

## Notes

- The docs site in `docs/` is its own workspace package.
