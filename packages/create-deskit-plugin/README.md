# create-deskit-plugin

Scaffold a new [DesKit](https://deskit.app) plugin project.

```bash
npm create deskit-plugin my-plugin
# or
pnpm create deskit-plugin my-plugin
```

Interactive by default; pass `--yes` to accept defaults. Options:

| Flag                  | Description                             |
| --------------------- | --------------------------------------- |
| `--id <reverse-dns>`  | Plugin id (default `com.example.<dir>`) |
| `--display <name>`    | Display name                            |
| `--description <txt>` | Description                             |
| `--author <name>`     | Author                                  |
| `--command <id>`      | Command id (default `<short>.run`)      |
| `--clipboard`         | Add clipboard activation + permission   |
| `--force`             | Scaffold into a non-empty directory     |
| `--yes`               | Skip prompts                            |

The generated project depends on **published** `@deskit/plugin-sdk` and
`@deskit/plugin-cli`, so it builds standalone outside this monorepo. Its
`template/` directory doubles as a GitHub template repo — keep template
dependencies on published versions (never `workspace:*`).

After scaffolding:

```bash
cd my-plugin
npm install
npm run build   # → <id>-<version>.deskit, importable from DesKit settings
npm run dev     # watch + hot-load into a running DesKit
```
