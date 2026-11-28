import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { vsixCommandCorrelationSchema } from "../../../src/domain/vsix/vsixCommandCorrelation.js";
import { vsixPackageFixture } from "../../../src/vsix/VsixPackage.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const SOURCE = `const vscode = require("vscode");
exports.activate = () => {
  vscode.commands.registerCommand("demo.run", () => {});
};
`;
const MANIFEST = JSON.stringify({
  name: "hello",
  publisher: "demo",
  version: "1.2.3",
  engines: { vscode: "^1.74.0" },
  main: "./extension.js",
  contributes: {
    commands: [{ command: "demo.run" }, { command: "demo.gone" }],
  },
});

cliTest(
  "correlates package and application Evidence through CLI and stdio MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-vsix-commands-");
    const vsix = join(root, "demo.vsix");
    const extracted = join(root, "extracted");
    await mkdir(extracted);
    await writeFile(vsix, await vsixPackageFixture({ packageJson: MANIFEST }));
    await writeFile(join(extracted, "package.json"), MANIFEST);
    await writeFile(join(extracted, "extension.js"), SOURCE);
    const call = await cli.sharedMcpCall?.();
    if (call === undefined) throw new Error("Expected a stdio MCP session");
    const source = async (name: string, input: Record<string, unknown>) => {
      const response = await call(name, { ...input, detail: "complete" });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      return response.structuredContent;
    };
    const request = {
      vsix_package: await source("inspect_vsix_package", { path: vsix }),
      javascript_application: await source("analyze_javascript_application", {
        input_path: extracted,
      }),
    };
    const response = await call("correlate_vsix_commands", request);
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    const document = join(root, "request.json");
    await writeFile(document, JSON.stringify(request));
    const result = await cli.run({
      arguments: ["correlate-vsix-commands", document, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    for (const value of [result.json, response.structuredContent]) {
      const report = vsixCommandCorrelationSchema.parse(
        (value as { normalized_result: unknown }).normalized_result,
      );
      expect(
        report.commands.map(({ command, status }) => [command, status]),
      ).toEqual([
        ["demo.gone", "not_found"],
        ["demo.run", "registered"],
      ]);
    }
  },
);
