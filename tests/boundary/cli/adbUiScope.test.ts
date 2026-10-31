import { expect } from "vitest";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest("withholds UI mutation from the production CLI", async ({ cli }) => {
  const help = await cli.run({ arguments: ["--help"] });
  expect(help.exitCode).toBe(0);
  expect(help.stdout).toContain("inspect-adb-ui");
  expect(help.stdout).not.toContain("perform-adb-ui-action");
  const refused = await cli.run({
    arguments: ["perform-adb-ui-action", "{}", "--json"],
  });
  expect(refused.exitCode).not.toBe(0);
  expect(refused.json).toMatchObject({ code: "COMMAND_NOT_FOUND" });
});
