import { z } from "zod";
import type { Evidence } from "../evidence.js";

/** Prefix caller paths on a nested Zod validation boundary. */
export const parseAtPath = <Value>(
  parse: (input: unknown) => Value,
  input: unknown,
  path: readonly (string | number)[],
): Value => {
  try {
    return parse(input);
  } catch (cause: unknown) {
    if (cause instanceof z.ZodError)
      throw new z.ZodError(
        cause.issues.map((issue) => ({
          ...issue,
          path: [...path, ...issue.path],
        })),
      );
    throw cause;
  }
};

/** Represent one semantic caller constraint as a standard validation issue. */
export const invalidInput = (
  path: readonly (string | number)[],
  message: string,
): z.ZodError => new z.ZodError([{ code: "custom", path: [...path], message }]);

/** Verify an authenticated Evidence record against one runtime workflow. */
export const assertEvidenceIdentity = (
  evidence: Evidence,
  expected: {
    readonly operation: string;
    readonly predicate: string;
    readonly providerId: string;
    readonly providerName: string;
    readonly providerVersion: string;
    readonly authority: Evidence["authority"];
    readonly confidence: Evidence["confidence"];
  },
  path: readonly (string | number)[],
): void => {
  if (
    evidence.operation !== expected.operation ||
    evidence.predicate_type !== expected.predicate ||
    evidence.provider.id !== expected.providerId ||
    evidence.provider.name !== expected.providerName ||
    evidence.provider.version !== expected.providerVersion ||
    evidence.authority !== expected.authority ||
    evidence.confidence !== expected.confidence
  )
    throw invalidInput(
      path,
      `Evidence does not match the supported ${expected.operation} contract`,
    );
};
