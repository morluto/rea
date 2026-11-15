import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { registrationEnvironment } from "../../support/cli/registrationEnvironment.js";

const QUIT_NOTICE =
  "A running Claude Desktop can rewrite its configuration from memory and drop the registration. If Claude Desktop was running, quit it fully (closing its window is not enough), rerun rea mcp add, then start Claude Desktop again.";

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

    const first = await run("claude-desktop");
    expect(first.exitCode, first.stderr).toBe(0);
    expect(first.stderr).toContain(QUIT_NOTICE);
    // The JSON report is unchanged: the notice is advice on stderr.
    expect(first.stdout).not.toContain("quit it fully");

    // An identical repeat writes nothing, so there is nothing to lose.
    const repeated = await run("claude-desktop");
    expect(repeated.exitCode, repeated.stderr).toBe(0);
    expect(repeated.stderr).not.toContain(QUIT_NOTICE);

    const other = await run("cursor");
    expect(other.exitCode, other.stderr).toBe(0);
    expect(other.stderr).not.toContain("quit it fully");
  },
);
