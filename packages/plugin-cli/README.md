# @synapsepkg/plugin-cli

Build tool for [Synapse](../../README.md) plugins. Bundles a plugin project
into an installable `.syn` package and manages dev-mode hot loading.

## Usage

```bash
# Bundle + package → <id>-<version>.syn in the project root
synapse-plugin build

# Just validate synapse.json
synapse-plugin validate

# Watch + rebuild, and register the project so a running Synapse loads it live
synapse-plugin dev

# Manually (un)register a project for Synapse dev loading
synapse-plugin link
synapse-plugin unlink
```

All commands accept an optional project directory (default: cwd) and:

- `--entry <file>` — source entry to bundle (default `src/index.ts`)
- `--out <dir>` — where `build` writes the `.syn` (default: project root)
- `--minify` — minify the bundle (`build`)
- `--data-dir <dir>` — override Synapse's userData dir (`dev`/`link`/`unlink`)
- `--no-link` — skip auto-linking in `dev`

## The `.syn` package

A `.syn` file is a ZIP with `synapse.json` at the root and the bundled CJS
entry at the path named by `manifest.main` (plus any declared icon assets):

```
<id>-<version>.syn
├─ synapse.json
└─ dist/index.js      # self-contained CommonJS bundle
```

The Synapse sandbox executes the entry in a `vm` context **without `require`**,
so `build` bundles every runtime import inline (esbuild, `platform: node`,
`format: cjs`). Author plugins against the host-injected `synapse` runtime and
`@synapsepkg/plugin-sdk` types — avoid Node built-ins, which cannot be required in
the sandbox.

Manifests are validated with [`@synapsepkg/plugin-manifest`](../plugin-manifest),
the same schema the Synapse host uses at install time.
