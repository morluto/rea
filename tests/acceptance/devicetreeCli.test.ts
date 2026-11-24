import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { z } from "zod";
import { fitFixture } from "../../src/artifacts/fit/FitImage.fixture.js";
import { toolContract } from "../../src/contracts/toolContracts.js";
import { createEvidence } from "../../src/domain/evidence.js";
import type { Devicetree } from "../../src/domain/firmware/devicetree.js";
import {
  cells,
  devicetreeFixture,
  emptyStringsAtReservationBoundaryFixture,
} from "../../src/domain/firmware/devicetree.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";
import { cliTest } from "../support/cli/cliFixture.js";

const paddingDiagnostic = /FDT structure padding contains/iu;

cliTest(
  "retains DTB facts and reports both nonzero padding placements",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-dtb-padding-");
    const path = join(root, "board.dtb");
    const zeroPadded = devicetreeFixture({
      name: "",
      properties: { model: Buffer.from([0x78, 0]) },
      children: [{ name: "a" }],
    });
    const nonzeroPadded = Buffer.from(zeroPadded);
    const start = nonzeroPadded.readUInt32BE(8);
    // Two-byte model value rounded up to four, then a child named "a".
    const propertyPadding = start + 22;
    nonzeroPadded[propertyPadding] = 1;
    // libfdt's in-place rename from "abc" to "a" leaves the former 'c'.
    nonzeroPadded[start + 30] = 0x63;

    const inspect = async (bytes: Buffer) => {
      await writeFile(path, bytes);
      const result = await cli.run({
        arguments: ["inspect-devicetree", path, "--json"],
      });
      expect(result.exitCode, result.stderr).toBe(0);
      return toolContract("inspect_devicetree").outputSchema.parse(result.json);
    };
    const control = await inspect(zeroPadded);
    expect(control.limitations).not.toEqual(
      expect.arrayContaining([expect.stringMatching(paddingDiagnostic)]),
    );
    const observed = await inspect(nonzeroPadded);
    const diagnostic = `FDT structure padding contains 2 nonzero bytes. The first is at file offset ${String(propertyPadding)}.`;
    expect(observed.limitations).toContain(diagnostic);
    expect(observed.normalized_result).toMatchObject({
      summary: { model: "x" },
      nodes: expect.arrayContaining([expect.objectContaining({ path: "/a" })]),
      coverage: {
        status: "complete",
        examined_nodes: 2,
        examined_properties: 1,
      },
      limitations: expect.arrayContaining([diagnostic]),
    });

    const { call } = await connectLocalToolsMcp();
    const reply = await call("inspect_devicetree", { path });
    expect(reply.isError).not.toBe(true);
    const mcp = toolContract("inspect_devicetree").outputSchema.parse(
      reply.structuredContent,
    );
    expect(mcp.limitations).toContain(diagnostic);
    expect(mcp.normalized_result).toEqual(observed.normalized_result);
    expect((await readFile(path)).equals(nonzeroPadded)).toBe(true);
  },
);

cliTest(
  "reports FIT structure padding without losing image inventory",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-fit-padding-");
    const path = join(root, "boot.itb");
    const bytes = fitFixture({
      images: [{ name: "kernel", data: Buffer.from([1, 2, 3, 4]) }],
    });
    const inspect = () =>
      cli.run({ arguments: ["inspect-artifact", path, "--json"] });

    await writeFile(path, bytes);
    const control = await inspect();
    expect(control.exitCode, control.stderr).toBe(0);
    expect(control.json).not.toMatchObject({
      limitations: expect.arrayContaining([
        expect.stringMatching(paddingDiagnostic),
      ]),
    });

    const rootNamePadding = bytes.readUInt32BE(8) + 5;
    bytes[rootNamePadding] = 1;
    await writeFile(path, bytes);
    const observed = await inspect();
    expect(observed.exitCode, observed.stderr).toBe(0);
    expect(observed.json).toMatchObject({
      limitations: expect.arrayContaining([
        `FDT structure padding contains 1 nonzero byte. The first is at file offset ${String(rootNamePadding)}.`,
      ]),
      normalized_result: {
        coverage: { status: "complete-within-substeps" },
        observations: expect.arrayContaining([
          expect.objectContaining({
            kind: "root-manifest",
            value: expect.objectContaining({
              root_format: "fit",
              occurrence_count: 2,
            }),
          }),
        ]),
      },
    });
    expect((await readFile(path)).equals(bytes)).toBe(true);
  },
);

const contradictoryReports = (report: Devicetree, nodeIndex: number) => {
  const duplicate = (first: boolean) => {
    const changed = structuredClone(report);
    changed.nodes.splice(first ? nodeIndex : changed.nodes.length, 0, {
      ...report.nodes[nodeIndex]!,
      properties: [],
    });
    changed.coverage.examined_nodes = changed.nodes.length;
    return {
      changed,
      issuePath: [
        "nodes",
        first ? nodeIndex + 1 : changed.nodes.length - 1,
        "path",
      ],
      message: "Duplicate Devicetree node path.",
      collection: first ? ("properties" as const) : ("nodes" as const),
      adapter: first ? "cli" : "mcp",
    };
  };
  const wrongGeometry = structuredClone(report);
  wrongGeometry.nodes[nodeIndex]!.properties[0]!.offset =
    report.header.totalsize;
  const wrongCoverage = {
    ...report,
    coverage: { ...report.coverage, examined_nodes: report.nodes.length + 1 },
  };
  return [
    duplicate(true),
    duplicate(false),
    {
      changed: wrongGeometry,
      issuePath: ["nodes", nodeIndex, "properties", 0, "offset"],
      message: "The property range exceeds the declared Devicetree extent.",
      collection: "properties",
      adapter: "mcp",
    },
    {
      changed: wrongCoverage,
      issuePath: ["coverage", "examined_nodes"],
      message: "Examined node count disagrees with the listed nodes.",
      collection: "nodes",
      adapter: "cli",
    },
  ] as const;
};

cliTest(
  "rejects contradictory Devicetree reports in authenticated Evidence",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-dtb-duplicate-path-");
    const path = join(root, "board.dtb");
    const bytes = devicetreeFixture();
    await writeFile(path, bytes);
    const original = await cli.run({
      arguments: ["inspect-devicetree", path, "--json"],
    });
    expect(original.exitCode, original.stderr).toBe(0);
    const evidence = toolContract("inspect_devicetree").outputSchema.parse(
      original.json,
    );
    const report = evidence.normalized_result;
    if (!("nodes" in report)) throw new Error("Expected complete DTB report");
    const nodePath = "/serial@1000";
    const index = report.nodes.findIndex((node) => node.path === nodePath);
    const node = report.nodes[index];
    if (node === undefined) throw new Error("Expected serial node");
    const requestPath = join(root, "view.json");
    const request = (parent: unknown, collection: "nodes" | "properties") => ({
      source: { kind: "inline", evidence: parent },
      view: { kind: "devicetree", collection, path: nodePath },
    });
    const inspect = async (input: unknown) => {
      await writeFile(requestPath, JSON.stringify(input));
      return cli.run({
        arguments: ["inspect-analysis-view", requestPath, "--json"],
      });
    };
    const control = await inspect(request(evidence, "properties"));
    expect(control.exitCode, control.stderr).toBe(0);
    expect(control.json).toMatchObject({
      normalized_result: {
        items: [
          { name: "reg" },
          { name: "phandle" },
          { name: "interrupt-parent" },
        ],
      },
    });
    const { call } = await connectLocalToolsMcp();
    const withReport = (changed: Devicetree) =>
      createEvidence(
        { path, sha256: report.artifact.sha256, format: "file" },
        evidence.provider,
        {
          operation: evidence.operation,
          parameters: evidence.parameters,
          result: changed,
          confidence: evidence.confidence,
          limitations: evidence.limitations,
          locations: evidence.locations,
        },
      );
    for (const {
      changed,
      issuePath,
      message,
      collection,
      adapter,
    } of contradictoryReports(report, index)) {
      const input = request(withReport(changed), collection);
      const error = {
        code: "invalid_request",
        details: {
          issues: [
            {
              path: ["source", "normalized_result", ...issuePath],
              reason: "invalid_value",
              message,
            },
          ],
        },
      };
      if (adapter === "cli") {
        const reply = await inspect(input);
        expect(reply.exitCode, reply.stderr + reply.stdout).toBe(1);
        expect(reply.json).toMatchObject(error);
      } else {
        const reply = await call("inspect_analysis_view", input);
        expect(reply.isError).toBe(true);
        expect(parseMcpToolError(reply).error).toMatchObject(error);
      }
    }
    expect((await readFile(path)).equals(bytes)).toBe(true);
  },
);

cliTest("inspects a relative DTB and preserves the source", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-dtb-cli-");
  const path = join(root, "board.dtb"),
    bytes = devicetreeFixture();
  await writeFile(path, bytes);
  const result = await cli.run({
    arguments: [
      "inspect-devicetree",
      "board.dtb",
      "--max-file-bytes",
      "4096",
      "--max-depth",
      "8",
      "--max-properties",
      "64",
      "--json",
    ],
    cwd: root,
  });
  expect(result.exitCode, result.stderr).toBe(0);
  const report = toolContract("inspect_devicetree").outputSchema.parse(
    result.json,
  ).normalized_result;
  expect(report).toMatchObject({
    artifact: { path },
    summary: { model: "Test board" },
    coverage: { examined_nodes: 5 },
  });
  expect(Buffer.compare(await readFile(path), bytes)).toBe(0);
});
for (const version of [16, 17] as const) {
  cliTest(
    `inspects a v${version} DTB with empty strings at the reservation boundary`,
    async ({ cli }) => {
      const root = await createTestTempDirectory("rea-dtb-empty-strings-");
      const path = join(root, "board.dtb");
      const bytes = emptyStringsAtReservationBoundaryFixture(version);
      await writeFile(path, bytes);
      const result = await cli.run({
        arguments: ["inspect-devicetree", path, "--json"],
      });
      expect(result.exitCode, result.stderr).toBe(0);
      const report = toolContract("inspect_devicetree").outputSchema.parse(
        result.json,
      ).normalized_result;
      expect(report).toMatchObject({
        header: {
          version,
          off_dt_strings: 56,
          size_dt_strings: 0,
          size_dt_struct: version === 16 ? null : 16,
        },
        nodes: [{ path: "/" }],
        reservations: [],
      });
      expect((await readFile(path)).equals(bytes)).toBe(true);
    },
  );
}

cliTest(
  "keeps references unresolved when either declared phandle is malformed",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-dtb-cli-phandle-");
    const path = join(root, "board.dtb");
    await writeFile(
      path,
      devicetreeFixture({
        name: "",
        children: [
          {
            name: "bad_canonical",
            properties: { phandle: Buffer.alloc(0), "linux,phandle": cells(3) },
          },
          {
            name: "bad_legacy",
            properties: { phandle: cells(4), "linux,phandle": cells(1, 2) },
          },
          {
            name: "legacy_only",
            properties: { "linux,phandle": Buffer.from([0, 0]) },
          },
          {
            name: "canonical_consumer",
            properties: { "interrupt-parent": cells(3) },
          },
          {
            name: "legacy_consumer",
            properties: { "interrupt-parent": cells(4) },
          },
        ],
      }),
    );
    const result = await cli.run({
      arguments: ["inspect-devicetree", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const report = toolContract("inspect_devicetree").outputSchema.parse(
      result.json,
    ).normalized_result;
    if (!("references" in report)) throw new Error("Expected complete report");
    expect(report.references).toMatchObject([
      { source: "/canonical_consumer", phandle: 3, target: null },
      { source: "/legacy_consumer", phandle: 4, target: null },
    ]);
    expect(report.nodes[1]?.properties[0]).toMatchObject({
      name: "phandle",
      bytes: 0,
      hex: "",
      derived: { cells: null },
    });
    expect(report.nodes[2]?.properties[1]).toMatchObject({
      name: "linux,phandle",
      bytes: 8,
      hex: cells(1, 2).toString("hex"),
      derived: { cells: null },
    });
    expect(report.limitations).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /phandle.*\/bad_canonical.*not a single cell.*unresolved/iu,
        ),
        expect.stringMatching(
          /linux,phandle.*\/bad_legacy.*not a single cell.*unresolved/iu,
        ),
        expect.stringMatching(
          /linux,phandle.*\/legacy_only.*not a single cell.*unresolved/iu,
        ),
      ]),
    );
  },
);

cliTest(
  "retains complete DTB Evidence when delivering a summary",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-dtb-cli-summary-");
    const path = join(root, "board.dtb"),
      output = join(root, "evidence.json");
    await writeFile(path, devicetreeFixture());
    const result = await cli.run({
      arguments: [
        "inspect-devicetree",
        path,
        "--detail",
        "summary",
        "--evidence_output",
        output,
        "--json",
      ],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(
      toolContract("inspect_devicetree").outputSchema.parse(
        z.object({ summary: z.unknown() }).parse(result.json).summary,
      ).normalized_result,
    ).toMatchObject({
      kind: "summary",
      summary: { unresolved_reference_count: 1 },
    });
    const bundle = z
      .object({ records: z.array(z.unknown()).length(1) })
      .parse(JSON.parse(await readFile(output, "utf8")));
    const retained = toolContract("inspect_devicetree").outputSchema.parse(
      bundle.records[0],
    ).normalized_result;
    if (!("nodes" in retained)) throw new Error("Expected complete evidence");
    expect(retained.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/serial@1000",
          properties: expect.arrayContaining([
            expect.objectContaining({
              name: "reg",
              derived: expect.objectContaining({
                reg: [{ address: "0x1000", size: "0x100" }],
              }),
            }),
          ]),
        }),
      ]),
    );
  },
);
for (const [name, build, flags, code] of [
  [
    "malformed",
    () => devicetreeFixture().subarray(0, 30),
    [],
    "unsupported_target",
  ],
  [
    "unsupported",
    () => devicetreeFixture(undefined, 18),
    [],
    "unsupported_target",
  ],
  [
    "exhausted",
    () => devicetreeFixture(),
    ["--max-nodes", "1"],
    "resource_constraint",
  ],
] as const) {
  cliTest(`reports ${name} DTB input`, async ({ cli }) => {
    const root = await createTestTempDirectory("rea-dtb-cli-errors-");
    const path = join(root, "board.dtb");
    await writeFile(path, build());
    const result = await cli.run({
      arguments: ["inspect-devicetree", path, ...flags, "--json"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({ code });
    if (name === "exhausted")
      expect(result.json).toMatchObject({
        details: {
          reported_limits: { boundary: "max_nodes", maximum: 1 },
          reason: expect.stringContaining("raise that caller-selected limit"),
        },
        retryable: false,
      });
  });
}
