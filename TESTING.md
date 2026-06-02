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

## LAN Transfer Simulation

Use two isolated development instances to manually test LAN transfers on one computer. Start each
instance in a separate terminal:

```bash
pnpm dev:lan:a
pnpm dev:lan:b
```

The windows are labeled `DesKit Sim A` and `DesKit Sim B`. Their development-only profiles are
stored separately under the app `userData/dev-lan-simulator/` directory, so each instance has its
own device identity, certificate, trusted devices, settings, and transfer records.

Manual smoke test:

1. Enable nearby device discovery in both windows.
2. Connect one simulated device to the other.
3. Confirm that both windows display the same six-digit security code.
4. Confirm the connection in both windows.
5. Send a file and accept the save operation in the receiving window.
6. Send a larger file, interrupt one instance during transfer, restart it with the same command,
   and resume the transfer.
