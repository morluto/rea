import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { compareTestDiscovery } from "./lib/test-discovery.mjs";
import {
  VerifierFixture,
  withVerifierFixture,
} from "./lib/verifier-fixture.mjs";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "..");

const temporaryFixture = await VerifierFixture.open({
  prefix: "rea-test-discovery-",
  private: false,
});
const temporary = temporaryFixture.path;
let discovered;
await withVerifierFixture(temporaryFixture, async () => {
  const output = join(temporary, "discovery.json");
  await execute(
    process.execPath,
    [
      join(root, "node_modules/vitest/vitest.mjs"),
      "list",
      "--filesOnly",
      `--json=${output}`,
    ],
    { cwd: root, maxBuffer: 8 * 1024 * 1024 },
  );
  const files = await execute(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "src",
      "tests",
    ],
    { cwd: root, maxBuffer: 8 * 1024 * 1024 },
  );
  const expected = [];
  for (const path of files.stdout
    .split("\0")
    .filter((path) => /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path))) {
    try {
      if ((await stat(join(root, path))).isFile()) expected.push(path);
    } catch (cause) {
      if (cause.code !== "ENOENT") throw cause;
    }
  }
  const report = compareTestDiscovery(
    expected,
    JSON.parse(await readFile(output, "utf8")),
    root,
  );
  if (
    report.missing.length ||
    report.unexpected.length ||
    report.duplicates.length ||
    report.wrongProjects.length
  ) {
    console.error(JSON.stringify(report, null, 2));
    process.exitCode = 1;
  } else discovered = report.discovered;
});
if (discovered !== undefined)
  console.log(
    `Discovered all ${discovered} test and spec files in src and tests exactly once.`,
  );
