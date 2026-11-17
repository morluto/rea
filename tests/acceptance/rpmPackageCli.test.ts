import { createHash } from "node:crypto";
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import { parseEvidenceBundle } from "../../src/domain/evidenceBundle.js";
import { RPM_PACKAGE_TOOL_CONTRACTS } from "../../src/contracts/rpm/rpmPackageToolContracts.js";
import { rpmPackageSchema } from "../../src/domain/rpm/package.js";
import {
  encodeRpmPackage,
  RPM_TAG,
  RPM_TYPE,
  rpmBinaryPackageFixture,
  rpmUtf8PackageFixture,
} from "../../src/rpm/RpmPackage.fixture.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const inspectRpmPackageContract = RPM_PACKAGE_TOOL_CONTRACTS.find(
  (candidate) => candidate.name === "inspect_rpm_package",
);
if (inspectRpmPackageContract === undefined)
  throw new Error("Missing inspect_rpm_package contract");

const completeEvidenceSchema =
  inspectRpmPackageContract.outputSchema.safeExtend({
    normalized_result: rpmPackageSchema,
  });

cliTest(
  "reports RPM lead, dependencies and header files through the public CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-rpm-cli-");
    const path = join(root, "demo-1.0.0-1.noarch.rpm");
    await writeFile(path, rpmBinaryPackageFixture());
    const result = await cli.run({
      arguments: ["inspect-rpm-package", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = completeEvidenceSchema.parse(result.json);
    expect(evidence).toMatchObject({
      confidence: "observed",
      subject: { local_path: path, identity: { format: "file" } },
    });
    expect(evidence.normalized_result.package).toMatchObject({
      name: "demo",
      version: "1.0.0",
      release: "1",
      epoch: 2,
    });
    expect(evidence.normalized_result.payload.listing_source).toBe("header");
    expect(evidence.normalized_result.coverage.status).toBe("complete");
  },
);

cliTest(
  "matches CLI and MCP observations for the same RPM",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-rpm-cli-mcp-");
    const path = join(root, "demo.rpm");
    await writeFile(path, rpmBinaryPackageFixture());
    const output = await cli.run({
      arguments: ["inspect-rpm-package", path, "--json"],
    });
    expect(output.exitCode, output.stderr).toBe(0);
    const report = completeEvidenceSchema.parse(output.json).normalized_result;
    const { call } = await connectLocalToolsMcp();
    const reply = await call("inspect_rpm_package", { path });
    expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
    expect(
      completeEvidenceSchema.parse(reply.structuredContent).normalized_result,
    ).toEqual(report);
  },
);

cliTest(
  "resolves a relative RPM path against the working directory",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-rpm-cli-rel-");
    await writeFile(join(root, "demo.rpm"), rpmBinaryPackageFixture());
    const result = await cli.run({
      arguments: ["inspect-rpm-package", "demo.rpm", "--json"],
      cwd: root,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(
      completeEvidenceSchema.parse(result.json).normalized_result.artifact.path,
    ).toBe(join(root, "demo.rpm"));
  },
);

cliTest("refuses a non-RPM file through the public CLI", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-rpm-cli-invalid-");
  const path = join(root, "not-a-package.rpm");
  const bytes = Buffer.from("not an rpm");
  await writeFile(path, bytes);
  const result = await cli.run({
    arguments: ["inspect-rpm-package", path, "--json"],
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.json).toMatchObject({
    code: "unsupported_target",
    details: {
      operation: "inspect_rpm_package",
      partial_observation: {
        kind: "file-snapshot-hash",
        path,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    },
  });
});

cliTest(
  "returns scriptlet text when --include-script-text is selected",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-rpm-cli-script-");
    const path = join(root, "demo.rpm");
    await writeFile(path, rpmBinaryPackageFixture());
    const result = await cli.run({
      arguments: [
        "inspect-rpm-package",
        path,
        "--include-script-text",
        "--json",
      ],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const report = completeEvidenceSchema.parse(result.json).normalized_result;
    expect(report.scriptlets?.find((row) => row.kind === "prein")?.text).toBe(
      "echo prein\n",
    );
  },
);

cliTest(
  "delivers a summary only alongside a saved Evidence bundle",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-rpm-cli-summary-");
    const path = join(root, "demo.rpm");
    await writeFile(path, rpmBinaryPackageFixture());
    const refused = await cli.run({
      arguments: ["inspect-rpm-package", path, "--detail", "summary", "--json"],
    });
    expect(refused.exitCode).not.toBe(0);
    expect(JSON.stringify(refused.json)).toContain("evidence_output");
    const bundle = join(root, "evidence.json");
    const summary = await cli.run({
      arguments: [
        "inspect-rpm-package",
        path,
        "--detail",
        "summary",
        "--evidence_output",
        bundle,
        "--json",
      ],
    });
    expect(summary.exitCode, summary.stderr).toBe(0);
    await expect(stat(bundle)).resolves.toMatchObject({
      size: expect.any(Number),
    });
  },
);

cliTest(
  "returns UTF-8 scriptlet text with its stored byte count",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-rpm-cli-utf8-");
    const path = join(root, "utf8.rpm");
    await writeFile(path, rpmUtf8PackageFixture());
    const result = await cli.run({
      arguments: [
        "inspect-rpm-package",
        path,
        "--include-script-text",
        "--json",
      ],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const scriptlets = completeEvidenceSchema.parse(result.json)
      .normalized_result.scriptlets;
    // "echo é\n" is 7 characters but 8 stored UTF-8 bytes.
    expect(
      scriptlets?.find((scriptlet) => scriptlet.text === "echo é\n")?.bytes,
    ).toBe(8);
  },
);

cliTest(
  "preserves transport URL provenance and caller choices through CLI, MCP and retained views",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-rpm-url-");
    const path = join(root, "url.rpm");
    const source = "token=visible password=source-data";
    await writeFile(
      path,
      encodeRpmPackage({
        headerTags: [
          {
            tag: RPM_TAG.url,
            type: RPM_TYPE.string,
            string:
              "HTTPS://fixture-user:fixture-password@Example.invalid/a/../b?token=visible",
          },
          { tag: RPM_TAG.prein, type: RPM_TYPE.string, string: source },
        ],
      }),
    );
    const { call } = await connectLocalToolsMcp();
    for (const include of [false, true]) {
      const output = await cli.run({
        arguments: [
          "inspect-rpm-package",
          path,
          "--json",
          ...(include ? ["--include-script-text"] : []),
        ],
      });
      expect(output.exitCode, output.stderr).toBe(0);
      const cliEvidence = completeEvidenceSchema.parse(output.json);
      expect(cliEvidence.parameters).toEqual({
        path,
        ...(include ? { include_script_text: true } : {}),
      });
      const input = { path, include_script_text: include, max_files: 16384 };
      const response = await call("inspect_rpm_package", input);
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      const evidence = completeEvidenceSchema.parse(response.structuredContent);
      expect(evidence.parameters).toEqual(input);
      expect(evidence.normalized_result).toEqual(cliEvidence.normalized_result);
      expect(evidence.normalized_result.package).toMatchObject({
        url: "HTTPS://Example.invalid/a/../b?token=visible",
        url_credentials_redacted: true,
      });
      expect(evidence.normalized_result.scriptlets?.[0]?.text).toBe(
        include ? source : null,
      );
      const view = await call("inspect_analysis_view", {
        source: {
          kind: "retained-evidence",
          evidence_id: evidence.evidence_id,
        },
        view: { kind: "summary" },
      });
      expect(view.isError, JSON.stringify(view)).not.toBe(true);
      expect(JSON.stringify(view.structuredContent)).toContain(
        "HTTPS://Example.invalid/a/../b?token=visible",
      );
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
      expect(
        JSON.stringify({ output: output.json, response, view, retained }),
      ).not.toContain("fixture-password");
    }
  },
);

cliTest(
  "distinguishes physical read admission from parser inventory limits through CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-rpm-limits-");
    const path = join(root, "demo.rpm");
    const bytes = rpmBinaryPackageFixture();
    await writeFile(path, bytes);
    const { call } = await connectLocalToolsMcp();
    for (const [field, maximum, resource] of [
      ["max_file_bytes", 16, "file-size"],
      ["max_files", 1, "memory"],
    ] as const) {
      const output = await cli.run({
        arguments: [
          "inspect-rpm-package",
          path,
          `--${field.replaceAll("_", "-")}`,
          String(maximum),
          "--json",
        ],
      });
      expect(output.exitCode).not.toBe(0);
      const response = await call("inspect_rpm_package", {
        path,
        [field]: maximum,
      });
      expect(response.isError).toBe(true);
      for (const value of [output.json, parseMcpToolError(response).error]) {
        expect(value).toMatchObject({
          code: "resource_constraint",
          details: { resource, reported_limits: { boundary: field, maximum } },
        });
      }
    }
  },
);
