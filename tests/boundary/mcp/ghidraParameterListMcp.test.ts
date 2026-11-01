import { expect, it } from "vitest";
import { connectGhidraMcp, sessionEvidence } from "./ghidraMcpHarness.js";
import { advertisedMcpToolSchemas } from "../../fixtures/advertisedMcpTool.js";
import { ghidraFunctionDossier } from "../../../src/domain/ghidraValues.fixture.js";
import { functionDossierSchema } from "../../../src/domain/native/functionDossier.js";
import { nativeApiInspectionResultSchema } from "../../../src/domain/native/nativeApiBoundary.js";
import { nativeValueTraceSchema } from "../../../src/domain/native/nativeValueTrace.js";
import { jsonValueSchema } from "../../../src/domain/jsonValue.js";
import { ok } from "../../../src/domain/result.js";

const caller = "0x401000";
const callee = "0x401100";
const register = {
  kind: "register",
  size_bytes: 4,
  location: "register:0x0",
  constant_hex: null,
} as const;

/** A controlled bridge wire dossier; it never launches Ghidra. */
const bridgeDossier = (
  address: string,
  name: string,
  operations: readonly Record<string, unknown>[],
  api: { readonly signatureSource: string; readonly parameterList: unknown },
) => {
  const base = functionDossierSchema.parse(ghidraFunctionDossier());
  if (
    base.native_api?.available !== true ||
    base.native_value_flow?.available !== true
  )
    throw new Error("Invalid Ghidra fixture");
  const end = `0x${(Number.parseInt(address, 16) + 5).toString(16)}`;
  const boundary: Record<string, unknown> = {
    ...base.native_api,
    signature_source: api.signatureSource,
    parameters: [],
    parameter_list: api.parameterList,
    jump_tables: [],
  };
  if (api.parameterList === undefined) delete boundary.parameter_list;
  return jsonValueSchema.parse({
    ...base,
    procedure: {
      ...base.procedure,
      address,
      name,
      body: { ...base.procedure.body, ranges: [{ start: address, end }] },
      signature: null,
    },
    native_api: boundary,
    native_value_flow: {
      ...base.native_value_flow,
      operations: operations.map((operation, sequence) => ({
        id: `${address}#${String(sequence)}`,
        sequence,
        is_dead: false,
        block_membership: "member",
        ...operation,
      })),
    },
  });
};

/** `audit_call_zero` calls `audit_zero`, which takes the callee's parameter facts. */
const connect = (calleeApi: Parameters<typeof bridgeDossier>[3]) =>
  connectGhidraMcp("ghidra-parameter-list", async (operation, input) => {
    if (operation === "resolve_native_call_targets")
      return ok(
        jsonValueSchema.parse({
          call_site: "0x401004",
          procedure: callee,
          status: "direct",
          mechanism: "direct",
          targets: [
            {
              address: callee,
              procedure: callee,
              status: "direct",
              basis: "provider-reference",
              references: [],
            },
          ],
          limitations: [],
        }),
      );
    if (operation !== "analyze_function")
      throw new Error(`Unexpected controlled Ghidra operation: ${operation}`);
    const value =
      input.procedure === callee
        ? bridgeDossier(
            callee,
            "audit_zero",
            [
              {
                address: "0x401104",
                opcode: "RETURN",
                inputs: [
                  {
                    kind: "constant",
                    size_bytes: 8,
                    location: null,
                    constant_hex: "0",
                  },
                  register,
                ],
                output: null,
              },
            ],
            calleeApi,
          )
        : bridgeDossier(
            caller,
            "audit_call_zero",
            [
              {
                address: "0x401004",
                opcode: "CALL",
                inputs: [
                  {
                    kind: "address",
                    size_bytes: 8,
                    location: callee,
                    constant_hex: null,
                  },
                ],
                output: register,
              },
            ],
            {
              signatureSource: "default",
              parameterList: { basis: "recovered", variadic: false },
            },
          );
    return ok(jsonValueSchema.parse({ value, limitations: [] }));
  });

const missingBindings = `Parameter bindings for ${callee} are unavailable or omitted`;

it.each([
  {
    label: "a user-defined zero-parameter signature",
    signatureSource: "user_defined",
    parameterList: { basis: "signature", variadic: false },
    unknowns: [],
  },
  {
    label: "a decompiler-recovered empty list",
    signatureSource: "default",
    parameterList: { basis: "recovered", variadic: false },
    unknowns: [missingBindings],
  },
  {
    label: "a user-defined variadic signature without fixed parameters",
    signatureSource: "user_defined",
    parameterList: { basis: "signature", variadic: true },
    unknowns: [missingBindings],
  },
] as const)(
  "traces $label through the Ghidra adapter and advertised MCP contracts",
  async ({ signatureSource, parameterList, unknowns }) => {
    const harness = await connect({ signatureSource, parameterList });
    try {
      const call = async (
        name: "trace_native_values" | "inspect_native_api",
        arguments_: Record<string, unknown>,
      ) => {
        const { toolDefinition, ajv, outputSchema } =
          await advertisedMcpToolSchemas(harness.mcp, name);
        const reply = await harness.mcp.callTool(
          { name, arguments: arguments_ },
          { toolDefinition },
        );
        expect(reply.isError, JSON.stringify(reply.content)).not.toBe(true);
        expect(
          ajv.validate(outputSchema, reply.structuredContent),
          JSON.stringify(ajv.errors),
        ).toBe(true);
        return sessionEvidence(harness.session, reply.structuredContent)
          .normalized_result;
      };
      const trace = nativeValueTraceSchema.parse(
        await call("trace_native_values", { procedure: caller, max_depth: 1 }),
      );
      expect(trace).toMatchObject({
        traversal: { status: "complete" },
        truncated: false,
      });
      expect(trace.unknowns.map(({ reason }) => reason)).toEqual(unknowns);
      expect(trace.edges.map(({ kind }) => kind)).toEqual([
        "call",
        "return-binding",
      ]);
      expect(
        nativeApiInspectionResultSchema.parse(
          await call("inspect_native_api", { procedure: callee }),
        ).boundary,
      ).toMatchObject({
        available: true,
        signature_source: signatureSource,
        parameters: [],
        parameter_list: parameterList,
      });
    } finally {
      await harness.close();
    }
  },
  30_000,
);

it("refuses a bridge API boundary that omits its parameter-list basis", async () => {
  const harness = await connect({
    signatureSource: "user_defined",
    parameterList: undefined,
  });
  try {
    const reply = await harness.mcp.callTool({
      name: "inspect_native_api",
      arguments: { procedure: callee },
    });
    expect(reply.isError).toBe(true);
  } finally {
    await harness.close();
  }
}, 30_000);
