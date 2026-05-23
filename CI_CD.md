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
- unit tests
- desktop build smoke checks

## Notes

- The main app is Electron, not Next.js.
- The docs site in `docs/` is its own workspace package.
- Keep macOS notarization notes separate if release signing is added later.
