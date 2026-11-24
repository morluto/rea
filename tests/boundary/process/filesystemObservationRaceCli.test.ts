import { lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "vitest";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { parseProcessCapture } from "../../../src/domain/process/processCaptureParsing.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { CAPTURE_SKIP_REASON } from "./processCaptureCapability.js";

const captureCliTest = cliTest.skipIf(
  CAPTURE_SKIP_REASON ||
    (process.platform === "win32" ? "requires POSIX symlink semantics" : false),
);

const racePreload = `
import fs from "node:fs";
import { resolve } from "node:path";
import { syncBuiltinESMExports } from "node:module";

const cliEntry = process.env.REA_TEST_CLI_ENTRY;
if (cliEntry !== undefined && resolve(process.argv[1] ?? "") === cliEntry) {
  const stable = process.env.REA_TEST_STABLE_SYMLINK;
  const vanishing = process.env.REA_TEST_VANISHING_SYMLINK;
  const readLog = process.env.REA_TEST_READLINK_LOG;
  let vanishingReads = 0;
  const originalReadlink = fs.promises.readlink;
  fs.promises.readlink = async function (path, ...options) {
    const candidate = resolve(String(path));
    if (candidate === stable) fs.appendFileSync(readLog, "stable\\n");
    if (candidate === vanishing) {
      fs.appendFileSync(readLog, "vanishing\\n");
      if (++vanishingReads === 2) await fs.promises.unlink(path);
    }
    return originalReadlink.call(this, path, ...options);
  };
  syncBuiltinESMExports();
}
`;

captureCliTest(
  "distinguishes stable and vanished symlinks in one public filesystem capture",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-snapshot-race-cli-");
    const observed = join(root, "observed");
    const stable = join(observed, "stable-link");
    const vanishing = join(observed, "vanishing-link");
    const scenario = join(root, "scenario.json");
    const preload = join(root, "readlink-race-preload.mjs");
    const readLog = join(root, "readlink-log.txt");
    await mkdir(observed);
    await writeFile(join(observed, "sibling.txt"), "sibling evidence\n");
    const target = "target-does-not-need-to-exist";
    await symlink(target, stable);
    await symlink(target, vanishing);
    await writeFile(preload, racePreload);
    await writeFile(
      scenario,
      JSON.stringify({
        executable: process.execPath,
        arguments: ["-e", "process.stdout.write('controlled capture\\n')"],
        working_directory: root,
        filesystem_observation_paths: [observed],
      }),
    );
    const result = await cli.run({
      arguments: ["capture-process", scenario, "--json"],
      cwd: root,
      environment: {
        NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
        REA_TEST_CLI_ENTRY: resolve("scripts/rea.mjs"),
        REA_TEST_STABLE_SYMLINK: stable,
        REA_TEST_VANISHING_SYMLINK: vanishing,
        REA_TEST_READLINK_LOG: readLog,
      },
    });

    expect(result.exitCode, result.stderr + result.stdout).toBe(0);
    expect((await readFile(readLog, "utf8")).trim().split("\n").sort()).toEqual(
      ["stable", "stable", "vanishing", "vanishing"],
    );
    expect((await lstat(stable)).isSymbolicLink()).toBe(true);
    await expect(lstat(vanishing)).rejects.toMatchObject({ code: "ENOENT" });
    const stableEntry = expect.objectContaining({
      path: "root_0:stable-link",
      type: "symlink",
      symlink_target: target,
    });
    const siblingEntry = expect.objectContaining({
      path: "root_0:sibling.txt",
      type: "file",
    });
    const capture = parseProcessCapture(
      parseEvidence(result.json).normalized_result,
    );
    expect(capture).toMatchObject({
      truncated: true,
      files_before: expect.arrayContaining([
        stableEntry,
        siblingEntry,
        expect.objectContaining({
          path: "root_0:vanishing-link",
          type: "symlink",
          symlink_target: target,
        }),
      ]),
      files_after: expect.arrayContaining([stableEntry, siblingEntry]),
      filesystem_effects: expect.arrayContaining([
        expect.objectContaining({
          path: "root_0:vanishing-link",
          status: "unknown",
          after: null,
        }),
      ]),
    });
    const coverage = capture.truncation_details.filesystem_after;
    expect(coverage.enumeration_truncated).toBe(true);
    expect(coverage.enumeration_reasons.toSorted()).toEqual([
      "entry_unavailable",
      "symlink_not_followed",
    ]);
    expect(
      coverage.enumeration_omissions.toSorted((left, right) =>
        left.path.localeCompare(right.path),
      ),
    ).toEqual([
      {
        path: "root_0:stable-link",
        reason: "symlink_not_followed",
        system_code: null,
      },
      {
        path: "root_0:vanishing-link",
        reason: "entry_unavailable",
        system_code: "ENOENT",
      },
    ]);
  },
);
