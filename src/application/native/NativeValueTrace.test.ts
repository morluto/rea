import { createAnalysisExecutionEvidence } from "../../domain/analysisObservation.js";
import { describe, expect, it } from "vitest";
import { traceNativeValues } from "./NativeValueTrace.js";
import {
  createAnalysisExecution,
  type AnalysisOperationPort,
} from "../AnalysisProvider.js";
import { ghidraFunctionDossier } from "../../domain/ghidraValues.fixture.js";
import { functionDossierSchema } from "../../domain/native/functionDossier.js";
import { jsonValueSchema } from "../../domain/jsonValue.js";
import { nativeValueTraceSchema } from "../../domain/native/nativeValueTrace.js";
import {
  AnalysisCancelledError,
  AnalysisOutputError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import { NoBinaryOpenError } from "../../domain/configurationErrors.js";
import { ok, err } from "../../domain/result.js";

const subject = {
  path: "/fixture",
  sha256: "a".repeat(64),
  format: "mach-o" as const,
  architecture: "arm64" as const,
};
const provider = { id: "fixture", name: "Fixture", version: "1" };
const scalar = {
  kind: "constant",
  size_bytes: 4,
  location: null,
  constant_hex: "3",
};
const node = (id: string, address: string, opcode: string) => ({
  id,
  address,
  sequence: 0,
  opcode,
  is_dead: true,
  block_membership: "member",
  inputs: [scalar, scalar],
  output: scalar,
});
const analysis: AnalysisOperationPort = {
  execute: async (operation, parameters) => {
    if (operation === "resolve_native_call_targets")
      return ok(
        createAnalysisExecution(
          {
            call_site: "0x1000",
            procedure: "0x1000",
            status: "direct",
            mechanism: "direct",
            targets: [
              {
                address: "0x2000",
                procedure: "0x2000",
                status: "direct",
                basis: "provider-reference",
                references: [],
              },
            ],
            limitations: [],
          },
          provider,
          { subject },
        ),
      );
    const callee = parameters.procedure === "0x2000";
    return ok(
      createAnalysisExecution(
        jsonValueSchema.parse({
          ...functionDossierSchema.parse(ghidraFunctionDossier()),
          procedure: {
            address: callee ? "0x2000" : "0x1000",
            name: callee ? "callee" : "caller",
            classification: null,
            body: {
              available: false,
              reason:
                "The provider did not report complete function body ranges.",
            },
            signature: null,
            locals: [],
          },
          native_value_flow: {
            available: true,
            provenance: "ghidra-high-pcode",
            operations: callee
              ? [node("return", "0x2000", "RETURN")]
              : [node("call", "0x1000", "CALL")],
            def_use: [],
            effects: [],
            parameters: callee
              ? [{ ordinal: 0, name: "value", data_type: "/int" }]
              : [],
            parameter_uses: callee
              ? [{ ordinal: 0, use: "return", input_index: 1 }]
              : [],
            truncated: false,
            omitted_operations_lower_bound: 0,
            known_omitted_inputs: 0,
            known_omitted_edges: 0,
            limitations: [],
          },
        }),
        provider,
        { subject },
      ),
    );
  },
};
describe("native value trace seed admission", () => {
  it("preserves the exact abort reason before attempting a seed", async () => {
    const reason = { request: "cancel before native trace" };
    const attempted: unknown[] = [];
    const result = await traceNativeValues(
      {
        execute: async (operation, parameters) => {
          attempted.push([operation, parameters]);
          return analysis.execute(operation, parameters);
        },
      },
      { procedure: "0x1000" },
      AbortSignal.abort(reason),
    );
    if (result.ok) throw new Error("Expected pre-seed cancellation");
    expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(result.error.cause).toBe(reason);
    expect(attempted).toEqual([]);
  });

  it.each([
    new AnalysisInputError("analyze_function", {
      userMessage: "Unknown selector: missing",
    }),
    new NoBinaryOpenError(),
    new AnalysisResourceConstraintError(
      "analyze_function",
      "capacity",
      "Provider is busy",
      null,
      { retryable: true },
    ),
    new AnalysisCancelledError("analyze_function"),
  ])("preserves the original seed failure object: $_tag", async (failure) => {
    const attempted: unknown[] = [];
    const result = await traceNativeValues(
      {
        execute: async (operation, parameters) => {
          attempted.push([operation, parameters]);
          return err(failure);
        },
      },
      { procedure: "missing" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected seed failure");
    expect(result.error).toBe(failure);
    expect(attempted).toEqual([["analyze_function", { procedure: "missing" }]]);
  });

  it("retains a successful seed without def-use as a useful unknown trace", async () => {
    const base = functionDossierSchema.parse(ghidraFunctionDossier());
    const result = await traceNativeValues(
      {
        execute: async () =>
          ok(
            createAnalysisExecution(
              { ...base, native_value_flow: null },
              provider,
              { subject },
            ),
          ),
      },
      { procedure: base.procedure.address },
    );
    if (!result.ok) throw result.error;
    expect(nativeValueTraceSchema.parse(result.value)).toMatchObject({
      target_sha256: subject.sha256,
      decompilations: 1,
      procedures: [
        expect.objectContaining({ address: base.procedure.address }),
      ],
      unknowns: [
        expect.objectContaining({
          reason: "Provider has no native def-use model",
        }),
      ],
    });
  });
});

describe("native value parameter-use node membership", () => {
  it("retains only parameter uses whose parameter nodes fit the node budget", async () => {
    const operationCount = 3_000;
    const parameterUseCount = 12_000;
    const base = functionDossierSchema.parse(ghidraFunctionDossier());
    const procedureAddress = base.procedure.address;
    const largeFlow = {
      available: true as const,
      provenance: "ghidra-high-pcode" as const,
      operations: Array.from({ length: operationCount }, (_, index) => ({
        ...node(`operation-${String(index)}`, procedureAddress, "MULTIEQUAL"),
        inputs: [scalar, scalar, scalar, scalar],
      })),
      def_use: [],
      effects: [],
      parameters: [{ ordinal: 0, name: "value", data_type: "/int" }],
      parameter_uses: Array.from({ length: parameterUseCount }, (_, index) => ({
        ordinal: 0,
        use: `operation-${String(index % operationCount)}`,
        input_index: Math.floor(index / operationCount),
      })),
      truncated: false,
      omitted_operations_lower_bound: 0,
      known_omitted_inputs: 0,
      known_omitted_edges: 0,
      limitations: [],
    };
    const largeDossier = {
      ...base,
      native_value_flow: largeFlow,
    };
    const largeAnalysis: AnalysisOperationPort = {
      execute: async () =>
        ok(createAnalysisExecution(largeDossier, provider, { subject })),
    };

    const includedParameter = await traceNativeValues(largeAnalysis, {
      procedure: procedureAddress,
      max_nodes: 20_000,
      max_edges: 40_000,
      offset: operationCount,
      limit: 1,
    });
    if (!includedParameter.ok) throw includedParameter.error;
    const includedResult = nativeValueTraceSchema.parse(
      includedParameter.value,
    );
    expect(includedResult).toMatchObject({
      total_nodes: operationCount + 1,
      total_edges: parameterUseCount,
      nodes: [
        expect.objectContaining({
          id: `${procedureAddress}/parameter:0`,
          kind: "parameter",
        }),
      ],
      truncated: true,
    });
    expect(includedResult.edges).toHaveLength(parameterUseCount);

    const omittedParameter = await traceNativeValues(largeAnalysis, {
      procedure: procedureAddress,
      max_nodes: operationCount,
      max_edges: 40_000,
      offset: operationCount - 1,
      limit: 1,
    });
    if (!omittedParameter.ok) throw omittedParameter.error;
    const omittedResult = nativeValueTraceSchema.parse(omittedParameter.value);
    expect(omittedResult).toMatchObject({
      total_nodes: operationCount,
      total_edges: 0,
      nodes: [expect.objectContaining({ kind: "operation" })],
      edges: [],
      truncated: true,
    });
  });

  it.each([3, 4])(
    "keeps parameter identity separate from colliding operation IDs with max_nodes=%i",
    async (max_nodes) => {
      const base = functionDossierSchema.parse(ghidraFunctionDossier());
      const address = base.procedure.address;
      const execution = createAnalysisExecution(
        {
          ...base,
          native_value_flow: {
            available: true,
            provenance: "ghidra-high-pcode",
            operations: [
              node("parameter:0", address, "COPY"),
              node("parameter:0#1", address, "COPY"),
              node("use", address, "COPY"),
            ],
            def_use: [],
            effects: [],
            parameters: [{ ordinal: 0, name: "value", data_type: "/int" }],
            parameter_uses: [{ ordinal: 0, use: "use", input_index: 1 }],
            truncated: false,
            omitted_operations_lower_bound: 0,
            known_omitted_inputs: 0,
            known_omitted_edges: 0,
            limitations: [],
          },
        },
        provider,
        { subject },
      );
      const result = await traceNativeValues(
        { execute: async () => ok(execution) },
        { procedure: address, max_nodes },
      );

      if (!result.ok) throw result.error;
      const parsedResult = nativeValueTraceSchema.parse(result.value);
      expect(parsedResult).toMatchObject({
        total_nodes: max_nodes,
        total_edges: max_nodes === 3 ? 0 : 1,
        edges:
          max_nodes === 3
            ? []
            : [
                {
                  source: `${address}/parameter:0#2`,
                  target: `${address}/use`,
                  kind: "parameter-use",
                },
              ],
      });
      expect(
        parsedResult.nodes
          .filter(({ kind }) => kind === "operation")
          .map(({ id }) => id),
      ).toEqual([
        `${address}/parameter:0`,
        `${address}/parameter:0#1`,
        `${address}/use`,
      ]);
      expect(new Set(parsedResult.nodes.map(({ id }) => id)).size).toBe(
        max_nodes,
      );
    },
  );
});

const nativeFlowDossier = (
  base: ReturnType<typeof functionDossierSchema.parse>,
  facts: {
    address: string;
    name: string;
    operations: ReturnType<typeof node>[];
    parameters: { ordinal: number; name: string; data_type: string }[];
  },
) => {
  const { address, name, operations, parameters } = facts;
  return jsonValueSchema.parse({
    ...base,
    procedure: {
      address,
      name,
      classification: null,
      body: {
        available: false,
        reason: "The provider did not report complete function body ranges.",
      },
      signature: null,
      locals: [],
    },
    native_value_flow: {
      available: true,
      provenance: "ghidra-high-pcode",
      operations,
      def_use: [],
      effects: [],
      parameters,
      parameter_uses: [],
      truncated: false,
      omitted_operations_lower_bound: 0,
      known_omitted_inputs: 0,
      known_omitted_edges: 0,
      limitations: [],
    },
  });
};

const callBindingAnalysis = (input: {
  readonly callerAddress: string;
  readonly calleeAddress: string;
  readonly caller: ReturnType<typeof jsonValueSchema.parse>;
  readonly callee: ReturnType<typeof jsonValueSchema.parse>;
  readonly targetLimitations?: readonly string[];
}): AnalysisOperationPort => ({
  execute: async (operation, parameters) => {
    if (operation === "resolve_native_call_targets")
      return ok(
        createAnalysisExecution(
          {
            call_site: String(parameters.address),
            procedure: input.calleeAddress,
            status: "direct",
            mechanism: "direct",
            targets: [
              {
                address: input.calleeAddress,
                procedure: input.calleeAddress,
                status: "direct",
                basis: "provider-reference",
                references: [],
              },
            ],
            limitations: [...(input.targetLimitations ?? [])],
          },
          provider,
          { subject },
        ),
      );
    if (operation !== "analyze_function")
      throw new Error(`Unexpected native trace operation: ${operation}`);
    if (
      parameters.procedure !== input.callerAddress &&
      parameters.procedure !== input.calleeAddress
    )
      throw new Error(`Unexpected procedure: ${String(parameters.procedure)}`);
    return ok(
      createAnalysisExecution(
        parameters.procedure === input.callerAddress
          ? input.caller
          : input.callee,
        provider,
        { subject },
      ),
    );
  },
});

describe("native value failed-callee traversal", () => {
  it("attempts a repeated failed selector once and still analyzes a later callee", async () => {
    const base = functionDossierSchema.parse(ghidraFunctionDossier());
    const caller = nativeFlowDossier(base, {
      address: "0x1000",
      name: "caller",
      operations: [
        node("bad-1", "0x1100", "CALL"),
        node("bad-2", "0x1104", "CALL"),
        node("good", "0x1108", "CALL"),
      ],
      parameters: [],
    });
    const good = nativeFlowDossier(base, {
      address: "0x3000",
      name: "good",
      operations: [],
      parameters: [],
    });
    const attempts: string[] = [];
    const port: AnalysisOperationPort = {
      execute: async (operation, parameters) => {
        if (operation === "resolve_native_call_targets") {
          const destination =
            parameters.address === "0x1108" ? "0x3000" : "0x2000";
          return ok(
            createAnalysisExecution(
              {
                call_site: String(parameters.address),
                procedure: "0x1000",
                status: "direct",
                mechanism: "direct",
                targets: [
                  {
                    address: destination,
                    procedure: destination,
                    status: "direct",
                    basis: "provider-reference",
                    references: [],
                  },
                ],
                limitations: [],
              },
              provider,
              { subject },
            ),
          );
        }
        expect(operation).toBe("analyze_function");
        const selector = String(parameters.procedure);
        attempts.push(selector);
        if (selector === "0x2000")
          return err(
            new AnalysisOutputError("analyze_function", "Callee unavailable"),
          );
        return ok(
          createAnalysisExecution(
            selector === "0x1000" ? caller : good,
            provider,
            { subject },
          ),
        );
      },
    };
    const expectedCalls = [
      { source: "0x1000/bad-1", target: "0x2000" },
      { source: "0x1000/bad-2", target: "0x2000" },
      { source: "0x1000/good", target: "0x3000" },
    ];
    // A new invocation retries the failed selector: failures are not cached
    // across traces, and successful procedure identity remains separate.
    for (let run = 0; run < 2; run++) {
      attempts.length = 0;
      const result = await traceNativeValues(port, {
        procedure: "0x1000",
        max_functions: 3,
      });
      if (!result.ok) throw result.error;
      const trace = nativeValueTraceSchema.parse(result.value);
      expect(attempts).toEqual(["0x1000", "0x2000", "0x3000"]);
      expect(trace.decompilations).toBe(3);
      expect(trace.procedures.map(({ address }) => address)).toEqual([
        "0x1000",
        "0x3000",
      ]);
      expect(trace.unknowns).toContainEqual({
        procedure: "0x2000",
        address: null,
        reason: expect.stringContaining("Callee unavailable"),
      });
      expect(
        trace.edges
          .filter(({ kind }) => kind === "call")
          .map(({ source, target }) => ({ source, target })),
      ).toEqual(expectedCalls);
      expect(trace.truncated).toBe(false);
    }
    const capped = await traceNativeValues(port, {
      procedure: "0x1000",
      max_functions: 3,
      max_edges: 2,
    });
    if (!capped.ok) throw capped.error;
    const cappedTrace = nativeValueTraceSchema.parse(capped.value);
    expect(
      cappedTrace.edges.map(({ source, target }) => ({ source, target })),
    ).toEqual(expectedCalls.slice(0, 2));
    expect(cappedTrace.truncated).toBe(true);
  });
});

describe("native value call-binding fan-out", () => {
  it("retains limitations embedded in resolved call-target results", async () => {
    const callerAddress = "0x1000";
    const calleeAddress = "0x2000";
    const base = functionDossierSchema.parse(ghidraFunctionDossier());
    const caller = nativeFlowDossier(base, {
      address: callerAddress,
      name: "caller",
      operations: [node("call", callerAddress, "CALL")],
      parameters: [],
    });
    const callee = nativeFlowDossier(base, {
      address: calleeAddress,
      name: "callee",
      operations: [],
      parameters: [],
    });
    const caveat = "Only statically resolved call sites are included.";
    const result = await traceNativeValues(
      callBindingAnalysis({
        callerAddress,
        calleeAddress,
        caller,
        callee,
        targetLimitations: [caveat],
      }),
      { procedure: callerAddress, max_functions: 2 },
    );

    if (!result.ok) throw result.error;
    expect(nativeValueTraceSchema.parse(result.value).limitations).toContain(
      `Fixture (fixture 1) resolve_native_call_targets: ${caveat}`,
    );
  });

  it("preserves binding order and edge-budget behavior for repeated callees", async () => {
    const callCount = 128;
    const callerAddress = "0x1000";
    const calleeAddress = "0x2000";
    const base = functionDossierSchema.parse(ghidraFunctionDossier());
    const caller = nativeFlowDossier(base, {
      address: callerAddress,
      name: "caller",
      operations: Array.from({ length: callCount }, (_, index) => ({
        ...node(
          `call-${index}`,
          `0x${(0x1000 + index * 4).toString(16)}`,
          "CALL",
        ),
        sequence: index,
        inputs: [scalar, scalar],
      })),
      parameters: [],
    });
    const callee = nativeFlowDossier(base, {
      address: calleeAddress,
      name: "callee",
      operations: [node("return", calleeAddress, "RETURN")],
      parameters: [{ ordinal: 0, name: "value", data_type: "/int" }],
    });
    const fanoutAnalysis = callBindingAnalysis({
      callerAddress,
      calleeAddress,
      caller,
      callee,
    });
    const expectedEdges = [
      ...Array.from({ length: callCount }, (_, index) => ({
        source: `${callerAddress}/call-${index}`,
        target: calleeAddress,
        input_index: null,
        kind: "call",
      })),
      ...Array.from({ length: callCount }, (_, index) => [
        {
          source: `${callerAddress}/call-${index}`,
          target: `${calleeAddress}/parameter:0`,
          input_index: 1,
          kind: "argument-binding",
        },
        {
          source: `${calleeAddress}/return`,
          target: `${callerAddress}/call-${index}`,
          input_index: 1,
          kind: "return-binding",
        },
      ]).flat(),
    ];
    const request = {
      procedure: callerAddress,
      max_functions: 2,
      max_call_sites: callCount,
      max_nodes: callCount + 2,
      max_edges: callCount * 3,
      limit: callCount + 2,
    };

    const complete = await traceNativeValues(fanoutAnalysis, request);
    if (!complete.ok) throw complete.error;
    const completeResult = nativeValueTraceSchema.parse(complete.value);
    const edgeShape = (edges: typeof completeResult.edges) =>
      edges.map(({ source, target, input_index, kind }) => ({
        source,
        target,
        input_index,
        kind,
      }));
    expect(completeResult).toMatchObject({
      total_nodes: callCount + 2,
      total_edges: callCount * 3,
      truncated: false,
      unknowns: [],
    });
    expect(edgeShape(completeResult.edges)).toEqual(expectedEdges);

    const capped = await traceNativeValues(fanoutAnalysis, {
      ...request,
      max_edges: callCount * 3 - 1,
    });
    if (!capped.ok) throw capped.error;
    const cappedResult = nativeValueTraceSchema.parse(capped.value);
    expect(cappedResult).toMatchObject({
      total_nodes: callCount + 2,
      total_edges: callCount * 3 - 1,
      truncated: true,
    });
    expect(edgeShape(cappedResult.edges)).toEqual(
      expectedEdges.slice(0, callCount * 3 - 1),
    );

    const nodeCapped = await traceNativeValues(fanoutAnalysis, {
      ...request,
      max_nodes: callCount + 1,
    });
    if (!nodeCapped.ok) throw nodeCapped.error;
    const nodeCappedResult = nativeValueTraceSchema.parse(nodeCapped.value);
    expect(nodeCappedResult).toMatchObject({
      total_nodes: callCount + 1,
      total_edges: callCount * 2,
      truncated: true,
      unknowns: Array.from({ length: callCount }, () => ({
        procedure: callerAddress,
        address: null,
        reason: `Parameter bindings for ${calleeAddress} are unavailable or omitted`,
      })),
    });
    expect(edgeShape(nodeCappedResult.edges)).toEqual(
      expectedEdges.filter(({ kind }) => kind !== "argument-binding"),
    );
  });
});

describe("bounded native value dependency composition", () => {
  it("reports work truncation and stable pagination without traversing ambiguous calls", async () => {
    const bounded = await traceNativeValues(analysis, {
      procedure: "0x1000",
      max_functions: 1,
    });
    expect(bounded.ok).toBe(true);
    if (bounded.ok)
      expect(bounded.value).toMatchObject({
        truncated: true,
        decompilations: 1,
      });
    const page = await traceNativeValues(analysis, {
      procedure: "0x1000",
      limit: 1,
    });
    expect(page.ok).toBe(true);
    if (page.ok)
      expect(page.value).toMatchObject({ total_nodes: 3, next_offset: 1 });
    const ambiguous = await traceNativeValues(
      {
        execute: async (operation, parameters, options) => {
          if (operation !== "resolve_native_call_targets")
            return analysis.execute(operation, parameters, options);
          return ok(
            createAnalysisExecution(
              {
                call_site: "0x1000",
                procedure: "0x1000",
                status: "ambiguous",
                mechanism: "computed",
                targets: [
                  {
                    address: "0x2000",
                    procedure: "0x2000",
                    status: "candidate",
                    basis: "provider-reference",
                    references: [],
                  },
                ],
                limitations: [],
              },
              provider,
              { subject },
            ),
          );
        },
      },
      { procedure: "0x1000" },
    );
    expect(ambiguous.ok).toBe(true);
    if (ambiguous.ok)
      expect(ambiguous.value).toMatchObject({
        decompilations: 1,
        edges: [expect.objectContaining({ status: "candidate" })],
      });
  });
  it("propagates cancellation and rejects cross-target dependencies", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      await traceNativeValues(
        analysis,
        { procedure: "0x1000" },
        controller.signal,
      ),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisCancelledError" } });
    const cancelled = await traceNativeValues(
      {
        execute: async () =>
          err(new AnalysisCancelledError("analyze_function")),
      },
      { procedure: "0x1000" },
    );
    expect(cancelled.ok).toBe(false);
    const mismatch = await traceNativeValues(
      {
        execute: async (operation, parameters, options) => {
          const value = await analysis.execute(operation, parameters, options);
          return value.ok && parameters.procedure === "0x2000"
            ? ok({
                ...value.value,
                subject: { ...subject, sha256: "b".repeat(64) },
              })
            : value;
        },
      },
      { procedure: "0x1000" },
    );
    expect(mismatch).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisOutputError" },
    });
  });

  it("returns typed cancellation when the caller aborts with the final provider reply", async () => {
    const controller = new AbortController();
    const reason = { request: "stop trace" };
    const result = await traceNativeValues(
      {
        execute: async (operation, parameters, options) => {
          const value = await analysis.execute(operation, parameters, options);
          if (parameters.procedure === "0x2000") controller.abort(reason);
          return value;
        },
      },
      { procedure: "0x1000" },
      controller.signal,
    );
    if (result.ok) throw new Error("Expected cancellation");
    expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(result.error.cause).toBe(reason);
  });
});

describe("native value trace selector origin", () => {
  it("marks only the initial procedure as caller-supplied", async () => {
    const analyzed: { procedure: unknown; origin: unknown }[] = [];

    const result = await traceNativeValues(
      {
        execute: async (operation, parameters, options) => {
          if (operation === "analyze_function")
            analyzed.push({
              procedure: parameters.procedure,
              origin: options?.selectorOrigin,
            });
          return analysis.execute(operation, parameters, options);
        },
      },
      { procedure: "0x1000" },
    );

    expect(result.ok, "the trace completes").toBe(true);
    expect(
      analyzed,
      "the caller's procedure is unmarked and the discovered callee is provider-derived",
    ).toEqual([
      { procedure: "0x1000", origin: undefined },
      { procedure: "0x2000", origin: "provider" },
    ]);
  });
});

describe("native value node byte budgets", () => {
  it("stops admitting parameters after an operation exceeds the byte budget", async () => {
    const base = functionDossierSchema.parse(ghidraFunctionDossier());
    const value = nativeFlowDossier(base, {
      address: "0x1000",
      name: "caller",
      operations: [node("use", "0x1000", "a".repeat(9 * 1024 * 1024))],
      parameters: [{ ordinal: 0, name: "value", data_type: "/int" }],
    });
    const result = await traceNativeValues(
      {
        execute: async () =>
          ok(createAnalysisExecution(value, provider, { subject })),
      },
      { procedure: "0x1000" },
    );
    if (!result.ok) throw result.error;
    expect(nativeValueTraceSchema.parse(result.value)).toMatchObject({
      truncated: true,
      total_nodes: 0,
      total_edges: 0,
      nodes: [],
      edges: [],
    });
  });

  it.each([
    { label: "plain text", name: "a".repeat(9 * 1024 * 1024) },
    { label: "JSON escapes", name: "\0".repeat(2 * 1024 * 1024) },
  ])("rejects an oversized parameter encoded with $label", async ({ name }) => {
    const base = functionDossierSchema.parse(ghidraFunctionDossier());
    const value = nativeFlowDossier(base, {
      address: "0x1000",
      name: "caller",
      operations: [
        node("parameter:0", "0x1000", "COPY"),
        node("use", "0x1000", "MULTIEQUAL"),
      ],
      parameters: [{ ordinal: 0, name, data_type: "/int" }],
    });
    const parsed = functionDossierSchema.parse(value);
    if (!parsed.native_value_flow?.available)
      throw new Error("Invalid fixture");
    parsed.native_value_flow.parameter_uses = [
      { ordinal: 0, use: "use", input_index: 0 },
    ];
    const result = await traceNativeValues(
      {
        execute: async () =>
          ok(createAnalysisExecution(parsed, provider, { subject })),
      },
      { procedure: "0x1000" },
    );
    if (!result.ok) throw result.error;
    const trace = nativeValueTraceSchema.parse(result.value);
    expect(trace).toMatchObject({
      truncated: true,
      total_nodes: 2,
      total_edges: 0,
      nodes: [
        expect.objectContaining({ kind: "operation" }),
        expect.objectContaining({ kind: "operation" }),
      ],
    });
  });

  it("shares the byte budget across operation and parameter nodes", async () => {
    const base = functionDossierSchema.parse(ghidraFunctionDossier());
    const value = nativeFlowDossier(base, {
      address: "0x1000",
      name: "caller",
      operations: [node("use", "0x1000", "MULTIEQUAL")],
      parameters: [0, 1].map((ordinal) => ({
        ordinal,
        name: "a".repeat(5 * 1024 * 1024),
        data_type: "/int",
      })),
    });
    const parsed = functionDossierSchema.parse(value);
    if (!parsed.native_value_flow?.available)
      throw new Error("Invalid fixture");
    parsed.native_value_flow.parameter_uses = [0, 1].map((ordinal) => ({
      ordinal,
      use: "use",
      input_index: ordinal,
    }));
    const result = await traceNativeValues(
      {
        execute: async () =>
          ok(createAnalysisExecution(parsed, provider, { subject })),
      },
      { procedure: "0x1000" },
    );
    if (!result.ok) throw result.error;
    const trace = nativeValueTraceSchema.parse(result.value);
    expect(trace).toMatchObject({
      truncated: true,
      total_nodes: 2,
      total_edges: 1,
    });
    expect(trace.nodes.map(({ id }) => id)).toEqual([
      "0x1000/use",
      "0x1000/parameter:0",
    ]);
    expect(trace.edges[0]?.source).toBe("0x1000/parameter:0");
    const retainedBytes = trace.nodes.reduce(
      (total, value) => total + Buffer.byteLength(JSON.stringify(value)),
      0,
    );
    expect(retainedBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
  });
});

describe("native value byte-bound call bindings", () => {
  it("omits argument bindings to rejected callee parameter nodes", async () => {
    const base = functionDossierSchema.parse(ghidraFunctionDossier());
    const caller = nativeFlowDossier(base, {
      address: "0x1000",
      name: "caller",
      operations: [node("call", "0x1000", "CALL")],
      parameters: [],
    });
    const callee = nativeFlowDossier(base, {
      address: "0x2000",
      name: "callee",
      operations: [node("return", "0x2000", "RETURN")],
      parameters: [
        { ordinal: 0, name: "a".repeat(9 * 1024 * 1024), data_type: "/int" },
      ],
    });
    const result = await traceNativeValues(
      callBindingAnalysis({
        callerAddress: "0x1000",
        calleeAddress: "0x2000",
        caller,
        callee,
      }),
      { procedure: "0x1000" },
    );
    if (!result.ok) throw result.error;
    const trace = nativeValueTraceSchema.parse(result.value);
    expect(trace.truncated).toBe(true);
    expect(trace.nodes.map(({ kind }) => kind)).toEqual([
      "operation",
      "operation",
    ]);
    expect(trace.edges.map(({ kind }) => kind)).toEqual([
      "call",
      "return-binding",
    ]);
    expect(trace.unknowns).toContainEqual(
      expect.objectContaining({
        reason: "Parameter bindings for 0x2000 are unavailable or omitted",
      }),
    );
  });
});

describe("native value validation failure provenance", () => {
  it.each(["call-targets", "target-digest"] as const)(
    "retains the exact provider observation for invalid %s",
    async (failure) => {
      let expected:
        | ReturnType<typeof createAnalysisExecutionEvidence>
        | undefined;
      const result = await traceNativeValues(
        {
          execute: async (operation, parameters, options) => {
            const execution = await analysis.execute(
              operation,
              parameters,
              options,
            );
            if (!execution.ok) return execution;
            if (
              (failure === "call-targets" &&
                operation === "resolve_native_call_targets") ||
              (failure === "target-digest" && parameters.procedure === "0x2000")
            ) {
              const observation = {
                ...execution.value,
                ...(failure === "call-targets"
                  ? { result: { malformed: "call targets" } }
                  : { subject: { ...subject, sha256: "b".repeat(64) } }),
                rawResult: { original: "provider output" },
                limitations: ["Provider coverage is partial"],
              };
              expected = createAnalysisExecutionEvidence(
                operation,
                parameters,
                observation,
                "observed",
              );
              return ok(observation);
            }
            return execution;
          },
        },
        { procedure: "0x1000" },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error._tag).toBe("AnalysisOutputError");
      expect(expected).toBeDefined();
      expect(result.error.partialObservation).toEqual(expected);
    },
  );
});
