import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { z } from "zod";

const root = process.cwd();
const historyDirectory = join(root, ".cache/ci-test-history");
const historyPath = join(historyDirectory, "test-results.json");
// Never let a failed or partial rerun leave a previous successful history file.
await rm(historyPath, { force: true });
const report = z
  .object({
    success: z.boolean(),
    numFailedTests: z.number().int().nonnegative(),
    testResults: z.array(
      z.object({
        name: z.string().min(1),
        startTime: z.number().finite(),
        endTime: z.number().finite(),
      }),
    ),
  })
  .parse(JSON.parse(await readFile("test-results.json", "utf8")));

const files = report.testResults.map(({ name, startTime, endTime }) => {
  const path = relative(root, resolve(root, name));
  if (
    path === "" ||
    path === ".." ||
    path.startsWith(".." + sep) ||
    isAbsolute(path)
  )
    throw new Error(`Test report path is outside the checkout: ${name}`);
  const duration = endTime - startTime;
  if (!Number.isFinite(duration) || duration < 0)
    throw new Error(`Test report has an invalid duration: ${name}`);
  return { name: path.split(sep).join("/"), startTime: 0, endTime: duration };
});
const complete = process.env.SHARD_RESULT === "success";
const passed =
  complete &&
  process.env.MERGE_RESULT === "success" &&
  report.success &&
  report.numFailedTests === 0;
const summary = [
  complete ? "## Merged test diagnostics" : "## Partial test diagnostics",
  "",
  `Shard result: ${process.env.SHARD_RESULT ?? "unknown"}; merge result: ${process.env.MERGE_RESULT ?? "unknown"}.`,
  passed
    ? "Successful timing history is available."
    : "This report is diagnostic only and is not a successful timing baseline.",
  "",
  "| Slowest file | Duration (ms) |",
  "| --- | ---: |",
  ...files
    .toSorted((left, right) => right.endTime - left.endTime)
    .slice(0, 20)
    .map(
      ({ name, endTime }) => `| ${name.replaceAll("|", "\\|")} | ${endTime} |`,
    ),
  "",
].join("\n");
if (process.env.GITHUB_STEP_SUMMARY)
  await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
else console.log(summary);

if (passed) {
  await mkdir(historyDirectory, { recursive: true });
  await writeFile(
    historyPath,
    JSON.stringify({ success: true, numFailedTests: 0, testResults: files }),
  );
}
