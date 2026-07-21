# Durable Agent Harness Verification Rehearsal

Date: 2026-07-20 (local execution)
Baseline commit: `21c9c9b87d5980996996c54ceff4bc9899b4af65` (`codex/s12-task-27`)

## Environment

| Item | Observed value |
| --- | --- |
| OS | Windows 11 Pro `10.0.26200` (build `26200`), x64 |
| Workspace filesystem | NTFS on `D:` (1547.51 GiB free of 2701.32 GiB) |
| Node.js | `v22.22.2` |
| pnpm | `11.0.8` |
| Electron package | `43.1.0` |

The rehearsal started from the commit above. The workspace also contained the
intended, uncommitted Task 28/29 changes; no commit was created by this
rehearsal.

## Command record

| Command | Exit | Duration | Result / decisive output |
| --- | ---: | ---: | --- |
| `pnpm build` | 0 | 27.38s | Package builds and Electron Vite main, preload, and renderer builds completed. |
| `pnpm typecheck` | 0 | 23.62s | All workspace/package, node, and web TypeScript checks completed. |
| `pnpm typecheck:native` | 1 | 1.62s | Blocked by `tsgo`: `tsconfig.node.json(6,5): TS5102 Option 'baseUrl' has been removed`. |
| `pnpm lint` | 0 | 21.39s | 24 warnings, 0 errors. Warnings include existing React state-in-effect/dependency warnings and array-index keys. |
| `pnpm format:check` | 0 | 11.26s | `All matched files use Prettier code style!` |
| `pnpm test` | 1 | 71.13s | 316 files passed, 4 failed, 1 skipped; 3204 tests passed, 6 failed, 5 skipped (3215 total). See [unit failures](#unit-test-failures). |
| `pnpm eval` | 1 | 3.48s | T0 eval ratchet failed: three tool fqName expectations use `com.probe/...` while actual traces use `com_probe_...`. |
| `pnpm test:e2e` | 1 | 21.5s | Development Electron E2E: 2 passed, 2 failed. See [development-e2e failures](#development-electron-e2e-failures). |
| `pnpm electron:build:win` | 0 | about 4m 51s | Built/signed `release/win-unpacked/Synapse.exe`, `Synapse-0.3.0.msi`, `Synapse-Setup-0.3.0.exe`, and NSIS blockmap. |
| `SYNAPSE_PACKAGED_EXE=release/win-unpacked/Synapse.exe; pnpm exec playwright test --project=packaged` | 0 | 21.07s | 2/2 packaged checks passed: shell readiness/diagnostics and MCP stdio handshake numeric tool/resource counts. |

### Test-discovery guard

The default Vitest config now excludes `.claude/**` from both `test.exclude`
and `coverage.exclude`, in addition to the pre-existing `.worktrees/**`
exclude. The bare `pnpm test` run above collected only the primary workspace
suite; no `.claude/worktrees/...` duplicate test paths appeared. A direct
config assertion also loaded `vitest.config.ts` and verified both exclusions
plus glob matching for a representative
`.claude/worktrees/s12-checkpoint-c/src/main/example.test.ts` path.

## Unit test failures

The failures below are failures of the full rehearsal, not passes:

1. `src/main/plugins/downloads-organizer.e2e.test.ts` — the settled download
   move/Undo scenario expected `runRecorded` once and observed zero calls.
2. `src/main/plugins/github-inbox.e2e.test.ts` — background trigger tool
   exposure scenario expected `runRecorded` once and observed zero calls.
3. `src/main/plugins/plugin-host.test.ts` — three failures, all waiting for
   `runRecorded`: the agent-budgeted trigger dispatcher and the confirmed and
   unconfirmed `memory:read`/`execution:read` paths.
4. `src/main/ai/eval/scorers/trajectory.test.ts` — its matching fixture
   expected `scoreTrajectory(base).passed === true`, received `false`.

The test runner reached the normal primary suite (including the Task 26/28
durability tests); these are not duplicate-worktree invalid-hook-call failures.

## Eval failure

`src/main/ai/eval/run-eval.eval.ts` gated all three T0 corpus entries:
`budget-stop`, `denied-recovers`, and `happy-path`. Each comparison reports
`com_probe_greet` / `com_probe_write` in the actual trace versus
`com.probe/greet` / `com.probe/write` in the baseline expectation. This is a
baseline/trace naming incompatibility; it is not a passing ratchet.

## Development Electron E2E failures

`pnpm test:e2e` rebuilt the app then ran four development tests:

- Passed: artifact real-restart/GC safety and ordinary shell/IPC smoke.
- Failed: the seeded recoverable-run panel showed both fixtures as `failed`
  rather than containing `running` within the 5s assertion window.
- Failed: the renderer-restart recovery fixture did not render its expected
  `read_file` tool card within 5s.

These two failures mean the durable recovery renderer acceptance path is not
accepted by this rehearsal, despite the packaged shell and MCP handshake smoke
passing.

## Post-remediation verification

The issues above were remediated in the same uncommitted Task 28/29 worktree,
then the following commands were rerun on 2026-07-20. This section supersedes
the earlier failing outcomes for those commands; the initial results remain
above as failure evidence rather than being rewritten as passes.

| Command | Exit | Result / decisive output |
| --- | ---: | --- |
| `pnpm build` | 0 | Package builds plus Electron Vite main/preload/renderer all completed. |
| `pnpm typecheck` | 0 | All package, node, and web TypeScript checks completed. |
| `pnpm typecheck:native` | 0 | `tsgo` completed node and web checks after removing only the obsolete `baseUrl` compiler option; the explicit `paths` aliases were retained unchanged. |
| `pnpm lint` | 0 | 24 existing renderer warnings, 0 errors. |
| `pnpm format:check` | 0 | `All matched files use Prettier code style!` |
| `pnpm test` | 0 | Fresh bare primary-workspace run after the lifecycle fixes; JUnit reports 3216 tests, 0 failures, 0 errors, 5 skipped. |
| `pnpm eval` | 0 | T0 trajectory ratchet passed; two judged evals skipped because no judge credential was supplied. |
| `pnpm test:e2e` | 0 | Fresh production build followed by development Electron E2E: 4/4 passed. |

The initial zero-failure JUnit artifact was not treated as sufficient evidence:
the complete bare run was repeated after the background-teardown and GUI-abort
race fixes. Its final JUnit artifact contains 3216 tests, zero failures, zero
errors, and five designed skips. No `.claude/worktrees/...` tests were
collected.

### Remediation summary

- Test discovery now excludes `.claude/**` from both Vitest test and coverage
  discovery, preventing active local worktrees from joining the primary suite.
- Native typechecking is compatible with the installed TypeScript toolchain:
  obsolete `baseUrl` was removed from the node and web configs without adding
  a wildcard alias or changing their explicit `paths` mappings.
- Background-trigger test probes now wait for durable finalization before
  observing a trace. Trigger adapter fires are tracked until their driver
  promises settle, and host teardown deregisters/aborts first, waits for that
  idle barrier, then permits temporary durable-store cleanup. The probes also
  make terminal-finalization observation an explicit promise rather than a
  best-effort polling callback.
- Trigger teardown also rejects a platform callback captured before its
  registration was disposed. Every asynchronous fire preflight rechecks the
  trigger controller after instance lookup and workspace-archive resolution,
  so disabling/removing a plugin while either read is pending cannot start a
  handler or background-agent fan-out. The regression proves the old callback
  makes zero dispatches while the newly registered callback remains live.
- GUI approval cancellation now installs an abort promise that resolves
  immediately when the signal was already aborted during connect/send. This
  closes the real connection-to-listener gap that could otherwise wait for the
  full response timeout under a busy full-suite worker; its test waits for
  observed request/cancel frames rather than fixed wall-clock sleeps.
- The trajectory scorer maps model-safe names back to its fixture's frozen
  fqName contract, fixing the `com_probe_*` versus `com.probe/*` ratchet
  mismatch without weakening tool-name sanitization.
- The recovery E2E checkpoints now include Task 25's required skill-catalog
  snapshot hashes. They seed the actual direct interactive execution tool and
  its workspace binding, assert the public recovery IPC snapshot, and use
  public IPC to create the credential/conversations for automatic recovery.
  The resumed fixture restores a pending approval, then proves continuation
  without issuing a provider network request by observing its
  `approval_pending` event through public `getRunEventsSince(runId, 0)` IPC.
  The fixture seeds no event-journal rows, so this event can only have been
  emitted by the startup continuator.
- Background recovery no longer compares its frozen governed tool authority
  with the interactive registry. It reconstructs the same current
  `GovernedBackgroundToolHost`, confirmed grants, plugin fallback, and trigger
  `uses` top-cap used at creation. The regression dispatches a real granted
  `memory:read` background run and verifies its reconstructed authority equals
  the persisted snapshot, including `requiredCapabilities`.

`pnpm electron:build:win` was not repeated after remediation. The earlier
Windows package build passed, and this remediation did not change
electron-builder configuration, package resources, signing, or dependencies;
the post-remediation `pnpm build` did rebuild the Electron main/preload and
renderer bundles. This is not a replacement for a fresh installer acceptance
run if release packaging itself is in scope.

## Windows packaged and manual status

The packaged automatic rehearsal was run against the just-built executable and
passed both existing `packaged-smoke.spec.ts` checks. Existing development
fixtures also exercise real Electron launch, durable recovery seeding, restart,
artifact read/GC, and real preload IPC; their actual pass/fail result is
recorded above.

No separate manual Electron fault rehearsal was performed. In particular, no
manual crash injection, screenshots, user-entered provider credentials, or
run/correlation identifiers were produced. The profile-compat rehearsal was
not run because it requires an explicitly supplied retained Electron 33
executable (`SYNAPSE_ELECTRON33_EXE`), which was not supplied for this task.
Therefore this document makes no claim for those manual/profile-compat
acceptance conditions.

## Payload and secret-handling evidence

Existing passing tests provide bounded evidence, rather than a claim that a
release-artifact secret scan was performed:

- `src/main/ai/runs/model-step-runner.test.ts` asserts transient dispatch and
  approval data are never persisted into a durable checkpoint message history.
- `src/main/mcp/mcp-durable-run.test.ts` asserts discovery polling is not
  persisted while external resource operations are traced.
- `src/main/logging/redact.test.ts`, `audit-sanitize.test.ts`, and
  `logger.test.ts` cover secret-shaped field/text redaction.
- `src/main/plugins/capability-audit.test.ts` asserts requested-scope,
  clipboard, request-body, URL query, path, and reason-shaped values are
  sanitized from audit records.

No recursive scan of the generated MSI/NSIS artifacts for secrets or payload
content was run in this rehearsal, so no stronger no-leak conclusion is made.

## Scope note

Checkpoint F remains parked for this task. It was neither implemented nor used
to turn any failed check into a pass. Post-remediation, the automated commands
recorded here pass; the remaining conditions are the manual/profile-compat
conditions stated above.
