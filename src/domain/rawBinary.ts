import { z } from "zod";

import type {
  BinaryArchitecture,
  HeaderArchitecture,
  RawBinaryLoad,
  RawOnlyArchitecture,
} from "./binaryTargetTypes.js";
import type { ExecutableFormatHint } from "./dosCom.js";
import type { JsonValue } from "./jsonValue.js";
import {
  ARCHITECTURE_VARIANT_NAMES,
  RAW_ENTRY_BASES,
  RAW_ENTRY_ISA_MODES,
  RAW_ENTRY_ROLES,
  architectureVariantRow,
  architectureVariantSchema,
  type ArchitectureVariant,
} from "./architectureVariant.js";
import { err, ok, type Result } from "./result.js";

/** Caller-visible CPU families admitted for headerless raw binaries. */
export const BINARY_ARCHITECTURES = [
  "x86",
  "x86_64",
  "arm",
  "arm64",
  "6502",
  "m68k",
] as const satisfies readonly BinaryArchitecture[];

/** Provider-neutral CPU family for a caller-supplied raw-binary load. */
export const binaryArchitectureSchema = z.enum(BINARY_ARCHITECTURES);

const RAW_BINARY_ENTRY_POINT = /^0x[0-9A-Fa-f]{1,16}$/u;

/** Hexadecimal load and entry address; file offset 0 is mapped here. */
export const rawBinaryEntryPointSchema = z
  .string()
  .regex(RAW_BINARY_ENTRY_POINT, {
    message: "entry_point must be a hexadecimal address of the form 0x…",
  });

/** Hexadecimal address of raw file offset 0 when it differs from the entry. */
export const rawBinaryBaseAddressSchema = z
  .string()
  .regex(RAW_BINARY_ENTRY_POINT, {
    message: "base_address must be a hexadecimal address of the form 0x…",
  });

/** Hexadecimal address of an M-profile vector table inside the mapped image. */
export const rawBinaryVectorTableAddressSchema = z
  .string()
  .regex(RAW_BINARY_ENTRY_POINT, {
    message:
      "vector_table_address must be a hexadecimal address of the form 0x…",
  });

/** Canonicalized caller-supplied raw-binary entry with the original spelling. */
export interface CanonicalRawBinaryEntry {
  readonly source: string;
  readonly canonical: string;
  readonly value: bigint;
}

/** Parse a caller-supplied hex entry while preserving the source spelling. */
export const parseRawBinaryEntryPoint = (
  value: string,
): Result<CanonicalRawBinaryEntry, string> => {
  if (!RAW_BINARY_ENTRY_POINT.test(value))
    return err("entry_point must be a hexadecimal address of the form 0x…");
  const parsed = BigInt(value);
  return ok({
    source: value,
    canonical: `0x${parsed.toString(16)}`,
    value: parsed,
  });
};

/** Reject empty or non-integral file extents for a headerless image. */
export const validateRawBinaryLength = (
  length: number,
): Result<null, string> =>
  Number.isSafeInteger(length) && length >= 1
    ? ok(null)
    : err("raw-binary requires at least one file byte");

/**
 * Caller-selected interpretation that target headers do not establish. The
 * CLI and MCP boundaries build it once; it reaches target admission unchanged.
 */
export interface NativeLoadSelection {
  readonly format?: ExecutableFormatHint;
  readonly architecture?: BinaryArchitecture;
  readonly entryPoint?: string;
  readonly baseAddress?: string;
  readonly architectureVariant?: ArchitectureVariant;
  readonly vectorTableAddress?: string;
}

/** Admitted headerless load identity used by target resolution and profiles. */
export interface RawBinaryAdmission {
  readonly architecture: HeaderArchitecture | RawOnlyArchitecture;
  readonly load: RawBinaryLoad;
}

/** Why a headerless load was refused, with its owning classification. */
export interface RawBinaryAdmissionRejection {
  readonly reason: string;
  /**
   * `load_selection_rejected` names a caller-input selection problem;
   * `file_format_rejected` names a refusal caused by the target file itself.
   */
  readonly constraint: "load_selection_rejected" | "file_format_rejected";
  /** The input to correct, when one input is to blame. */
  readonly field?: LoadSelectionIssue["field"];
  /** Facts a caller can act on, such as the even address of an odd Thumb entry. */
  readonly diagnostics?: Readonly<Record<string, JsonValue>>;
}

/** Admission that must read the first two vector-table words to finish. */
export interface RawBinaryVectorTableRead {
  /** File offset of vector-table word 0. */
  readonly fileOffset: number;
  /** Bytes to read at `fileOffset`: word 0, the initial stack pointer, and word 1, Reset. */
  readonly byteLength: number;
  /** Finish admission from the bytes read at `fileOffset`. */
  readonly admit: (
    words: Uint8Array,
  ) => Result<RawBinaryAdmission, RawBinaryAdmissionRejection>;
}

/**
 * Whether a load is expressible with the inputs that predate base_address and
 * architecture_variant: base at a caller-selected entry and no variant. Such a
 * load keeps its earlier identity and Evidence, however its base was spelled.
 */
export const isLegacyRawLoad = (load: RawBinaryLoad): boolean =>
  load.architectureVariant === undefined &&
  load.entrySource.kind === "caller" &&
  load.baseAddress === load.entryPoint;

/** The entry's role and the basis on which admission chose it. */
export const rawEntryRoleAndBasis = (
  load: RawBinaryLoad,
): {
  readonly role: (typeof RAW_ENTRY_ROLES)[number];
  readonly basis: (typeof RAW_ENTRY_BASES)[number];
} =>
  load.entrySource.kind === "vector-table"
    ? { role: "reset", basis: "vector-table" }
    : { role: "entry", basis: "caller" };

/**
 * Session and snapshot identity of a load that is not legacy-equivalent, from
 * canonical resolved values: the base, the variant, the vector table Reset was
 * read from, and the entry's address, instruction set, role and basis. Every
 * load fact that summaries and Evidence report is here, provenance included,
 * or follows from it and the file digest that sessions and snapshots also
 * match: the vector words are the file bytes at the table address. So a reused
 * session never reports what the current request did not choose.
 * Spellings are excluded, and no result retains them yet: summaries, Evidence
 * and snapshots report canonical values only. Coordinate identity is narrower
 * and leaves provenance out. Change `version` whenever the meaning of these
 * values changes.
 */
export const rawLoadIdentitySchema = z.strictObject({
  version: z.literal(1),
  base_address: rawBinaryBaseAddressSchema,
  architecture_variant: architectureVariantSchema.exactOptional(),
  vector_table_address: rawBinaryVectorTableAddressSchema.exactOptional(),
  entries: z
    .array(
      z.strictObject({
        address: rawBinaryEntryPointSchema,
        isa_mode: z.enum(RAW_ENTRY_ISA_MODES).exactOptional(),
        role: z.enum(RAW_ENTRY_ROLES),
        basis: z.enum(RAW_ENTRY_BASES),
      }),
    )
    .min(1),
});
export type RawLoadIdentity = z.infer<typeof rawLoadIdentitySchema>;

/** The versioned identity, or undefined for a legacy-equivalent load, whose identity is unchanged. */
export const rawLoadIdentity = (
  load: RawBinaryLoad,
): RawLoadIdentity | undefined =>
  isLegacyRawLoad(load)
    ? undefined
    : {
        version: 1,
        base_address: load.baseAddress,
        ...(load.architectureVariant === undefined
          ? {}
          : { architecture_variant: load.architectureVariant }),
        ...(load.entrySource.kind === "vector-table"
          ? { vector_table_address: load.entrySource.address }
          : {}),
        entries: [
          {
            address: load.entryPoint,
            ...(load.entryIsaMode === undefined
              ? {}
              : { isa_mode: load.entryIsaMode }),
            ...rawEntryRoleAndBasis(load),
          },
        ],
      };

const addressWidth = (architecture: BinaryArchitecture): bigint =>
  architecture === "6502"
    ? 0xffffn
    : architecture === "x86" ||
        architecture === "arm" ||
        architecture === "m68k"
      ? 0xffffffffn
      : 0xffffffffffffffffn;

const hexAddress = (value: bigint): string => `0x${value.toString(16)}`;
/** Minimum M-profile vector-table alignment: VTOR.TBLOFF is bits 31:7. */
const VECTOR_TABLE_ALIGNMENT = 128n;
/** Admission reads vector-table words 0 and 1. */
const VECTOR_TABLE_READ_BYTES = 8;
const VECTOR_TABLE_READ_LAST = BigInt(VECTOR_TABLE_READ_BYTES - 1);
/** A 32-bit word as read, at full width, unlike a canonical address. */
const hexWord = (value: number): string =>
  `0x${value.toString(16).padStart(8, "0")}`;

/** Name the input to correct, or undefined when no single input is to blame. */
const selectionRejected = (
  reason: string,
  field: LoadSelectionIssue["field"] | undefined,
  diagnostics?: Readonly<Record<string, JsonValue>>,
): Result<never, RawBinaryAdmissionRejection> =>
  err({
    reason,
    constraint: "load_selection_rejected",
    ...(field === undefined ? {} : { field }),
    ...(diagnostics === undefined ? {} : { diagnostics }),
  });

const parseRawBinaryAddress = (
  value: unknown,
  field: "base_address" | "vector_table_address",
): Result<CanonicalRawBinaryEntry, RawBinaryAdmissionRejection> =>
  typeof value === "string" && RAW_BINARY_ENTRY_POINT.test(value)
    ? ok({
        source: value,
        canonical: hexAddress(BigInt(value)),
        value: BigInt(value),
      })
    : selectionRejected(
        `${field} must be a hexadecimal address of the form 0x…`,
        field,
      );

/**
 * Validate the selected family, variant, base and entry, and that the mapped
 * image fits the CPU width. Without an entry, an M-profile load asks the
 * caller to read the vector table and finishes from its first two words.
 */
export const admitRawBinary = (input: {
  readonly architecture: unknown;
  readonly entryPoint: unknown;
  readonly baseAddress?: unknown;
  readonly architectureVariant?: unknown;
  readonly vectorTableAddress?: unknown;
  readonly fileBytes: number;
}): Result<
  RawBinaryAdmission | RawBinaryVectorTableRead,
  RawBinaryAdmissionRejection
> => {
  const architecture = binaryArchitectureSchema.safeParse(input.architecture);
  if (!architecture.success)
    return selectionRejected(
      "raw-binary format requires architecture (x86, x86_64, arm, arm64, 6502, or m68k)",
      "architecture",
    );
  const variant = architectureVariantRow(input.architectureVariant);
  if (input.architectureVariant !== undefined && variant === undefined)
    return selectionRejected(
      `architecture_variant must be one of ${ARCHITECTURE_VARIANT_NAMES.join(", ")}`,
      "architecture_variant",
    );
  const issue = rawBinaryVariantSelectionIssue({
    ...input,
    architecture: architecture.data,
  });
  if (issue !== undefined) return selectionRejected(issue.message, issue.field);
  let entry: CanonicalRawBinaryEntry | undefined;
  // Without an entry, the shared rules above guarantee a variant and a base.
  if (input.entryPoint !== undefined || variant === undefined) {
    if (typeof input.entryPoint !== "string")
      return selectionRejected(
        "raw-binary format requires entry_point as a hexadecimal address of the form 0x…",
        "entry_point",
      );
    const parsed = parseRawBinaryEntryPoint(input.entryPoint);
    if (!parsed.ok) return selectionRejected(parsed.error, "entry_point");
    entry = parsed.value;
  }
  let base: CanonicalRawBinaryEntry | undefined;
  if (input.baseAddress !== undefined) {
    const parsed = parseRawBinaryAddress(input.baseAddress, "base_address");
    if (!parsed.ok) return parsed;
    base = parsed.value;
  }
  if (entry !== undefined) {
    if (variant !== undefined) {
      // M-profile code runs in Thumb state; an odd value is an interworking address.
      if (entry.value % 2n !== 0n) {
        const codeAddress = hexAddress(entry.value - 1n);
        return selectionRejected(
          `raw-binary ${variant.name} entry_point ${entry.canonical} is a Thumb interworking address with bit 0 set; its code address is ${codeAddress}`,
          "entry_point",
          {
            entry_point: entry.source,
            code_address: codeAddress,
            isa_mode: variant.isaMode,
            suggestion:
              "Omit entry_point to read Reset from the vector table, or pass code_address as entry_point.",
          },
        );
      }
    } else if (
      (architecture.data === "arm" || architecture.data === "arm64") &&
      entry.value % 4n !== 0n
    )
      return selectionRejected(
        `raw-binary ${architecture.data} entry_point ${entry.canonical} must be 4-byte aligned`,
        "entry_point",
        // An odd ARM entry is most often a Cortex-M Reset vector.
        architecture.data === "arm" && entry.value % 2n !== 0n
          ? {
              entry_point: entry.source,
              suggestion:
                "An odd ARM entry is usually a Thumb address. For Cortex-M code, give architecture_variant and base_address, and omit entry_point to read Reset from the vector table.",
            }
          : undefined,
      );
    // 68000-family instruction words are fetched from even addresses.
    else if (architecture.data === "m68k" && entry.value % 2n !== 0n)
      return selectionRejected(
        `raw-binary m68k entry_point ${entry.canonical} must be 2-byte aligned`,
        "entry_point",
      );
  }
  const length = validateRawBinaryLength(input.fileBytes);
  if (!length.ok)
    return err({ reason: length.error, constraint: "file_format_rejected" });
  // A legacy load has no base_address: file offset 0 maps at its entry.
  const start = base ?? entry;
  if (start === undefined)
    throw new Error("raw-binary admission lost both base and entry");
  const last = start.value + BigInt(input.fileBytes) - 1n;
  const max = addressWidth(architecture.data);
  if (start.value > max || last > max)
    return selectionRejected(
      `raw-binary mapping from ${start.canonical} must fit in the ${architecture.data} address width`,
      base === undefined ? "entry_point" : "base_address",
    );
  const mapped = `${start.canonical}..${hexAddress(last)}`;
  const shared = {
    baseAddress: start.canonical,
    ...(variant === undefined
      ? {}
      : { architectureVariant: variant.name, entryIsaMode: variant.isaMode }),
  };
  if (entry !== undefined) {
    if (entry.value < start.value || entry.value > last)
      return selectionRejected(
        `raw-binary entry_point ${entry.canonical} must lie inside the image mapped at ${mapped}`,
        "entry_point",
      );
    return ok({
      architecture: architecture.data,
      load: {
        ...shared,
        entryPoint: entry.canonical,
        entrySource: { kind: "caller" },
      },
    });
  }
  if (variant === undefined)
    throw new Error("raw-binary admission derived an entry without a variant");
  let table = start;
  // The table is at the base unless the caller names it.
  const tableField =
    input.vectorTableAddress === undefined
      ? "base_address"
      : "vector_table_address";
  if (input.vectorTableAddress !== undefined) {
    const parsed = parseRawBinaryAddress(
      input.vectorTableAddress,
      "vector_table_address",
    );
    if (!parsed.ok) return parsed;
    table = parsed.value;
  }
  // VTOR.TBLOFF holds address bits 31:7 wherever VTOR exists (ARMv6-M with
  // VTOR, ARMv7-M, ARMv8-M), so a table is at least 128-byte aligned. Any less
  // would admit a table named at its Reset slot, which reads NMI as Reset.
  if (table.value % VECTOR_TABLE_ALIGNMENT !== 0n)
    return selectionRejected(
      `raw-binary vector table at ${table.canonical} must be ${VECTOR_TABLE_ALIGNMENT}-byte aligned, as VTOR requires${
        input.vectorTableAddress === undefined
          ? "; it is at base_address unless vector_table_address is given"
          : ""
      }`,
      tableField,
    );
  if (table.value < start.value || table.value > last)
    return selectionRejected(
      `raw-binary vector table at ${table.canonical} must lie inside the image mapped at ${mapped}`,
      tableField,
    );
  if (table.value + VECTOR_TABLE_READ_LAST > last)
    return selectionRejected(
      `raw-binary file ends before the Reset vector at ${hexAddress(table.value + 4n)}; the vector table at ${table.canonical} needs ${VECTOR_TABLE_READ_BYTES} bytes`,
      // No base moves a table at file offset 0 further from the end.
      input.vectorTableAddress === undefined ? undefined : tableField,
    );
  return ok({
    fileOffset: Number(table.value - start.value),
    byteLength: VECTOR_TABLE_READ_BYTES,
    admit: (words) => {
      if (words.byteLength !== VECTOR_TABLE_READ_BYTES)
        return err({
          reason: `raw-binary vector table at ${table.canonical} could not be read in full`,
          constraint: "file_format_rejected",
        });
      const view = new DataView(
        words.buffer,
        words.byteOffset,
        words.byteLength,
      );
      const stackPointer = hexWord(view.getUint32(0, true));
      const resetWord = view.getUint32(4, true);
      const reset = hexWord(resetWord);
      const observed = {
        vector_table_address: table.canonical,
        initial_stack_pointer: stackPointer,
        reset_vector: reset,
      };
      // A raw dump has no format these words can violate. An even Reset word,
      // or one outside the image or inside the words just read, almost always
      // means the selected base, vector table or variant is wrong, so these
      // refusals are load selections that report the words observed and name
      // no single input.
      if (resetWord % 2 === 0)
        return selectionRejected(
          `raw-binary Reset vector ${reset} at ${hexAddress(table.value + 4n)} is even; an M-profile Reset handler runs in Thumb state, so bit 0 must be set`,
          undefined,
          observed,
        );
      const code = BigInt(resetWord - 1);
      if (code < start.value || code > last)
        return selectionRejected(
          `raw-binary Reset vector ${reset} points to ${hexAddress(code)}, outside the image mapped at ${mapped}`,
          undefined,
          observed,
        );
      if (code >= table.value && code <= table.value + VECTOR_TABLE_READ_LAST)
        return selectionRejected(
          `raw-binary Reset vector ${reset} points to ${hexAddress(code)}, inside the vector-table words read at ${table.canonical}`,
          undefined,
          observed,
        );
      return ok({
        architecture: architecture.data,
        load: {
          ...shared,
          entryPoint: hexAddress(code),
          entrySource: {
            kind: "vector-table",
            address: table.canonical,
            resetVector: reset,
            initialStackPointer: stackPointer,
          },
        },
      });
    },
  });
};

/** A load selection refused before any file is read, naming the input to correct. */
export interface LoadSelectionIssue {
  readonly field:
    | "architecture"
    | "entry_point"
    | "base_address"
    | "architecture_variant"
    | "vector_table_address";
  readonly message: string;
}

const RAW_ONLY_INPUTS =
  "base_address, architecture_variant and vector_table_address apply only with format=raw-binary";

/**
 * Rules for the variant, base and vector-table inputs of a raw-binary
 * selection. The boundary pairing check and admission both apply them, so they
 * refuse the same selections in the same words. Legacy selections pass.
 */
export const rawBinaryVariantSelectionIssue = (input: {
  readonly architecture?: unknown;
  readonly entryPoint?: unknown;
  readonly baseAddress?: unknown;
  readonly architectureVariant?: unknown;
  readonly vectorTableAddress?: unknown;
}): LoadSelectionIssue | undefined => {
  const variant = architectureVariantRow(input.architectureVariant);
  if (variant !== undefined && variant.architecture !== input.architecture)
    return {
      field: "architecture_variant",
      message: `architecture_variant ${variant.name} requires architecture ${variant.architecture}`,
    };
  // A raw dump records neither its load address nor where Reset is; mapping it
  // at the entry would put a vector table at Reset. A code fragment that does
  // start at its entry passes that address as its base.
  if (
    input.architectureVariant !== undefined &&
    input.baseAddress === undefined
  )
    return {
      field: "base_address",
      message:
        "architecture_variant requires base_address, the address of file offset 0",
    };
  // Narrow first: only the M-profile lane is verified with a separate base.
  if (
    input.baseAddress !== undefined &&
    input.architectureVariant === undefined
  )
    return {
      field: "base_address",
      message: "base_address applies only with architecture_variant",
    };
  if (input.entryPoint !== undefined)
    return input.vectorTableAddress === undefined
      ? undefined
      : {
          field: "vector_table_address",
          message:
            "vector_table_address locates Reset only when entry_point is omitted",
        };
  if (
    input.baseAddress === undefined &&
    input.architectureVariant === undefined &&
    input.vectorTableAddress === undefined
  )
    return undefined;
  return input.architectureVariant !== undefined &&
    input.baseAddress !== undefined
    ? undefined
    : {
        field: "entry_point",
        message:
          "entry_point may be omitted only with architecture_variant and base_address; Reset is then read from the vector table",
      };
};

/** Describe the pairing of the selected load inputs without performing I/O. */
export const rawBinarySelectionError = (input: {
  readonly format?: ExecutableFormatHint;
  readonly architecture?: unknown;
  readonly entryPoint?: unknown;
  readonly baseAddress?: unknown;
  readonly architectureVariant?: unknown;
  readonly vectorTableAddress?: unknown;
}): LoadSelectionIssue | undefined => {
  const hasArchitecture = input.architecture !== undefined;
  const hasEntry = input.entryPoint !== undefined;
  const hasBase = input.baseAddress !== undefined;
  const hasVariant = input.architectureVariant !== undefined;
  const hasVectorTable = input.vectorTableAddress !== undefined;
  const rawOnlyField = hasBase
    ? "base_address"
    : hasVariant
      ? "architecture_variant"
      : hasVectorTable
        ? "vector_table_address"
        : undefined;
  if (input.format === "gamecube-dol") {
    // The DOL header fixes architecture; entry_point is checked against it at admission.
    if (hasArchitecture)
      return {
        field: "architecture",
        message:
          "format=gamecube-dol takes its architecture from the DOL header; omit architecture",
      };
    return rawOnlyField === undefined
      ? undefined
      : { field: rawOnlyField, message: RAW_ONLY_INPUTS };
  }
  if (input.format === "raw-binary") {
    if (!hasArchitecture)
      return {
        field: "architecture",
        message:
          rawOnlyField === undefined
            ? "format=raw-binary requires architecture and entry_point"
            : "format=raw-binary requires architecture",
      };
    const issue = rawBinaryVariantSelectionIssue(input);
    if (issue !== undefined) return issue;
    return hasEntry || rawOnlyField !== undefined
      ? undefined
      : {
          field: "entry_point",
          message: "format=raw-binary requires architecture and entry_point",
        };
  }
  if (hasArchitecture || hasEntry)
    return {
      field: hasArchitecture ? "architecture" : "entry_point",
      message: "architecture and entry_point apply only with format=raw-binary",
    };
  return rawOnlyField === undefined
    ? undefined
    : { field: rawOnlyField, message: RAW_ONLY_INPUTS };
};
