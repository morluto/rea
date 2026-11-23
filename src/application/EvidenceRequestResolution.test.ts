import { unknownTarget } from "../domain/targetIdentity.js";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import { createEvidence, type Evidence } from "../domain/evidence.js";
import {
  borrowEvidenceArray,
  borrowEvidenceInput,
  evidenceInputSchema,
} from "../domain/evidenceReference.js";
import { getEvidenceInputContract } from "../domain/evidenceInputContract.js";
import { readImmutableEvidence } from "../domain/evidenceValidation.js";
import { EvidenceIntegrityError } from "../domain/evidenceErrors.js";
import { err } from "../domain/result.js";
import {
  resolveEvidenceRequest,
  type EvidenceRequestResolutionOptions,
} from "./EvidenceInputResolver.js";

const evidence = createEvidence(
  unknownTarget("not-observed"),
  {
    id: "test-evidence-input",
    name: "Evidence input regression",
    version: "1",
  },
  {
    operation: "test_observation",
    parameters: {},
    result: { value: 42 },
  },
);
const reference = {
  kind: "retained-evidence" as const,
  evidence_id: evidence.evidence_id,
};

describe("schema-owned Evidence request resolution", () => {
  it("resolves declared single, nested and array sources once per exact ID", () => {
    const schema = z.strictObject({
      source: evidenceInputSchema.describe("Owner-described source"),
      layers: z.array(z.strictObject({ analysis: evidenceInputSchema })),
      optional: evidenceInputSchema.optional(),
      ordinary: z.unknown(),
    });
    let lookups = 0;
    const ordinary = { ...reference };
    const result = resolveEvidenceRequest(
      "test",
      {
        source: reference,
        layers: [{ analysis: reference }, { analysis: evidence }],
        ordinary,
      },
      schema,
      () => {
        lookups += 1;
        return evidence;
      },
    );
    if (!result.ok) throw result.error;
    expectTypeOf(result.value.input.source).toBeUnknown();
    expectTypeOf(result.value.input.layers).toEqualTypeOf<
      { analysis: unknown }[]
    >();
    expect(lookups).toBe(1);
    expect(result.value.input.source).toBe(evidence);
    expect(result.value.input.layers.map(({ analysis }) => analysis)).toEqual([
      evidence,
      evidence,
    ]);
    expect(result.value.input).not.toHaveProperty("optional");
    expect(result.value.input.ordinary).toBe(ordinary);
    expect(result.value.sources).toEqual([evidence]);
  });

  it("borrows inline values until the format owner authenticates them", () => {
    const schema = z.strictObject({ source: evidenceInputSchema });
    const opaque = Object.defineProperty({}, "normalized_result", {
      enumerable: true,
      get: () => {
        throw new Error("premature payload access");
      },
    });
    const result = resolveEvidenceRequest("test", { source: opaque }, schema);
    if (!result.ok) throw result.error;
    expectTypeOf(result.value.input.source).toBeUnknown();
    expect(result.value.input.source).toBe(opaque);
    expect(result.value.sources).toEqual([opaque]);
    const admitted = resolveEvidenceRequest(
      "test",
      { source: evidence },
      schema,
      undefined,
      { readEvidence: readImmutableEvidence },
    );
    if (!admitted.ok) throw admitted.error;
    expectTypeOf(admitted.value.input.source).toEqualTypeOf<Evidence>();
    expect(admitted.value.input.source).toEqual(evidence);
    expect(admitted.value.sources).toEqual([admitted.value.input.source]);
    const optionalAdmission: EvidenceRequestResolutionOptions = {};
    const borrowed = resolveEvidenceRequest(
      "test",
      { source: null },
      schema,
      undefined,
      optionalAdmission,
    );
    if (!borrowed.ok) throw borrowed.error;
    expectTypeOf(borrowed.value.input.source).toBeUnknown();
    expect(borrowed.value.input.source).toBeNull();
  });

  it.each([{ ownerPath: undefined }, { ownerPath: ["payload", 2] }])(
    "preserves source-owner failures and existing paths: %j",
    ({ ownerPath }) => {
      const failure = new EvidenceIntegrityError("Invalid source", {
        diagnostics: {
          owner: "fixture",
          ...(ownerPath === undefined ? {} : { input_path: ownerPath }),
        },
      });
      const result = resolveEvidenceRequest(
        "test",
        { layers: [{ source: {} }] },
        z.strictObject({
          layers: z.array(z.strictObject({ source: evidenceInputSchema })),
        }),
        undefined,
        {
          readEvidence: () => err(failure),
        },
      );
      if (result.ok) throw new Error("Invalid source was accepted");
      expect(result.error).toBe(failure);
      expect(failure.diagnostics).toEqual({
        owner: "fixture",
        input_path: ownerPath ?? ["layers", 0, "source"],
      });
    },
  );

  it("preserves optional/default/nullable source selection and envelope constraints", () => {
    const schema = z.strictObject({
      sources: z.array(evidenceInputSchema).min(1).default([reference]),
      absent: evidenceInputSchema.exactOptional(),
      nullable: evidenceInputSchema.nullable(),
      limit: z.int().positive(),
    });
    const result = resolveEvidenceRequest(
      "test",
      {
        nullable: null,
        limit: 1,
      },
      schema,
      () => evidence,
    );
    if (!result.ok) throw result.error;
    expect(result.value.input.sources).toEqual([evidence]);
    expect(result.value.input.nullable).toBeNull();
    expect(result.value.input).not.toHaveProperty("absent");
    const rejected = resolveEvidenceRequest(
      "test",
      {
        sources: [],
        nullable: null,
        limit: 0,
      },
      schema,
    );
    expect(rejected).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisInputError",
        issues: [
          expect.objectContaining({ path: ["sources"] }),
          expect.objectContaining({ path: ["limit"] }),
        ],
      },
    });
  });
});

describe("Evidence request branches and source diagnostics", () => {
  it("preserves selected union overwrites and refinements without running them twice", () => {
    let refinements = 0;
    const schema = z
      .union([
        z.strictObject({
          kind: z.literal("selected"),
          source: evidenceInputSchema,
          label: z.string().overwrite((value) => value + "!"),
        }),
        z.strictObject({ kind: z.literal("plain"), value: z.string() }),
      ])
      .superRefine(() => {
        refinements += 1;
      });
    const result = resolveEvidenceRequest(
      "test",
      {
        kind: "selected",
        source: reference,
        label: "once",
      },
      schema,
      () => evidence,
    );
    if (!result.ok) throw result.error;
    expect(result.value.input).toEqual({
      kind: "selected",
      source: evidence,
      label: "once!",
    });
    expect(refinements).toBe(1);
    const plain = resolveEvidenceRequest(
      "test",
      {
        kind: "plain",
        value: "literal",
      },
      schema,
    );
    if (!plain.ok) throw plain.error;
    expect(plain.value.sources).toEqual([]);
  });

  it("preserves nested optional malformed carriers for typed owner rejection", () => {
    const schema = z.strictObject({
      sources: z.array(
        z.strictObject({ source: evidenceInputSchema.optional() }),
      ),
    });
    const result = resolveEvidenceRequest(
      "test",
      {
        sources: [{ source: null }],
      },
      schema,
      undefined,
      { readEvidence: readImmutableEvidence },
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "EvidenceIntegrityError",
        diagnostics: { input_path: ["sources", 0, "source"] },
      },
    });
  });

  it("keeps nested reference validation, missing IDs and wrong record identity distinct", () => {
    const schema = z.strictObject({
      layers: z.array(z.strictObject({ source: evidenceInputSchema })),
    });
    const path = ["layers", 0, "source"];
    const input = (source: unknown) => ({ layers: [{ source }] });
    const invalid = resolveEvidenceRequest(
      "test",
      input({ kind: "retained-evidence" }),
      schema,
    );
    expect(invalid).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisInputError",
        issues: [
          {
            path: [...path, "evidence_id"],
            reason: "missing_argument",
            expected: "string",
          },
        ],
      },
    });

    for (const referenceScope of [undefined, "retained-closure"] as const) {
      const missing = resolveEvidenceRequest(
        "test",
        input(reference),
        schema,
        undefined,
        referenceScope === undefined ? {} : { referenceScope },
      );
      expect(missing).toMatchObject({
        ok: false,
        error: {
          _tag: "EvidenceIntegrityError",
          evidenceId: reference.evidence_id,
          reason: "missing",
          actual: null,
          referenceScope,
          diagnostics: { input_path: path },
        },
      });
    }

    const different = { ...reference, evidence_id: `ev_${"f".repeat(64)}` };
    const mismatched = resolveEvidenceRequest(
      "test",
      input(different),
      schema,
      () => evidence,
    );
    expect(mismatched).toMatchObject({
      ok: false,
      error: {
        _tag: "EvidenceIntegrityError",
        reason: "identity_mismatch",
        evidenceId: different.evidence_id,
        expected: different.evidence_id,
        actual: evidence.evidence_id,
        diagnostics: { input_path: path },
      },
    });
  });
});

describe("Evidence request borrowing and cancellation", () => {
  it("keeps borrowed SDK selections untouched before service capacity admission", () => {
    const schema = z.strictObject({
      source: borrowEvidenceInput(),
      observations: borrowEvidenceArray().default([]),
    });
    const observations = [reference, evidence];
    const parsed = getEvidenceInputContract(schema).frameSchema.parse({
      source: evidence,
      observations,
    });
    expect(parsed.source).toBe(evidence);
    expect(parsed.observations).toBe(observations);
    const result = resolveEvidenceRequest(
      "test",
      parsed,
      schema,
      () => evidence,
    );
    if (!result.ok) throw result.error;
    expect(result.value.input.observations).toEqual([evidence, evidence]);
    expect(observations[0]).toBe(reference);
  });

  it("honors cancellation before parsing or resolving selected sources", () => {
    const controller = new AbortController();
    const reason = new Error("cancelled by caller");
    controller.abort(reason);
    const schema = z
      .strictObject({ source: evidenceInputSchema })
      .superRefine(() => {
        throw new Error("Cancelled request reached input parsing");
      });
    const result = resolveEvidenceRequest(
      "test",
      { source: reference },
      schema,
      () => {
        throw new Error("Cancelled request reached source lookup");
      },
      { signal: controller.signal },
    );
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError", cause: reason },
    });
  });

  it("observes cancellation raised by the final source owner", () => {
    const controller = new AbortController();
    const reason = new Error("cancelled during source admission");
    const result = resolveEvidenceRequest(
      "test",
      { source: reference },
      z.strictObject({ source: evidenceInputSchema }),
      () => evidence,
      {
        signal: controller.signal,
        readEvidence: (input) => {
          const read = readImmutableEvidence(input);
          controller.abort(reason);
          return read;
        },
      },
    );
    if (result.ok) throw new Error("late source cancellation was lost");
    expect(result.error.cause).toBe(reason);
  });
});
