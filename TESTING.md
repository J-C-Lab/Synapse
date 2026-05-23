# Testing

The test stack is Vitest, jsdom, and Testing Library.

## Commands

```bash
pnpm test
pnpm test:watch
pnpm test:coverage
```

## Layout

Tests live next to the code they cover:

- `src/main/**/*.test.ts`
- `src/preload/**/*.test.ts`
- `src/renderer/src/**/*.test.ts`
- `src/renderer/src/**/*.test.tsx`

`__mocks__/electron.ts` is used to stub Electron in unit tests.

## Notes

- Use `vitest.setup.ts` for shared setup.
- Keep renderer tests focused on UI behavior.
- Keep main-process tests small and pure where possible.
