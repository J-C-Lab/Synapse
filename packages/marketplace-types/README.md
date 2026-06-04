# @synapse/marketplace-types

The Synapse marketplace **domain model** and **HTTP API contract** as a single
source of truth — shared by the marketplace server, the plugin CLI, the desktop
app, and the web portal.

zod schemas are authoritative; TypeScript types are **inferred** from them
(`z.infer`), so there are no hand-maintained parallel interfaces to drift. A
request validated on a client matches exactly what the server parses.

## What's here

- **`common`** — shared primitives: `pluginId`, `handle`, `semver`, `sha256`,
  `timestamp`, `httpsUrl`, `localizedString`, and the `visibility` /
  `userRole` / `pluginStatus` / `pluginSort` enums.
- **`domain`** — entities: `User`, `AuthIdentity`, `Plugin`, `PluginVersion`,
  `PluginStats`, `Download`, `Rating`, `Review`, and the `PluginSummary`
  listing projection.
- **`api`** — request/response bodies: device-code auth, search, plugin detail,
  publish, visibility/yank, download resolution, ratings, reviews, and the
  uniform `apiError` envelope.

## Conventions

- **Identity is provider-agnostic**: a `User` owns one or more `AuthIdentity`
  rows, so adding email/Google later never migrates the user table.
- **Versions are immutable**: a bad release is _yanked_ (`yankedAt`), never
  deleted, so existing installs stay reproducible.
- **The manifest is the single source of truth for `manifestSnapshot`**: it
  reuses `@synapse/plugin-manifest`'s `manifestSchema`, so publish validation and
  install-time permission disclosure agree with what the plugin host enforces.

## Usage

```ts
import { searchPluginsQuerySchema, type Plugin } from "@synapse/marketplace-types"

const query = searchPluginsQuerySchema.parse(req.query) // throws on invalid input
```
