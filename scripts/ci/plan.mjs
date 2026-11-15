import { appendFileSync } from "node:fs";

import { gitRepository, planChanges } from "./change-plan.mjs";
import { CI_FLAGS as flags } from "./scopes.mjs";

const plan = planChanges(
  {
    event: process.env.GITHUB_EVENT_NAME,
    full: process.env.CI_FULL === "true",
    skipFull: process.env.CI_SKIP_FULL === "true",
    base: process.env.BASE_SHA,
    head: process.env.HEAD_SHA,
    baselineReason: process.env.BASELINE_REASON,
  },
  gitRepository(),
);
const { tier, matrix, reasons, testSelection } = plan;
const selected = Object.fromEntries(flags.map((flag) => [flag, plan[flag]]));
if (process.env.GITHUB_OUTPUT)
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries({
      ...selected,
      tier,
      matrix: JSON.stringify(matrix),
      test_selection: JSON.stringify(testSelection),
    })
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### Selected CI lanes (${tier})\n\n${flags.filter((flag) => selected[flag]).join(", ") || "Formatting only"}\n\n${reasons.join("\n\n")}\n`,
  );
console.log(JSON.stringify(plan));
