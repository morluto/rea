import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { z } from "zod";
import { toolContract } from "../../src/contracts/toolContracts.js";
import { createEvidence } from "../../src/domain/evidence.js";
import {
  cells,
  devicetreeFixture,
} from "../../src/firmware/devicetree/Devicetree.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { cliTest } from "../support/cli/cliFixture.js";

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
  });
}
