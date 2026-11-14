import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import { rpmPackageSchema } from "../../src/domain/rpm/package.js";
import { rpmBinaryPackageFixture } from "../../src/rpm/RpmPackage.fixture.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const completeEvidenceSchema = toolContract(
  "inspect_rpm_package",
).outputSchema.safeExtend({ normalized_result: rpmPackageSchema });

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
      subject: { local_path: path, format: "file" },
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
