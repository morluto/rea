import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { nativeExportsSchema } from "../../../src/domain/native/nativeExports.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { peExportImage } from "../../fixtures/binaryDiagnostics/nativeExports.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "reports the last PE ordinal when an unused EAT slot follows it",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-pe-export-last-ordinal-");
    const path = join(root, "exports.dll");
    await writeFile(
      path,
      peExportImage({
        ordinalBase: 0xffff,
        functions: [{ rva: 0x1300 }, null],
        names: [{ name: "Kept", index: 0 }],
      }),
    );

    const result = await cli.run({
      arguments: ["inspect-native-exports", path, "--json"],
    });

    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_native_exports").outputSchema.parse(
      result.json,
    );
    expect(nativeExportsSchema.parse(evidence.normalized_result)).toMatchObject(
      {
        format: "pe",
        coverage: { status: "complete", examined_entries: 2, exports: 1 },
        issues: [],
        exports: [
          {
            name: "Kept",
            ordinal: 0xffff,
            address: "0x180001300",
            forwarder: null,
          },
        ],
      },
    );
  },
);

cliTest.for(["CLI", "stdio MCP"] as const)(
  "preserves biased PE ordinals above the name-table index width through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-pe-biased-ordinal-");
    const cases = [
      { name: "word-base", base: 0x10000, index: 0, ordinal: 0x10000 },
      {
        name: "maximum-dword-base",
        base: 0xffffffff,
        index: 0,
        ordinal: 0xffffffff,
      },
      {
        name: "sum-above-dword",
        base: 0xffffffff,
        index: 1,
        ordinal: 0x1_0000_0000,
      },
    ];
    const mcp =
      surface === "stdio MCP" ? await connectLocalToolsMcp() : undefined;

    for (const fixture of cases) {
      const path = join(root, `${fixture.name}.dll`);
      const functions = Array.from({ length: fixture.index + 1 }, (_, row) =>
        row === fixture.index ? { rva: 0x1300 } : null,
      );
      await writeFile(
        path,
        peExportImage({
          ordinalBase: fixture.base,
          functions,
          names: [{ name: "Named", index: fixture.index }],
        }),
      );

      let document: unknown;
      if (surface === "CLI") {
        const response = await cli.run({
          arguments: ["inspect-native-exports", path, "--json"],
        });
        expect(response.exitCode, response.stderr).toBe(0);
        document = toolContract("inspect_native_exports").outputSchema.parse(
          response.json,
        );
      } else {
        const response = await mcp!.call("inspect_native_exports", { path });
        expect(response.isError, JSON.stringify(response)).not.toBe(true);
        document = response.structuredContent;
      }

      const evidence = toolContract(
        "inspect_native_exports",
      ).outputSchema.parse(document);
      expect(
        nativeExportsSchema.parse(evidence.normalized_result),
      ).toMatchObject({
        format: "pe",
        coverage: {
          status: "complete",
          examined_entries: fixture.index + 1,
          exports: 1,
        },
        exports: [{ name: "Named", ordinal: fixture.ordinal }],
      });
    }
  },
);

cliTest.for([32, 64] as const)(
  "requires a PE%s export-name terminator inside the declared section extent",
  async (bits, { cli }) => {
    const root = await createTestTempDirectory("rea-pe-export-extent-");
    const path = join(root, "exports.dll");
    const bytes = peExportImage({
      bits,
      functions: [{ rva: 0x2000 }, { rva: 0x2010 }],
      names: [
        { name: "Kept", index: 0 },
        { name: "TailNote", index: 1 },
      ],
    });
    const tailName = Buffer.from("TailNote\0");
    const lastNameOffset = bytes.indexOf(tailName) - 0x400;
    const nameEnd = lastNameOffset + tailName.length;
    const virtualSizeField = 152 + (bits === 32 ? 224 : 240) + 8;
    const mcp = await connectLocalToolsMcp();
    const contract = toolContract("inspect_native_exports");

    for (const [size, expectedNames] of [
      [0, ["Kept", "TailNote"]],
      [nameEnd, ["Kept", "TailNote"]],
      [nameEnd - 1, ["Kept"]],
    ] as const) {
      bytes.writeUInt32LE(size, virtualSizeField);
      await writeFile(path, bytes);
      const result = await cli.run({
        arguments: ["inspect-native-exports", path, "--json"],
      });
      expect(result.exitCode, result.stderr).toBe(0);
      const response = await mcp.call("inspect_native_exports", { path });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      for (const value of [result.json, response.structuredContent]) {
        const report = nativeExportsSchema.parse(
          contract.outputSchema.parse(value).normalized_result,
        );
        expect(report.exports.map(({ name }) => name)).toEqual(expectedNames);
        expect(report.coverage).toMatchObject({
          status: expectedNames.length === 2 ? "complete" : "partial",
          examined_entries: 2,
        });
        expect(report.issues).toMatchObject(
          expectedNames.length === 2
            ? []
            : [{ code: "name_unreadable", location: "0x1211" }],
        );
      }
    }
  },
);
