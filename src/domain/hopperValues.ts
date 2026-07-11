import { z } from "zod";

import type { JsonValue } from "../hopper/protocol.js";
import { HopperProtocolError } from "./errors.js";
import { err, ok, type Result } from "./result.js";

export interface AddressedName {
  readonly address: string;
  readonly name: string;
}

export interface SegmentSummary {
  readonly name: string;
  readonly start: string;
  readonly end: string;
}

const procedureMapSchema = z.record(z.string(), z.string());
const addressedNamesSchema = z.array(
  z.object({ address: z.string(), name: z.string() }),
);
const addressedNameMapSchema = z.record(z.string(), z.string());
const segmentSchema = z.object({
  name: z.string().default(""),
  start: z.string().default(""),
  end: z.string().default(""),
});

/** Parse Hopper's direct or wrapped procedure map into stable entries. */
export const parseProcedures = (
  value: JsonValue,
): Result<readonly AddressedName[], HopperProtocolError> => {
  const parsed = procedureMapSchema.safeParse(
    unwrapProperty(value, "procedures"),
  );
  return parsed.success
    ? ok(
        Object.entries(parsed.data).map(([address, name]) => ({
          address,
          name,
        })),
      )
    : invalid("procedure map", parsed.error);
};

/** Parse Hopper's direct or wrapped list of address/name records. */
export const parseNames = (
  value: JsonValue,
): Result<readonly AddressedName[], HopperProtocolError> => {
  const unwrapped = unwrapProperty(value, "names");
  const records = addressedNamesSchema.safeParse(unwrapped);
  if (records.success) return ok(records.data);
  const map = addressedNameMapSchema.safeParse(unwrapped);
  return map.success
    ? ok(Object.entries(map.data).map(([address, name]) => ({ address, name })))
    : invalid("name list", map.error);
};

/** Parse callee/caller strings from direct or wrapped Hopper results. */
export const parseRelatedAddresses = (
  value: JsonValue,
  relation: "callees" | "callers",
): Result<readonly string[], HopperProtocolError> => {
  const parsed = z.array(z.string()).safeParse(unwrapProperty(value, relation));
  return parsed.success
    ? ok(parsed.data)
    : invalid(`${relation} list`, parsed.error);
};

/** Parse direct or wrapped Hopper segment records. */
export const parseSegments = (
  value: JsonValue,
): Result<readonly SegmentSummary[], HopperProtocolError> => {
  const parsed = z
    .array(segmentSchema)
    .safeParse(unwrapProperty(value, "segments"));
  return parsed.success
    ? ok(parsed.data)
    : invalid("segment list", parsed.error);
};

/** Parse direct or wrapped Hopper document names. */
export const parseDocuments = (
  value: JsonValue,
): Result<readonly string[], HopperProtocolError> => {
  const parsed = z
    .array(z.string())
    .safeParse(unwrapProperty(value, "documents"));
  return parsed.success
    ? ok(parsed.data)
    : invalid("document list", parsed.error);
};

/** Parse a direct or wrapped list when only its cardinality is required. */
export const parseListCount = (
  value: JsonValue,
  property: string,
): Result<number, HopperProtocolError> => {
  const unwrapped = unwrapProperty(value, property);
  const list = z.array(z.unknown()).safeParse(unwrapped);
  if (list.success) return ok(list.data.length);
  const map = z.record(z.string(), z.unknown()).safeParse(unwrapped);
  return map.success
    ? ok(Object.keys(map.data).length)
    : invalid(`${property} list`, map.error);
};

const unwrapProperty = (value: JsonValue, property: string): JsonValue => {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    property in value
  ) {
    return value[property] ?? null;
  }
  return value;
};

const invalid = <T>(
  expected: string,
  cause: z.ZodError,
): Result<T, HopperProtocolError> =>
  err(
    new HopperProtocolError(`Hopper returned an invalid ${expected}`, {
      cause,
    }),
  );
