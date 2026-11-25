import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { normalizeWorkflowRun } from "./workflow-run.mjs";

const repository = process.env.CI_REPOSITORY;
const branch = process.env.CI_DEFAULT_BRANCH;
const head = process.env.HEAD_SHA;
const baselineEvent = process.env.CI_BASELINE_EVENT || "push";
const shaPattern = /^[0-9a-f]{40}$/i;

function ancestor(base) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", base, head], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function write(base, reason) {
  const output = { base, reason };
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `base=${base}\nreason=${reason.replace(/[\r\n]/g, " ")}\n`,
    );
  }
  console.log(JSON.stringify(output));
}

function findBaseline() {
  const deadline = Date.now() + 15_000;
  // Most baselines are recent. Widen once to the original 100-run window
  // when the short list contains only ineligible runs.
  for (const pageSize of [5, 100]) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Baseline lookup budget exhausted");
    const response = execFileSync(
      "gh",
      [
        "api",
        "--method",
        "GET",
        `repos/${repository}/actions/workflows/ci.yml/runs`,
        "-f",
        `branch=${branch}`,
        "-f",
        `event=${baselineEvent}`,
        "-f",
        "status=success",
        "-F",
        `per_page=${pageSize}`,
      ],
      { encoding: "utf8", timeout: remaining, maxBuffer: 4 * 1024 * 1024 },
    );
    const runs = JSON.parse(response).workflow_runs;
    if (!Array.isArray(runs))
      throw new Error("GitHub returned no workflow run list");
    const base = runs.find(
      (run) =>
        run?.event === baselineEvent &&
        run.status === "completed" &&
        run.conclusion === "success" &&
        normalizeWorkflowRun(run).workflowPath?.file ===
          ".github/workflows/ci.yml" &&
        run?.head_branch === branch &&
        run?.head_repository?.full_name === repository &&
        typeof run?.head_sha === "string" &&
        shaPattern.test(run.head_sha) &&
        run.head_sha.toLowerCase() !== head.toLowerCase() &&
        ancestor(run.head_sha),
    )?.head_sha;
    if (base || runs.length < pageSize) return base;
  }
}

if (
  !repository ||
  !branch ||
  !head ||
  !shaPattern.test(head) ||
  !["push", "schedule"].includes(baselineEvent)
) {
  write("", "Repository, default branch, or checked-out head is invalid");
} else {
  try {
    const base = findBaseline();
    if (base) write(base, "");
    else
      write(
        "",
        `No trusted successful CI ${baselineEvent} baseline is an ancestor of this head`,
      );
  } catch {
    write(
      "",
      `Could not read a successful CI ${baselineEvent} baseline from GitHub`,
    );
  }
}
