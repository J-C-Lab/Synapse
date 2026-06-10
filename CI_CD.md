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

## Auto-update (electron-updater)

The app checks for updates on startup (packaged builds only) and surfaces an in-app banner:
the user clicks **Download**, then **Restart to update**. It never restarts itself. The flow lives in
[src/main/updates/update-service.ts](src/main/updates/update-service.ts) (state machine, unit-tested),
wired to electron-updater in [src/main/index.ts](src/main/index.ts) and shown by
[update-banner.tsx](src/renderer/src/components/update-banner.tsx).

The update feed is the project's **GitHub Releases** (configured under `build.publish` in
`package.json`). For the updater to find a new version, the GitHub Release must contain the
electron-builder metadata files alongside the installers:

- Windows: `latest.yml`, `*.exe`, `*.exe.blockmap`
- macOS: `latest-mac.yml`, `*.zip`, `*.zip.blockmap`
- Linux: `latest-linux.yml`, `*.AppImage`

The release workflow already uploads these (see `build-electron.yml` and the `files:` list in
`release.yml`).

> electron-updater reads from **published** (non-draft) releases. The release is created as a draft,
> so updates only roll out once you publish it. To test an upgrade: ship `v0.3.0`, install it, then
> publish `v0.3.1` and confirm the running `v0.3.0` shows the update banner.

## Code signing (optional)

Builds are **unsigned by default**, so Windows SmartScreen and macOS Gatekeeper will warn users.
electron-builder reads signing material from environment variables, so signing is opt-in: populate
the (currently commented) `env:` block on the "Build Electron app" step in `build-electron.yml` from
repository secrets.

- **Windows**: `CSC_LINK` (base64 `.pfx`) + `CSC_KEY_PASSWORD`.
- **macOS**: `CSC_LINK`/`CSC_KEY_PASSWORD` (or `APPLE_*` for an Apple Developer ID) plus
  notarization (`APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`).

Auto-update on macOS **requires** a valid Developer ID signature (Squirrel.Mac rejects unsigned
updates); on Windows unsigned updates apply but trip SmartScreen. Sign before relying on auto-update
for those platforms.

## Notes

- The docs site in `docs/` is its own workspace package.
