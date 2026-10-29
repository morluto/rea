import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { z } from "zod";
import { toolContract } from "../../src/contracts/toolContracts.js";
import {
  cells,
  devicetreeFixture,
} from "../../src/firmware/devicetree/Devicetree.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

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
    expect(report.references).toMatchObject([{ phandle: 3, target: null }]);
    expect(report.limitations).toContain(
      "phandle at /target is not a single cell; this node's reference identity remains unresolved.",
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
    expect(await readFile(output, "utf8")).toContain('"nodes"');
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
