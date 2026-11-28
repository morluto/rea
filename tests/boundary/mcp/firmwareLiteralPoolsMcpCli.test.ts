import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, onTestFinished } from "vitest";
import { createCli } from "../../../src/cli.js";
import { silentLogger } from "../../../src/logger.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const MINI_SVD = `<device>
  <name>STM32F103</name>
  <peripherals>
    <peripheral>
      <name>GPIOA</name>
      <baseAddress>0x40010800</baseAddress>
      <addressBlock>
        <offset>0x0</offset>
        <size>0x400</size>
        <usage>registers</usage>
      </addressBlock>
    </peripheral>
  </peripherals>
</device>`;

describe("inspect_firmware_literal_pools CLI and MCP parity", () => {
  it("disassembles Thumb literal-pool MMIO loads with CLI and advertised MCP parity", async () => {
    const dir = await createTestTempDirectory("rea-literal-pools-");
    const fwPath = join(dir, "stm32.bin");
    const image = Buffer.alloc(24, 0x00);
    image.writeUInt16LE(0x4802, 0x00);
    image.writeUInt16LE(0x4903, 0x02);
    for (let p = 0x04; p < 0x0c; p += 2) image.writeUInt16LE(0xbf00, p);
    image.writeUInt32LE(0xe000_ed08, 0x0c);
    image.writeUInt32LE(0x4001_080c, 0x10);
    await writeFile(fwPath, image);

    const session = createTestBinarySession(() => {
      throw new Error("No deep provider should start");
    });
    const server = createServer(
      { kind: "session", session },
      { environment: {}, logger: silentLogger },
    );
    const client = new Client(
      { name: "firmware-literal-pools-test", version: "1" },
      { jsonSchemaValidator: createMcpSchemaValidation() },
    );
    onTestFinished(async () => {
      await client.close();
      await server.close();
      await session.close();
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const mcpRes = await client.callTool({
      name: "inspect_firmware_literal_pools",
      arguments: {
        path: fwPath,
        isa: "arm-thumb",
        base_address: "0x08000000",
        svd_xml: MINI_SVD,
      },
    });
    expect(mcpRes.isError).not.toBe(true);
    const mcpStructured = mcpRes.structuredContent as {
      evidence_id: string;
      parameters: Record<string, unknown>;
      normalized_result: {
        references: {
          loaded_value: string;
          svd_peripheral: string | null;
          architectural_block: string | null;
        }[];
      };
    };
    expect(Object.keys(mcpStructured.parameters).sort()).toEqual([
      "base_address",
      "isa",
      "path",
      "svd_xml_sha256",
    ]);
    expect(mcpStructured.normalized_result.references).toMatchObject([
      {
        loaded_value: "0xe000ed08",
        svd_peripheral: null,
        architectural_block: "SCB.VTOR",
      },
      {
        loaded_value: "0x4001080c",
        svd_peripheral: "GPIOA",
        architectural_block: null,
      },
    ]);

    let cliStdout = "";
    let cliExitCode = 0;
    await createCli({}).serve(
      [
        "inspect-firmware-literal-pools",
        fwPath,
        "--isa",
        "arm-thumb",
        "--base-address",
        "0x08000000",
        "--svd-xml",
        MINI_SVD,
        "--format",
        "json",
      ],
      {
        env: {},
        exit: (code) => {
          cliExitCode = code;
        },
        stdout: (chunk) => {
          cliStdout += chunk;
        },
      },
    );
    expect(cliExitCode).toBe(0);
    const cliParsed = JSON.parse(cliStdout) as {
      normalized_result: typeof mcpStructured.normalized_result;
    };
    expect(cliParsed.normalized_result).toEqual(
      mcpStructured.normalized_result,
    );
  });

  it("retains complete Evidence behind summary delivery and pages mmio_summary and references via inspect_analysis_view", async () => {
    const dir = await createTestTempDirectory("rea-literal-pools-view-");
    const fwPath = join(dir, "stm32_view.bin");
    const bundlePath = join(dir, "bundle.json");
    const image = Buffer.alloc(28, 0x00);
    image.writeUInt16LE(0x4802, 0x00); // loads 0x0c -> 0xe000ef00 (NVIC STIR)
    image.writeUInt16LE(0x4903, 0x02); // loads 0x10 -> 0x4001080c (GPIOA)
    image.writeUInt16LE(0x4a03, 0x04); // loads 0x14 -> 0xe000edd0 (SAU)
    for (let p = 0x06; p < 0x0c; p += 2) image.writeUInt16LE(0xbf00, p);
    image.writeUInt32LE(0xe000_ef00, 0x0c);
    image.writeUInt32LE(0x4001_080c, 0x10);
    image.writeUInt32LE(0xe000_edd0, 0x14);
    await writeFile(fwPath, image);

    const session = createTestBinarySession(() => {
      throw new Error("No deep provider should start");
    });
    const server = createServer(
      { kind: "session", session },
      { environment: {}, logger: silentLogger },
    );
    const client = new Client(
      { name: "firmware-literal-pools-view-test", version: "1" },
      { jsonSchemaValidator: createMcpSchemaValidation() },
    );
    onTestFinished(async () => {
      await client.close();
      await server.close();
      await session.close();
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const summaryRes = await client.callTool({
      name: "inspect_firmware_literal_pools",
      arguments: {
        path: fwPath,
        isa: "arm-thumb",
        base_address: "0x08000000",
        svd_xml: MINI_SVD,
        detail: "summary",
      },
    });
    expect(summaryRes.isError).not.toBe(true);
    const summaryContent = summaryRes.structuredContent as {
      normalized_result: {
        kind: string;
        parent_evidence_id: string;
        summary: {
          mmio_group_count: number;
          counts: { resolved_pool_loads: number };
        };
      };
    };
    expect(summaryContent.normalized_result.kind).toBe("summary");
    expect(summaryContent.normalized_result.summary.mmio_group_count).toBe(3);
    expect(
      summaryContent.normalized_result.summary.counts.resolved_pool_loads,
    ).toBe(3);

    const parentId = summaryContent.normalized_result.parent_evidence_id;
    const pageRes = await client.callTool({
      name: "inspect_analysis_view",
      arguments: {
        source: { kind: "retained-evidence", evidence_id: parentId },
        view: {
          kind: "firmware-literal-pools",
          collection: "references",
          offset: 1,
          limit: 2,
        },
      },
    });
    expect(pageRes.isError).not.toBe(true);
    const pageContent = pageRes.structuredContent as {
      normalized_result: {
        items: { source_index: number; loaded_value: string }[];
        coverage: { total: number; examined: number };
      };
    };
    expect(pageContent.normalized_result.coverage).toMatchObject({
      total: 3,
      examined: 2,
    });
    expect(pageContent.normalized_result.items).toMatchObject([
      { source_index: 1, loaded_value: "0x4001080c" },
      { source_index: 2, loaded_value: "0xe000edd0" },
    ]);

    // CLI summary + evidence bundle retains all 3 references, and bad base-address returns invalid_request:
    let cliExit = 0;
    let cliOut = "";
    await createCli({}).serve(
      [
        "inspect-firmware-literal-pools",
        fwPath,
        "--isa",
        "arm-thumb",
        "--base-address",
        "0x08000000",
        "--detail",
        "summary",
        "--evidence_output",
        bundlePath,
        "--format",
        "json",
      ],
      {
        env: {},
        exit: (c) => {
          cliExit = c;
        },
        stdout: (s) => {
          cliOut += s;
        },
      },
    );
    expect(cliExit).toBe(0);
    expect(JSON.parse(cliOut)).toHaveProperty("summary");
    const savedBundle = JSON.parse(await readFile(bundlePath, "utf8")) as {
      records: { normalized_result: { references: unknown[] } }[];
    };
    expect(savedBundle.records[0]?.normalized_result.references).toHaveLength(
      3,
    );

    let errOut = "";
    let errExit = 0;
    await createCli({}).serve(
      [
        "inspect-firmware-literal-pools",
        fwPath,
        "--isa",
        "arm-thumb",
        "--base-address",
        "0x08000001",
        "--format",
        "json",
      ],
      {
        env: {},
        exit: (c) => {
          errExit = c;
        },
        stdout: (s) => {
          errOut += s;
        },
      },
    );
    expect(errExit).toBe(0);
    expect(JSON.parse(errOut)).toMatchObject({
      code: "invalid_request",
      details: {
        issues: [expect.objectContaining({ path: ["baseAddress"] })],
      },
    });
  });
});
