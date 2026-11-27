import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, onTestFinished } from "vitest";
import { createCli } from "../../../src/cli.js";
import { silentLogger } from "../../../src/logger.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("inspect_firmware_vector_table CLI and MCP parity", () => {
  it("decodes an STM32 Cortex-M vector table with CLI and advertised MCP parity and enforces max_file_bytes", async () => {
    const dir = await createTestTempDirectory("rea-fw-vt-");
    const fwPath = join(dir, "stm32.bin");
    const img = Buffer.alloc(128, 0);
    img.writeUInt32LE(0x20020000, 0); // InitialSP
    img.writeUInt32LE(0x08000081, 4); // Reset
    img.writeUInt32LE(0x08000091, 8); // NMI
    img.writeUInt32LE(0x08000091, 12); // HardFault (shared with NMI)
    img.writeUInt32LE(0x080000a1, 16 * 4); // IRQ 0
    await writeFile(fwPath, img);

    const svdXml =
      "<device><peripherals><peripheral><name>WWDG</name><interrupt><name>WWDG_IRQ</name><value>0</value></interrupt></peripheral></peripherals></device>";

    const session = createTestBinarySession(() => {
      throw new Error("No deep provider should start");
    });
    const server = createServer(
      { kind: "session", session },
      { environment: {}, logger: silentLogger },
    );
    const client = new Client(
      { name: "fw-vt-test", version: "1" },
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
      name: "inspect_firmware_vector_table",
      arguments: {
        path: fwPath,
        architecture: "armv7-m",
        base_address: "0x08000000",
        max_entries: 20,
        svd_xml: svdXml,
      },
    });
    expect(mcpRes.isError).not.toBe(true);
    const mcpStructured = mcpRes.structuredContent as {
      parameters: Record<string, unknown>;
      limitations: string[];
      normalized_result: {
        initial_stack_pointer: string;
        reset_code_address: string;
        trap_entry_address: string | null;
        arm_entries: { irq_number: number | null; name: string | null }[];
      };
    };
    expect(mcpStructured.parameters).toEqual({
      path: fwPath,
      architecture: "armv7-m",
      base_address: "0x08000000",
      max_entries: 20,
      svd_xml_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(mcpStructured.limitations).toContain(
      "Inline svd_xml UTF-8 text is not retained in Evidence and is unavailable from this record; parameters.svd_xml_sha256 records the SHA-256 digest of the caller-supplied svd_xml.",
    );
    expect(mcpStructured.normalized_result.initial_stack_pointer).toBe(
      "0x20020000",
    );
    expect(mcpStructured.normalized_result.reset_code_address).toBe(
      "0x8000080",
    );
    expect(mcpStructured.normalized_result.trap_entry_address).toBeNull();
    expect(mcpStructured.normalized_result.arm_entries[16]).toMatchObject({
      irq_number: 0,
      name: "WWDG_IRQ",
    });

    const oversizedRes = await client.callTool({
      name: "inspect_firmware_vector_table",
      arguments: {
        path: fwPath,
        architecture: "armv7-m",
        base_address: "0x08000000",
        max_file_bytes: 16,
      },
    });
    expect(oversizedRes.isError).toBe(true);
    const oversizedError = JSON.parse(
      (oversizedRes.content[0] as { type: "text"; text: string }).text,
    ) as Record<string, unknown>;
    expect(oversizedError).toMatchObject({
      error: {
        remediation: {
          action:
            "inspect_firmware_vector_table reached its max_file_bytes budget of 16 bytes. Pass a larger max_file_bytes on the next inspect_firmware_vector_table call (at least 128 bytes; range 4..67108864 bytes), then retry.",
        },
        details: {
          refusal: {
            kind: "adjustable_budget",
            control: "max_file_bytes",
            effective_value: 16,
            required_value: 128,
          },
        },
      },
    });

    let cliStdout = "";
    let cliExitCode = 0;
    await createCli({}).serve(
      [
        "inspect-firmware-vector-table",
        fwPath,
        "--architecture",
        "armv7-m",
        "--base-address",
        "0x08000000",
        "--max-entries",
        "20",
        "--svd-xml",
        svdXml,
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
      limitations: string[];
      normalized_result: typeof mcpStructured.normalized_result;
    };
    expect(cliParsed.limitations).toEqual(mcpStructured.limitations);
    expect(cliParsed.normalized_result).toEqual(
      mcpStructured.normalized_result,
    );

    const badSvdMcp = await client.callTool({
      name: "inspect_firmware_vector_table",
      arguments: {
        path: fwPath,
        architecture: "armv7-m",
        base_address: "0x08000000",
        svd_xml: "<wrong/>",
      },
    });
    expect(badSvdMcp.isError).toBe(true);
    expect(
      JSON.parse(
        (badSvdMcp.content[0] as { type: "text"; text: string }).text,
      ) as Record<string, unknown>,
    ).toMatchObject({
      error: {
        code: "invalid_request",
        category: "invalid_input",
        details: {
          issues: [{ path: ["svd_xml"], reason: "invalid_format" }],
        },
      },
    });
  });
});
