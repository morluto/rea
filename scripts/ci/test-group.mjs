import { spawn } from "node:child_process";
import { resolve } from "node:path";

import {
  BUILT_TEST_PROJECTS,
  SOURCE_TEST_PROJECTS,
} from "../lib/test-projects.mjs";
import { parseTestSelection, testShards } from "./test-selection.mjs";

const [group, ...arguments_] = process.argv.slice(2);
// The group owns project and file selection; callers can request reporters
// or (for project groups) shards.
if (
  arguments_.some((argument) => /^--(?:project|exclude)(?:=|$)/u.test(argument))
)
  throw new Error("Test groups cannot override their project inventory");
let runner;
let environment = process.env;
if (group === "selected") {
  // `selected <k/n>` runs shard k of the plan's selected test files, by exact
  // identity, in whichever projects own them. With REA_CI_TEST_HISTORY the CI
  // sequencer balances the shards by main's recorded per-file durations.
  const [shard, ...rest] = arguments_;
  const plan = parseTestSelection(process.env.CI_TEST_SELECTION ?? "");
  if (plan.mode !== "selected" || !testShards("fast", plan).includes(shard))
    throw new Error(`No selected test group ${shard ?? ""} in this plan`);
  if (rest.some((argument) => /^--shard(?:=|$)/u.test(argument)))
    throw new Error("Selected test groups are already sharded");
  runner = [
    resolve("scripts/run-exact-tests.mjs"),
    "run",
    `--shard=${shard}`,
    ...rest,
    ...plan.files,
  ];
  // Each shard writes its own blob report for the merge.
  environment = {
    ...process.env,
    VITEST_BLOB_LABEL: `selected-${shard.split("/")[0]}`,
  };
} else {
  const projects = {
    source: SOURCE_TEST_PROJECTS,
    built: BUILT_TEST_PROJECTS,
  }[group];
  if (!projects) throw new Error("Expected source, built or selected tests");
  runner = [
    resolve("node_modules/vitest/vitest.mjs"),
    "run",
    ...projects.flatMap(({ name }) => ["--project", name]),
    ...arguments_,
  ];
}
const child = spawn(
  process.execPath,
  [
    // Reuse the development runner's POSIX process-group owner. Windows
    // source tests must remain usable without the built native Job Object.
    ...(process.platform === "win32"
      ? []
      : [resolve("scripts/run-exclusive.mjs"), "--unlocked", process.execPath]),
    ...runner,
  ],
  { stdio: "inherit", env: environment },
);
let shutdownSignal;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    shutdownSignal ??= signal;
    child.kill(signal);
  });
child.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once("close", (code) => {
  process.exitCode =
    shutdownSignal === "SIGINT"
      ? 130
      : shutdownSignal === "SIGTERM"
        ? 143
        : (code ?? 1);
});
