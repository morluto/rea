import { nugetNupkgSchema } from "../../src/domain/nuget/nupkg.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { NUGET_NUPKG_TOOL_CONTRACTS } from "../../src/contracts/nuget/nupkgToolContracts.js";
import { contractNamed } from "../../src/cli/contractCliDescription.js";
import { nugetNupkgFixture } from "../../src/nuget/NugetNupkg.fixture.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const nupkgContract = contractNamed(
  NUGET_NUPKG_TOOL_CONTRACTS,
  "inspect_nuget_nupkg",
);
const completeNupkgEvidenceSchema = nupkgContract.outputSchema.safeExtend({
  normalized_result: nugetNupkgSchema,
});

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
      subject: { local_path: path, identity: { format: "file" } },
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

cliTest(
  "preserves selected budgets and redacts transport userinfo through CLI, MCP and retained views",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-nupkg-provenance-");
    const path = join(root, "pkg.nupkg");
    const nuspec = `<package><metadata><id>Credentials.Package</id><version>1</version><repository type="git" url="HTTPS://user:password@Example.invalid/a/../b?token=visible#hash" /></metadata></package>`;
    const rels = `<Relationships><Relationship Type="http://schemas.microsoft.com/packaging/2010/07/manifest" TargetMode="External" Target="https://user:password@feed.invalid/package?token=visible" /><Relationship Type="http://schemas.microsoft.com/packaging/2010/07/manifest" Target="//user:password@feed.invalid/missing.nuspec?token=visible" /></Relationships>`;
    await writeFile(
      path,
      await nugetNupkgFixture({
        nuspec,
        includeRels: false,
        extraMembers: { "_rels/.rels": rels },
      }),
    );
    const { call } = await connectLocalToolsMcp();
    for (const maximum of [undefined, 67108864, 8192]) {
      const input = {
        path,
        ...(maximum === undefined ? {} : { max_file_bytes: maximum }),
      };
      const output = await cli.run({
        arguments: [
          "inspect-nuget-nupkg",
          "./pkg.nupkg",
          "--json",
          ...(maximum === undefined
            ? []
            : ["--max-file-bytes", String(maximum)]),
        ],
        cwd: root,
      });
      expect(output.exitCode, output.stderr).toBe(0);
      const cliEvidence = completeNupkgEvidenceSchema.parse(output.json);
      expect(cliEvidence.caller_input_path).toBe("./pkg.nupkg");
      expect(cliEvidence.parameters).toEqual(input);
      const reply = await call("inspect_nuget_nupkg", input);
      expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
      const evidence = completeNupkgEvidenceSchema.parse(
        reply.structuredContent,
      );
      expect(evidence.parameters).toEqual(input);
      expect(evidence.normalized_result).toEqual(cliEvidence.normalized_result);
      expect(evidence.normalized_result.repository).toMatchObject({
        url: "HTTPS://Example.invalid/a/../b?token=visible#hash",
        url_credentials_redacted: true,
      });
      expect(JSON.stringify(evidence)).not.toContain("user:password");
      expect(evidence.normalized_result.limitations.join(" ")).toContain(
        "https://feed.invalid/package?token=visible",
      );
      expect(evidence.normalized_result.limitations.join(" ")).toContain(
        "//feed.invalid/missing.nuspec?token=visible",
      );
      const view = await call("inspect_analysis_view", {
        source: {
          kind: "retained-evidence",
          evidence_id: evidence.evidence_id,
        },
        view: { kind: "summary" },
      });
      expect(view.isError, JSON.stringify(view)).not.toBe(true);
      expect(JSON.stringify(view.structuredContent)).not.toContain(
        "user:password",
      );
      expect(JSON.stringify(view.structuredContent)).toContain(
        "HTTPS://Example.invalid/a/../b?token=visible#hash",
      );
    }
  },
);
