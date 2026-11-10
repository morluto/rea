import { execFile } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

// Exhausts the open-file limit, then starts the selected adb through the
// version probe and a device command; both take the owned stop-signal route.
const PRESSURE = `
import { open } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const [repo, binary] = process.argv.slice(1);
const load = (path) => import(pathToFileURL(repo + "/dist/" + path));
const { inspectAdbClient } = await load("adb/AdbConfiguration.js");
const { runAdbCapture } = await load("adb/AdbCommand.js");
const selection = { binary, pathSource: "environment", environment: {} };
const probe = () =>
  inspectAdbClient(selection).then(
    (identity) => ({ version: identity.version }),
    (cause) => ({ code: cause.code, diagnostics: cause.diagnostics }),
  );
const command = () =>
  runAdbCapture("adb devices", { device: "serial" }, selection, ["devices"],
    { timeoutMs: 10_000, maxOutputBytes: 1024 }, undefined,
  ).then((result) => result.ok ? { ok: true } : {
    tag: result.error._tag,
    resource: result.error.resource,
    retryable: result.error.retryable,
    reportedLimits: result.error.reportedLimits,
  });
const handles = [];
for (let index = 0; index < 128; index += 1) {
  try {
    handles.push(await open("/dev/null", "r"));
  } catch (cause) {
    if (cause.code !== "EMFILE") throw cause;
    break;
  }
}
if (handles.length === 128) throw new Error("Run under a low descriptor limit");
const pressure = { probe: await probe(), command: await command() };
for (const handle of handles) await handle.close();
const after = { probe: await probe(), command: await command() };
process.stdout.write(JSON.stringify({ pressure, after }));
`;

it.skipIf(process.platform === "win32")(
  "reports open-file exhaustion as retryable host capacity without an unhandled spawn error",
  async () => {
    const directory = await createTestTempDirectory("rea-adb-descriptors-");
    const adb = join(directory, "adb");
    await writeFile(
      adb,
      `#!/bin/sh
if [ "$1" = version ]; then printf 'Android Debug Bridge version 1.0.41\\nVersion 34.0.5-cli\\n'; fi
exit 0
`,
    );
    await chmod(adb, 0o755);
    const { stdout, stderr } = await promisify(execFile)(
      "/bin/sh",
      [
        "-c",
        'ulimit -n 64; exec "$@"',
        "adb-descriptor-pressure",
        process.execPath,
        "--input-type=module",
        "--eval",
        PRESSURE,
        process.cwd(),
        adb,
      ],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
    );

    // An unhandled child error would exit the process before this report.
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      pressure: {
        probe: {
          code: "host_capacity",
          diagnostics: expect.objectContaining({
            selected_binary: adb,
            filesystem_error: "EMFILE",
          }),
        },
        command: {
          tag: "AnalysisResourceConstraintError",
          resource: "capacity",
          retryable: true,
          reportedLimits: { spawn_error: "EMFILE" },
        },
      },
      after: { probe: { version: "34.0.5-cli" }, command: { ok: true } },
    });
  },
);
