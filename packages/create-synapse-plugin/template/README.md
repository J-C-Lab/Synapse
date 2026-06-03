# hello-world

A [Synapse](https://synapse.app) plugin.

## Develop

```bash
npm install

# Watch + rebuild and register the plugin into a running Synapse (dev source).
# Reload plugins in Synapse after edits to pick up changes.
npm run dev
```

## Build

```bash
# Bundle into an installable package: hello-world-0.1.0.syn
npm run build
```

Then import the generated `.syn` file from Synapse's plugin settings.

## Release

This repo ships a GitHub Actions workflow at `.github/workflows/release.yml`.
Push a version tag to build and attach the `.syn` (plus its SHA-256) to a
GitHub Release:

```bash
git tag v0.1.0 && git push --tags
```

## Layout

- `synapse.json` — plugin manifest (id, commands, permissions). Validated on
  build; the `$schema` reference gives editor autocomplete against the same
  contract the Synapse host enforces.
- `src/index.ts` — your plugin entry. Register commands that return declarative
  views; the host renders them. You author against `@synapse/plugin-sdk` types
  and the host-injected runtime — avoid Node built-ins (the sandbox has no
  `require`).
