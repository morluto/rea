import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "setup and doctor accept a client's hyphenated name as its canonical id",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-setup-client-name-");
    const run = (arguments_: readonly string[]) =>
      cli.run({
        arguments: [...arguments_, "--json"],
        cwd: home,
        environment: { HOME: home, USERPROFILE: home, TMPDIR: home },
      });
    const plan = (client: string) =>
      run(["setup", "--client", client, "--skill=false", "--dry-run"]);

    const canonical = await plan("claude_code");
    const hyphenated = await plan("claude-code");
    expect(hyphenated.exitCode, hyphenated.stdout).toBe(0);
    expect(hyphenated.json).toMatchObject({
      status: "planned",
      plannedActions: [{ id: "configure_client:claude_code" }],
    });
    expect(hyphenated.json).toEqual(canonical.json);

    const doctor = await run(["doctor", "--client", "claude-code"]);
    expect(doctor.json).not.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(doctor.json).toMatchObject({
      scope: { clients: ["claude_code"] },
    });
  },
);

cliTest("setup suggests the closest client id on a typo", async ({ cli }) => {
  const home = await createTestTempDirectory("rea-setup-client-typo-");
  const result = await cli.run({
    arguments: ["setup", "--client", "claud_code", "--dry-run", "--json"],
    cwd: home,
    environment: { HOME: home, USERPROFILE: home, TMPDIR: home },
  });
  expect(result.exitCode).toBe(1);
  expect(result.json).toMatchObject({
    code: "VALIDATION_ERROR",
    fieldErrors: [
      {
        code: "invalid_value",
        path: "client.0",
        message: "Unknown client 'claud_code'. Did you mean 'claude_code'?",
      },
    ],
  });
});
