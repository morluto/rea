import { chmod, lstat, readFile } from "node:fs/promises";
import { expect, it, onTestFinished } from "vitest";

import {
  expectConfigurationRefusal,
  serveCli as serve,
} from "./cliServeHarness.js";
import {
  createTestWorkspace,
  removeTestWorkspace,
} from "../../support/workspace/workspaceFixture.js";

it.each([
  [
    ["inspect-adb-client", "--json"],
    "/nonexistent/adb",
    "The selected adb binary was not found: /nonexistent/adb. Set REA_ADB_PATH",
  ],
  [
    ["list-adb-devices", "--json"],
    "/nonexistent/adb",
    "The selected adb binary was not found: /nonexistent/adb. Set REA_ADB_PATH",
  ],
  [
    ["list-adb-devices", "--json"],
    "relative/adb",
    "REA_ADB_PATH must be an absolute path to the adb binary.",
  ],
])(
  "%j with REA_ADB_PATH=%s names the host requirement",
  async (argv, binary, reason) => {
    const result = await serve(argv, { REA_ADB_PATH: binary });
    expectConfigurationRefusal(result, reason);
  },
);

it("validates device serials before contacting any device", async () => {
  const result = await serve(["inspect-adb-device", "bad serial", "--json"]);
  expect(JSON.parse(result.stdout)).toMatchObject({
    code: "invalid_request",
    category: "invalid_input",
  });
});

it("requires the output directory option on pull", async () => {
  const result = await serve([
    "pull-adb-package",
    "emulator-5554",
    "com.example",
    "--json",
  ]);
  expect(result.exitCode).not.toBe(0);
});

it.skipIf(process.platform === "win32")(
  "refuses a trailing device separator through the CLI before adb or output effects",
  async () => {
    const workspace = await createTestWorkspace("rea-adb-cli-pull-");
    onTestFinished(() => removeTestWorkspace(workspace.root));
    const adb = await workspace.write(
      "adb",
      `#!/bin/sh
if [ "$1" = "version" ]; then
  printf 'Android Debug Bridge version 1.0.41\\nVersion 34.0.5-cli\\nInstalled as %s\\n' "$0"
  exit 0
fi
: > '${workspace.path("invoked")}'
exit 0
`,
    );
    await chmod(adb, 0o755);
    const output = workspace.path("pulls");
    const result = await serve(
      [
        "pull-adb-file",
        "emulator-5554",
        "/data/local/tmp/",
        "--output-directory",
        output,
        "--json",
      ],
      { REA_ADB_PATH: adb },
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "invalid_request",
    });
    await expect(readFile(workspace.path("invoked"))).rejects.toThrow();
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
