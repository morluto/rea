import { Ajv2020 } from "ajv/dist/2020.js";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, expect, onTestFinished } from "vitest";
import { BINARY_DIAGNOSTICS_TOOL_CONTRACTS } from "../../../src/contracts/native/binaryDiagnosticsToolContracts.js";
import { contractNamed } from "../../../src/cli/contractCliDescription.js";
import { createServer } from "../../../src/server/createServer.js";
import { sha256Hex } from "../../../src/kernel/sha256Hex.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { structuredRasterFixture } from "../../fixtures/structuredRaster.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";
import { mcpTest } from "../../support/mcp/mcpFixture.js";
const contract = contractNamed(
  BINARY_DIAGNOSTICS_TOOL_CONTRACTS,
  "export_structured_raster_resources",
);
const validation = createMcpSchemaValidation();
afterAll(() => validation.clear());
mcpTest(
  "exports through shared MCP binding, retains receipt, and refuses clobber or changed source",
  async ({ mcp }) => {
    const session = createTestBinarySession(() => {
      throw new Error("No deep provider");
    });
    onTestFinished(async () => {
      const result = await session.close();
      if (!result.ok) throw result.error;
    });
    const client = await mcp.connect(
      createServer({ kind: "session", session }),
      undefined,
      validation,
    );
    const advertised = (await client.listTools()).tools.find(
      (tool) => tool.name === contract.name,
    );
    expect(advertised?.annotations?.readOnlyHint).toBe(false);
    const root = await createTestTempDirectory("rea-export-mcp-");
    const path = join(root, "source"),
      output_directory = join(root, "export"),
      bytes = structuredRasterFixture();
    await writeFile(path, bytes);
    const arguments_ = {
      path,
      output_directory,
      expected_sha256: sha256Hex(bytes),
    };
    if (!advertised) throw new Error("Export contract was not advertised");
    const validate = new Ajv2020({ strict: false }).compile(
      advertised.inputSchema,
    );
    for (const [entry, accepted] of [
      [[0, 1, 254, 255], true],
      [[0, 1, 2], false],
      [[0, 1, 2, 3, 4], false],
      [[0, 1, 2, 256], false],
      [[0, 1, 2, "3"], false],
    ] as const) {
      const input = {
        ...arguments_,
        color_policy: {
          kind: "rgba-palette",
          entries: [entry],
          index_space: "selector",
          sentinel: "disabled",
        },
      };
      expect(validate(input)).toBe(accepted);
      expect(contract.inputSchema.safeParse(input).success).toBe(accepted);
    }
    const response = await client.callTool({
      name: contract.name,
      arguments: arguments_,
    });
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    const evidence = contract.outputSchema.parse(response.structuredContent);
    expect(session.evidenceById(evidence.evidence_id)).toEqual(evidence);
    expect(evidence.parameters).toEqual(arguments_);
    expect(evidence.normalized_result.exported).toBe(12);
    expect(response.content.some((block) => block.type === "image")).toBe(
      false,
    );
    const manifest = await readFile(join(output_directory, "manifest.json"));
    expect(sha256Hex(manifest)).toBe(
      evidence.normalized_result.manifest.sha256,
    );
    const repeated = await client.callTool({
      name: contract.name,
      arguments: arguments_,
    });
    expect(repeated.isError).toBe(true);
    expect(
      (await readFile(join(output_directory, "manifest.json"))).equals(
        manifest,
      ),
    ).toBe(true);
    const other = join(root, "wrong-source");
    const wrong = await client.callTool({
      name: contract.name,
      arguments: {
        ...arguments_,
        output_directory: other,
        expected_sha256: "0".repeat(64),
      },
    });
    expect(wrong.isError).toBe(true);
    await expect(access(other)).rejects.toThrow();
  },
);
