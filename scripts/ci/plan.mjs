import { appendFileSync, writeFileSync } from "node:fs";

import { gitRepository, planChanges } from "./change-plan.mjs";
import { CI_FLAGS as flags, testShardJob } from "./scopes.mjs";

const plan = planChanges(
  {
    event: process.env.GITHUB_EVENT_NAME,
    full: process.env.CI_FULL === "true",
    skipFull: process.env.CI_SKIP_FULL === "true",
    pushWarmOnly: process.env.CI_PUSH_WARM_ONLY === "true",
    scheduleFast: process.env.CI_SCHEDULE_FAST === "true",
    base: process.env.BASE_SHA,
    head: process.env.HEAD_SHA,
    baselineReason: process.env.BASELINE_REASON,
  },
  gitRepository(),
);
const { tier, matrix, reasons, testSelection, testShards, typedLintFiles } =
  plan;
// Candidate files are diagnostic only. Keep them out of the active selection
// output shared by every test job and by the required gate.
const { shadowFiles, ...activeSelection } = testSelection;
let recordedShadow = false;
if (
  shadowFiles &&
  process.env.CI_RECORD_TEST_SHADOW === "true" &&
  process.env.GITHUB_SHA
) {
  try {
    writeFileSync(
      ".git/test-selection-shadow.json",
      JSON.stringify({
        version: 1,
        sha: process.env.GITHUB_SHA,
        files: shadowFiles,
      }),
      { flag: "wx" },
    );
    recordedShadow = true;
  } catch (error) {
    console.warn("Could not record the test selection prediction:", error);
  }
}
const selected = Object.fromEntries(flags.map((flag) => [flag, plan[flag]]));
if (process.env.GITHUB_OUTPUT)
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries({
      ...selected,
      tier,
      matrix: JSON.stringify(matrix),
      test_selection: JSON.stringify(activeSelection),
      test_shadow: recordedShadow,
      test_mode: testSelection.mode,
      test_shards: JSON.stringify(testShards),
      test_shard_job: testShardJob(
        process.env.GITHUB_EVENT_NAME,
        tier,
        testSelection.mode,
      ),
      typed_lint_files: JSON.stringify(typedLintFiles),
    })
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### Selected CI lanes (${tier})\n\n${flags.filter((flag) => selected[flag]).join(", ") || "Formatting only"}\n\n${reasons.join("\n\n")}\n\nPortable tests (${testSelection.mode}): ${testSelection.reason}\n`,
  );
console.log(JSON.stringify({ ...plan, testSelection: activeSelection }));
