import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import pino from "pino";
import { expect, it } from "vitest";
import { runDirectAnalysis } from "../../../src/application/DirectAnalysis.js";
import type { DirectAnalysisDependencies } from "../../../src/application/DirectAnalysisDependencies.js";
import { registerCoreNativeCommands } from "../../../src/cli/coreNativeCommands.js";
import { parseConfig } from "../../../src/config/parseConfig.js";
import { createAnalysisProfile } from "../../../src/domain/analysisProfile.js";
import { hardwarePeripheralReconstructionResultSchema } from "../../../src/domain/firmware/hardwarePeripheralReconstructionSchema.js";
import {
  ghidraFunctionIdentity,
  ghidraReferenceEdge,
} from "../../../src/domain/ghidraValues.fixture.js";
import { jsonValueSchema } from "../../../src/domain/jsonValue.js";
import { ok } from "../../../src/domain/result.js";
import {
  createAnalysisExecution,
  type AnalysisProvider,
} from "../../../src/ports/AnalysisProvider.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import {
  canonicalOutputSchema,
  withCanonicalOutputSchema,
} from "../../fixtures/canonicalOutputSchema.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { createCommandCli } from "../../support/cli/commandCli.js";
import { connectGhidraMcp, sessionEvidence } from "./ghidraMcpHarness.js";

const SAMPLE_REFERENCES = {
  procedure: ghidraFunctionIdentity(),
  direction: "outgoing" as const,
  reference_kinds_available: true,
  unresolved_calls: [],
  references: [
    {
      ...ghidraReferenceEdge(),
      source_address: "0x08000110",
      target_address: "0x40023830",
    },
    {
      ...ghidraReferenceEdge(),
      source_address: "0x08000118",
      target_address: "0x40001000",
    },
  ],
};

it("executes reconstruct_procedure_hardware_interactions through the advertised MCP contract", async () => {
  const harness = await connectGhidraMcp(
    "ghidra-hardware-reconstruction",
    async (operation) => {
      if (operation === "procedure_references") {
        return ok(
          jsonValueSchema.parse({ value: SAMPLE_REFERENCES, limitations: [] }),
        );
      }
      throw new Error(`Unexpected provider operation: ${operation}`);
    },
  );
  try {
    const catalog = await harness.mcp.listTools();
    const definition = catalog.tools.find(
      (tool) => tool.name === "reconstruct_procedure_hardware_interactions",
    );
    if (definition === undefined) {
      throw new Error(
        "Missing advertised reconstruct_procedure_hardware_interactions tool",
      );
    }
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    expect(ajv.validateSchema(definition.inputSchema)).toBe(true);
    expect(ajv.validateSchema(canonicalOutputSchema(definition.name))).toBe(
      true,
    );

    const svdXml = `
      <device><name>CustomMcu</name><peripherals>
        <!-- <peripheral><name>CUSTOM_UART</name><baseAddress>0x40009000</baseAddress></peripheral> -->
        <peripheral>
          <name>CUSTOM_UART</name>
          <baseAddress>0x40001000</baseAddress>
          <registers>
            <register><name>DR</name><addressOffset>0x00</addressOffset></register>
          </registers>
        </peripheral>
      </peripherals></device>
    `;
    const reply = await harness.mcp.callTool(
      {
        name: "reconstruct_procedure_hardware_interactions",
        arguments: {
          procedure: "reset_handler",
          hardware_architecture: "cortex-m",
          platform: "stm32f4",
          svd_xml: svdXml,
        },
      },
      { toolDefinition: withCanonicalOutputSchema(definition) },
    );
    expect(reply.isError).not.toBe(true);
    const evidence = sessionEvidence(harness.session, reply.structuredContent);
    const parsed = hardwarePeripheralReconstructionResultSchema.parse(
      evidence.normalized_result,
    );
    expect(parsed.procedure).toBe("reset_handler");
    expect(parsed.mmioAccessCount).toBe(2);
    expect(parsed.customProfile).toMatchObject({
      id: "CustomMcu",
      sourceKind: "cmsis_svd",
    });
    expect(
      parsed.peripheralBlocks.map((block) => block.socPeripheralName),
    ).toEqual(expect.arrayContaining(["CUSTOM_UART", "RCC"]));
    expect(harness.calls).toEqual(["procedure_references"]);
    expect(harness.session.evidenceById(evidence.evidence_id)).toEqual(
      evidence,
    );
  } finally {
    await harness.close();
  }
});

it("executes reconstruct-procedure-hardware-interactions through the public CLI command", async () => {
  const root = await createTestTempDirectory("rea-hw-reconstruct-cli-");
  const targetPath = join(root, "firmware.hop");
  await writeFile(targetPath, "synthetic firmware database");

  const identity = { id: "fixture", name: "Fixture", version: "1" } as const;
  const provider: AnalysisProvider = {
    identity: () => identity,
    capabilities: () => [
      {
        provider: identity,
        operation: "procedure_references",
        available: true,
        reason: null,
        cachePolicy: "live",
        limitations: [],
        effects: {
          mutatesArtifact: false,
          launchesProcess: false,
          mayShowUi: false,
          mayAccessNetwork: false,
          mayWriteFilesystem: false,
          changesPermissions: false,
          requiresRoot: false,
        },
      },
    ],
    resolveAnalysisProfile: async () =>
      ok({ profile: createAnalysisProfile(identity, { fixture: true }) }),
    createClient: () => ({
      execute: async (operation) => {
        expect(operation).toBe("procedure_references");
        return ok(
          createAnalysisExecution(
            jsonValueSchema.parse(SAMPLE_REFERENCES),
            identity,
          ),
        );
      },
      close: async () => ok(null),
    }),
  };

  const createSession = () => createTestBinarySession(provider);
  const dependencies: DirectAnalysisDependencies = {
    readConfiguration: () => parseConfig({}),
    createBinarySession: createSession,
    createNativeDispatchBinarySession: createSession,
    createArtifactBinarySession: createSession,
    createNativeBinarySession: createSession,
    createManagedBinarySession: createSession,
  };

  const cli = createCommandCli();
  registerCoreNativeCommands(
    cli,
    pino({ enabled: false }),
    (target, tool, args, options) =>
      runDirectAnalysis(dependencies, target, tool, args, options),
  );

  let stdout = "";
  await cli.serve(
    [
      "reconstruct-procedure-hardware-interactions",
      targetPath,
      "reset_handler",
      "--hardware-architecture",
      "cortex-m",
      "--platform",
      "stm32f4",
      "--provider",
      "fixture",
      "--json",
    ],
    {
      env: {},
      stdout: (text) => {
        stdout += text;
      },
      exit: () => undefined,
    },
  );

  const response = JSON.parse(stdout) as {
    evidence_id: string;
    operation: string;
    normalized_result: unknown;
  };
  expect(response.operation).toBe(
    "reconstruct_procedure_hardware_interactions",
  );
  const parsed = hardwarePeripheralReconstructionResultSchema.parse(
    response.normalized_result,
  );
  expect(parsed.procedure).toBe("reset_handler");
  expect(parsed.platform).toBe("stm32f4");
  expect(parsed.mmioAccessCount).toBe(2);
  expect(
    parsed.peripheralBlocks.some((block) => block.socPeripheralName === "RCC"),
  ).toBe(true);

  let dashStdout = "";
  await cli.serve(
    [
      "reconstruct-procedure-hardware-interactions",
      targetPath,
      "--procedure=-sub_init",
      "--hardware-architecture",
      "riscv",
      "--svd-xml",
      `<device><name>Rv64SoC</name><peripherals>
        <peripheral>
          <dim>2</dim>
          <dimIncrement>0x1000</dimIncrement>
          <dimIndex>0,1</dimIndex>
          <name>UART%s</name>
          <baseAddress>0x400000000</baseAddress>
          <addressBlock><offset>0x0</offset><size>0x1000</size></addressBlock>
          <registers>
            <register><name>THR</name><addressOffset>0x00</addressOffset></register>
          </registers>
        </peripheral>
      </peripherals></device>`,
      "--provider",
      "fixture",
      "--json",
    ],
    {
      env: {},
      stdout: (text) => {
        dashStdout += text;
      },
      exit: () => undefined,
    },
  );
  const dashParsed = hardwarePeripheralReconstructionResultSchema.parse(
    (JSON.parse(dashStdout) as { normalized_result: unknown })
      .normalized_result,
  );
  expect(dashParsed.procedure).toBe("-sub_init");
  expect(dashParsed.architecture).toBe("riscv");
});

it("attributes 64-bit RISC-V peripheral windows above 0xffffffff through MCP", async () => {
  const harness = await connectGhidraMcp(
    "ghidra-rv64-hardware-reconstruction",
    async (operation) => {
      if (operation === "procedure_references") {
        return ok(
          jsonValueSchema.parse({
            value: {
              ...SAMPLE_REFERENCES,
              references: [
                {
                  ...ghidraReferenceEdge(),
                  source_address: "0x80200010",
                  target_address: "0x400001000",
                },
              ],
            },
            limitations: [],
          }),
        );
      }
      throw new Error(`Unexpected provider operation: ${operation}`);
    },
  );
  try {
    const catalog = await harness.mcp.listTools();
    const definition = catalog.tools.find(
      (tool) => tool.name === "reconstruct_procedure_hardware_interactions",
    )!;
    const reply = await harness.mcp.callTool(
      {
        name: "reconstruct_procedure_hardware_interactions",
        arguments: {
          procedure: "rv64_uart_putc",
          hardware_architecture: "riscv",
          svd_xml: `<device><name>Rv64SoC</name><peripherals>
            <peripheral>
              <dim>2</dim>
              <dimIncrement>0x1000</dimIncrement>
              <dimIndex>0,1</dimIndex>
              <name>UART%s</name>
              <baseAddress>0x400000000</baseAddress>
              <addressBlock><offset>0x0</offset><size>0x1000</size></addressBlock>
              <registers>
                <register><name>THR</name><addressOffset>0x00</addressOffset></register>
              </registers>
            </peripheral>
          </peripherals></device>`,
        },
      },
      { toolDefinition: withCanonicalOutputSchema(definition) },
    );
    expect(reply.isError).not.toBe(true);
    const evidence = sessionEvidence(harness.session, reply.structuredContent);
    const parsed = hardwarePeripheralReconstructionResultSchema.parse(
      evidence.normalized_result,
    );
    expect(parsed.mmioAccessCount).toBe(1);
    expect(parsed.peripheralBlocks).toEqual([
      expect.objectContaining({
        blockBase: "0x400001000",
        socPeripheralName: "UART1",
        socPeripheralNameBasis: "explicit_profile",
        knownRegisters: ["UART1_THR"],
      }),
    ]);
  } finally {
    await harness.close();
  }
});
