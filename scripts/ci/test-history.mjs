import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeWorkflowRun } from "./workflow-run.mjs";

const TIER_EVENTS = ["push", "schedule", "workflow_dispatch"];
const TIER_PROFILES = {
  fast: { artifactName: "test-timings-fast", events: TIER_EVENTS },
  full: { artifactName: "test-timings-full", events: TIER_EVENTS },
};
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CANDIDATES = 5;
const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const EMPTY_SELECTION = { runId: "", artifactName: "" };
const positiveId = (value) =>
  (typeof value === "string" || typeof value === "number") &&
  /^[1-9]\d*$/.test(String(value)) &&
  Number.isSafeInteger(Number(value));

function findTimingRun({
  repository,
  branch,
  repositoryId,
  tier,
  now = Date.now(),
}) {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "") ||
    !branch ||
    !positiveId(repositoryId)
  )
    return EMPTY_SELECTION;
  const profile = Object.hasOwn(TIER_PROFILES, tier)
    ? TIER_PROFILES[tier]
    : null;
  // Reused and other tiers do not publish shard history. Missing history uses
  // Vitest's own assignment rather than another tier's artifact.
  if (!profile) return EMPTY_SELECTION;
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
  const search = ({ artifactName, events }) => {
    const { artifacts } = api(
      `repos/${repository}/actions/artifacts`,
      "-f",
      `name=${artifactName}`,
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
          artifact?.name === artifactName &&
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
          typeof lineage.head_sha === "string" &&
          COMMIT_SHA.test(lineage.head_sha) &&
          lineage.head_branch === branch
        );
      })
      .sort(
        (left, right) =>
          Date.parse(right.created_at) - Date.parse(left.created_at),
      );

    const accepts = (run, artifact) => {
      const age = now - Date.parse(run?.created_at);
      return (
        typeof run?.created_at === "string" &&
        Number.isFinite(age) &&
        age >= 0 &&
        age < MAX_AGE_MS &&
        run.id === artifact.workflow_run.id &&
        run.head_sha === artifact.workflow_run.head_sha &&
        run.status === "completed" &&
        run.conclusion === "success" &&
        run.workflowPath?.file === ".github/workflows/ci.yml" &&
        events.includes(run.event) &&
        run.head_branch === branch &&
        run.head_repository?.full_name === repository
      );
    };
    for (const artifact of candidates.slice(0, MAX_CANDIDATES)) {
      let run;
      try {
        run = normalizeWorkflowRun(
          api(`repos/${repository}/actions/runs/${artifact.workflow_run.id}`),
        );
      } catch {
        // A listed artifact can outlive its run or race a deletion. Its
        // lineage remains unverified, but the next candidate may still work.
        continue;
      }
      if (accepts(run, artifact)) return String(run.id);
    }
    if (candidates.length > MAX_CANDIDATES) {
      // Failed workflow runs can still publish portable timings. One page of
      // successes lets older artifacts compete without a request per run.
      const { workflow_runs: runs } = api(
        `repos/${repository}/actions/workflows/ci.yml/runs`,
        "-f",
        `branch=${branch}`,
        "-f",
        "status=success",
        "-F",
        "per_page=100",
      );
      if (!Array.isArray(runs))
        throw new Error("Missing successful CI run inventory");
      const byId = new Map(
        runs
          .filter((run) => positiveId(run?.id))
          .map((run) => [run.id, normalizeWorkflowRun(run)]),
      );
      for (const artifact of candidates) {
        const run = byId.get(artifact.workflow_run.id);
        if (accepts(run, artifact)) return String(run.id);
      }
    }
    return "";
  };

  const runId = search(profile);
  return runId
    ? { runId, artifactName: profile.artifactName }
    : EMPTY_SELECTION;
}

function write({ runId, artifactName }) {
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `run-id=${runId}\nartifact-name=${artifactName}\n`,
    );
  console.log(JSON.stringify({ run_id: runId, artifact_name: artifactName }));
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  let selection = EMPTY_SELECTION;
  try {
    selection = findTimingRun({
      repository: process.env.CI_REPOSITORY,
      branch: process.env.CI_DEFAULT_BRANCH,
      repositoryId: process.env.CI_REPOSITORY_ID,
      tier: process.env.CI_TIMING_TIER,
    });
  } catch {
    // History improves shard ordering but must never block CI.
  }
  write(selection);
}
