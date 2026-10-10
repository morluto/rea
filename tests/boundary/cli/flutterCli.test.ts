import { expect, it } from "vitest";

import { createCli } from "../../../src/cli.js";

const serve = async (
  argv: readonly string[],
): Promise<{ readonly stdout: string; readonly exitCode: number }> => {
  const cli = createCli({});
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

it.each(["identify-flutter-build", "inspect-dart-aot"])(
  "%s advertises a schema through the public CLI",
  async (command) => {
    const result = await serve([command, "--schema", "--json"]);
    expect(result.exitCode).toBe(0);
    const schema = JSON.parse(result.stdout) as { args?: unknown };
    expect(schema).toBeTruthy();
  },
);

it("reports an unreadable target with an input refusal", async () => {
  const result = await serve([
    "identify-flutter-build",
    "/nonexistent/app.apk",
    "--json",
  ]);
  expect(result.stdout).toContain("invalid_request");
});
