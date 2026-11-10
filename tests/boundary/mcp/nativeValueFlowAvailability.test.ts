import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import type { AnalysisProvider } from "../../../src/application/AnalysisProvider.js";
import {
  valueTraceDiamond,
  valueTraceProvider,
} from "../../../src/application/native/NativeValueTrace.fixture.js";
import { createAnalysisProfile } from "../../../src/domain/analysisProfile.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { functionDossierSchema } from "../../../src/domain/native/functionDossier.js";
import { ok } from "../../../src/domain/result.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { advertisedMcpToolSchemas } from "../../fixtures/advertisedMcpTool.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";

const schemaValidation = createMcpSchemaValidation();
afterAll(() => schemaValidation.clear());

it.each([
  { profile: "compact", state: "supported" },
  { profile: "full", state: "supported" },
  { profile: "compact", state: "unknown" },
  { profile: "full", state: "unknown" },
  { profile: "compact", state: "unavailable" },
  { profile: "full", state: "unavailable" },
] as const)(
  "reports $state value flow without a resolver in $profile MCP",
  async ({ profile, state }) => {
    const target = join(
      await createTestTempDirectory("flow-capability-"),
      "fixture.com",
    );
    await writeFile(target, Buffer.from([0xb8, 0x00, 0x4c, 0xcd, 0x21]));
    const graph = valueTraceDiamond({ sessionSubject: true });
    const provider: AnalysisProvider = {
      identity: () => valueTraceProvider,
      capabilities: () => [
        {
          provider: valueTraceProvider,
          operation: "analyze_function",
          available: true,
          reason: null,
          ...(state === "unknown"
            ? {}
            : state === "supported"
              ? { nativeValueFlow: { status: "supported" as const } }
              : {
                  nativeValueFlow: {
                    status: "unavailable" as const,
                    reason: "Fixture has no value flow.",
                  },
                }),
          effects: {
            mutatesArtifact: false,
            launchesProcess: false,
            mayShowUi: false,
            mayAccessNetwork: false,
            mayWriteFilesystem: false,
            changesPermissions: false,
            requiresRoot: false,
          },
          limitations: [],
        },
      ],
      resolveAnalysisProfile: async () =>
        ok({
          profile: createAnalysisProfile(valueTraceProvider, { fixture: true }),
        }),
      createClient: () => ({
        execute: async (operation, parameters, options) => {
          const execution = await graph.port.execute(
            operation,
            parameters,
            options,
          );
          if (
            !execution.ok ||
            state !== "unavailable" ||
            operation !== "analyze_function"
          )
            return execution;
          const dossier = functionDossierSchema.parse(execution.value.result);
          return ok({
            ...execution.value,
            result: {
              ...dossier,
              native_value_flow: {
                available: false,
                reason: "Fixture has no value flow.",
                limitations: [],
              },
            },
          });
        },
        close: async () => ok(null),
      }),
    };
    const session = createTestBinarySession(provider);
    const { client } = await createApplicationMcpHarness({
      session,
      schemaValidator: schemaValidation,
      serverOptions: {
        environment: {
          ...process.env,
          REA_MCP_INPUT_SCHEMA_PROFILE: profile,
          REA_MCP_OUTPUT_SCHEMA_PROFILE: profile,
        },
      },
    });
    const call = async (name: string, args: Record<string, unknown>) => {
      const schema = await advertisedMcpToolSchemas(
        client,
        name,
        schemaValidation.assertions,
      );
      const reply = await client.callTool(
        { name, arguments: args },
        { toolDefinition: schema.toolDefinition },
      );
      expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
      expect(
        schema.ajv.validate(schema.outputSchema, reply.structuredContent),
        JSON.stringify(schema.ajv.errors),
      ).toBe(true);
      return reply.structuredContent;
    };
    await call("open_binary", { path: target, format: "dos-com" });
    const status = (await call("binary_session", { detail: "summary" })) as {
      result: {
        tool_availability: {
          groups: Array<{
            names: string[];
            available: boolean;
            value_flow_support?: { status: string; provider_id: string };
            remediation: string | null;
          }>;
        };
      };
    };
    const traceStatus = status.result.tool_availability.groups.find((g) =>
      g.names.includes("trace_native_values"),
    );
    expect(traceStatus).toMatchObject({
      available: false,
      value_flow_support: { status: state, provider_id: "fixture" },
      remediation: expect.any(String),
    });
    if (state === "unavailable")
      expect(traceStatus?.remediation).toContain("Fixture has no value flow.");
    else
      expect(traceStatus?.remediation).toContain("resolve_native_call_targets");
    const trace = parseEvidence(
      await call("trace_native_values", { procedure: "0x1000", max_depth: 0 }),
    );
    const value = trace.normalized_result as {
      total_nodes: number;
      unknowns: Array<{ reason: string }>;
    };
    if (state === "unavailable") {
      expect(value.total_nodes).toBe(0);
      expect(value.unknowns).toContainEqual(
        expect.objectContaining({ reason: "Fixture has no value flow." }),
      );
    } else {
      expect(value.total_nodes).toBeGreaterThan(0);
      expect(
        value.unknowns.some((unknown) =>
          unknown.reason.includes("resolve_native_call_targets"),
        ),
      ).toBe(true);
    }
  },
);
