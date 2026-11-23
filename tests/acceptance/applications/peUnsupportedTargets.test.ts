import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import {
  dosMz,
  nonPeWindowsMz,
} from "../../../src/domain/binaryTarget.fixture.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const cases = (
  ["DOS", "NE", "LE", "LX", "unknown", "truncated PE", "truncated MZ"] as const
).flatMap((format) =>
  (["CLI", "stdio MCP"] as const).map((surface) => ({ format, surface })),
);

cliTest.for(cases)(
  "classifies $format for PE resources and certificates through $surface",
  async ({ format, surface }, { cli }) => {
    const root = await createTestTempDirectory("rea-pe-dos-public-");
    const path = join(root, "program.exe");
    let bytes =
      format === "DOS"
        ? dosMz(1024)
        : nonPeWindowsMz(
            format === "NE" || format === "LE" || format === "LX"
              ? format
              : "NE",
          );
    const malformed =
      format === "unknown" ||
      format === "truncated PE" ||
      format === "truncated MZ";
    if (format === "truncated MZ") bytes = Buffer.from("MZ");
    if (format === "unknown") bytes.write("ZZ", 128, "ascii");
    if (format === "truncated PE") {
      bytes.write("PE\0\0", 128, "binary");
      bytes = bytes.subarray(0, 132);
    }
    // A recognized two-byte signature needs no PE COFF header to refuse it.
    if (format === "LE") bytes = bytes.subarray(0, 130);
    await writeFile(path, bytes);
    const mcp =
      surface === "stdio MCP" ? await connectLocalToolsMcp() : undefined;
    for (const operation of ["resources", "certificates"] as const) {
      let error: unknown;
      if (surface === "CLI") {
        const response = await cli.run({
          arguments: [`inspect-pe-${operation}`, path, "--json"],
        });
        expect(response.exitCode).toBe(1);
        error = response.json;
      } else {
        const response = await mcp!.call(`inspect_pe_${operation}`, { path });
        expect(response.isError).toBe(true);
        error = parseMcpToolError(response).error;
      }
      expect(error).toMatchObject({
        code: malformed ? "invalid_request" : "unsupported_target",
        category: malformed ? "invalid_input" : "unsupported_target",
        retryable: false,
        details: { operation: `inspect_pe_${operation}` },
      });
      if (malformed) {
        expect(error).toMatchObject({
          details: { issues: [{ path: ["path"], reason: "invalid_format" }] },
        });
      } else {
        expect(error).toMatchObject({ details: { path } });
        expect(JSON.stringify(error)).not.toContain("inspect_input_contract");
      }
      expect(Buffer.compare(await readFile(path), bytes)).toBe(0);
    }
  },
);
