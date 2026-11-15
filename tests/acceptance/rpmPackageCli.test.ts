import { createHash } from "node:crypto";
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { RPM_PACKAGE_TOOL_CONTRACTS } from "../../src/contracts/rpm/rpmPackageToolContracts.js";
import { rpmPackageSchema } from "../../src/domain/rpm/package.js";
import {
  rpmBinaryPackageFixture,
  rpmUtf8PackageFixture,
} from "../../src/rpm/RpmPackage.fixture.js";
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
