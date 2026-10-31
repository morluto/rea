// Shared assertions for the declared public machine-readable output contracts
// (issue #6339), reused by the MCP boundary and CLI acceptance suites. The
// literal enum values below document the stable surface; a schema change that
// alters them must update this file in the same change with an explanation.
// See docs/testing.md -> Public output contract regressions.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Ajv2020 } from "ajv/dist/2020.js";
import { expect } from "vitest";

import type { CallToolResult } from "@modelcontextprotocol/server";

import { analysisErrorProjectionSchema } from "../../src/contracts/errorSchemas.js";
import {
  evidenceAuthoritySchema,
  evidenceConfidenceSchema,
  parseEvidence,
  type Evidence,
} from "../../src/domain/evidence.js";
import type { AnalysisErrorProjection } from "../../src/domain/analysisErrorProjection.js";

/** Documented confidence vocabulary on every canonical Evidence record. */
export const CONFIDENCE_VALUES = ["observed", "derived", "inferred"] as const;
/** Documented authority vocabulary on every canonical Evidence record. */
export const AUTHORITY_VALUES = [
  "shipped-artifact",
  "controlled-replay",
  "historical-reference",
  "external-service",
  "analyst-inference",
] as const;
/** Documented category vocabulary in the generated error contract. */
export const ERROR_CATEGORY_VALUES = [
  "invalid_input",
  "unsupported_provider",
  "unsupported_target",
  "integrity_mismatch",
  "truncated",
  "cancelled",
  "timeout",
  "resource_constraint",
  "unavailable",
  "execution_failure",
] as const;

/** Shape of the generated docs/error-contract.schema.json oneOf variants. */
export interface ErrorContractDocument {
  readonly oneOf: ReadonlyArray<{
    readonly properties: {
      readonly code: { readonly const: string };
      readonly category: { readonly enum: readonly string[] };
    };
  }>;
}

const readDocumentedErrorContract = (() => {
  let cached: Promise<ErrorContractDocument> | undefined;
  return () => {
    cached ??= readFile(
      resolve("docs/error-contract.schema.json"),
      "utf8",
    ).then((text) => JSON.parse(text) as ErrorContractDocument);
    return cached;
  };
})();

const compileDocumentedErrorContract = (() => {
  let cached:
    | Promise<(value: unknown) => { valid: boolean; issues: string }>
    | undefined;
  return () => {
    cached ??= readDocumentedErrorContract().then((document) => {
      const validate = new Ajv2020({
        strict: false,
        validateFormats: false,
      }).compile(document as unknown as object);
      return (value: unknown) => ({
        valid: validate(value) === true,
        issues: JSON.stringify(validate.errors),
      });
    });
    return cached;
  };
})();

/** Parsed generated error contract document, for drift assertions. */
export const documentedErrorContractDocument =
  (): Promise<ErrorContractDocument> => readDocumentedErrorContract();

/**
 * Assert one value satisfies the committed generated error contract document.
 * The checked-in document is the reviewed contract, so runtime projections
 * that drift from it fail here instead of in integrations.
 */
export const expectDocumentedErrorContract = async (
  value: unknown,
): Promise<void> => {
  const outcome = await (await compileDocumentedErrorContract())(value);
  expect(
    outcome.valid,
    `value must satisfy docs/error-contract.schema.json: ${outcome.issues}`,
  ).toBe(true);
};

/**
 * The pinned vocabularies must equal the runtime Evidence schema's full
 * allowed-value sets, so adding a schema value without updating the pinned
 * literals fails here rather than passing through untested.
 */
export const assertPinnedEvidenceVocabularies = (): void => {
  expect(new Set(evidenceConfidenceSchema.options)).toEqual(
    new Set(CONFIDENCE_VALUES),
  );
  expect(new Set(evidenceAuthoritySchema.options)).toEqual(
    new Set(AUTHORITY_VALUES),
  );
};

/**
 * Assert the canonical Evidence record fields documented for both adapters in
 * docs/mcp-contracts.md -> Tool results: required keys, field types, and the
 * documented confidence and authority enums.
 */
export const assertCanonicalEvidenceContract = (value: unknown): Evidence => {
  assertPinnedEvidenceVocabularies();
  const evidence = parseEvidence(value);
  expect(typeof evidence.evidence_id).toBe("string");
  expect(evidence.evidence_id.startsWith("ev_")).toBe(true);
  expect(typeof evidence.operation).toBe("string");
  expect(typeof evidence.predicate_type).toBe("string");
  expect(typeof evidence.provider.id).toBe("string");
  expect(typeof evidence.provider.name).toBe("string");
  expect(
    evidence.provider.version === null ||
      typeof evidence.provider.version === "string",
  ).toBe(true);
  // The documented contract requires the key itself, not just a value.
  expect(Object.hasOwn(evidence, "analysis_profile")).toBe(true);
  expect(CONFIDENCE_VALUES).toContain(evidence.confidence);
  expect(AUTHORITY_VALUES).toContain(evidence.authority);
  expect(Array.isArray(evidence.limitations)).toBe(true);
  for (const limitation of evidence.limitations)
    expect(typeof limitation).toBe("string");
  expect(Array.isArray(evidence.locations)).toBe(true);
  expect(Array.isArray(evidence.evidence_links)).toBe(true);
  expect(
    evidence.raw_result === null || evidence.raw_result !== undefined,
  ).toBe(true);
  return evidence;
};

/**
 * Assert one public failure keeps the documented error projection contract:
 * the runtime zod schema accepts it, the generated committed document accepts
 * it, and the documented required fields and enums hold their types.
 */
export const assertErrorProjectionContract = async (
  projection: unknown,
): Promise<AnalysisErrorProjection> => {
  const parsed = analysisErrorProjectionSchema.parse(projection);
  expect(parsed).toEqual(projection);
  await expectDocumentedErrorContract(projection);
  expect(typeof parsed.code).toBe("string");
  expect(ERROR_CATEGORY_VALUES).toContain(parsed.category);
  expect(parsed.message.length).toBeGreaterThan(0);
  expect(typeof parsed.retryable).toBe("boolean");
  expect(parsed.remediation.action.length).toBeGreaterThan(0);
  return parsed;
};

/** Read and assert the typed diagnostic an MCP tool failure delivers. */
export const mcpToolErrorProjection = async (
  result: CallToolResult,
): Promise<AnalysisErrorProjection> => {
  expect(result.isError).toBe(true);
  const text = result.content.find((item) => item.type === "text");
  if (text?.type !== "text") throw new Error("Tool error omitted text content");
  return assertErrorProjectionContract(
    (JSON.parse(text.text) as { error: unknown }).error,
  );
};
