import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, it } from "vitest";

const execute = promisify(execFile);

it("runs the HTTP/3 verifier's deterministic assertion regressions without optional providers", async () => {
  const { stdout } = await execute(
    process.execPath,
    [
      "--test",
      "--test-reporter=tap",
      fileURLToPath(
        new URL(
          "../../scripts/lib/http3-capture-assertions.test.mjs",
          import.meta.url,
        ),
      ),
    ],
    { timeout: 10_000, maxBuffer: 1024 * 1024 },
  );
  // Node reports an empty test file as one passing file-level test. Require
  // a named assertion as well as successful suite totals.
  expect(stdout).toContain(
    "# Subtest: positive assertions retain exact producer connection facts on both legs",
  );
  expect(stdout).toMatch(/^# tests [1-9]\d*$/mu);
  expect(stdout).toMatch(/^# fail 0$/mu);
  expect(stdout).toMatch(/^# skipped 0$/mu);
  expect(stdout).toMatch(/^# todo 0$/mu);
});
