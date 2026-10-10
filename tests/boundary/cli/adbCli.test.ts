import { expect, it } from "vitest";

import { createCli } from "../../../src/cli.js";

const serve = async (
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = {},
): Promise<{ readonly stdout: string; readonly exitCode: number }> => {
  const cli = createCli(environment);
  let stdout = "";
  let exitCode = 0;
  await cli.serve([...argv], {
    env: {},
    exit: (code) => {
      exitCode = code;
    },
    stdout: (text) => {
      stdout += text;
    },
  });
  return { stdout, exitCode };
};

it.each([
  ["inspect-adb-client"],
  ["list-adb-devices"],
  ["inspect-adb-device"],
  ["list-adb-packages"],
  ["pull-adb-package"],
  ["read-adb-logcat"],
  ["inspect-adb-package"],
  ["pull-adb-file"],
  ["push-adb-file"],
  ["capture-adb-screen"],
  ["list-adb-processes"],
  ["list-adb-directory"],
  ["list-adb-features"],
  ["list-adb-services"],
  ["inspect-adb-display"],
  ["inspect-adb-window"],
  ["read-adb-setting"],
  ["collect-adb-bugreport"],
  ["resolve-adb-packages"],
  ["install-adb-package"],
  ["uninstall-adb-package"],
  ["start-adb-app"],
  ["start-adb-activity"],
  ["stop-adb-app"],
])("%s advertises a schema through the public CLI", async (command) => {
  const result = await serve([command, "--schema", "--json"]);
  expect(result.exitCode, command).toBe(0);
  const schema = JSON.parse(result.stdout) as { args?: unknown };
  expect(schema).toBeTruthy();
});

it("reports a missing adb binary with recovery guidance", async () => {
  const result = await serve(["inspect-adb-client", "--json"], {
    REA_ADB_PATH: "/nonexistent/adb",
  });
  expect(result.stdout).toContain("capability_unavailable");
  expect(result.stdout).toContain("REA_ADB_PATH");
});

it("validates device serials before contacting any device", async () => {
  const result = await serve(["inspect-adb-device", "bad serial", "--json"]);
  expect(result.stdout).toContain("invalid_input");
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
