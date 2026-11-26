import { vsixPackageSchema } from "../../src/domain/vsix/vsixPackage.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { VSIX_PACKAGE_TOOL_CONTRACTS } from "../../src/contracts/vsix/vsixPackageToolContracts.js";
import { toolContract } from "../../src/contracts/toolContracts.js";
import { parseEvidenceBundle } from "../../src/domain/evidenceBundle.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { artifactInspectionResultSchema } from "../../src/domain/artifactInspection.js";
import { contractNamed } from "../../src/cli/contractCliDescription.js";
import {
  vsixPackageFixture,
  vsixPackageMalformedManifestFixture,
} from "../../src/vsix/VsixPackage.fixture.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const vsixContract = contractNamed(
  VSIX_PACKAGE_TOOL_CONTRACTS,
  "inspect_vsix_package",
);
const completeVsixEvidenceSchema = vsixContract.outputSchema.safeExtend({
  normalized_result: vsixPackageSchema,
});

cliTest(
  "reports VS Code extension identity and activation through the public CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-vsix-cli-");
    const path = join(root, "demo.hello-1.2.3.vsix");
    await writeFile(path, await vsixPackageFixture({ includeSignature: true }));
    const result = await cli.run({
      arguments: ["inspect-vsix-package", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = completeVsixEvidenceSchema.parse(result.json);
    expect(evidence).toMatchObject({
      confidence: "observed",
      subject: { local_path: path, identity: { format: "file" } },
    });
    expect(evidence.normalized_result.vsix_identity).toEqual({
      id: "demo.hello",
      version: "1.2.3",
      publisher: "demo",
      target_platform: "win32-x64",
      display_name: "Hello Demo",
      description: "A tiny fixture extension.",
    });
    expect(evidence.normalized_result.package_identity).toEqual({
      name: "hello",
      publisher: "demo",
      version: "1.2.3",
    });
    expect(
      evidence.normalized_result.activation_events.some(
        (event) => event.event === "*" && event.eager,
      ),
    ).toBe(true);
    expect(evidence.normalized_result.signatures).toEqual({
      p7s: true,
      manifest: true,
    });
    expect(evidence.normalized_result.coverage.status).toBe("complete");
  },
);

cliTest(
  "matches CLI and MCP observations for the same .vsix",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-vsix-cli-mcp-");
    const path = join(root, "demo.hello.vsix");
    await writeFile(path, await vsixPackageFixture());
    const output = await cli.run({
      arguments: ["inspect-vsix-package", path, "--json"],
    });
    expect(output.exitCode, output.stderr).toBe(0);
    const report = completeVsixEvidenceSchema.parse(
      output.json,
    ).normalized_result;
    const { call } = await connectLocalToolsMcp();
    const reply = await call("inspect_vsix_package", { path });
    expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
    expect(
      completeVsixEvidenceSchema.parse(reply.structuredContent)
        .normalized_result,
    ).toEqual(report);
  },
);

cliTest.for([
  { kind: "non-ZIP", bytes: Buffer.from("not a zip"), reason: "not a ZIP" },
  {
    kind: "ZIP with no central directory",
    bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    reason: "ZIP archive is malformed",
  },
])("refuses a $kind file through the public CLI", async (input, { cli }) => {
  const root = await createTestTempDirectory("rea-vsix-cli-invalid-");
  const path = join(root, "not-an-extension.vsix");
  await writeFile(path, input.bytes);
  const result = await cli.run({
    arguments: ["inspect-vsix-package", path, "--json"],
  });
  expect(result.exitCode, result.stderr).toBe(1);
  expect(result.json).toMatchObject({
    code: "unsupported_target",
    category: "unsupported_target",
    details: {
      operation: "inspect_vsix_package",
      failure_kind: "malformed",
      reason: expect.stringContaining(input.reason),
    },
  });
});

cliTest(
  "returns inventory with limitations for a malformed vsixmanifest",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-vsix-cli-malformed-");
    const path = join(root, "broken.vsix");
    await writeFile(path, await vsixPackageMalformedManifestFixture());
    const result = await cli.run({
      arguments: ["inspect-vsix-package", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = completeVsixEvidenceSchema.parse(result.json);
    expect(evidence.normalized_result.vsix_identity).toBeNull();
    expect(evidence.normalized_result.package_identity?.name).toBe("hello");
    expect(evidence.normalized_result.limitations).toEqual(
      expect.arrayContaining([expect.stringContaining("not well-formed XML")]),
    );
  },
);

cliTest(
  "preserves selected budgets through CLI, MCP and retained views",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-vsix-provenance-");
    const path = join(root, "pkg.vsix");
    await writeFile(path, await vsixPackageFixture());
    const { call } = await connectLocalToolsMcp();
    for (const maximum of [undefined, 67108864, 8192]) {
      const input = {
        path,
        ...(maximum === undefined ? {} : { max_file_bytes: maximum }),
      };
      const output = await cli.run({
        arguments: [
          "inspect-vsix-package",
          "./pkg.vsix",
          "--json",
          ...(maximum === undefined
            ? []
            : ["--max-file-bytes", String(maximum)]),
        ],
        cwd: root,
      });
      expect(output.exitCode, output.stderr).toBe(0);
      const cliEvidence = completeVsixEvidenceSchema.parse(output.json);
      expect(cliEvidence.caller_input_path).toBe("./pkg.vsix");
      expect(cliEvidence.parameters).toEqual(input);
      const reply = await call("inspect_vsix_package", input);
      expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
      const evidence = completeVsixEvidenceSchema.parse(
        reply.structuredContent,
      );
      expect(evidence.parameters).toEqual(input);
      expect(evidence.normalized_result).toEqual(cliEvidence.normalized_result);
      const view = await call("inspect_analysis_view", {
        source: {
          kind: "retained-evidence",
          evidence_id: evidence.evidence_id,
        },
        view: { kind: "summary" },
      });
      expect(view.isError, JSON.stringify(view)).not.toBe(true);
      expect(JSON.stringify(view.structuredContent)).toContain("demo.hello");
      const retained = await call("get_evidence_bundle", {
        detail: "complete",
      });
      expect(retained.isError, JSON.stringify(retained)).not.toBe(true);
      const bundle = parseEvidenceBundle(
        toolContract("get_evidence_bundle").outputSchema.parse(
          retained.structuredContent,
        ).result,
      );
      expect(
        bundle.records.find(
          (record) => record.evidence_id === evidence.evidence_id,
        ),
      ).toEqual(evidence);
    }
  },
);

cliTest(
  "accepts three manifests within max-manifest-bytes through CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-vsix-three-manifests-");
    const path = join(root, "dir-main.vsix");
    const vsixmanifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Id="demo.hello" Version="1.2.3" Publisher="demo" />
    <DisplayName>Hello Demo</DisplayName>
    <Description xml:space="preserve">${"x".repeat(350)}</Description>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" />
  </Assets>
</PackageManifest>
`;
    const packageJson = JSON.stringify({
      name: "hello",
      publisher: "demo",
      version: "1.2.3",
      engines: { vscode: "^1.74.0" },
      main: "./out",
      description: "p".repeat(780),
    });
    const outPackageJson = JSON.stringify({
      main: "./start.js",
      padding: "q".repeat(860),
    });
    await writeFile(
      path,
      await vsixPackageFixture({
        vsixmanifest,
        packageJson,
        includeMain: false,
        extraMembers: {
          "extension/out/package.json": outPackageJson,
          "extension/out/start.js": "exports.activate = () => {};",
        },
      }),
    );
    const output = await cli.run({
      arguments: [
        "inspect-vsix-package",
        path,
        "--json",
        "--max-manifest-bytes",
        "1024",
      ],
    });
    expect(output.exitCode, output.stderr).toBe(0);
    const cliReport = completeVsixEvidenceSchema.parse(
      output.json,
    ).normalized_result;
    expect(cliReport.entry_points.main).toEqual({
      path: "extension/out/start.js",
      present: true,
    });
    expect(cliReport.coverage.examined_manifest_bytes).toBeGreaterThan(2048);
    const { call } = await connectLocalToolsMcp();
    const reply = await call("inspect_vsix_package", {
      path,
      max_manifest_bytes: 1024,
    });
    expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
    const mcpReport = completeVsixEvidenceSchema.parse(
      reply.structuredContent,
    ).normalized_result;
    expect(mcpReport.entry_points.main).toEqual({
      path: "extension/out/start.js",
      present: true,
    });
    expect(mcpReport.coverage.examined_manifest_bytes).toBeGreaterThan(2048);
    expect(mcpReport).toEqual(cliReport);
  },
);

cliTest(
  "points first-contact inspection of a .vsix to the VSIX reader",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-vsix-first-contact-");
    const path = join(root, "demo.hello.vsix");
    await writeFile(path, await vsixPackageFixture());
    const inspected = await cli.run({
      arguments: ["inspect-artifact", path, "--json"],
    });
    expect(inspected.exitCode, inspected.stdout + inspected.stderr).toBe(0);
    const inspection = artifactInspectionResultSchema.parse(
      parseEvidence(inspected.json).normalized_result,
    );
    expect(inspection.next_probes.map((probe) => probe.operation)).toContain(
      "inspect_vsix_package",
    );
  },
);
