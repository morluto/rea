import { parseExactJson } from "../../domain/exactJsonNumber.js";
import { findDuplicateJsonMember } from "../../domain/jsonDuplicateMember.js";
import {
  jsonValueExceedsDepth,
  MAX_JSON_DEPTH,
  type JsonValue,
} from "../../domain/jsonValue.js";
import type { ElfNoteTypeName, FdoNote } from "../../domain/native/elfNotes.js";
import { decodeStrictUtf8 } from "../../domain/strictUtf8.js";
import { isRecord } from "../../kernel/isRecord.js";

/** Independent ceilings for distinct descriptor reads and projected JSON copies. */
const FDO_ALLOWANCE = 65_536;
// Reserve the enclosing path from Evidence to the descriptor's JSON root.
const FDO_MAX_DEPTH =
  MAX_JSON_DEPTH -
  ["normalized_result", "entries", 0, "fdo", "metadata"].length;

type FdoType = "fdo_packaging_metadata" | "fdo_dlopen_metadata";

interface FdoDecode {
  readonly note: FdoNote;
  readonly projectedBytes: number;
}

export interface FdoDecodeBudget {
  decoded: number;
  retained: number;
  readonly descriptors: Map<string, FdoDecode>;
}

const invalid = (issue: string): FdoDecode => ({
  note: { metadata: null, issue },
  projectedBytes: 0,
});

const decodeDescriptor = (type: FdoType, descriptor: Buffer): FdoDecode => {
  const end = descriptor.indexOf(0);
  if (end < 0) return invalid("FDO metadata is not NUL-terminated.");
  if (descriptor.subarray(end + 1).some((byte) => byte !== 0))
    return invalid("FDO metadata has non-NUL bytes after its terminator.");

  let source: string;
  try {
    source = decodeStrictUtf8(descriptor.subarray(0, end), "preserve");
  } catch {
    return invalid("FDO metadata is not valid UTF-8.");
  }
  const value = parseExactJson(source);
  if (value === undefined)
    return invalid("FDO metadata could not be represented as exact JSON.");
  if (jsonValueExceedsDepth(value, FDO_MAX_DEPTH))
    return invalid("FDO metadata exceeds the Evidence JSON nesting allowance.");
  if (findDuplicateJsonMember(source) !== undefined)
    return invalid("FDO metadata repeats a JSON object member.");

  let metadata:
    | Record<string, JsonValue>
    | Record<string, JsonValue>[]
    | undefined;
  if (type === "fdo_packaging_metadata") {
    if (isRecord(value)) metadata = value;
  } else if (Array.isArray(value) && value.every((item) => isRecord(item))) {
    metadata = value;
  }
  if (metadata === undefined)
    return invalid(
      type === "fdo_packaging_metadata"
        ? "FDO packaging metadata must be a JSON object."
        : "FDO dlopen metadata must be a JSON array of objects.",
    );

  return {
    note: { metadata, issue: null },
    projectedBytes: Buffer.byteLength(JSON.stringify(metadata)),
  };
};

/** Decode a recognized FDO descriptor while retaining the raw note on refusal. */
export const decodeFdoNote = (
  type: ElfNoteTypeName,
  range: string,
  descriptor: Buffer,
  budget: FdoDecodeBudget,
): FdoNote | null => {
  if (type !== "fdo_packaging_metadata" && type !== "fdo_dlopen_metadata")
    return null;

  // The same physical range can be encountered independently in two tables.
  // Include its type because the layouts require different JSON roots.
  const key = `${type}:${range}`;
  let decoded = budget.descriptors.get(key);
  if (decoded === undefined) {
    if (descriptor.length > FDO_ALLOWANCE - budget.decoded)
      return invalid(
        "FDO metadata exceeds the report's 64 KiB descriptor decode allowance.",
      ).note;
    budget.decoded += descriptor.length;
    decoded = decodeDescriptor(type, descriptor);
    budget.descriptors.set(key, decoded);
  }

  // A shared decoded object is copied or serialized for every emitted entry.
  if (decoded.projectedBytes > FDO_ALLOWANCE - budget.retained)
    return invalid(
      "FDO metadata exceeds the report's 64 KiB projected JSON allowance.",
    ).note;
  budget.retained += decoded.projectedBytes;
  return decoded.note;
};
