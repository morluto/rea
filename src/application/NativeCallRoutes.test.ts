import { describe, expect, it } from "vitest";
import { readNativeCallRoutes } from "./NativeCallRoutes.js";
import { createAnalysisExecution } from "./AnalysisProvider.js";
import { ghidraReferenceEdge } from "../domain/ghidraValues.fixture.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { err, ok } from "../domain/result.js";
import { AnalysisCancelledError } from "../domain/errors.js";

const provider = { id: "fixture", name: "Fixture", version: "1" };
describe("typed native call routes", () => {
  it("preserves computed targets, ambiguity and targetless call sites", async () => {
    const reference = jsonValueSchema.parse(ghidraReferenceEdge());
    if (
      reference === null ||
      typeof reference !== "object" ||
      Array.isArray(reference)
    )
      throw new TypeError("Invalid reference fixture");
    const result = await readNativeCallRoutes(
      {
        execute: async () =>
          ok(
            createAnalysisExecution(
              {
                reference_kinds_available: true,
                references: ["0x2000", "0x3000"].map((address) => ({
                  ...reference,
                  source_address: "0x1004",
                  target_address: address,
                  target_procedure: { address },
                  kind: {
                    available: true,
                    provenance: "fixture-reference",
                    type: "COMPUTED_CALL",
                    flow: true,
                    call: true,
                    jump: false,
                    data: false,
                    read: false,
                    write: false,
                    indirect: true,
                    computed: true,
                    external: false,
                    conditional: false,
                    terminal: false,
                    primary: true,
                    operand_index: 0,
                  },
                })),
                unresolved_calls: [
                  { address: "0x1008", reason: "No static target" },
                ],
              },
              provider,
            ),
          ),
      },
      "0x1000",
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        routes: [
          {
            address: "0x2000",
            relation: "indirect_call",
            resolution: "ambiguous",
          },
          {
            address: "0x3000",
            relation: "indirect_call",
            resolution: "ambiguous",
          },
        ],
        unknowns: [{ address: "0x1008" }],
      },
    });
  });
  it("does not fall back on cancellation or invalid typed output", async () => {
    let calls = 0;
    const cancelled = await readNativeCallRoutes(
      {
        execute: async () => {
          calls++;
          return err(new AnalysisCancelledError("procedure_references"));
        },
      },
      "0x1000",
    );
    expect(cancelled).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
    expect(calls).toBe(1);
    const malformed = await readNativeCallRoutes(
      { execute: async () => ok(createAnalysisExecution({}, provider)) },
      "0x1000",
    );
    expect(malformed).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisOutputError" },
    });
  });
});
