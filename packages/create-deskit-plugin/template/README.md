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

## Layout

- `deskit.json` — plugin manifest (id, commands, permissions). Validated on build.
- `src/index.ts` — your plugin entry. Register commands that return declarative
  views; the host renders them. You author against `@deskit/plugin-sdk` types
  and the host-injected runtime — avoid Node built-ins (the sandbox has no
  `require`).
