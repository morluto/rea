import { expect } from "vitest";

import { runningClientRewriteNotice } from "../../../src/application/SupportedClients.js";
import { mcpRegistrationReportSchema } from "../../../src/contracts/mcpRegistration.js";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { registrationEnvironment } from "../../support/cli/registrationEnvironment.js";

// The owner's own text; this test checks delivery, not wording.
const QUIT_NOTICE = runningClientRewriteNotice({
  name: "claude_desktop",
  displayName: "Claude Desktop",
  quitBeforeSetup: true,
});

cliTest.skipIf(process.platform === "win32")(
  "mcp add tells the caller to quit Claude Desktop only when it wrote that client",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-mcp-add-quit-notice-");
    const environment = await registrationEnvironment(home);
    const run = (agent: string) =>
      cli.run({
        arguments: [
          "mcp",
          "add",
          "--agent",
          agent,
          "--command",
          "fixture-server --mcp",
          "--json",
        ],
        cwd: home,
        environment,
      });

    if (QUIT_NOTICE === undefined)
      throw new Error("Claude Desktop has no notice");
    const first = await run("claude-desktop");
    expect(first.exitCode, first.stderr).toBe(0);
    expect(
      mcpRegistrationReportSchema.parse(JSON.parse(first.stdout)).clients,
    ).toEqual([
      expect.objectContaining({
        client: "claude-desktop",
        status: "configured",
      }),
    ]);
    expect(first.stderr).toContain(QUIT_NOTICE);
    // The JSON report is unchanged: the notice is advice on stderr.
    expect(first.stdout).not.toContain(QUIT_NOTICE);

    // An identical repeat writes nothing, so there is nothing to lose.
    const repeated = await run("claude-desktop");
    expect(repeated.exitCode, repeated.stderr).toBe(0);
    expect(repeated.stderr).not.toContain(QUIT_NOTICE);

    const other = await run("cursor");
    expect(other.exitCode, other.stderr).toBe(0);
    expect(other.stderr).not.toContain(QUIT_NOTICE);
  },
);
