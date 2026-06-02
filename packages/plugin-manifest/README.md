# @deskit/plugin-manifest

Shared manifest contract for [DesKit](../../README.md) plugins.

This package owns the `deskit.json` schema and validation so that both the
DesKit host (main process) and the [`@deskit/plugin-cli`](../plugin-cli) build
tool validate manifests against a single source of truth — no schema drift
between "what the CLI accepts" and "what the app loads".

## Exports

- `parseManifest(raw): PluginManifest` — structural validation (throws
  `ManifestValidationError` with a list of human-readable issues).
- `manifestSchema` — the underlying zod schema.
- `isEngineCompatible(range, hostVersion)` — `engines.deskit` range check
  (`"*"`, exact `x.y.z`, caret `^x.y.z`).
- `ManifestValidationError` — error type carrying `issues: string[]`.
- Manifest TypeScript types (`PluginManifest`, `ManifestCommand`, …).

Engine compatibility is deliberately **not** part of `parseManifest`: it
depends on the consuming host's version, so callers compose the two as needed.
