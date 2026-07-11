import { execFileSync } from "node:child_process"
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import process from "node:process"
import { fileURLToPath } from "node:url"

const ISSUE_LABEL = "eval-nightly-status"
const ISSUE_TITLE = "Eval Nightly Status"

/**
 * Pure state-selection + rendering. No I/O — takes already-loaded
 * scorecard JSON (or null if a file was missing/unparseable) and the two
 * pieces of workflow state that distinguish the four signal states.
 */
export function renderStatus({ configured, evalOutcome, asrCard, ragCard }) {
  if (!configured) {
    return {
      state: "not-configured",
      summary: "⚠️ Judge key not configured — this run did not execute the judged suites.",
    }
  }

  if (asrCard === null || ragCard === null) {
    const missing = [asrCard === null ? "asr" : null, ragCard === null ? "rag-judged" : null]
      .filter(Boolean)
      .join(", ")
    return {
      state: "incomplete",
      summary: `🔴 Incomplete run — missing scorecard(s): ${missing}. Check the workflow run logs.`,
    }
  }

  const regressed = [...regressedIds(asrCard), ...regressedIds(ragCard)]

  if (evalOutcome !== "success" || regressed.length > 0) {
    // A failure outcome with no named regression (or a success outcome
    // that somehow still has one) is still reported as incomplete — that
    // combination isn't supposed to happen once the eval suites write
    // their scorecard before any throwing assertion (see the
    // rag-faithfulness.judged.eval.ts ordering fix), so if it does happen
    // it's itself worth flagging rather than silently picking a state.
    if (regressed.length > 0 && evalOutcome === "failure") {
      return {
        state: "regressed",
        summary: `⚠️ Regression detected: ${regressed.join(", ")}`,
      }
    }
    return {
      state: "incomplete",
      summary:
        "🔴 Incomplete or inconsistent run — eval step outcome and scorecard contents disagree. Check the workflow run logs.",
    }
  }

  return { state: "clean", summary: "✅ All judged suites within baseline." }
}

/** Builds the machine-readable status artifact main() writes alongside
 *  the human-facing issue body. `state` is the same value renderStatus()
 *  already computed — never re-derived. */
export function buildStatusJson({ state, runId, headSha, now = () => new Date() }) {
  return {
    schemaVersion: 1,
    state,
    // GitHub exposes GITHUB_RUN_ID as an environment string. Keep that
    // representation in the persisted contract so consumers never depend on
    // a JSON number versus API-number coincidence.
    runId: String(runId),
    headSha,
    completedAt: now().toISOString(),
  }
}

function regressedIds(card) {
  if (!card.results) return []
  return card.results.filter((r) => r.gated && !r.passed).map((r) => r.id)
}

function readCard(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
}

function main() {
  const configured = process.env.JUDGE_CONFIGURED === "true"
  const evalOutcome = process.env.EVAL_STEP_OUTCOME ?? "failure"
  const runUrl = process.env.RUN_URL ?? ""
  const asrCard = configured ? readCard("coverage/eval/asr.json") : null
  const ragCard = configured ? readCard("coverage/eval/rag-judged.json") : null

  const { state, summary } = renderStatus({ configured, evalOutcome, asrCard, ragCard })

  const statusJson = buildStatusJson({
    state,
    runId: process.env.GITHUB_RUN_ID ?? "",
    headSha: process.env.GITHUB_SHA ?? "",
  })
  writeFileSync("eval-nightly-status.json", `${JSON.stringify(statusJson, null, 2)}\n`)

  const body = [
    `## Eval Nightly Status`,
    "",
    summary,
    "",
    runUrl ? `[Workflow run](${runUrl})` : "",
  ]
    .filter((line) => line !== "")
    .join("\n")

  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (summaryPath) appendFileSync(summaryPath, `${body}\n`)

  syncIssue(body, state)
}

function ensureIssueLabel() {
  try {
    execFileSync(
      "gh",
      [
        "label",
        "create",
        ISSUE_LABEL,
        "--description",
        "Eval nightly workflow status",
        "--color",
        "0E8A16",
      ],
      { stdio: "ignore" }
    )
  } catch {
    // label already exists
  }
}

function syncIssue(body, state) {
  ensureIssueLabel()
  const existing = execFileSync(
    "gh",
    [
      "issue",
      "list",
      "--label",
      ISSUE_LABEL,
      "--state",
      "all",
      "--json",
      "number,state",
      "--limit",
      "1",
    ],
    { encoding: "utf8" }
  )
  const issues = JSON.parse(existing)

  if (issues.length === 0) {
    execFileSync("gh", [
      "issue",
      "create",
      "--title",
      ISSUE_TITLE,
      "--label",
      ISSUE_LABEL,
      "--body",
      body,
    ])
    return
  }

  const issue = issues[0]
  if (issue.state === "CLOSED") {
    execFileSync("gh", ["issue", "reopen", String(issue.number)])
  }
  execFileSync("gh", ["issue", "edit", String(issue.number), "--body", body])
  console.log(`Eval nightly status: ${state}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
}
