import { Cli } from "incur";
import { expect, it } from "vitest";
import { registerElectronCommands } from "../../../src/cli/electronCommands.js";
import { silentLogger } from "../../../src/logger.js";

const serve = async (argv: readonly string[]): Promise<unknown> => {
  const cli = Cli.create("javascript-application-path-admission", {
    sync: false,
  });
  registerElectronCommands(cli, silentLogger, {});
  let stdout = "";
  await cli.serve([...argv, "--json"], {
    env: {},
    stdout: (text) => {
      stdout += text;
    },
    exit: () => undefined,
  });
  return JSON.parse(stdout);
};

it("rejects an empty or NUL analyze-javascript-application path before analysis", async () => {
  expect(await serve(["analyze-javascript-application", ""])).toMatchObject({
    code: "VALIDATION_ERROR",
    fieldErrors: [expect.objectContaining({ path: "path", code: "too_small" })],
  });
  expect(
    await serve(["analyze-javascript-application", "target\x00name"]),
  ).toMatchObject({
    code: "VALIDATION_ERROR",
    fieldErrors: [
      expect.objectContaining({ path: "path", code: "invalid_format" }),
    ],
  });
});
