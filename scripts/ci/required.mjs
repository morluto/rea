import { CI_FLAGS, CI_LANES, testShardJob } from "./scopes.mjs";
import { recordQualification } from "./qualification.mjs";

const jobs = JSON.parse(process.env.CI_JOBS);
const outputs = jobs?.changes?.outputs;
if (!["fast", "full", "reused", "warm"].includes(outputs?.tier))
  throw new Error(
    "CI classification requires a valid tier: fast, full, reused, or warm",
  );
const invalidFlags = CI_FLAGS.filter(
  (flag) => outputs[flag] !== "true" && outputs[flag] !== "false",
);
if (invalidFlags.length)
  throw new Error(
    `CI classification requires explicit true/false scope outputs: ${invalidFlags.join(", ")}`,
  );
const selectedScopes = CI_FLAGS.filter((flag) => outputs[flag] === "true");
const reused = outputs.tier === "reused";
const warm = outputs.tier === "warm";
if (
  warm &&
  (process.env.GITHUB_EVENT_NAME !== "push" ||
    selectedScopes.length !== 1 ||
    selectedScopes[0] !== "code")
)
  throw new Error(
    "Warm main-push tier is only valid on push events with code-only cache warming",
  );
if (
  reused &&
  (process.env.GITHUB_EVENT_NAME !== "schedule" ||
    !/^[1-9]\d*$/.test(outputs.qualification_run_id ?? "") ||
    !Number.isSafeInteger(Number(outputs.qualification_run_id)) ||
    selectedScopes.length !== 0)
)
  throw new Error(
    "Reused qualification requires a scheduled admission receipt and no selected lanes",
  );
if (
  process.env.GITHUB_EVENT_NAME === "schedule" &&
  outputs.tier === "fast" &&
  outputs.code !== "true"
)
  throw new Error(
    "Scheduled fast sweep requires the complete portable test suite before issuing a receipt",
  );
if (outputs.tier === "full" && selectedScopes.length !== CI_FLAGS.length)
  throw new Error("Full qualification requires every canonical CI scope");
// Only a fast pull-request plan may run a selected test subset.
const testMode = outputs.test_mode;
if (
  !["full", "selected"].includes(testMode) ||
  (testMode === "selected" &&
    (outputs.tier !== "fast" ||
      process.env.GITHUB_EVENT_NAME !== "pull_request" ||
      outputs.code !== "true"))
)
  throw new Error(
    "CI classification requires a valid test mode: full, or selected on a fast pull request",
  );
const required = reused
  ? ["changes"]
  : warm
    ? ["changes", "static", "build"]
    : ["changes", "static"];
if (outputs.tier === "full") required.push("static-deep");
if (!warm)
  for (const scope of selectedScopes)
    required.push(
      ...((testMode === "selected" && CI_LANES[scope].selectedTests) ||
        CI_LANES[scope].required[outputs.tier]),
    );
const matrix = testShardJob(
  process.env.GITHUB_EVENT_NAME,
  outputs.tier,
  testMode,
);
const failed = [...new Set(required)]
  .map((name) => (name === "test-shard" ? matrix : name))
  .filter((name) => jobs[name]?.result !== "success");
for (const [name, job] of Object.entries(jobs)) {
  if (["failure", "cancelled"].includes(job.result) && !failed.includes(name))
    failed.push(name);
}
if (failed.length)
  throw new Error(`CI lanes did not pass: ${failed.join(", ")}`);
console.log("Every selected CI lane passed");
if (reused)
  console.log(
    `Qualification reused from run ${outputs.qualification_run_id}; no fresh provider observation`,
  );
if (
  (outputs.tier === "full" ||
    (process.env.GITHUB_EVENT_NAME === "schedule" &&
      outputs.tier === "fast")) &&
  process.env.CI_QUALIFICATION_DIRECTORY
)
  recordQualification(process.env.CI_QUALIFICATION_DIRECTORY, outputs.tier);
