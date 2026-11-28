import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { vsixRegistrationCorrelationSchema } from "../../../src/domain/vsix/vsixRegistrationCorrelation.js";
import { vsixPackageFixture } from "../../../src/vsix/VsixPackage.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";

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
    const response = await call("correlate_vsix_registrations", request);
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    const document = join(root, "request.json");
    await writeFile(document, JSON.stringify(request));
    const result = await cli.run({
      arguments: ["correlate-vsix-registrations", document, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    for (const value of [result.json, response.structuredContent]) {
      const report = vsixRegistrationCorrelationSchema.parse(
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

cliTest(
  "delivers a retained summary for a correlation above the agent budget",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-vsix-summary-");
    const vsix = join(root, "demo.vsix");
    const extracted = join(root, "extracted");
    await mkdir(extracted);
    const manifest = JSON.stringify({
      name: "hello",
      publisher: "demo",
      version: "1.2.3",
      main: "./extension.js",
      contributes: {
        commands: Array.from({ length: 600 }, (_, index) => ({
          command: `demo.command${String(index)}`,
        })),
      },
    });
    await writeFile(vsix, await vsixPackageFixture({ packageJson: manifest }));
    await writeFile(join(extracted, "extension.js"), SOURCE);
    // The shipped delivery, without the test suite's complete-Evidence seed.
    const { call } = await connectLocalToolsMcp(
      {},
      undefined,
      undefined,
      undefined,
      "budgeted",
    );
    const source = async (name: string, input: Record<string, unknown>) => {
      const response = await call(name, { ...input, detail: "complete" });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      const { evidence_id } = response.structuredContent as {
        evidence_id: string;
      };
      return { kind: "retained-evidence", evidence_id };
    };
    const request = {
      vsix_package: await source("inspect_vsix_package", { path: vsix }),
      javascript_application: await source("analyze_javascript_application", {
        input_path: extracted,
      }),
    };
    for (const detail of [undefined, "summary"]) {
      const response = await call("correlate_vsix_registrations", {
        ...request,
        ...(detail === undefined ? {} : { detail }),
      });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      expect(response.structuredContent).toMatchObject({
        normalized_result: {
          kind: "summary",
          parent_operation: "correlate_vsix_registrations",
          summary: { command_count: 601, summary: { declared: 600 } },
        },
      });
    }
    const complete = await call("correlate_vsix_registrations", {
      ...request,
      detail: "complete",
    });
    expect(complete.structuredContent).toHaveProperty(
      "normalized_result.commands",
    );
  },
);
