# Baseline tightening policy

Files in this directory (`asr.json`, `rag.json`, `rag-judged.json`) hold
the accepted thresholds the eval suites gate against. They are ordinary
reviewed files, not generated artifacts — no script batch-rewrites them.

**Rules:**

- A baseline value only ever moves in the strict direction:
  - `asr.json` ceilings only go **down** (a lower attack-success-rate
    ceiling is stricter).
  - `rag.json` / `rag-judged.json` minimums only go **up** (a higher
    required minimum is stricter — `checkAgainstBaseline()` flags a
    metric below its minimum as a regression).
  - The only exception is a PR that lands a deliberately-scoped guardrail
    fix (e.g. the S02 tool-metadata guardrail spec) that measurably earns
    a stricter number — that PR's description must say so explicitly.
- Any PR touching a file in this directory must explain why in its
  description. A baseline diff with no explanation should be treated as a
  request for changes, not approved as-is.
- Never seed or update a baseline to match a currently-failing score. If
  a suite doesn't pass with the baseline you want to set, the suite (or
  the underlying guardrail) isn't ready yet — fix that first, run for
  real, and seed from the passing result.
- JSON has no comment syntax — this policy lives here, not inline in the
  baseline files themselves.
