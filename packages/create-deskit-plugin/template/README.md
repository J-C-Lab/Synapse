# hello-world

A [DesKit](https://deskit.app) plugin.

## Develop

```bash
npm install

# Watch + rebuild and register the plugin into a running DesKit (dev source).
# Reload plugins in DesKit after edits to pick up changes.
npm run dev
```

## Build

```bash
# Bundle into an installable package: hello-world-0.1.0.deskit
npm run build
```

Then import the generated `.deskit` file from DesKit's plugin settings.

## Release

This repo ships a GitHub Actions workflow at `.github/workflows/release.yml`.
Push a version tag to build and attach the `.deskit` (plus its SHA-256) to a
GitHub Release:

```bash
git tag v0.1.0 && git push --tags
```

## Layout

- `deskit.json` — plugin manifest (id, commands, permissions). Validated on
  build; the `$schema` reference gives editor autocomplete against the same
  contract the DesKit host enforces.
- `src/index.ts` — your plugin entry. Register commands that return declarative
  views; the host renders them. You author against `@deskit/plugin-sdk` types
  and the host-injected runtime — avoid Node built-ins (the sandbox has no
  `require`).
