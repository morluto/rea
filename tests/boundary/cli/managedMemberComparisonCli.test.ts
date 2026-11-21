import { createHash } from "node:crypto";
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { managedMemberInspectionSchema } from "../../../src/domain/managed/managedArtifact.js";
import { managedMemberComparisonResultSchema } from "../../../src/domain/managed/managedMemberComparison.js";
import { buildManagedPeFixture } from "../../../src/dotnet/ManagedPe.fixture.js";
import { comparisonLimitations } from "../../../src/domain/managed/managedMemberComparisonCoverage.js";
import { buildManagedMemberSelectionCapacityFixture } from "../../fixtures/managedMemberCapacity.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { managedComparisonCommand } from "../../fixtures/managedComparisonCommand.js";
import { createDirectAnalysis } from "../../../src/composition/directAnalysis.js";
import { OwnedFileHandle } from "../../../src/filesystem/OwnedFileHandle.js";

cliTest(
  "compares proven same-artifact TypeSpec rows through CLI and MCP",
  async ({ cli }) => {
    const directory = await createTestTempDirectory("rea-typespec-row-proof-");
    const call = await cli.sharedMcpCall!();
    for (const [name, token, spec, resolved] of [
      ["resolved", 0x0a000001, [0x1d, 8], true],
      ["missing-row", 0x0a000002, [0x1d, 8], false],
      ["malformed-owner", 0x0a000001, [0x7f], false],
    ] as const) {
      const operand = Buffer.alloc(4);
      operand.writeUInt32LE(token);
      const bytes = buildManagedPeFixture({
        memberRefParentRaw: 12,
        memberRefSignature: Buffer.from([0, 0, 1]),
        typeSpecSignatures: [Buffer.from(spec)],
        ilBody: Buffer.concat([
          Buffer.from([0x1a, 0x28]),
          operand,
          Buffer.from([0x2a]),
        ]),
      });
      const leftPath = join(directory, `${name}.dll`);
      const rightPath = join(directory, `${name}-copy.dll`);
      await writeFile(leftPath, bytes);
      await writeFile(rightPath, bytes);
      const inspection = await cli.run({
        arguments: ["inspect-managed-members", leftPath, "--json"],
      });
      expect(inspection.exitCode, inspection.stderr).toBe(0);
      const left = parseEvidence(inspection.json);
      const facts = managedMemberInspectionSchema.parse(left.normalized_result);
      expect(facts.call_edges[0]).toMatchObject({
        target_identity_sha256: null,
        target_row_resolved: resolved,
      });
      const other = await call("inspect_managed_members", { path: rightPath });
      expect(other.isError, JSON.stringify(other)).not.toBe(true);
      const right = parseEvidence(other.structuredContent);
      const compared = await cli.run({
        arguments: ["compare-managed-members", leftPath, rightPath, "--json"],
      });
      expect(compared.exitCode, compared.stderr).toBe(0);
      const mcp = await call("compare_managed_members", { left, right });
      expect(mcp.isError, JSON.stringify(mcp)).not.toBe(true);
      for (const evidence of [
        parseEvidence(compared.json),
        parseEvidence(mcp.structuredContent),
      ]) {
        const result = managedMemberComparisonResultSchema.parse(
          evidence.normalized_result,
        );
        expect(result.left.artifact_sha256).toBe(facts.artifact.sha256);
        expect(result.right.artifact_sha256).toBe(facts.artifact.sha256);
        expect(result.methods[0]?.status).toBe(
          resolved ? "unchanged" : "unknown",
        );
      }
    }
  },
);

cliTest(
  "attributes malformed managed comparison input to its selected argument and retains completed peer Evidence",
  async ({ cli }) => {
    const directory = await createTestTempDirectory(
      "rea-managed-malformed-cli-",
    );
    const good = join(directory, "good.dll");
    const peer = join(directory, "peer.dll");
    const bad = join(directory, "bad.dll");
    const bytes = buildManagedPeFixture();
    await writeFile(good, bytes);
    await writeFile(peer, bytes);
    bytes.writeUInt16LE(0, bytes.readUInt32LE(0x3c) + 6);
    await writeFile(bad, bytes);

    const healthy = await cli.run({
      arguments: [
        "compare-managed-members",
        good,
        peer,
        "--max-snapshot-bytes",
        String(bytes.length),
        "--max-metadata-representation-bytes",
        "1048576",
        "--json",
      ],
    });
    expect(healthy.exitCode, healthy.stderr).toBe(0);
    expect(healthy.json).toMatchObject({
      operation: "compare_managed_members",
      parameters: {
        left_path: good,
        right_path: peer,
        max_snapshot_bytes: bytes.length,
        max_metadata_representation_bytes: 1048576,
      },
    });

    // A source refused by its snapshot budget names the source option that
    // raises it; the remediation names only the contract field.
    const refused = await cli.run({
      arguments: [
        "compare-managed-members",
        good,
        peer,
        "--max-snapshot-bytes",
        String(bytes.length - 1),
        "--json",
      ],
    });
    expect(refused.exitCode, refused.stderr).toBe(1);
    expect(refused.json).toMatchObject({
      details: {
        limit: {
          control_kind: "parameter",
          parameter: "max_snapshot_bytes",
          cli_flag: "--max-snapshot-bytes",
        },
      },
    });
    expect(
      JSON.stringify((refused.json as { remediation: unknown }).remediation),
    ).not.toContain("--max-snapshot-bytes");

    for (const field of ["leftPath", "rightPath"] as const) {
      const result = await cli.run({
        arguments: [
          "compare-managed-members",
          field === "leftPath" ? bad : good,
          field === "rightPath" ? bad : good,
          "--json",
        ],
      });
      expect(result.exitCode, result.stderr).toBe(1);
      expect(result.json).toMatchObject({
        code: "invalid_request",
        category: "invalid_input",
        retryable: false,
        details: {
          issues: [
            {
              path: [field],
              reason: "invalid_format",
              message: `Selected artifact ${bad}: PE section count must be positive`,
            },
          ],
        },
      });
      if (field === "rightPath")
        expect(result.json).toMatchObject({
          details: {
            argument_observations: [
              {
                argument: "left",
                observation: {
                  operation: "inspect_managed_members",
                  subject: { local_path: good },
                },
              },
            ],
          },
        });
      else
        expect(result.json).not.toHaveProperty("details.argument_observations");
      expect(result.json).not.toHaveProperty("details.partial_observation");
    }

    const inspection = await cli.run({
      arguments: ["inspect-managed-members", bad, "--json"],
    });
    expect(inspection.exitCode, inspection.stderr).toBe(1);
    expect(inspection.json).toMatchObject({
      code: "invalid_request",
      category: "invalid_input",
      details: {
        issues: [
          {
            path: ["path"],
            reason: "invalid_format",
            message: `Selected artifact ${bad}: PE section count must be positive`,
          },
        ],
      },
    });
  },
);

cliTest(
  "keeps malformed signatures unknown through CLI and stdio MCP comparison while a valid control stays unchanged",
  async ({ cli }) => {
    const directory = await createTestTempDirectory(
      "rea-managed-signature-cli-",
    );
    const call = await cli.sharedMcpCall!();
    for (const malformed of [true, false]) {
      const name = malformed ? "truncated" : "control";
      const path = join(directory, `${name}.dll`);
      const peerPath = join(directory, `${name}-peer.dll`);
      const bytes = buildManagedPeFixture({
        methodSignature: Buffer.from(
          malformed ? [0x00, 0x80] : [0x00, 0x00, 0x01],
        ),
        ilBody: Buffer.from([0x06, 0x2a]),
      });
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      await writeFile(path, bytes);
      await writeFile(peerPath, bytes);
      const inspected = await cli.run({
        arguments: ["inspect-managed-members", path, "--json"],
      });
      expect(inspected.exitCode, inspected.stderr).toBe(0);
      const cliEvidence = parseEvidence(inspected.json);
      const mcpInspected = await call("inspect_managed_members", {
        path: peerPath,
      });
      expect(mcpInspected.isError, JSON.stringify(mcpInspected)).not.toBe(true);
      const mcpEvidence = parseEvidence(mcpInspected.structuredContent);
      for (const [evidence, sourcePath] of [
        [cliEvidence, path],
        [mcpEvidence, peerPath],
      ] as const) {
        const report = managedMemberInspectionSchema.parse(
          evidence.normalized_result,
        );
        expect(report.artifact).toMatchObject({ path: sourcePath, sha256 });
        expect(report.coverage.state).toBe(malformed ? "partial" : "complete");
        expect(report.methods[0]?.signature).toMatchObject({
          parse_status: malformed ? "malformed" : "decoded",
          ...(malformed
            ? { issue: "truncated compressed integer", resolved_sha256: null }
            : {}),
        });
      }
      const compared = await cli.run({
        arguments: ["compare-managed-members", path, peerPath, "--json"],
      });
      expect(compared.exitCode, compared.stderr).toBe(0);
      // Identical bytes under separate paths provide distinct authenticated
      // observations, as each comparison's Evidence inputs must differ.
      const mcpCompared = await call("compare_managed_members", {
        left: cliEvidence,
        right: mcpEvidence,
      });
      expect(mcpCompared.isError, JSON.stringify(mcpCompared)).not.toBe(true);
      for (const evidence of [
        parseEvidence(compared.json),
        parseEvidence(mcpCompared.structuredContent),
      ]) {
        const report = managedMemberComparisonResultSchema.parse(
          evidence.normalized_result,
        );
        expect(report.left.artifact_sha256).toBe(sha256);
        expect(report.right.artifact_sha256).toBe(sha256);
        expect(report.coverage.status).toBe(
          malformed ? "partial" : "complete-within-inputs",
        );
        expect(report.summary).toEqual({
          unchanged: malformed ? 1 : 2,
          changed: 0,
          added: 0,
          removed: 0,
          unknown: malformed ? 1 : 0,
        });
        expect(report.methods).toEqual([
          expect.objectContaining({
            status: malformed ? "unknown" : "unchanged",
            match: expect.objectContaining({
              status: "matched",
              basis: "exact-il-signature",
              confidence: "exact",
            }),
            limitations: malformed
              ? [expect.objectContaining({ code: "signature-malformed" })]
              : [],
          }),
        ]);
        expect(report.fields[0]?.status).toBe("unchanged");
      }
    }
  },
);

cliTest(
  "surfaces one side's member capacity limit in the comparison and recovers with a shared --type selection",
  async ({ cli }) => {
    const directory = await createTestTempDirectory("rea-managed-capacity-");
    const left = join(directory, "left.dll");
    const right = join(directory, "right.dll");
    await writeFile(
      left,
      buildManagedPeFixture({
        additionalEmptyTypes: 1,
        fieldRowCount: 2,
        methodRowCount: 2,
        firstTypeFieldRowCount: 1,
        firstTypeMethodRowCount: 1,
        distinctMemberNames: true,
      }),
    );
    await writeFile(right, buildManagedMemberSelectionCapacityFixture(1));
    const call = await cli.sharedMcpCall!();
    const sources = [];
    for (const path of [left, right]) {
      const reply = await call("inspect_managed_members", { path });
      expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
      const evidence = parseEvidence(reply.structuredContent);
      sources.push({
        evidence,
        report: managedMemberInspectionSchema.parse(evidence.normalized_result),
      });
    }
    const [leftSource, rightSource] = sources;
    if (leftSource === undefined || rightSource === undefined)
      throw new Error("Missing source inspection");
    const limits = rightSource.report.coverage.issues.filter(
      ({ code }) => code === "resource-limit",
    );
    expect(limits).toEqual([
      expect.objectContaining({
        code: "resource-limit",
        scope: "metadata.representation",
        // The fixture sits within a few hundred bytes of the 64 MiB budget, so
        // whether a decoding row or the final projection is refused (and so
        // the offset) follows the recovery envelope's size, not this workflow.
        limit: expect.objectContaining({
          parameter: "max_metadata_representation_bytes",
        }),
      }),
    ]);

    const whole = await cli.run({
      arguments: [
        "compare-managed-members",
        left,
        right,
        "--full-output",
        "--json",
      ],
    });
    expect(whole.exitCode, whole.stderr).toBe(0);
    const envelope = whole.json as { data: unknown; meta: unknown };
    // The source inspection option that raises the recorded budget is named
    // by the comparison command, outside the record.
    expect(envelope.meta).toMatchObject({
      cli_controls: {
        max_metadata_representation_bytes:
          "--max-metadata-representation-bytes",
      },
    });
    const wholeEvidence = parseEvidence(envelope.data);
    const wholeReport = managedMemberComparisonResultSchema.parse(
      wholeEvidence.normalized_result,
    );
    expect(wholeReport.coverage).toEqual({
      status: "partial",
      left_status: "complete",
      right_status: "partial",
    });
    expect(wholeReport.right.methods_total).toBe(0);
    expect(wholeReport.left.resource_limits).toEqual([]);
    expect(wholeReport.right.resource_limits).toEqual(limits);
    expect(wholeReport.limitations).toEqual(
      comparisonLimitations(leftSource.report, rightSource.report),
    );
    expect(wholeReport.limitations).toContainEqual(
      expect.stringMatching(
        /right.*metadata\.representation.*do not establish absence/i,
      ),
    );
    expect(wholeReport.limitations).toContainEqual(
      expect.stringMatching(/smaller selection.*type_names.*--type/i),
    );
    const mcpCompared = await call("compare_managed_members", {
      left: leftSource.evidence,
      right: rightSource.evidence,
    });
    expect(mcpCompared.isError, JSON.stringify(mcpCompared)).not.toBe(true);
    expect(
      parseEvidence(mcpCompared.structuredContent).normalized_result,
    ).toMatchObject({
      left: { resource_limits: [] },
      right: { resource_limits: limits },
      coverage: wholeReport.coverage,
    });
    expect(wholeEvidence.limitations).toEqual(
      expect.arrayContaining(wholeReport.limitations),
    );

    const selected = await cli.run({
      arguments: [
        "compare-managed-members",
        left,
        right,
        "--type",
        "Fixture.Empty0",
        "--json",
      ],
    });
    expect(selected.exitCode, selected.stderr).toBe(0);
    const selectedEvidence = parseEvidence(selected.json);
    expect(selectedEvidence.parameters).toMatchObject({
      left_path: left,
      right_path: right,
      type_names: ["Fixture.Empty0"],
    });
    const selectedReport = managedMemberComparisonResultSchema.parse(
      selectedEvidence.normalized_result,
    );
    expect(selectedReport.coverage).toMatchObject({
      left_status: "complete",
      right_status: "complete",
    });
    expect(selectedReport.left.resource_limits).toEqual([]);
    expect(selectedReport.right.resource_limits).toEqual([]);
    expect(selectedReport.summary).toEqual({
      unchanged: 2,
      changed: 0,
      added: 0,
      removed: 0,
      unknown: 0,
    });
    expect(selectedReport.fields).toMatchObject([
      {
        status: "unchanged",
        left: { name: "Field0" },
        right: { name: "Field0" },
      },
    ]);
    expect(selectedReport.methods).toMatchObject([
      {
        status: "unchanged",
        left: { name: "Method0" },
        right: { name: "Method0" },
      },
    ]);
  },
);

const comparisonFixture = async () => {
  const directory = await createTestTempDirectory("rea-managed-finalization-");
  const leftPath = join(directory, "left.dll");
  const rightPath = join(directory, "right.dll");
  await writeFile(leftPath, buildManagedPeFixture());
  await writeFile(rightPath, buildManagedPeFixture({ methodName: "Renamed" }));
  return { leftPath, rightPath };
};

it("retains the left Evidence when the right target's cleanup fails", async () => {
  const { leftPath, rightPath } = await comparisonFixture();
  const rightIdentity = await stat(rightPath);
  const nativeClose = OwnedFileHandle.prototype.close;
  const owners = new Set<OwnedFileHandle>();
  const close = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockImplementation(async function (this: OwnedFileHandle) {
      if ((await this.handle.stat()).ino === rightIdentity.ino) {
        owners.add(this);
        throw new Error("right close denied");
      }
      await nativeClose.call(this);
    });
  try {
    const result = await managedComparisonCommand()(leftPath, rightPath);
    expect(result).toMatchObject({
      code: "cleanup_incomplete",
      details: {
        resources: [rightPath],
        argument_observations: [
          {
            argument: "left",
            observation: {
              operation: "inspect_managed_members",
              subject: { local_path: leftPath },
            },
          },
        ],
      },
    });
    expect(owners.size).toBe(1);
  } finally {
    close.mockRestore();
    for (const owner of owners) await owner.close();
  }
});

it("retains both sources' Evidence when interrupted as the last target settles", async () => {
  const { leftPath, rightPath } = await comparisonFixture();
  const runner = createDirectAnalysis({}).runManagedProviderEvidence;
  const previousExitCode = process.exitCode;
  try {
    const result = await managedComparisonCommand(async (...args) => {
      const evidence = await runner(...args);
      if (args[0] === rightPath) process.emit("SIGINT");
      return evidence;
    })(leftPath, rightPath);
    expect(result).toMatchObject({
      code: "cancelled",
      details: {
        argument_observations: [
          {
            argument: "left",
            observation: {
              operation: "inspect_managed_members",
              subject: { local_path: leftPath },
            },
          },
          {
            argument: "right",
            observation: {
              operation: "inspect_managed_members",
              subject: { local_path: rightPath },
            },
          },
        ],
      },
    });
    expect(process.exitCode).toBe(130);
  } finally {
    process.exitCode = previousExitCode;
  }
});

it("retains the comparison and both sources' Evidence when interrupted as the comparison settles", async () => {
  const { leftPath, rightPath } = await comparisonFixture();
  const parse = managedMemberComparisonResultSchema.parse.bind(
    managedMemberComparisonResultSchema,
  );
  const interrupt = vi
    .spyOn(managedMemberComparisonResultSchema, "parse")
    .mockImplementation((...args) => {
      const parsed = parse(...args);
      // An OS interrupt is delivered on a later turn, after the synchronous
      // comparison has settled.
      setImmediate(() => process.emit("SIGINT"));
      return parsed;
    });
  const previousExitCode = process.exitCode;
  try {
    expect(await managedComparisonCommand()(leftPath, rightPath)).toMatchObject(
      {
        code: "cancelled",
        details: {
          partial_observation: {
            operation: "compare_managed_members",
            parameters: { left_path: leftPath, right_path: rightPath },
          },
          argument_observations: [
            {
              argument: "left",
              observation: { subject: { local_path: leftPath } },
            },
            {
              argument: "right",
              observation: { subject: { local_path: rightPath } },
            },
          ],
        },
      },
    );
    expect(process.exitCode).toBe(130);
  } finally {
    process.exitCode = previousExitCode;
    interrupt.mockRestore();
  }
});
