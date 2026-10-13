import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ARTIFACT_NAME = "test-timings";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CANDIDATES = 5;
const positiveId = (value) =>
  (typeof value === "string" || typeof value === "number") &&
  /^[1-9]\d*$/.test(String(value)) &&
  Number.isSafeInteger(Number(value));

function findTimingRun({ repository, branch, repositoryId, now = Date.now() }) {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "") ||
    !branch ||
    !positiveId(repositoryId)
  )
    return "";
  const deadline = Date.now() + 20_000;
  const api = (...arguments_) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      throw new Error("Timing history lookup budget exhausted");
    return JSON.parse(
      execFileSync("gh", ["api", "--method", "GET", ...arguments_], {
        encoding: "utf8",
        timeout: Math.min(10_000, remaining),
        maxBuffer: 4 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  };

  const { artifacts } = api(
    `repos/${repository}/actions/artifacts`,
    "-f",
    `name=${ARTIFACT_NAME}`,
    "-F",
    "per_page=100",
  );
  if (!Array.isArray(artifacts))
    throw new Error("Missing timing artifact inventory");
  const candidates = artifacts
    .filter((artifact) => {
      const lineage = artifact?.workflow_run;
      const age = now - Date.parse(artifact?.created_at);
      return (
        artifact?.name === ARTIFACT_NAME &&
        artifact?.expired === false &&
        typeof artifact?.created_at === "string" &&
        Number.isFinite(age) &&
        age >= 0 &&
        age < MAX_AGE_MS &&
        positiveId(lineage?.id) &&
        positiveId(lineage?.repository_id) &&
        positiveId(lineage?.head_repository_id) &&
        lineage.repository_id === lineage.head_repository_id &&
        lineage.repository_id === Number(repositoryId) &&
        lineage.head_branch === branch
      );
    })
    .sort(
      (left, right) =>
        Date.parse(right.created_at) - Date.parse(left.created_at),
    )
    .slice(0, MAX_CANDIDATES);

  for (const artifact of candidates) {
    const run = api(
      `repos/${repository}/actions/runs/${artifact.workflow_run.id}`,
    );
    const runAge = now - Date.parse(run?.created_at);
    if (
      typeof run?.created_at === "string" &&
      Number.isFinite(runAge) &&
      runAge >= 0 &&
      runAge < MAX_AGE_MS &&
      run.id === artifact.workflow_run.id &&
      run.status === "completed" &&
      run.conclusion === "success" &&
      run.path === ".github/workflows/ci.yml" &&
      ["schedule", "workflow_dispatch"].includes(run.event) &&
      run.head_branch === branch &&
      run.head_repository?.full_name === repository
    )
      return String(run.id);
  }
  return "";
}

function write(runId) {
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `run-id=${runId}\n`);
  console.log(JSON.stringify({ run_id: runId }));
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  let runId = "";
  try {
    runId = findTimingRun({
      repository: process.env.CI_REPOSITORY,
      branch: process.env.CI_DEFAULT_BRANCH,
      repositoryId: process.env.CI_REPOSITORY_ID,
    });
  } catch {
    // History improves shard ordering but must never block CI.
  }
  write(runId);
}
