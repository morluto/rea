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

it.each(["inspect-apktool-client", "decode-android-resources"])(
  "%s advertises a schema through the public CLI",
  async (command) => {
    const result = await serve([command, "--schema", "--json"]);
    expect(result.exitCode, command).toBe(0);
    const schema = JSON.parse(result.stdout) as { args?: unknown };
    expect(schema).toBeTruthy();
  },
);

it("reports a missing apktool launcher with recovery guidance", async () => {
  const result = await serve(["inspect-apktool-client", "--json"], {
    REA_APKTOOL_COMMAND: "/nonexistent/apktool",
  });
  expect(result.stdout).toContain("capability_unavailable");
  expect(result.stdout).toContain("REA_APKTOOL_COMMAND");
});

it("validates the locale option before launching apktool", async () => {
  const result = await serve([
    "decode-android-resources",
    "/targets/app.apk",
    "--locale",
    "not a locale",
    "--json",
  ]);
  expect(result.stdout).toContain("invalid");
});
