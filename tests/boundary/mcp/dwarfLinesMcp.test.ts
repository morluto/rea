import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { contractNamed } from "../../../src/cli/contractCliDescription.js";
import { BINARY_DIAGNOSTICS_TOOL_CONTRACTS } from "../../../src/contracts/native/binaryDiagnosticsToolContracts.js";
import { dwarfLinesSchema } from "../../../src/domain/native/dwarfLines.js";
import {
  buildStringTable,
  elfDebugLineImage,
  lineProgram,
  lneEndSequence,
  lneSetAddress,
  lnsCopy,
  lnsSetFile,
} from "../../../src/native/dwarf/DwarfLines.fixture.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { mcpTest, type TestMcp } from "../../support/mcp/mcpFixture.js";

const dwarfLinesContract = contractNamed(
  BINARY_DIAGNOSTICS_TOOL_CONTRACTS,
  "inspect_dwarf_lines",
);

const connect = async (mcp: TestMcp) => {
  const session = createTestBinarySession(() => {
    throw new Error("DWARF line inspection must not start a deep provider");
  });
  const client = await mcp.connect(createServer({ kind: "session", session }));
  return { client, session };
};

mcpTest(
  "advertises inspect_dwarf_lines and reads line programs",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const advertised = (await client.listTools()).tools.find(
        (tool) => tool.name === "inspect_dwarf_lines",
      );
      expect(advertised?.annotations).toMatchObject({
        readOnlyHint: false,
        idempotentHint: true,
      });
      const root = await createTestTempDirectory("rea-dwarf-lines-mcp-");
      const path = join(root, "program");
      const strings = buildStringTable(["/src", "main.c"]);
      const line = lineProgram({
        version: 5,
        addressSize: 8,
        v5Directories: [{ form: 0x1f, lineStrp: strings.offsets[0]! }],
        v5Files: [
          { path: { form: 0x1f, lineStrp: strings.offsets[1]! }, dirIndex: 0 },
        ],
        opcodes: Buffer.concat([
          lneSetAddress(0x1000n, 8, true),
          lnsSetFile(0),
          lnsCopy(),
          lneSetAddress(0x1010n, 8, true),
          lneEndSequence(),
        ]),
      });
      await writeFile(
        path,
        elfDebugLineImage({ line, lineStr: strings.table }, { type: 2 }),
      );
      const response = await client.callTool({
        name: "inspect_dwarf_lines",
        arguments: { path, addresses: ["0x1004"] },
      });
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      const evidence = dwarfLinesContract.outputSchema.parse(
        response.structuredContent,
      );
      const report = dwarfLinesSchema.parse(evidence.normalized_result);
      expect(report.programs[0]?.files[0]?.name.value).toBe("main.c");
      expect(report.address_matches[0]).toMatchObject({
        query_address: "0x1004",
        status: "resolved",
      });
      expect(evidence.parameters).toEqual({ path, addresses: ["0x1004"] });

      const parameters = {
        path,
        max_programs: 16,
        max_rows: 0,
        max_file_bytes: 67_108_864,
      };
      const explicit = await client.callTool({
        name: "inspect_dwarf_lines",
        arguments: { ...parameters, detail: "complete" },
      });
      expect(explicit.isError).not.toBe(true);
      const selected = dwarfLinesContract.outputSchema.parse(
        explicit.structuredContent,
      );
      const selectedReport = dwarfLinesSchema.parse(selected.normalized_result);
      expect(selected.parameters).toEqual(parameters);
      expect(selectedReport.rows).toEqual([]);
      expect(selectedReport.coverage.status).toBe("complete");
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "requires an absolute path for inspect_dwarf_lines",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const response = await client.callTool({
        name: "inspect_dwarf_lines",
        arguments: { path: "program" },
      });
      expect(response.isError).toBe(true);
      expect(parseMcpToolError(response).error).toMatchObject({
        code: "invalid_request",
        details: { operation: "inspect_dwarf_lines" },
      });
    } finally {
      await session.close();
    }
  },
);
