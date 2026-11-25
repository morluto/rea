import { nugetNupkgSchema } from "../../src/domain/nuget/nupkg.js";
import { createHash } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { ANALYSIS_VIEW_TOOL_CONTRACTS } from "../../src/contracts/analysisViewToolContracts.js";
import { NUGET_NUPKG_TOOL_CONTRACTS } from "../../src/contracts/nuget/nupkgToolContracts.js";
import { toolContract } from "../../src/contracts/toolContracts.js";
import { nugetNupkgSummaryViewResultSchema } from "../../src/domain/analysisView/analysisViewResult.js";
import { parseEvidenceBundle } from "../../src/domain/evidenceBundle.js";
import { contractNamed } from "../../src/cli/contractCliDescription.js";
import {
  nugetNupkgFixture,
  nugetNupkgNameEncodingFixture,
} from "../../src/nuget/NugetNupkg.fixture.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const nupkgContract = contractNamed(
  NUGET_NUPKG_TOOL_CONTRACTS,
  "inspect_nuget_nupkg",
);
const analysisViewContract = contractNamed(
  ANALYSIS_VIEW_TOOL_CONTRACTS,
  "inspect_analysis_view",
);
const completeNupkgEvidenceSchema = nupkgContract.outputSchema.safeExtend({
  normalized_result: nugetNupkgSchema,
});

cliTest(
  "preserves ZIP filename bytes and encoding uncertainty through CLI, MCP and retained views",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-nupkg-name-provenance-");
    const path = join(root, "mixed-names.nupkg");
    const bytes = await nugetNupkgNameEncodingFixture();
    await writeFile(path, bytes);
    const artifact = {
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    const output = await cli.run({
      arguments: ["inspect-nuget-nupkg", path, "--json"],
    });
    expect(output.exitCode, output.stderr).toBe(0);
    const cliEvidence = completeNupkgEvidenceSchema.parse(output.json);
    expect(cliEvidence).toMatchObject({
      confidence: "observed",
      subject: { local_path: path, identity: { format: "file" } },
      normalized_result: {
        artifact: { ...artifact, bytes: bytes.length },
        identity: {
          id: "Demo.Package",
          version: "1.2.3",
          authors: "Alice, Bob",
          description: "A tiny fixture package.",
        },
        dependency_groups: [
          {
            target_framework: "net8.0",
            dependencies: [{ id: "Newtonsoft.Json", version: "13.0.1" }],
          },
          {
            target_framework: "netstandard2.0",
            dependencies: [
              { id: "Newtonsoft.Json", version: "[12.0.3,13.0.0)" },
            ],
          },
        ],
        coverage: { status: "complete", entries: 5 },
      },
    });
    const { call } = await connectLocalToolsMcp();
    const response = await call("inspect_nuget_nupkg", { path });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    const evidence = completeNupkgEvidenceSchema.parse(
      response.structuredContent,
    );
    expect(evidence.normalized_result).toEqual(cliEvidence.normalized_result);
    expect(
      evidence.normalized_result.contents.filter(({ role }) => role === "lib"),
    ).toEqual(
      ["é.dll", "demo.dll", "π.dll", "café.dll"].map((file) =>
        expect.objectContaining({
          name: `lib/net8.0/${file}`,
          path: `lib/net8.0/${file}`,
        }),
      ),
    );
    const warnings = evidence.normalized_result.limitations.filter((message) =>
      message.includes("CP437"),
    );
    expect(warnings).toEqual([
      expect.stringMatching(
        /ZIP member "lib\/net8\.0\/é\.dll".*CP437 fallback; source encoding unverified; raw hex: 6c69622f6e6574382e302f822e646c6c/u,
      ),
    ]);
    const [warning] = warnings;
    expect(evidence.limitations).toContain(warning);

    await unlink(path);
    const view = await call("inspect_analysis_view", {
      source: { kind: "retained-evidence", evidence_id: evidence.evidence_id },
      view: { kind: "summary" },
    });
    expect(view.isError, JSON.stringify(view)).not.toBe(true);
    const summary = nugetNupkgSummaryViewResultSchema.parse(
      analysisViewContract.outputSchema.parse(view.structuredContent)
        .normalized_result,
    );
    expect(summary).toMatchObject({
      parent_evidence_id: evidence.evidence_id,
      artifact,
    });
    expect(
      summary.limitations.filter((message) => message.includes("CP437")),
    ).toEqual([warning]);
    const retained = await call("get_evidence_bundle", { detail: "complete" });
    expect(retained.isError, JSON.stringify(retained)).not.toBe(true);
    const bundle = parseEvidenceBundle(
      toolContract("get_evidence_bundle").outputSchema.parse(
        retained.structuredContent,
      ).result,
    );
    expect(
      bundle.records.find(
        ({ evidence_id }) => evidence_id === evidence.evidence_id,
      ),
    ).toEqual(evidence);
  },
);

cliTest(
  "matches NuGet's field namespaces and license type through CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-nupkg-cli-mcp-");
    const path = join(root, "Demo.Package.nupkg");
    await writeFile(
      path,
      await nugetNupkgFixture({
        nuspec: `<package xmlns="http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd" xmlns:ext="urn:example">
          <ext:metadata>
            <ext:id>Extension</ext:id><id>Demo.Package</id>
            <ext:version>9.0.0</ext:version><version>1.2.3</version>
            <ext:license type="expression">ISC</ext:license><license type="EXPRESSION">MIT</license>
            <ext:repository type="git" url="https://example.invalid/extension" />
            <repository type="git" url="https://example.invalid/declared" />
            <ext:authors>Alice</ext:authors><authors>Second author</authors>
            <ext:description>First description.</ext:description><description>Second description.</description>
            <dependencies>
              <ext:group targetFramework="net8.0"><ext:dependency id="Extension" /></ext:group>
              <dependency id="Declared" version="1.0" />
            </dependencies>
          </ext:metadata>
        </package>`,
      }),
    );
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
    expect(report).toMatchObject({
      identity: {
        id: "Demo.Package",
        version: "1.2.3",
        authors: "Alice",
        description: "First description.",
      },
      license: { type: "expression", value: "MIT" },
      repository: { url: "https://example.invalid/declared" },
      dependency_groups: [
        { target_framework: null, dependencies: [{ id: "Declared" }] },
      ],
    });
  },
);

cliTest("refuses a non-ZIP file through the public CLI", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-nupkg-cli-invalid-");
  const path = join(root, "not-a-package.nupkg");
  await writeFile(path, "not a zip");
  const result = await cli.run({
    arguments: ["inspect-nuget-nupkg", path, "--json"],
  });
  expect(result.exitCode, result.stderr).toBe(1);
  expect(result.json).toMatchObject({
    code: "unsupported_target",
    category: "unsupported_target",
    details: {
      operation: "inspect_nuget_nupkg",
      failure_kind: "malformed",
      reason: expect.stringContaining("not a ZIP"),
    },
  });
});

cliTest(
  "preserves selected budgets and redacts transport userinfo through CLI, MCP and retained views",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-nupkg-provenance-");
    const path = join(root, "pkg.nupkg");
    const nuspec = `<package><metadata><id>Credentials.Package</id><version>1</version><repository type="git" url="HTTPS://user:password@Example.invalid/a/../b?token=visible#hash" /></metadata></package>`;
    const rels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="http://schemas.microsoft.com/packaging/2010/07/manifest" TargetMode="External" Target="https://user:password@feed.invalid/package?token=visible" /><Relationship Type="http://schemas.microsoft.com/packaging/2010/07/manifest" Target="//user:password@feed.invalid/missing.nuspec?token=visible" /></Relationships>`;
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
      if (maximum !== 8192) continue;
      await unlink(path);
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
