import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { z } from "zod";

import { BINARY_DIAGNOSTICS_TOOL_CONTRACTS } from "../../src/contracts/native/binaryDiagnosticsToolContracts.js";
import { devicetreeFixture } from "../../src/domain/firmware/devicetree.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";
import { cliTest } from "../support/cli/cliFixture.js";

const devicetreeContract = (() => {
  const contract = BINARY_DIAGNOSTICS_TOOL_CONTRACTS.find(
    (item) => item.name === "inspect_devicetree",
  );
  if (contract === undefined)
    throw new Error("Missing inspect_devicetree contract");
  return contract;
})();

const oracle = z
  .object({
    cases: z
      .array(
        z.object({
          version: z.union([z.literal(16), z.literal(17)]),
          table_hex: z.string().regex(/^(?:[a-f0-9]{2})+$/u),
          reservations: z.array(
            z.object({ address: z.string(), size: z.string() }),
          ),
        }),
      )
      .refine(
        (cases) =>
          cases.length === 2 &&
          new Set(cases.map(({ version }) => version)).size === 2,
        "Expected exactly one libfdt witness for each supported version (16 and 17)",
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
      const evidence = devicetreeContract.outputSchema.parse(result.json);
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
        const mcp = devicetreeContract.outputSchema.parse(
          response.structuredContent,
        );
        expect(mcp.normalized_result).toEqual(report);
      }
      expect((await readFile(path)).equals(bytes)).toBe(true);
    }
  },
);

cliTest.for([16, 17] as const)(
  "rejects overlapping reservations and preserves adjacent 64-bit entries through CLI and MCP: v%s",
  async (version, { cli }) => {
    const root = await createTestTempDirectory("rea-dtb-reservation-overlap-");
    const { call } = await connectLocalToolsMcp();
    for (const { label, size, rejected } of [
      { label: "overlap", size: 9n, rejected: true },
      { label: "adjacent", size: 8n, rejected: false },
    ] as const) {
      const path = join(root, `${label}-${String(version)}.dtb`);
      const bytes = devicetreeFixture({ name: "" }, version, [
        [0x20000000000009n, 8n],
        [0x20000000000001n, size],
      ]);
      await writeFile(path, bytes);
      const result = await cli.run({
        arguments: ["inspect-devicetree", path, "--json"],
      });
      const response = await call("inspect_devicetree", { path });
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (rejected) {
        expect(result.exitCode).toBe(1);
        expect(result.json).toMatchObject({
          code: "invalid_request",
          details: {
            partial_observation: {
              kind: "file-snapshot-hash",
              path,
              bytes: bytes.length,
              sha256,
            },
          },
        });
        expect(response.isError).toBe(true);
        expect(parseMcpToolError(response)).toMatchObject({
          error: {
            code: "invalid_request",
            category: "invalid_input",
            details: {
              partial_observation: {
                kind: "file-snapshot-hash",
                path,
                bytes: bytes.length,
                sha256,
              },
            },
          },
        });
      } else {
        expect(result.exitCode, result.stderr).toBe(0);
        expect(response.isError, JSON.stringify(response)).not.toBe(true);
        const cliEvidence = devicetreeContract.outputSchema.parse(result.json);
        const mcpEvidence = devicetreeContract.outputSchema.parse(
          response.structuredContent,
        );
        expect(mcpEvidence.normalized_result).toEqual(
          cliEvidence.normalized_result,
        );
        const report = cliEvidence.normalized_result;
        if (!("reservations" in report))
          throw new Error("Expected complete DTB report");
        expect(report.artifact).toEqual({ path, bytes: bytes.length, sha256 });
        expect(report.reservations).toEqual([
          { offset: 40, address: "0x20000000000009", size: "0x8" },
          { offset: 56, address: "0x20000000000001", size: "0x8" },
        ]);
        expect(report.coverage.status).toBe("complete");
      }
      expect((await readFile(path)).equals(bytes)).toBe(true);
    }
  },
);
