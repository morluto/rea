import { execFileSync } from "node:child_process";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { z } from "zod";

import { parseTestSelection } from "./test-selection.mjs";

const root = process.cwd();
const historyDirectory = join(root, ".cache/ci-test-history");
const historyPath = join(historyDirectory, "test-results.json");
// Never let a failed or partial rerun leave a previous successful history file.
await rm(historyPath, { force: true });
const report = z
  .object({
    version: z.literal(1),
    success: z.boolean(),
    reason: z.string().optional(),
    unhandledErrors: z.number().int().nonnegative().optional(),
    files: z.array(
      z.object({
        name: z.string().min(1),
        durationMs: z.number().finite().nonnegative(),
        state: z.string().optional(),
      }),
    ),
  })
  .parse(JSON.parse(await readFile("test-timings.json", "utf8")));

const files = report.files.map(({ name, durationMs, state }) => {
  const path = relative(root, resolve(root, name));
  if (
    path === "" ||
    path === ".." ||
    path.startsWith(".." + sep) ||
    isAbsolute(path)
  )
    throw new Error(`Test report path is outside the checkout: ${name}`);
  return { name: path.split(sep).join("/"), durationMs, state };
});
// Keep group outcomes intact: an unavailable group is not a completed failure.
const groupResults = [
  process.env.SHARD_RESULT,
  ...(process.env.SOURCE_REQUIRED === "true"
    ? [process.env.SOURCE_RESULT]
    : []),
];
const groupsCompleted = groupResults.every((state) =>
  ["success", "failure"].includes(state),
);
const passed =
  groupResults.every((state) => state === "success") &&
  process.env.MERGE_RESULT === "success" &&
  report.success;
// Successful shards and merged reports must account for the complete portable
// inventory, or exactly the selected subset. Coverage thresholds alone cannot
// prove that every file ran.
const verifyInventory = process.env.CI_VERIFY_TEST_INVENTORY === "true";
const selection = process.env.CI_TEST_SELECTION
  ? parseTestSelection(process.env.CI_TEST_SELECTION)
  : undefined;
const selected = selection?.mode === "selected";
const expected = !verifyInventory
  ? []
  : selected
    ? selection.files
    : execFileSync("git", ["ls-files", "-z", "--", "src", "tests"], {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
      })
        .split("\0")
        .filter((path) => path.endsWith(".test.ts"));
if (passed && verifyInventory) {
  const actual = files.map(({ name }) => name);
  if (actual.length === 0)
    throw new Error("No portable test modules were reported");
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected.filter((path) => !actualSet.has(path));
  const unexpected = actual.filter((path) => !expectedSet.has(path));
  if (missing.length || unexpected.length || actualSet.size !== actual.length)
    throw new Error(
      `Incomplete ${selected ? "selected" : "portable"} test inventory: ${JSON.stringify({ missing, unexpected, duplicateFiles: actual.length - actualSet.size })}`,
    );
  if (files.every(({ state }) => state === "skipped"))
    throw new Error("Every portable test module was skipped");
}
// A selected subset is not a timing baseline for the complete suite.
const publishesHistory = passed && !selected;
const skippedFiles = files.filter(({ state }) => state === "skipped");
const summary = [
  groupsCompleted
    ? "## Merged test diagnostics"
    : "## Partial test diagnostics",
  "",
  ...(selection
    ? [
        `Portable tests: ${selected ? `${selection.files.length} selected files` : "complete suite"}. ${selection.reason}.`,
        "",
      ]
    : []),
  `Shard result: ${process.env.SHARD_RESULT ?? "unknown"}; merge result: ${process.env.MERGE_RESULT ?? "unknown"}.`,
  ...(process.env.SOURCE_REQUIRED === "true"
    ? [`Source result: ${process.env.SOURCE_RESULT ?? "unknown"}.`]
    : []),
  `Skipped test modules: ${skippedFiles.length}. Their skip reasons and required coverage are not established by this report.`,
  ...(skippedFiles.length ? [""] : []),
  ...skippedFiles.map(({ name }) => `- ${name.replaceAll("|", "\\|")}`),
  "",
  publishesHistory
    ? "Successful timing history is available."
    : "This report is diagnostic only and is not a successful timing baseline.",
  "",
  "Durations include tests and hooks, worker preparation, environment, imports, and setup. They are scheduling weights, not summed workflow wall time.",
  "",
  "| Slowest file | Duration (ms) |",
  "| --- | ---: |",
  ...files
    .toSorted((left, right) => right.durationMs - left.durationMs)
    .slice(0, 20)
    .map(
      ({ name, durationMs }) =>
        `| ${name.replaceAll("|", "\\|")} | ${durationMs} |`,
    ),
  "",
].join("\n");
if (process.env.GITHUB_STEP_SUMMARY)
  await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
else console.log(summary);

if (publishesHistory) {
  await mkdir(historyDirectory, { recursive: true });
  await writeFile(
    historyPath,
    JSON.stringify({
      version: 1,
      success: true,
      files: files.map(({ name, durationMs }) => ({ name, durationMs })),
    }),
  );
}
