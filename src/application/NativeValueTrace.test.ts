import { describe, expect, it } from "vitest";
import { traceNativeValues } from "./NativeValueTrace.js";
import {
  createAnalysisExecution,
  type AnalysisOperationPort,
} from "./AnalysisProvider.js";
import { ghidraFunctionDossier } from "../domain/ghidraValues.fixture.js";
import { functionDossierSchema } from "../domain/hopperValues.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { AnalysisCancelledError } from "../domain/errors.js";
import { ok, err } from "../domain/result.js";

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
});
