import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, onTestFinished } from "vitest";
import { runDirectAnalysis } from "../../../src/application/DirectAnalysis.js";
import type { DirectAnalysisDependencies } from "../../../src/application/DirectAnalysisDependencies.js";
import { CLI_COMMAND_REGISTRATIONS } from "../../../src/cli/cliCommandRegistrations.js";
import { createCliShell } from "../../../src/cli/cliShell.js";
import * as coreAnalysisModule from "../../../src/cli/coreAnalysisCommands.js";
import { parseConfig } from "../../../src/config/parseConfig.js";
import { ok } from "../../../src/domain/result.js";
import { silentLogger } from "../../../src/logger.js";
import { createServer } from "../../../src/server/createServer.js";
import { observed } from "../../fixtures/analysisExecution.js";
import {
  createBinarySessionTargets,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";

describe("inspect_procedure_hardware_instructions CLI and MCP parity", () => {
  it("executes over advertised MCP session and public CLI with Evidence linkage", async () => {
    const [targetPath] = await createBinarySessionTargets();
    const clientFactory = () => ({
      execute: async (operation: string) => {
        if (operation === "health") return observed({ ok: true });
        if (operation === "read_function_instructions") {
          return observed({
            procedure: {
              name: "SystemInit",
              address: "0x08000200",
              classification: null,
              body: { available: false, reason: "fixture" },
            },
            instructions: [
              "0x08000200: cpsid i",
              "0x08000202: mrs r0, control",
              "0x08000206: msr basepri, r1",
              "0x0800020a: dsb sy",
              "0x0800020e: isb",
            ],
            limitations: [],
          });
        }
        throw new Error(`Unexpected provider operation: ${operation}`);
      },
      close: async () => ok(null),
    });

    const session = createTestBinarySession(clientFactory);
    const opened = await session.open(targetPath);
    expect(opened.ok).toBe(true);

    const server = createServer(
      { kind: "session", session },
      { environment: {}, logger: silentLogger },
    );
    const client = new Client(
      { name: "hw-insn-test", version: "1" },
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
      name: "inspect_procedure_hardware_instructions",
      arguments: {
        procedure: "SystemInit",
        hardware_architecture: "arm",
      },
    });
    expect(mcpRes.isError).not.toBe(true);
    const mcpStructured = mcpRes.structuredContent as {
      parameters: Record<string, unknown>;
      normalized_result: {
        matched_instruction_count: number;
        summary: { distinct_targets: string[] };
      };
      evidence_links: string[];
    };
    expect(mcpStructured.parameters).toEqual({
      procedure: "SystemInit",
      hardware_architecture: "arm",
    });
    expect(mcpStructured.normalized_result.matched_instruction_count).toBe(5);
    expect(mcpStructured.normalized_result.summary.distinct_targets).toEqual([
      "BASEPRI",
      "CONTROL",
      "CPS:I",
    ]);
    expect(mcpStructured.evidence_links.length).toBeGreaterThanOrEqual(1);

    const deps: DirectAnalysisDependencies = {
      readConfiguration: () => parseConfig({}),
      createBinarySession: () => createTestBinarySession(clientFactory),
      createNativeDispatchBinarySession: () =>
        createTestBinarySession(clientFactory),
      createArtifactBinarySession: () => createTestBinarySession(clientFactory),
      createNativeBinarySession: () => createTestBinarySession(clientFactory),
      createManagedBinarySession: () => {
        throw new Error("Unexpected managed session");
      },
    };

    const cli = createCliShell({
      selectedEnvironment: {},
      registrations: [
        {
          registration: CLI_COMMAND_REGISTRATIONS.coreAnalysis,
          module: coreAnalysisModule,
        },
      ],
      createAnalysis: () => ({
        runDirectAnalysis: (p, tool, args, opts) =>
          runDirectAnalysis(deps, p, tool, args, opts),
        runProviderAnalysis: () => {
          throw new Error("Unexpected provider analysis");
        },
        runManagedProviderEvidence: () => {
          throw new Error("Unexpected managed provider evidence");
        },
        runSessionStatus: () => {
          throw new Error("Unexpected session status");
        },
      }),
    });

    let cliStdout = "";
    let cliExitCode = 0;
    await cli.serve(
      [
        "inspect-procedure-hardware-instructions",
        targetPath,
        "SystemInit",
        "--hardware-architecture",
        "arm",
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
});
