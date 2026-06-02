# @deskit/plugin-cli

Build tool for [DesKit](../../README.md) plugins. Bundles a plugin project
into an installable `.deskit` package and manages dev-mode hot loading.

## Usage

```bash
# Bundle + package → <id>-<version>.deskit in the project root
deskit-plugin build

# Just validate deskit.json
deskit-plugin validate

# Watch + rebuild, and register the project so a running DesKit loads it live
deskit-plugin dev

# Manually (un)register a project for DesKit dev loading
deskit-plugin link
deskit-plugin unlink
```

All commands accept an optional project directory (default: cwd) and:

- `--entry <file>` — source entry to bundle (default `src/index.ts`)
- `--out <dir>` — where `build` writes the `.deskit` (default: project root)
- `--minify` — minify the bundle (`build`)
- `--data-dir <dir>` — override DesKit's userData dir (`dev`/`link`/`unlink`)
- `--no-link` — skip auto-linking in `dev`

## The `.deskit` package

A `.deskit` file is a ZIP with `deskit.json` at the root and the bundled CJS
entry at the path named by `manifest.main` (plus any declared icon assets):

```
<id>-<version>.deskit
├─ deskit.json
└─ dist/index.js      # self-contained CommonJS bundle
```

The DesKit sandbox executes the entry in a `vm` context **without `require`**,
so `build` bundles every runtime import inline (esbuild, `platform: node`,
`format: cjs`). Author plugins against the host-injected `deskit` runtime and
`@deskit/plugin-sdk` types — avoid Node built-ins, which cannot be required in
the sandbox.

Manifests are validated with [`@deskit/plugin-manifest`](../plugin-manifest),
the same schema the DesKit host uses at install time.
