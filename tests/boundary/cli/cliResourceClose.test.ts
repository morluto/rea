import { expect, it, vi } from "vitest";
import { createCli } from "../../../src/cli.js";
import {
  CliResourceOwners,
  closeCliResources,
} from "../../../src/cli/cliResources.js";
import { ArtifactResourceScope } from "../../../src/resources/ArtifactResourceScope.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { registrationEnvironment } from "../../support/cli/registrationEnvironment.js";
import { serveInProcessCli } from "../../support/cli/serveInProcessCli.js";

it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])(
  "settles both CLI owners when JavaScript fails=%s and guidance fails=%s",
  async (jsFails, guideFails) => {
    const jsError = new Error("JavaScript resources retained");
    const guideError = new Error("Guidance descriptor retained");
    const js = vi.fn(async () => {
      if (jsFails) throw jsError;
    });
    const guides = vi.fn(async () => {
      if (guideFails) throw guideError;
    });
    const owners = new CliResourceOwners();
    owners.own("javascript-analysis", js);
    owners.own("guidance", guides);
    const closing = owners.close();
    if (jsFails && guideFails)
      await expect(closing).rejects.toMatchObject({
        errors: [jsError, guideError],
      });
    else if (jsFails || guideFails)
      await expect(closing).rejects.toBe(jsFails ? jsError : guideError);
    else await expect(closing).resolves.toBeUndefined();
    expect(js).toHaveBeenCalledOnce();
    expect(guides).toHaveBeenCalledOnce();
  },
);

it.each([
  {
    name: "guidance",
    args: ["guidance", "--query", "qzxv"],
    exitCode: 0,
  },
  {
    name: "MCP registration",
    args: [
      "mcp",
      "add",
      "--agent",
      "fixture-not-a-client",
      "--command",
      "fixture-mcp",
    ],
    exitCode: 1,
  },
])(
  "closes the resource scope acquired by $name",
  async ({ args, exitCode }) => {
    await closeCliResources();
    const home = await createTestTempDirectory("rea-cli-resource-close-");
    const cli = createCli(await registrationEnvironment(home));
    const runs = vi.spyOn(ArtifactResourceScope.prototype, "run");
    try {
      const result = await serveInProcessCli(cli, [...args, "--json"]);
      expect(result.exitCode, result.stdout).toBe(exitCode);
      const scope = runs.mock.contexts.find(
        (value): value is ArtifactResourceScope =>
          value instanceof ArtifactResourceScope,
      );
      if (scope === undefined)
        throw new Error("Expected command to enter its resource scope");
      await expect(scope.run(async () => "open")).resolves.toBe("open");
      await closeCliResources();
      await expect(scope.run(async () => "closed")).rejects.toMatchObject({
        reason: "unavailable",
      });
    } finally {
      runs.mockRestore();
      await closeCliResources();
    }
  },
);
