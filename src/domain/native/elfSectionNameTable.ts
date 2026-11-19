import { decodeLimit, ParseFailureError } from "../parseFailure.js";
import {
  decodeElfCompressedSection,
  type ElfCompressedSectionResult,
} from "./elfCompressedSection.js";

const SUBJECT = "ELF compressed section-name table";

/** Limit name of the caller's file budget, which also bounds decoded section names. */
const SECTION_NAME_BUDGET_LIMIT = "max_file_bytes";

/** Caller can raise max_file_bytes to admit the decoded section-name table. */
export const elfSectionNameBudgetFailure = (
  required: bigint,
  selected: number,
): ParseFailureError<"limit"> =>
  decodeLimit(
    "elf",
    `ELF source and decoded section names require ${String(required)} bytes, above the selected max_file_bytes (${String(selected)}).`,
    { name: SECTION_NAME_BUDGET_LIMIT, maximum: selected, required },
  );

/**
 * The section-name budget stop's limit: the selected max_file_bytes and the
 * size the source plus decoded names require.
 */
export const elfSectionNameBudget = (
  cause: unknown,
):
  | {
      readonly selected: number;
      readonly required: bigint;
      readonly detail: string;
    }
  | undefined => {
  if (
    !(cause instanceof ParseFailureError) ||
    cause.failure.kind !== "limit" ||
    cause.failure.format !== "elf" ||
    cause.failure.limit.name !== SECTION_NAME_BUDGET_LIMIT
  )
    return undefined;
  const { maximum, required } = cause.failure.limit;
  return required === undefined
    ? undefined
    : {
        selected: maximum,
        required: BigInt(required),
        detail: cause.failure.detail,
      };
};

/** Decode section names through the shared ELF compressed-section owner. */
export const decodeElfSectionNameTable = (
  bytes: Buffer,
  flags: bigint,
  bits: 32 | 64,
  little: boolean,
  maximumDecodedBytes: number,
): ElfCompressedSectionResult =>
  decodeElfCompressedSection(
    bytes,
    flags,
    bits,
    little,
    maximumDecodedBytes,
    SUBJECT,
  );
