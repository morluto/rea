import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { z } from "zod";

import { toolContract } from "../../src/contracts/toolContracts.js";
import { devicetreeFixture } from "../../src/firmware/devicetree/Devicetree.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { cliTest } from "../support/cli/cliFixture.js";

const oracle = z
  .object({
    cases: z.array(
      z.object({
        version: z.union([z.literal(16), z.literal(17)]),
        table_hex: z.string().regex(/^(?:[a-f0-9]{2})+$/u),
        reservations: z.array(
          z.object({ address: z.string(), size: z.string() }),
        ),
      }),
    ),
  })
  .parse(
    JSON.parse(
      await readFile(
        new URL(
          "../fixtures/devicetree-reservations/oracle.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
  );

/** Reframe the producer's exact table bytes; do not re-encode its 64-bit words. */
const carrier = (version: 16 | 17, tableHex: string): Buffer => {
  const original = devicetreeFixture(undefined, version);
  const reservationStart = original.readUInt32BE(16);
  const structureStart = original.readUInt32BE(8);
  const table = Buffer.from(tableHex, "hex");
  const delta = table.length - (structureStart - reservationStart);
  const bytes = Buffer.concat([
    original.subarray(0, reservationStart),
    table,
    original.subarray(structureStart),
  ]);
  // The synthetic carrier stores reservations immediately before structure.
  for (const column of [4, 8, 12])
    bytes.writeUInt32BE(original.readUInt32BE(column) + delta, column);
  return bytes;
};

cliTest(
  "preserves libfdt 64-bit reservations through CLI and stdio MCP Evidence",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-dtb-reservation-width-");
    const { call } = await connectLocalToolsMcp();
    for (const sample of oracle.cases) {
      const path = join(root, `board-${sample.version}.dtb`);
      const bytes = carrier(sample.version, sample.table_hex);
      await writeFile(path, bytes);
      const result = await cli.run({
        arguments: ["inspect-devicetree", path, "--json"],
      });
      expect(result.exitCode, result.stderr).toBe(0);
      const evidence = toolContract("inspect_devicetree").outputSchema.parse(
        result.json,
      );
      const report = evidence.normalized_result;
      if (!("reservations" in report))
        throw new Error("Expected complete DTB report");
      expect(report.header.version).toBe(sample.version);
      expect(report.artifact).toEqual({
        path,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      expect(report.reservations).toEqual(
        sample.reservations.map((row, index) => ({
          offset: bytes.readUInt32BE(16) + index * 16,
          ...row,
        })),
      );
      expect(report.coverage.status).toBe("complete");
      if (sample.version === 17) {
        const response = await call("inspect_devicetree", { path });
        expect(response.isError).not.toBe(true);
        const mcp = toolContract("inspect_devicetree").outputSchema.parse(
          response.structuredContent,
        );
        expect(mcp.normalized_result).toEqual(report);
      }
      expect((await readFile(path)).equals(bytes)).toBe(true);
    }
  },
);
