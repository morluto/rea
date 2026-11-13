import { nugetNupkgSchema } from "../../src/domain/nuget/nupkg.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import { nugetNupkgFixture } from "../../src/nuget/NugetNupkg.fixture.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const completeNupkgEvidenceSchema = toolContract(
  "inspect_nuget_nupkg",
).outputSchema.safeExtend({ normalized_result: nugetNupkgSchema });

cliTest(
  "reports NuGet package identity and dependencies through the public CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-nupkg-cli-");
    const path = join(root, "Demo.Package.1.2.3.nupkg");
    await writeFile(path, await nugetNupkgFixture());
    const result = await cli.run({
      arguments: ["inspect-nuget-nupkg", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = completeNupkgEvidenceSchema.parse(result.json);
    expect(evidence).toMatchObject({
      confidence: "observed",
      subject: { local_path: path, format: "file" },
    });
    expect(evidence.normalized_result.identity).toEqual({
      id: "Demo.Package",
      version: "1.2.3",
      authors: "Alice, Bob",
      description: "A tiny fixture package.",
    });
    expect(evidence.normalized_result.dependency_groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target_framework: "net8.0" }),
      ]),
    );
    expect(
      evidence.normalized_result.contents.some(
        (entry) => entry.role === "lib" && entry.name === "lib/net8.0/Demo.dll",
      ),
    ).toBe(true);
    expect(evidence.normalized_result.coverage.status).toBe("complete");
  },
);

cliTest(
  "matches CLI and MCP observations for the same .nupkg",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-nupkg-cli-mcp-");
    const path = join(root, "Demo.Package.nupkg");
    await writeFile(path, await nugetNupkgFixture());
    const output = await cli.run({
      arguments: ["inspect-nuget-nupkg", path, "--json"],
    });
    expect(output.exitCode, output.stderr).toBe(0);
    const report = completeNupkgEvidenceSchema.parse(
      output.json,
    ).normalized_result;
    const { call } = await connectLocalToolsMcp();
    const reply = await call("inspect_nuget_nupkg", { path });
    expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
    expect(
      completeNupkgEvidenceSchema.parse(reply.structuredContent)
        .normalized_result,
    ).toEqual(report);
  },
);

cliTest("refuses a non-ZIP file through the public CLI", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-nupkg-cli-invalid-");
  const path = join(root, "not-a-package.nupkg");
  await writeFile(path, "not a zip");
  const result = await cli.run({
    arguments: ["inspect-nuget-nupkg", path, "--json"],
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.json).toMatchObject({
    code: "invalid_request",
    category: "invalid_input",
    details: {
      operation: "inspect_nuget_nupkg",
      issues: [
        expect.objectContaining({
          path: ["path"],
          reason: "invalid_format",
          message: expect.stringContaining("not a ZIP"),
        }),
      ],
    },
  });
});
