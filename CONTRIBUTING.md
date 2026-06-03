# Contributing Guide

This document defines how the Synapse team works in this repository. It is written for contributors with different Git and GitHub experience levels, so please follow it even when a shortcut looks faster.

## Core Rules

- Do not push directly to `main`.
- Work on a feature branch and open a pull request.
- Keep each pull request focused on one problem.
- Run local checks before requesting review.
- Do not commit generated files, secrets, local settings, or personal notes.
- Ask before changing project-wide configuration, dependencies, CI, build scripts, or security-related Electron code.

## First-Time Setup

Install the required tools:

- Node.js 20+
- pnpm 11.x
- Git

Clone the repository and install dependencies:

```bash
git clone https://github.com/WiIIiamWei/Synapse.git
cd Synapse
pnpm install
```

Start the app:

```bash
pnpm dev
```

## Branch Workflow

Always create a new branch from the latest `main`:

```bash
git switch main
git pull
git switch -c feat/short-description
```

Use these branch prefixes:

- `feat/` for user-facing features
- `fix/` for bug fixes
- `docs/` for documentation
- `test/` for tests only
- `refactor/` for behavior-preserving code changes
- `chore/` for tooling, config, or dependency maintenance

Good examples:

```text
feat/command-palette
fix/preload-greet-error
docs/update-setup-guide
```

Avoid vague names:

```text
test
my-work
update
final
```

## Commit Rules

Use Conventional Commits:

```text
feat: add command palette shell
fix: handle missing preload api
docs: update local setup guide
test: add timestamp parser cases
chore: update eslint config
```

Commit small, reviewable chunks. A commit should describe what changed, not when you changed it.

Before committing, check what will be included:

```bash
git status
git diff
```

Never commit:

- `.env.local` or any secret file
- `node_modules/`
- `out/`, `release/`, `.next/`, coverage output, or build artifacts
- personal editor or agent state
- files under `Synapse/`

## Pull Request Rules

Open a pull request when your branch has a complete, reviewable change.

Every pull request should include:

- what changed
- why it changed
- screenshots or recordings for UI changes
- test steps you actually ran
- linked issue, if there is one

Keep pull requests small. If a change touches unrelated areas, split it.

Do not merge your own pull request unless the maintainer explicitly asks you to.

## Review Rules

Reviewers should check:

- whether the change solves the stated problem
- whether the code is simple enough for the current project stage
- whether Electron security boundaries remain intact
- whether tests or manual validation are enough
- whether the UI behaves well on realistic window sizes
- whether documentation needs an update

Authors should respond to review comments by either making a change or explaining the decision. Do not mark a conversation as resolved until the reviewer can see the resolution.

## Local Checks

Run these before requesting review:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Useful commands while developing:

```bash
pnpm lint:fix
pnpm format
pnpm test:watch
pnpm typecheck:native
```

If a command fails, do not hide the failure in the pull request. Mention it and include the error summary.

## Dependency Rules

Do not add dependencies casually. Before adding one, check whether the project already has a suitable package.

Adding or upgrading dependencies requires a pull request that explains:

- why the dependency is needed
- what alternatives were considered
- whether it affects Electron main, preload, renderer, build, or CI
- whether the lockfile changed as expected

Use `pnpm install` from the repository root. Do not use `npm install` or `yarn`.

## Electron Security Rules

The renderer must not get broad access to Node.js or Electron APIs.

Keep these defaults unless the maintainer approves a change:

- `contextIsolation: true`
- `sandbox: true`
- `nodeIntegration: false`
- typed APIs exposed through `contextBridge`
- explicit IPC channels only
- strict CSP
- no uncontrolled external navigation

When adding IPC:

- validate inputs in the main process
- return typed results
- keep handlers small
- add tests for pure business logic
- expose the smallest renderer API possible

## UI Rules

- Use existing components from `src/renderer/src/components/ui/`.
- Do not add tests inside `components/ui/`; these files are vendored UI primitives.
- Keep feature components close to the feature that owns them.
- Use accessible labels, keyboard-friendly interactions, and stable layouts.
- Use lucide icons when an icon exists.

## Documentation Rules

Public project documentation belongs in tracked files such as:

- `README.md`
- `README_zh.md`
- `TESTING.md`
- `CI_CD.md`
- `CONTRIBUTING.md`
- `docs/`

The `Synapse/` directory is for local planning and development discussion. It is ignored by Git and should not be linked as required public documentation.

## When You Are Unsure

Ask before doing any of these:

- changing CI or release workflows
- changing Electron security settings
- changing repository-wide lint, format, or TypeScript config
- adding a new package
- changing public APIs or shared data models
- rewriting code outside the scope of your task

Small questions early are cheaper than large fixes late.

## Maintainer Repository Settings

Configure these settings on GitHub after creating the repository.

### Access

- Keep most teammates at `Write` access only if they need to push branches.
- Prefer `Triage` or `Read` for people who only manage issues or review discussions.
- Keep `Admin` limited to the repository owner and one backup maintainer.
- Enable two-factor authentication requirements if the organization supports it.

### Main Branch Protection

Protect `main` with a branch protection rule or repository ruleset:

- require a pull request before merging
- require at least 1 approving review
- require review from CODEOWNERS
- dismiss stale approvals when new commits are pushed
- require conversation resolution before merging
- require status checks to pass before merging
- require branches to be up to date before merging
- block force pushes
- block deletions
- include administrators, unless emergency maintenance is needed

Recommended required checks:

- `Quality`
- `Test`
- `Build Electron`

If GitHub shows expanded job names instead, select the equivalent checks produced by the CI workflow.

### Merge Strategy

Recommended repository settings:

- enable `Squash merge`
- disable `Merge commit`
- disable `Rebase merge` unless the team is comfortable with it
- enable `Automatically delete head branches`
- set the default branch to `main`

### Pull Request Hygiene

Enable:

- branch protection or rulesets for `main`
- CODEOWNERS review requirement
- Dependabot alerts
- secret scanning, if available
- private vulnerability reporting, if the repository is public

### Issue and Project Management

Use issues for work tracking:

- one issue per task or bug
- assign one owner per issue
- use labels such as `bug`, `feature`, `docs`, `good first issue`, `blocked`
- link pull requests with `Closes #123`

Avoid assigning multiple people to the same small implementation task unless they are pairing deliberately.
