import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { contractNamed } from "../../../src/cli/contractCliDescription.js";
import { BINARY_DIAGNOSTICS_TOOL_CONTRACTS } from "../../../src/contracts/native/binaryDiagnosticsToolContracts.js";

import {
  elfDebugImage,
  namedUnit,
} from "../../../src/native/dwarf/DwarfUnits.fixture.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { mcpTest, type TestMcp } from "../../support/mcp/mcpFixture.js";

const dwarfUnitsContract = contractNamed(
  BINARY_DIAGNOSTICS_TOOL_CONTRACTS,
  "inspect_dwarf_units",
);

const connect = async (mcp: TestMcp) => {
  const session = createTestBinarySession(() => {
    throw new Error("DWARF inspection must not start a deep provider");
  });
  const client = await mcp.connect(createServer({ kind: "session", session }));
  return { client, session };
};

mcpTest(
  "advertises inspect_dwarf_units and reads a compile unit",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const advertised = (await client.listTools()).tools.find(
        (tool) => tool.name === "inspect_dwarf_units",
      );
      expect(advertised?.annotations).toMatchObject({
        readOnlyHint: false,
        idempotentHint: true,
      });
      const root = await createTestTempDirectory("rea-dwarf-units-mcp-");
      const path = join(root, "program");
      await writeFile(path, elfDebugImage(namedUnit({ name: "main.c" })));
      const response = await client.callTool({
        name: "inspect_dwarf_units",
        arguments: { path },
      });
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      const evidence = dwarfUnitsContract.outputSchema.parse(
        response.structuredContent,
      );
      expect(evidence.normalized_result.units[0]?.name.value).toBe("main.c");
      expect(evidence.normalized_result.coverage.status).toBe("complete");
      expect(evidence.parameters).toEqual({ path });
      const parameters = {
        path,
        offset: 0,
        limit: 32,
        max_file_bytes: 67_108_864,
      };
      const explicit = await client.callTool({
        name: "inspect_dwarf_units",
        arguments: parameters,
      });
      expect(explicit.isError).not.toBe(true);
      const selected = dwarfUnitsContract.outputSchema.parse(
        explicit.structuredContent,
      );
      expect(selected.parameters).toEqual(parameters);
      expect(selected.normalized_result).toEqual(evidence.normalized_result);
      expect(selected.evidence_id).not.toBe(evidence.evidence_id);
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "requires an absolute path for inspect_dwarf_units",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const response = await client.callTool({
        name: "inspect_dwarf_units",
        arguments: { path: "program" },
      });
      expect(response.isError).toBe(true);
      expect(parseMcpToolError(response).error).toMatchObject({
        code: "invalid_request",
        details: { operation: "inspect_dwarf_units" },
      });
    } finally {
      await session.close();
    }
  },
);
