import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, onTestFinished } from "vitest";
import { createCli } from "../../../src/cli.js";
import { silentLogger } from "../../../src/logger.js";
import { AGENT_RESULT_BUDGET_ENVIRONMENT } from "../../../src/domain/agentResultBudget.js";
import { analysisRefusalRemediation } from "../../../src/domain/analysisRefusal.js";
import type { AdjustableBudget } from "../../../src/domain/analysisRefusal.js";
import {
  DEFAULT_AGENT_RESULT_BUDGET_BYTES,
  MINIMUM_AGENT_RESULT_BUDGET_BYTES,
} from "../../../src/domain/analysisResourceLimits.js";
import { AGENT_BUDGET_DELIVERY_META } from "../../../src/server/ToolResultDelivery.js";
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
    const oversizedDetails = (
      oversizedError as { error: { details: { limit: AdjustableBudget } } }
    ).error.details;
    expect(oversizedError).toMatchObject({
      error: {
        // The recovery is the shared refusal formatter over the reported limit.
        remediation: {
          action: analysisRefusalRemediation({
            kind: "adjustable_budget",
            operation: "inspect_firmware_vector_table",
            budget: oversizedDetails.limit,
          }),
        },
        details: {
          limit: {
            control_kind: "parameter",
            parameter: "max_file_bytes",
            effective_value: 16,
            required_value: 128,
          },
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

    // MCP summary delivery + inspect_analysis_view pagination
    const mcpSummaryRes = await client.callTool({
      name: "inspect_firmware_vector_table",
      arguments: {
        path: fwPath,
        architecture: "armv7-m",
        base_address: "0x08000000",
        max_entries: 20,
        svd_xml: svdXml,
        detail: "summary",
      },
    });
    expect(mcpSummaryRes.isError).not.toBe(true);
    const summaryRecord = mcpSummaryRes.structuredContent as {
      normalized_result: {
        kind: string;
        parent_evidence_id: string;
        parent_operation: string;
        summary: {
          arm_entry_count: number;
          active_arm_entry_count: number;
          shared_handler_group_count: number;
          initial_stack_pointer: string;
          reset_code_address: string;
        };
      };
    };
    expect(summaryRecord.normalized_result).toMatchObject({
      kind: "summary",
      parent_operation: "inspect_firmware_vector_table",
      summary: {
        arm_entry_count: 20,
        active_arm_entry_count: 4,
        shared_handler_group_count: 1,
        initial_stack_pointer: "0x20020000",
        reset_code_address: "0x8000080",
      },
    });

    const pageRes = await client.callTool({
      name: "inspect_analysis_view",
      arguments: {
        source: {
          kind: "retained-evidence",
          evidence_id: summaryRecord.normalized_result.parent_evidence_id,
        },
        view: {
          kind: "firmware-vector-table",
          collection: "arm_entries",
          offset: 16,
          limit: 2,
        },
      },
    });
    expect(pageRes.isError).not.toBe(true);
    const pageStructured = pageRes.structuredContent as {
      normalized_result: {
        kind: string;
        items: {
          slot_index: number;
          irq_number: number | null;
          name: string | null;
          source_index: number;
        }[];
        coverage: {
          total: number;
          examined: number;
          next_offset: number | null;
        };
      };
    };
    expect(pageStructured.normalized_result.kind).toBe("firmware-vector-table");
    expect(pageStructured.normalized_result.coverage).toMatchObject({
      total: 20,
      examined: 2,
      next_offset: 18,
    });
    expect(pageStructured.normalized_result.items[0]).toMatchObject({
      slot_index: 16,
      irq_number: 0,
      name: "WWDG_IRQ",
      source_index: 16,
    });

    // CLI --detail summary --evidence_output writes complete bundle and prints summary
    const bundlePath = join(dir, "vt-bundle.json");
    let cliSummaryStdout = "";
    let cliSummaryExit = 0;
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
        "--detail",
        "summary",
        "--evidence_output",
        bundlePath,
        "--format",
        "json",
      ],
      {
        env: {},
        exit: (code) => {
          cliSummaryExit = code;
        },
        stdout: (chunk) => {
          cliSummaryStdout += chunk;
        },
      },
    );
    expect(cliSummaryExit).toBe(0);
    const cliSummaryParsed = JSON.parse(cliSummaryStdout) as {
      summary: {
        operation: string;
        normalized_result: {
          kind: string;
          parent_evidence_id: string;
          parent_operation: string;
          summary: { arm_entry_count: number; active_arm_entry_count: number };
        };
      };
    };
    expect(cliSummaryParsed.summary.operation).toBe("inspect_analysis_view");
    expect(cliSummaryParsed.summary.normalized_result).toMatchObject({
      kind: "summary",
      parent_operation: "inspect_firmware_vector_table",
      summary: {
        arm_entry_count: 20,
        active_arm_entry_count: 4,
      },
    });
    const parentId =
      cliSummaryParsed.summary.normalized_result.parent_evidence_id;
    const savedBundle = JSON.parse(await readFile(bundlePath, "utf8")) as {
      records: { evidence_id: string }[];
    };
    expect(
      savedBundle.records.some((record) => record.evidence_id === parentId),
    ).toBe(true);

    let cliViewStdout = "";
    let cliViewExit = 0;
    await createCli({}).serve(
      [
        "inspect-analysis-view",
        JSON.stringify({
          source: {
            kind: "retained-evidence",
            evidence_id: parentId,
          },
          view: {
            kind: "firmware-vector-table",
            collection: "shared_handler_groups",
            offset: 0,
            limit: 10,
          },
        }),
        "--evidence-bundle",
        bundlePath,
        "--format",
        "json",
      ],
      {
        env: {},
        exit: (code) => {
          cliViewExit = code;
        },
        stdout: (chunk) => {
          cliViewStdout += chunk;
        },
      },
    );
    expect(cliViewExit).toBe(0);
    const cliViewParsed = JSON.parse(cliViewStdout) as {
      normalized_result: {
        kind: string;
        items: {
          target_code_address: string;
          slot_count: number;
          source_index: number;
        }[];
      };
    };
    expect(cliViewParsed.normalized_result.kind).toBe("firmware-vector-table");
    expect(cliViewParsed.normalized_result.items).toEqual([
      {
        target_code_address: "0x8000090",
        slot_count: 2,
        slot_indices: [2, 3],
        source_index: 0,
      },
    ]);
  });

  it("delivers a retained summary only when the complete result exceeds the selected agent result budget", async () => {
    const dir = await createTestTempDirectory("rea-fw-vt-budget-");
    const fwPath = join(dir, "vt.bin");
    // 48 slots: a complete report between the 4096-byte minimum budget and
    // the 32768-byte default, so only the selected budget summarizes it.
    const img = Buffer.alloc(48 * 4, 0);
    img.writeUInt32LE(0x20020000, 0);
    for (let i = 1; i < 48; i += 1)
      img.writeUInt32LE(0x08001001 + i * 4, i * 4);
    await writeFile(fwPath, img);

    const inspectWith = async (environment: NodeJS.ProcessEnv) => {
      const session = createTestBinarySession(() => {
        throw new Error("No deep provider should start");
      });
      const server = createServer(
        { kind: "session", session },
        { environment, logger: silentLogger },
      );
      const client = new Client(
        { name: "fw-vt-budget-test", version: "1" },
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
      return client.callTool({
        name: "inspect_firmware_vector_table",
        arguments: {
          path: fwPath,
          architecture: "armv7-m",
          base_address: "0x08000000",
          max_entries: 48,
        },
      });
    };
    // The test environment seeds a complete-delivery budget; drop it.
    const { [AGENT_RESULT_BUDGET_ENVIRONMENT]: _seed, ...defaults } =
      process.env;

    const summarized = await inspectWith({
      ...defaults,
      [AGENT_RESULT_BUDGET_ENVIRONMENT]: String(
        MINIMUM_AGENT_RESULT_BUDGET_BYTES,
      ),
    });
    expect(summarized.isError).not.toBe(true);
    const delivery = summarized._meta?.[AGENT_BUDGET_DELIVERY_META] as {
      readonly budget_bytes: number;
      readonly complete_bytes: number;
    };
    expect(delivery.budget_bytes).toBe(MINIMUM_AGENT_RESULT_BUDGET_BYTES);
    expect(delivery.complete_bytes).toBeGreaterThan(
      MINIMUM_AGENT_RESULT_BUDGET_BYTES,
    );
    expect(delivery.complete_bytes).toBeLessThanOrEqual(
      DEFAULT_AGENT_RESULT_BUDGET_BYTES,
    );
    expect(summarized.structuredContent).toMatchObject({
      operation: "inspect_analysis_view",
      normalized_result: {
        kind: "summary",
        parent_operation: "inspect_firmware_vector_table",
        summary: { arm_entry_count: 48 },
      },
    });

    const complete = await inspectWith(defaults);
    expect(complete.isError).not.toBe(true);
    expect(complete._meta?.[AGENT_BUDGET_DELIVERY_META]).toBeUndefined();
    expect(complete.structuredContent).toMatchObject({
      operation: "inspect_firmware_vector_table",
    });
  });
});
