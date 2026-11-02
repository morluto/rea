import { execFile } from "node:child_process";
import { realpath, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  applicationFixture,
  electronRuntimeEvidence,
  SOURCE,
} from "../../fixtures/javascriptRuntimeReconciliation.js";

const execute = promisify(execFile);

it.each(["once", "always", "physical"] as const)(
  "retries the exact Evidence descriptor after close denial: %s",
  async (denial) => {
    const root = await createTestTempDirectory("rea-verifier-evidence-close-");
    const evidence = join(root, "evidence.json");
    const preload = join(root, "instrument.mjs");
    const application = await applicationFixture();
    await writeFile(
      evidence,
      JSON.stringify(electronRuntimeEvidence(application, SOURCE)),
    );
    const selected = await realpath(evidence);
    await writeFile(
      preload,
      `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const open = fs.promises.open;
let attempts = 0;
fs.promises.open = async function(path, ...args) {
  const handle = await open.call(this, path, ...args);
  if (String(path) === ${JSON.stringify(selected)}) {
    const close = handle.close.bind(handle);
    if (${JSON.stringify(denial)} === 'physical')
      handle.read = async () => { throw new Error('authored Evidence read failure'); };
    handle.close = async () => {
      attempts++;
      if (${JSON.stringify(denial)} === 'always' || attempts === 1)
        throw new Error('authored Evidence close denial');
      return close();
    };
  }
  return handle;
};
syncBuiltinESMExports();
process.on('exit', () => fs.writeSync(2, 'Evidence close attempts: ' + attempts + '\\n'));
`,
    );
    const invocation = execute(
      process.execPath,
      [
        "--import",
        preload,
        "scripts/verify/javascript/runtime-observation.mjs",
        "--application",
        application,
        "--runtime-evidence",
        evidence,
      ],
      { timeout: 20_000 },
    );
    if (denial === "once") {
      const result = await invocation;
      expect(JSON.parse(result.stdout)).toMatchObject({ verified: true });
      expect(result.stderr).toContain("Evidence close attempts: 2");
      expect(result.stderr).not.toContain("authored Evidence close denial");
      return;
    }
    const result: unknown = await invocation.then(
      () => {
        throw new Error("Expected Evidence failure");
      },
      (error: unknown) => error,
    );
    expect(result).toMatchObject({
      stderr: expect.stringContaining("Evidence close attempts: 2"),
    });
    if (
      !(result instanceof Error) ||
      !("stderr" in result) ||
      typeof result.stderr !== "string"
    )
      throw new Error("Missing verifier diagnostics");
    if (denial === "always") {
      expect(result.stderr).toContain("authored Evidence close denial");
      expect(result.stderr).toContain(
        "AggregateError: Verifier cleanup failed",
      );
      expect(result.stderr).toContain("cleanupLeases");
    } else {
      expect(result.stderr).toContain("authored Evidence read failure");
      expect(result.stderr).not.toContain("authored Evidence close denial");
      expect(result.stderr).not.toContain(
        "AggregateError: Verifier cleanup failed",
      );
    }
  },
  30_000,
);

it("refuses oversized Evidence before a whole-file read", async () => {
  const root = await createTestTempDirectory("rea-verifier-evidence-limit-");
  const evidence = join(root, "evidence.json");
  const preload = join(root, "instrument.mjs");
  await writeFile(evidence, "");
  await truncate(evidence, 64 * 1024 * 1024 + 1);
  const selected = await realpath(evidence);
  await writeFile(
    preload,
    `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const readFile = fs.promises.readFile;
fs.promises.readFile = function(path, ...args) {
  if (String(path) === ${JSON.stringify(selected)}) throw new Error('oversized whole-file read');
  return readFile.call(this, path, ...args);
};
syncBuiltinESMExports();
`,
  );
  const application = await applicationFixture();
  const result = await execute(
    process.execPath,
    [
      "--import",
      preload,
      "scripts/verify/javascript/runtime-observation.mjs",
      "--application",
      application,
      "--runtime-evidence",
      evidence,
    ],
    { timeout: 20_000 },
  ).then(
    () => {
      throw new Error("Expected oversized Evidence rejection");
    },
    (error: unknown) => error,
  );
  expect(result).toMatchObject({
    stderr: expect.stringContaining(
      `Runtime Evidence exceeds 64 MiB: ${evidence}`,
    ),
  });
}, 30_000);
