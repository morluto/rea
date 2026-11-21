import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { z } from "zod";
import { fitFixture } from "../../src/artifacts/fit/FitImage.fixture.js";
import { toolContract } from "../../src/contracts/toolContracts.js";
import { createEvidence } from "../../src/domain/evidence.js";
import {
  cells,
  devicetreeFixture,
  emptyStringsAtReservationBoundaryFixture,
} from "../../src/domain/firmware/devicetree.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
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

cliTest(
  "rejects ambiguous Devicetree node paths in correctly hashed Evidence",
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
    for (const first of [true, false]) {
      const nodes = [...report.nodes];
      nodes.splice(first ? index : nodes.length, 0, {
        ...node,
        properties: [],
      });
      const duplicateIndex = first ? index + 1 : nodes.length - 1;
      const ambiguous = createEvidence(
        { path, sha256: report.artifact.sha256, format: "file" },
        evidence.provider,
        {
          operation: evidence.operation,
          parameters: evidence.parameters,
          result: {
            ...report,
            nodes,
            coverage: { ...report.coverage, examined_nodes: nodes.length },
          },
          confidence: "observed",
          limitations: evidence.limitations,
        },
      );
      const error = {
        code: "invalid_request",
        details: {
          issues: [
            expect.objectContaining({
              path: [
                "source",
                "normalized_result",
                "nodes",
                duplicateIndex,
                "path",
              ],
              message: expect.stringContaining(
                "Duplicate Devicetree node path",
              ),
            }),
          ],
        },
      };
      const cliResult = await inspect(request(ambiguous, "properties"));
      expect(cliResult.exitCode).toBe(1);
      expect(cliResult.json).toMatchObject(error);
      const mcpResult = await call(
        "inspect_analysis_view",
        request(ambiguous, "nodes"),
      );
      expect(mcpResult.isError).toBe(true);
      const content = mcpResult.content.find((item) => item.type === "text");
      if (content?.type !== "text")
        throw new Error("Missing MCP error response");
      expect(JSON.parse(content.text)).toMatchObject({ error });
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
    `inspects a v${version} DTB with empty strings at arbitrary in-blob offsets`,
    async ({ cli }) => {
      const root = await createTestTempDirectory("rea-dtb-empty-strings-");
      for (const offset of [0, 44, 56, 60, 72]) {
        const path = join(root, `board-${String(offset)}.dtb`);
        const bytes = emptyStringsAtReservationBoundaryFixture(version);
        bytes.writeUInt32BE(offset, 12);
        await writeFile(path, bytes);
        const result = await cli.run({
          arguments: ["inspect-devicetree", path, "--json"],
        });
        expect(result.exitCode, result.stderr).toBe(0);
        const report = toolContract("inspect_devicetree").outputSchema.parse(
          result.json,
        ).normalized_result;
        expect(report).toMatchObject({
          nodes: [{ path: "/" }],
          reservations: [],
        });
        expect(Buffer.compare(await readFile(path), bytes)).toBe(0);
      }
    },
  );
}
cliTest(
  "does not resolve through a legacy phandle when the canonical value is malformed",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-dtb-cli-phandle-");
    const path = join(root, "board.dtb");
    await writeFile(
      path,
      devicetreeFixture({
        name: "",
        children: [
          {
            name: "target",
            properties: { phandle: Buffer.alloc(0), "linux,phandle": cells(3) },
          },
          { name: "consumer", properties: { "interrupt-parent": cells(3) } },
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
      { source: "/consumer", phandle: 3, target: null },
    ]);
    expect(report.nodes[1]?.properties[0]).toMatchObject({
      name: "phandle",
      bytes: 0,
      hex: "",
      derived: { cells: null },
    });
    expect(report.limitations).toContainEqual(
      expect.stringMatching(
        /phandle.*\/target.*not a single cell.*unresolved/iu,
      ),
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
    "invalid_request",
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
