import { Budget } from "../budget.js";
import { BinaryReader } from "../binaryContainer.js";
import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../analysisErrorCore.js";
import { allKeyed, keyedBy, uniqueKeyed } from "../keyedCollection.js";
import { decodeLimit, ParseFailureError } from "../parseFailure.js";
import type { NativeMetadataRecovery } from "./nativeMetadataRecovery.js";
import {
  NativeAotAdmissionError,
  nativeAotHydrationFacts,
  nativeAotHydrationReason,
  type NativeAotHydrationFacts,
  type NativeAotReason,
  type NativeAotTruncationReason,
} from "./nativeAotReason.js";
import {
  NATIVE_AOT_FORMAT,
  NativeAotPeImage as PeImage,
  fileBackedVirtualExtent,
  virtualExtent,
} from "./nativeAotPeImage.js";
import { sha256Hex } from "../../kernel/sha256Hex.js";

const RTR_SIGNATURE = 0x00525452;
const RTR_ROW_SIZE = 24;
const RTR_ROW_TYPE = 1;
const DEHYDRATED_DATA = 207;
const FROZEN_OBJECT_REGION = 206;
export const NATIVE_AOT_MAX_SOURCE_BYTES = 128 * 1024 * 1024;
/** Bound one parser-produced JSON report independently of any transport. */
export const NATIVE_AOT_MAX_REPORT_BYTES = 4 * 1024 * 1024;
/** Work every image may use, covering headers, directories and sections. */
export const NATIVE_AOT_BASE_WORK_UNITS = 64 * 1024 * 1024;
/**
 * Work added per admitted source byte, so discovery is not starved on larger
 * images. bflat 8.0.2's 26,180,096-byte win-x64 NativeAOT image completes with
 * 71,645,819 units (about 2.7 per byte), past the former fixed 64 Mi budget.
 */
export const NATIVE_AOT_WORK_UNITS_PER_SOURCE_BYTE = 8;
export const NATIVE_AOT_MAX_WORKING_MEMORY_BYTES = 64 * 1024 * 1024;

export type NativeAotParserLimits = {
  readonly sourceBytes: number;
  readonly workUnits: number;
  readonly workingMemoryBytes: number;
};
/** Limits for one admitted image; the work budget follows its size. */
export const nativeAotParserLimitsFor = (
  sourceBytes: number,
): NativeAotParserLimits => ({
  sourceBytes: NATIVE_AOT_MAX_SOURCE_BYTES,
  workUnits:
    NATIVE_AOT_BASE_WORK_UNITS +
    Math.min(Math.max(sourceBytes, 0), NATIVE_AOT_MAX_SOURCE_BYTES) *
      NATIVE_AOT_WORK_UNITS_PER_SOURCE_BYTE,
  workingMemoryBytes: NATIVE_AOT_MAX_WORKING_MEMORY_BYTES,
});

/** The scaled limits at the source-byte ceiling. */
export const DEFAULT_NATIVE_AOT_PARSER_LIMITS: NativeAotParserLimits =
  nativeAotParserLimitsFor(NATIVE_AOT_MAX_SOURCE_BYTES);

class NativeAotParserBudget {
  readonly #work: Budget;
  readonly #workingMemory: Budget;
  workingMemoryBytesPeak = 0;
  truncationReason:
    | "work-unit-budget"
    | "working-memory-budget"
    | "response-budget"
    | undefined;

  constructor(readonly limits: NativeAotParserLimits) {
    this.#work = new Budget(limits.workUnits);
    this.#workingMemory = new Budget(limits.workingMemoryBytes);
  }

  /** Work units consumed so far. */
  get workUnits(): number {
    return this.#work.used;
  }

  /** Working-memory bytes still available. */
  get remainingWorkingMemoryBytes(): number {
    return this.#workingMemory.remaining;
  }

  consumeWork(bytes: number): boolean {
    if (this.#work.tryCharge(bytes)) return true;
    this.truncationReason ??= "work-unit-budget";
    return false;
  }

  reserveWorkingMemory(bytes: number): boolean {
    if (!this.#workingMemory.tryCharge(bytes)) {
      this.truncationReason ??= "working-memory-budget";
      return false;
    }
    this.workingMemoryBytesPeak = Math.max(
      this.workingMemoryBytesPeak,
      this.#workingMemory.used,
    );
    return true;
  }

  releaseWorkingMemory(bytes: number): void {
    this.#workingMemory.refund(bytes);
  }
}

/** Source-byte identity mismatch retained for adapter-specific recovery. */
export class NativeAotSnapshotIdentityError extends Error {
  constructor(
    readonly expectedSha256: string,
    readonly observedSha256: string,
  ) {
    super(
      `NativeAOT snapshot digest does not match the admitted artifact identity: expected ${expectedSha256}, observed ${observedSha256}`,
    );
    this.name = "NativeAotSnapshotIdentityError";
  }
}

/** Limit names of the two hydration budgets, as `decodeLimit` reports them. */
const NATIVE_AOT_BUDGET_LIMIT = {
  work: "work-units",
  "working-memory": "working-memory-bytes",
} as const;

/** Hydration stops by throwing; other scans record truncation and continue. */
const parserBudgetExhausted = (
  budget: NativeAotParserBudget,
  kind: keyof typeof NATIVE_AOT_BUDGET_LIMIT,
): never => {
  const maximum =
    kind === "work"
      ? budget.limits.workUnits
      : budget.limits.workingMemoryBytes;
  throw decodeLimit(
    NATIVE_AOT_FORMAT,
    `NativeAOT hydration stopped at its ${String(maximum)} ${kind === "work" ? "work-unit" : "working-memory byte"} budget`,
    { name: NATIVE_AOT_BUDGET_LIMIT[kind], maximum },
  );
};

/** Which hydration budget a cause reports, if it is one. */
const exhaustedParserBudget = (
  cause: unknown,
): keyof typeof NATIVE_AOT_BUDGET_LIMIT | undefined => {
  if (
    !(cause instanceof ParseFailureError) ||
    cause.failure.kind !== "limit" ||
    cause.failure.format !== NATIVE_AOT_FORMAT
  )
    return undefined;
  const { name } = cause.failure.limit;
  if (name === NATIVE_AOT_BUDGET_LIMIT.work) return "work";
  if (name === NATIVE_AOT_BUDGET_LIMIT["working-memory"])
    return "working-memory";
  return undefined;
};

const nativeAotHydrationFailure = (
  cause: unknown,
  budget: NativeAotParserBudget,
): NativeAotHydrationFacts => {
  const exhausted = exhaustedParserBudget(cause);
  if (exhausted !== undefined)
    return nativeAotHydrationFacts(
      exhausted === "work" ? "work_budget" : "working_memory_budget",
    );
  if (
    cause instanceof NativeAotAdmissionError &&
    cause.reason.code === "hydration_failed"
  ) {
    // Budgeted image reads return no bytes once their work is exhausted.
    // That stop cannot establish the physical absence claimed by admission.
    if (budget.truncationReason === "work-unit-budget")
      return nativeAotHydrationFacts("work_budget");
    return nativeAotHydrationFacts(cause.reason.detail, cause.reason.command);
  }
  throw cause;
};

const reportBudgetRefusal = (
  code:
    | "report_budget_too_small"
    | "summary_exceeds_budget"
    | "summary_exceeded_after_serialization",
  maximumSummaryBytes: number,
): AnalysisResourceConstraintError =>
  new AnalysisResourceConstraintError(
    "parse_native_aot_pe",
    "capacity",
    code,
    { maximum_summary_bytes: maximumSummaryBytes },
    {
      diagnostics: { code },
      retryable: false,
    },
  );

type RtrSection = {
  readonly type: number;
  readonly flags: number;
  readonly start: bigint;
  readonly end: bigint;
};
type MethodTable = {
  readonly address: bigint;
  readonly flags: number;
  readonly baseSize: number;
  readonly related: bigint;
  readonly slotsCount: number;
  readonly interfacesCount: number;
};

const METHOD_TABLE_HEADER_BYTES = 24;
const NATIVE_AOT_POINTER_BYTES = 8;
const METHOD_TABLE_FORMAT = "NativeAOT MethodTable";
const methodTableSlotOffset = (slot: number): number =>
  METHOD_TABLE_HEADER_BYTES + slot * NATIVE_AOT_POINTER_BYTES;
const methodTableInterfaceOffset = (
  slotsCount: number,
  index: number,
): number => methodTableSlotOffset(slotsCount + index);
const methodTableByteLength = (
  slotsCount: number,
  interfacesCount: number,
): number => methodTableInterfaceOffset(slotsCount, interfacesCount);
const methodTablePointerAddress = (
  table: MethodTable,
  offset: number,
): bigint => table.address + BigInt(offset);
const TYPE_ROW_FIXED_BYTES = Buffer.byteLength(
  JSON.stringify({ address: "", type: null }),
);
const STRING_ROW_FIXED_BYTES =
  Buffer.byteLength(JSON.stringify({ address: "", value: "" })) - 2;

const readMappedPointer = (
  image: PeImage,
  address: bigint,
  budget: NativeAotParserBudget,
): bigint | null => {
  const loc = image.readAt(address, NATIVE_AOT_POINTER_BYTES, budget);
  return loc === null ? null : loc.reader.word(loc.offset, 64);
};

const METHOD_TABLE_RECORD_BYTES = 32;
const METHOD_TABLE_RECORD = {
  address: 0,
  flags: 8,
  baseSize: 12,
  related: 16,
  slotsCount: 24,
  interfacesCount: 26,
  included: 28,
} as const;

class MethodTableIndex {
  #records = new BinaryReader(
    Buffer.alloc(0),
    true,
    "NativeAOT MethodTable index",
  );
  #count = 0;
  #includedCount = 0;

  constructor(private readonly budget: NativeAotParserBudget) {}

  get count(): number {
    return this.#count;
  }
  get includedCount(): number {
    return this.#includedCount;
  }

  append(table: MethodTable): boolean {
    if (!this.#ensureCapacity(this.#count + 1)) return false;
    const offset = this.#count * METHOD_TABLE_RECORD_BYTES;
    const { bytes } = this.#records;
    bytes.writeBigUInt64LE(table.address, offset + METHOD_TABLE_RECORD.address);
    bytes.writeUInt32LE(table.flags, offset + METHOD_TABLE_RECORD.flags);
    bytes.writeUInt32LE(table.baseSize, offset + METHOD_TABLE_RECORD.baseSize);
    bytes.writeBigUInt64LE(table.related, offset + METHOD_TABLE_RECORD.related);
    bytes.writeUInt16LE(
      table.slotsCount,
      offset + METHOD_TABLE_RECORD.slotsCount,
    );
    bytes.writeUInt16LE(
      table.interfacesCount,
      offset + METHOD_TABLE_RECORD.interfacesCount,
    );
    bytes.fill(
      0,
      offset + METHOD_TABLE_RECORD.included,
      offset + METHOD_TABLE_RECORD_BYTES,
    );
    this.#count++;
    return true;
  }

  at(index: number): MethodTable | undefined {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.#count)
      return undefined;
    const offset = index * METHOD_TABLE_RECORD_BYTES;
    return {
      address: this.#records.word(offset + METHOD_TABLE_RECORD.address, 64),
      flags: this.#records.u32(offset + METHOD_TABLE_RECORD.flags),
      baseSize: this.#records.u32(offset + METHOD_TABLE_RECORD.baseSize),
      related: this.#records.word(offset + METHOD_TABLE_RECORD.related, 64),
      slotsCount: this.#records.u16(offset + METHOD_TABLE_RECORD.slotsCount),
      interfacesCount: this.#records.u16(
        offset + METHOD_TABLE_RECORD.interfacesCount,
      ),
    };
  }

  isIncluded(index: number): boolean {
    return (
      index >= 0 &&
      index < this.#count &&
      this.#records.u8(
        index * METHOD_TABLE_RECORD_BYTES + METHOD_TABLE_RECORD.included,
      ) !== 0
    );
  }

  include(index: number): void {
    if (!this.isIncluded(index)) {
      this.#records.bytes.writeUInt8(
        1,
        index * METHOD_TABLE_RECORD_BYTES + METHOD_TABLE_RECORD.included,
      );
      this.#includedCount++;
    }
  }

  /** Index validated related pointers once, then visit every reachable table once. */
  includeReachable(root: number, image: PeImage): boolean {
    const storageBytes = this.#count * 3 * Int32Array.BYTES_PER_ELEMENT;
    if (!this.budget.reserveWorkingMemory(storageBytes)) return false;
    try {
      if (!this.budget.consumeWork(this.#count * 8)) return false;
      const storage = new Int32Array(this.#count * 3);
      const children = storage.subarray(0, this.#count).fill(-1);
      const next = storage.subarray(this.#count, this.#count * 2).fill(-1);
      const queue = storage.subarray(this.#count * 2);
      for (let index = 0; index < this.#count; index += 1) {
        const related = this.#records.word(
          index * METHOD_TABLE_RECORD_BYTES + METHOD_TABLE_RECORD.related,
          64,
        );
        if (related === 0n) continue;
        const parent = this.find(related, this.budget);
        if (this.budget.truncationReason !== undefined) return false;
        if (parent >= 0) {
          next[index] = children[parent] ?? -1;
          children[parent] = index;
        }
      }
      let read = 0;
      let write = 0;
      const include = (index: number) => {
        if (this.isIncluded(index)) return;
        this.include(index);
        queue[write++] = index;
      };
      include(root);
      while (read < write) {
        const baseIndex = queue[read++] ?? -1;
        const base = this.at(baseIndex);
        if (base === undefined) continue;
        for (
          let child = children[baseIndex] ?? -1;
          child >= 0;
          child = next[child] ?? -1
        ) {
          if (!this.budget.consumeWork(8)) return false;
          include(child);
        }
        for (let index = 0; index < base.interfacesCount; index += 1) {
          if (!this.budget.consumeWork(NATIVE_AOT_POINTER_BYTES)) return false;
          const address = readMappedPointer(
            image,
            methodTablePointerAddress(
              base,
              methodTableInterfaceOffset(base.slotsCount, index),
            ),
            this.budget,
          );
          if (address === null) continue;
          const interfaceIndex = this.find(address, this.budget);
          if (this.budget.truncationReason !== undefined) return false;
          if (interfaceIndex >= 0) include(interfaceIndex);
        }
      }
      return true;
    } finally {
      this.budget.releaseWorkingMemory(storageBytes);
    }
  }

  find(address: bigint, budget: NativeAotParserBudget): number {
    let low = 0;
    let high = this.#count;
    while (low < high) {
      if (!budget.consumeWork(8)) return -1;
      const middle = low + ((high - low) >>> 1);
      const record = middle * METHOD_TABLE_RECORD_BYTES;
      const candidate = this.#records.word(
        record + METHOD_TABLE_RECORD.address,
        64,
      );
      if (candidate < address) low = middle + 1;
      else high = middle;
    }
    return low < this.#count &&
      this.#records.word(
        low * METHOD_TABLE_RECORD_BYTES + METHOD_TABLE_RECORD.address,
        64,
      ) === address
      ? low
      : -1;
  }

  forEach(callback: (table: MethodTable, index: number) => void): void {
    for (let index = 0; index < this.#count; index++) {
      const table = this.at(index);
      if (table !== undefined) callback(table, index);
    }
  }

  forEachIncluded(callback: (table: MethodTable, index: number) => void): void {
    for (let index = 0; index < this.#count; index++) {
      if (!this.isIncluded(index)) continue;
      const table = this.at(index);
      if (table !== undefined) callback(table, index);
    }
  }

  #ensureCapacity(requiredRecords: number): boolean {
    const requiredBytes = requiredRecords * METHOD_TABLE_RECORD_BYTES;
    const { bytes, little, format } = this.#records;
    if (requiredBytes <= bytes.byteLength) return true;
    const capacityBytes = Math.min(
      this.budget.limits.workingMemoryBytes,
      Math.max(requiredBytes, bytes.byteLength * 2 || 4096),
    );
    if (capacityBytes < requiredBytes) {
      this.budget.truncationReason ??= "working-memory-budget";
      return false;
    }
    if (!this.budget.reserveWorkingMemory(capacityBytes)) return false;
    const expanded = Buffer.allocUnsafe(capacityBytes);
    bytes.copy(expanded, 0, 0, this.#count * METHOD_TABLE_RECORD_BYTES);
    this.budget.releaseWorkingMemory(bytes.byteLength);
    this.#records = new BinaryReader(expanded, little, format);
    return true;
  }
}
export type NativeAotType = {
  readonly address: string;
  readonly type: null;
};
export type NativeAotString = {
  readonly address: string;
  readonly value: string;
};
type NativeAotCoverage = {
  readonly pointer_candidates_examined: number;
  readonly pointer_slots_examined?: number;
  readonly scan_bytes_examined?: number;
  readonly scan_bytes_omitted?: number;
  readonly rtr_signature_scan_bytes_examined?: number;
  readonly rtr_signature_scan_bytes_omitted?: number;
  readonly method_table_validation_items_examined?: number;
  readonly work_units_examined?: number;
  readonly method_tables_recovered: number;
  readonly frozen_string_candidates: number;
  readonly frozen_scan_bytes_examined?: number;
  readonly frozen_scan_bytes_omitted?: number;
  readonly frozen_string_data_bytes_examined?: number;
  readonly source_bytes_examined?: number;
  readonly source_bytes_omitted?: number;
  readonly work_budget_units?: number;
  readonly source_byte_budget_bytes?: number;
  readonly working_memory_budget_bytes?: number;
  readonly working_memory_bytes_peak?: number;
  readonly truncation_reason?: NativeAotTruncationReason;
  readonly basis:
    | "raw-image-pointer-scan"
    | "raw-image-and-rehydrated-pointer-scan"
    | "unsupported-layout"
    | "no-rtr-header";
};

type NativeAotReportBase = {
  readonly format: "dotnet-nativeaot";
  readonly analysis_artifact_sha256: string;
  readonly analysis_mode: "read-only-derived-overlay";
  readonly method_tables: number;
  readonly types: readonly NativeAotType[];
  readonly frozen_strings: readonly NativeAotString[];
  readonly derived_memory: null;
  readonly coverage: NativeAotCoverage;
  readonly diagnostics: readonly string[];
  readonly limitations: readonly string[];
  readonly output_budget_bytes?: number;
};

type NativeAotLocatedHeader = {
  readonly header_address: string;
  readonly discovery: "signature-heuristic";
  readonly format_major: number;
  readonly format_minor: number;
  readonly derived_overlay: {
    readonly address: string;
    readonly size_bytes: number;
    readonly sha256: string;
  } | null;
};

type NativeAotAbsentHeader = {
  readonly header_address: null;
  readonly discovery: null;
  readonly format_major: null;
  readonly format_minor: null;
  readonly derived_overlay: null;
};

type NativeAotTruncated = {
  readonly truncated: true;
  readonly types_omitted: number;
  readonly frozen_strings_omitted: number;
  readonly output_budget_bytes: number;
};

type NativeAotUntruncated = {
  readonly truncated?: false;
  readonly types_omitted?: number;
  readonly frozen_strings_omitted?: number;
};

type NativeAotNotApplicableReport = NativeAotReportBase &
  NativeAotAbsentHeader &
  NativeAotUntruncated & {
    readonly status: "not_applicable";
    readonly reason: NativeAotReason;
  };

/** Complete reports have a header and no reason. Failures carry a reason code. */
export type NativeAotReport =
  | (NativeAotReportBase &
      NativeAotLocatedHeader &
      NativeAotUntruncated & {
        readonly status: "complete";
        readonly reason: null;
        readonly types_omitted?: 0;
        readonly frozen_strings_omitted?: 0;
      })
  | (NativeAotReportBase &
      NativeAotLocatedHeader &
      (NativeAotTruncated | NativeAotUntruncated) & {
        readonly status: "partial";
        readonly reason: NativeAotReason;
      })
  | (NativeAotReportBase &
      NativeAotAbsentHeader &
      NativeAotTruncated & {
        readonly status: "partial";
        readonly reason: NativeAotReason;
      })
  | NativeAotNotApplicableReport;
export type NativeAotPeResult = {
  readonly summary: NativeAotReport;
  readonly readTypeDetail: (
    address: string,
    maximumBytes: number,
  ) => NativeMetadataRecovery | undefined;
};

export const nativeAotSnapshotOverCapacity = (
  sha256: string,
  sourceBytesAtLeast: number,
  maximumSummaryBytes: number,
  limits: NativeAotParserLimits = DEFAULT_NATIVE_AOT_PARSER_LIMITS,
): NativeAotReport =>
  assertNativeAotReportFits(
    {
      format: "dotnet-nativeaot",
      status: "partial",
      reason: {
        code: "source_byte_budget",
        limit_bytes: limits.sourceBytes,
        observed_bytes: sourceBytesAtLeast,
        runtime_override: false,
      },
      analysis_artifact_sha256: sha256,
      analysis_mode: "read-only-derived-overlay",
      header_address: null,
      discovery: null,
      format_major: null,
      format_minor: null,
      method_tables: 0,
      types: [],
      frozen_strings: [],
      truncated: true,
      types_omitted: 0,
      frozen_strings_omitted: 0,
      output_budget_bytes: maximumSummaryBytes,
      derived_overlay: null,
      derived_memory: null,
      coverage: {
        pointer_candidates_examined: 0,
        scan_bytes_examined: 0,
        scan_bytes_omitted: 0,
        method_table_validation_items_examined: 0,
        work_units_examined: 0,
        method_tables_recovered: 0,
        frozen_string_candidates: 0,
        frozen_scan_bytes_examined: 0,
        frozen_scan_bytes_omitted: 0,
        frozen_string_data_bytes_examined: 0,
        source_bytes_examined: 0,
        work_budget_units: limits.workUnits,
        source_byte_budget_bytes: limits.sourceBytes,
        working_memory_budget_bytes: limits.workingMemoryBytes,
        working_memory_bytes_peak: 0,
        truncation_reason: "source-byte-budget",
        basis: "unsupported-layout",
      },
      diagnostics: ["source_byte_budget"],
      limitations: [
        "NativeAOT metadata was not inspected because the captured snapshot exceeded the local source-byte budget.",
        "The artifact digest identifies the selected target; no metadata facts are inferred from the omitted snapshot.",
        "No Ghidra database types, labels, functions, or bytes are created or changed.",
      ],
    },
    maximumSummaryBytes,
  );

const assertNativeAotReportFits = (
  report: NativeAotReport,
  maximumBytes: number,
): NativeAotReport => {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 0 ||
    Buffer.byteLength(JSON.stringify(report)) > maximumBytes
  )
    throw reportBudgetRefusal("report_budget_too_small", maximumBytes);
  return report;
};

const parsedSummary = (
  summary: NativeAotReport,
  maximumBytes: number,
): NativeAotPeResult => ({
  summary: assertNativeAotReportFits(summary, maximumBytes),
  readTypeDetail: () => undefined,
});

const hex = (value: bigint): string => `0x${value.toString(16)}`;
const notApplicable = (
  sha: string,
  reason: NativeAotReason,
  basis: NativeAotReport["coverage"]["basis"],
): NativeAotNotApplicableReport => ({
  format: "dotnet-nativeaot",
  status: "not_applicable",
  reason,
  analysis_artifact_sha256: sha,
  analysis_mode: "read-only-derived-overlay",
  header_address: null,
  discovery: null,
  format_major: null,
  format_minor: null,
  method_tables: 0,
  types: [],
  frozen_strings: [],
  derived_overlay: null,
  derived_memory: null,
  coverage: {
    pointer_candidates_examined: 0,
    method_tables_recovered: 0,
    frozen_string_candidates: 0,
    basis,
  },
  diagnostics: [],
  limitations: [
    "This report is derived from the admitted file snapshot; it does not define or annotate Ghidra database types.",
  ],
});

type RtrDirectory = {
  readonly address: bigint;
  readonly major: number;
  readonly minor: number;
  readonly sections: readonly RtrSection[];
};
type RtrDirectorySearch = {
  readonly directory: RtrDirectory | null;
  readonly matches: number;
  readonly scanBytesExamined: number;
  readonly scanBytesOmitted: number;
  readonly truncated: boolean;
};

const findDirectory = (
  image: PeImage,
  bytes: Buffer,
  budget: NativeAotParserBudget,
): RtrDirectorySearch => {
  let found: RtrDirectory | null = null;
  let matches = 0;
  let scanBytesExamined = 0;
  const ranges = image.sections.flatMap((section) => {
    if (
      (section.characteristics & 0x40000000) === 0 ||
      (section.characteristics & 0x20000000) !== 0
    )
      return [];
    const begin = section.rawOffset;
    const end = begin + fileBackedVirtualExtent(section);
    const first = (begin + 7) & ~7;
    const candidateBytes =
      first <= end - 16 ? (Math.floor((end - 16 - first) / 8) + 1) * 8 : 0;
    return [{ section, begin, end, first, candidateBytes }];
  });
  const totalScanBytes = ranges.reduce(
    (total, range) => total + range.candidateBytes,
    0,
  );
  let truncated = false;
  scan: for (const { section, begin, end, first } of ranges) {
    const fields = new BinaryReader(
      bytes.subarray(begin, end),
      true,
      NATIVE_AOT_FORMAT,
    );
    for (
      let offset = first - begin;
      offset <= fields.bytes.length - 16;
      offset += 8
    ) {
      if (!budget.consumeWork(8)) {
        truncated = true;
        break scan;
      }
      scanBytesExamined += 8;
      if (fields.u32(offset) !== RTR_SIGNATURE) continue;
      if (!budget.consumeWork(16)) {
        truncated = true;
        break scan;
      }
      const count = fields.u16(offset + 12);
      if (
        fields.u8(offset + 14) !== RTR_ROW_SIZE ||
        fields.u8(offset + 15) !== RTR_ROW_TYPE ||
        count < 1 ||
        offset > fields.bytes.length - (16 + count * RTR_ROW_SIZE)
      )
        continue;
      const rows: RtrSection[] = [];
      let valid = true;
      for (let row = 0; row < count; row++) {
        if (!budget.consumeWork(RTR_ROW_SIZE)) {
          truncated = true;
          break scan;
        }
        const p = offset + 16 + row * RTR_ROW_SIZE;
        const type = fields.u32(p);
        const start = fields.word(p + 8, 64);
        const finish = fields.word(p + 16, 64);
        const isConsumedRange =
          type === FROZEN_OBJECT_REGION || type === DEHYDRATED_DATA;
        const isTypeManagerIndirection = type === 204;
        if (
          isConsumedRange &&
          finish !== start &&
          !image.hasImageRange(start, finish)
        ) {
          valid = false;
          break;
        }
        if (
          isTypeManagerIndirection &&
          start !== 0n &&
          image.read(start, 8, budget) === null
        ) {
          valid = false;
          break;
        }
        if (isConsumedRange || isTypeManagerIndirection) {
          // A repeated frozen region is kept for the consumer to report as
          // ambiguous; other repeated rows disqualify the candidate.
          if (
            type !== FROZEN_OBJECT_REGION &&
            rows.some((existing) => existing.type === type)
          ) {
            valid = false;
            break;
          }
          rows.push({
            type,
            flags: fields.u32(p + 4),
            start,
            end: finish,
          });
        }
      }
      if (valid) {
        matches++;
        if (found === null)
          found = {
            address: image.addressForRva(section.rva + offset),
            major: fields.u16(offset + 4),
            minor: fields.u16(offset + 6),
            sections: rows,
          };
      }
    }
  }
  return {
    directory: found,
    matches,
    scanBytesExamined,
    scanBytesOmitted: Math.max(0, totalScanBytes - scanBytesExamined),
    truncated,
  };
};

/** One discovery owner counts only entries the validator actually examines. */
const parseMethodTable = (
  image: PeImage,
  address: bigint,
  budget: NativeAotParserBudget,
  validation: { itemsExamined: number },
): MethodTable | null => {
  const header = image.readAt(address, METHOD_TABLE_HEADER_BYTES, budget);
  if (header === null) return null;
  const { reader: fields, offset: hOff } = header;
  const flags = fields.u32(hOff),
    baseSize = fields.u32(hOff + 4),
    related = fields.word(hOff + 8, 64);
  const elementType = (flags & 0x7c000000) >>> 26;
  if (
    (elementType !== 0x14 && elementType !== 0x15) ||
    baseSize < 16 ||
    baseSize > 0x10000000 ||
    (related !== 0n &&
      image.readAt(related, METHOD_TABLE_HEADER_BYTES, budget) === null)
  )
    return null;
  const slotsCount = fields.u16(hOff + 16);
  const interfacesCount = fields.u16(hOff + 18);
  const body = image.readAt(
    address,
    methodTableByteLength(slotsCount, interfacesCount),
    budget,
  );
  if (body === null) return null;
  const { reader: pointers, offset: bOff } = body;
  for (let slot = 0; slot < slotsCount; slot++) {
    if (!budget.consumeWork(NATIVE_AOT_POINTER_BYTES)) return null;
    validation.itemsExamined++;
    const target = pointers.word(bOff + methodTableSlotOffset(slot), 64);
    if (target !== 0n && !image.isExecutable(target, budget)) return null;
  }
  for (let index = 0; index < interfacesCount; index++) {
    if (!budget.consumeWork(NATIVE_AOT_POINTER_BYTES)) return null;
    validation.itemsExamined++;
    const iface = pointers.word(
      bOff + methodTableInterfaceOffset(slotsCount, index),
      64,
    );
    if (iface !== 0n && image.readAt(iface, 20, budget) === null) return null;
  }
  return { address, flags, baseSize, related, slotsCount, interfacesCount };
};

const readRelativePointer = (
  image: PeImage,
  address: bigint,
  budget: NativeAotParserBudget,
): bigint | null => {
  const raw = image.readAt(address, 4, budget);
  return raw === null ? null : address + BigInt(raw.reader.i32(raw.offset));
};

/** Exact UTF-8 length of JSON.stringify for a UTF-16 string without allocating it. */
const jsonUtf16StringBytes = (
  fields: BinaryReader,
  codeUnits: number,
  baseOffset = 0,
): number => {
  let total = 2;
  for (let index = 0; index < codeUnits; index++) {
    const value = fields.u16(baseOffset + index * 2);
    if (value === 0x22 || value === 0x5c) total += 2;
    else if (value < 0x20)
      total +=
        value === 8 ||
        value === 9 ||
        value === 10 ||
        value === 12 ||
        value === 13
          ? 2
          : 6;
    else if (value >= 0xd800 && value <= 0xdbff) {
      const next =
        index + 1 < codeUnits ? fields.u16(baseOffset + (index + 1) * 2) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        total += 4;
        index++;
      } else total += 6;
    } else if (value >= 0xdc00 && value <= 0xdfff) total += 6;
    else if (value <= 0x7f) total++;
    else if (value <= 0x7ff) total += 2;
    else total += 3;
  }
  return total;
};

/** Versioned .NET 8 RTR9.1 hydration, adapted from Washi's MIT-licensed
 * `ghidra-nativeaot` at effeb734fc570c32650f88b159608979dc7b423e. The
 * MethodTable layout is cross-checked against the .NET Foundation MIT-licensed
 * MethodTable.h at runtime commit a3b2d40328be0be3f8dd43f0e5cc925b8827b044.
 * See licenses/nativeaot-parser-MIT.txt. Output is an isolated parser overlay;
 * input snapshot bytes stay immutable. */
const hydrate = (
  image: PeImage,
  dehydrated: RtrSection,
  budget: NativeAotParserBudget,
): {
  readonly base: bigint;
  readonly sizeBytes: number;
  readonly sha256: string;
} | null => {
  const length = dehydrated.end - dehydrated.start;
  if (
    length < 5n ||
    length > BigInt(image.virtualBytesRemaining(dehydrated.start, budget))
  )
    throw new NativeAotAdmissionError({
      code: "hydration_failed",
      detail: "length_outside_section",
    });
  const first = image.read(dehydrated.start, Number(length), budget);
  if (first === null)
    throw new NativeAotAdmissionError({
      code: "hydration_failed",
      detail: "leaves_captured_sections",
    });
  const base = readRelativePointer(image, dehydrated.start, budget);
  if (base === null)
    throw new NativeAotAdmissionError({
      code: "hydration_failed",
      detail: "missing_base_pointer",
    });
  // Section coverage and parser budgets are independent admission facts.
  // Work and memory exhaustion must not turn a mapped base into corrupt data.
  const outputLimit = image.virtualBytesRemaining(base, budget);
  if (outputLimit === 0)
    throw new NativeAotAdmissionError({
      code: "hydration_failed",
      detail: "base_outside_mapped_sections",
    });
  const initialCapacity = Math.min(
    outputLimit,
    64 * 1024,
    budget.remainingWorkingMemoryBytes,
  );
  if (!budget.reserveWorkingMemory(initialCapacity))
    parserBudgetExhausted(budget, "working-memory");
  let output = Buffer.alloc(initialCapacity);
  let outputLength = 0;
  let cursor = 4;
  /** Reserve the next output bytes and return a view of the retained buffer.
   * Writers must use only this view: growth replaces `output`, so a reference
   * taken before reserving would write into the superseded buffer. Every byte
   * of the view must be written because growth leaves new capacity
   * uninitialized. */
  const reserveOutput = (length: number): Buffer => {
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > outputLimit - outputLength
    ) {
      throw new NativeAotAdmissionError({
        code: "hydration_failed",
        detail: "exceeds_mapped_section",
      });
    }
    const start = outputLength;
    const required = start + length;
    if (required > output.length) {
      const capacity = Math.min(
        outputLimit,
        Math.max(
          required,
          Math.min(outputLimit, output.length * 2 || 64 * 1024),
        ),
      );
      if (!budget.reserveWorkingMemory(capacity))
        parserBudgetExhausted(budget, "working-memory");
      const expanded = Buffer.allocUnsafe(capacity);
      output.copy(expanded, 0, 0, outputLength);
      budget.releaseWorkingMemory(output.byteLength);
      output = expanded;
    }
    outputLength = required;
    return output.subarray(start, required);
  };
  const append = (chunk: Buffer): void => {
    if (!budget.consumeWork(chunk.length))
      parserBudgetExhausted(budget, "work");
    chunk.copy(reserveOutput(chunk.length));
  };
  const appendZero = (length: number): void => {
    if (!budget.consumeWork(length)) parserBudgetExhausted(budget, "work");
    reserveOutput(length).fill(0);
  };
  const appendRel = (target: bigint): void => {
    if (!budget.consumeWork(4)) parserBudgetExhausted(budget, "work");
    const delta = target - (base + BigInt(outputLength));
    if (delta < -0x80000000n || delta > 0x7fffffffn)
      throw new NativeAotAdmissionError({
        code: "hydration_failed",
        detail: "relative_pointer_overflow",
      });
    reserveOutput(4).writeInt32LE(Number(delta), 0);
  };
  const appendPtr = (target: bigint): void => {
    if (!budget.consumeWork(8)) parserBudgetExhausted(budget, "work");
    // writeBigUInt64LE throws RangeError outside the unsigned 64-bit domain.
    // That is a malformed fixup, not an unexpected parser failure.
    if (target < 0n || target > 0xffffffffffffffffn)
      throw new NativeAotAdmissionError({
        code: "hydration_failed",
        detail: "pointer_outside_address_domain",
      });
    reserveOutput(8).writeBigUInt64LE(target, 0);
  };
  const readFixup = (index: number): bigint => {
    const fixupLocation = dehydrated.end + BigInt(index * 4);
    const target = readRelativePointer(image, fixupLocation, budget);
    if (target === null)
      throw new NativeAotAdmissionError({
        code: "hydration_failed",
        detail: "fixup_leaves_sections",
      });
    return target;
  };
  try {
    while (cursor < first.length) {
      if (!budget.consumeWork(1)) parserBudgetExhausted(budget, "work");
      const encoded = first[cursor];
      if (encoded === undefined) break;
      cursor++;
      const command = encoded & 7;
      let payload = encoded >>> 3;
      const extraBytes = payload - 28;
      if (extraBytes > 0) {
        if (extraBytes > 3 || cursor > first.length - extraBytes)
          throw new NativeAotAdmissionError({
            code: "hydration_failed",
            detail: "invalid_payload_encoding",
          });
        payload = 0;
        for (let i = 0; i < extraBytes; i++)
          payload += (first[cursor++] ?? 0) * 2 ** (8 * i);
        payload += 28;
      }
      switch (command) {
        case 0: {
          if (cursor > first.length - payload)
            throw new NativeAotAdmissionError({
              code: "hydration_failed",
              detail: "copy_leaves_section",
            });
          append(first.subarray(cursor, cursor + payload));
          cursor += payload;
          break;
        }
        case 1:
          appendZero(payload);
          break;
        case 2:
          appendRel(readFixup(payload));
          break;
        case 3:
          appendPtr(readFixup(payload));
          break;
        case 4:
          if (!budget.consumeWork(payload * 4))
            parserBudgetExhausted(budget, "work");
          if (
            payload > Math.floor((first.length - cursor) / 4) ||
            payload > Math.floor((outputLimit - outputLength) / 4)
          )
            throw new NativeAotAdmissionError({
              code: "hydration_failed",
              detail: "inline_relative_fixups_leave",
            });
          for (let i = 0; i < payload; i++) {
            const target = readRelativePointer(
              image,
              dehydrated.start + BigInt(cursor),
              budget,
            );
            if (target === null)
              throw new NativeAotAdmissionError({
                code: "hydration_failed",
                detail: "invalid_inline_relative_pointer",
              });
            cursor += 4;
            appendRel(target);
          }
          break;
        case 5:
          if (!budget.consumeWork(payload * 4))
            parserBudgetExhausted(budget, "work");
          if (
            payload > Math.floor((first.length - cursor) / 4) ||
            payload > Math.floor((outputLimit - outputLength) / 8)
          )
            throw new NativeAotAdmissionError({
              code: "hydration_failed",
              detail: "inline_pointer_fixups_leave",
            });
          for (let i = 0; i < payload; i++) {
            const target = readRelativePointer(
              image,
              dehydrated.start + BigInt(cursor),
              budget,
            );
            if (target === null)
              throw new NativeAotAdmissionError({
                code: "hydration_failed",
                detail: "invalid_inline_pointer",
              });
            cursor += 4;
            appendPtr(target);
          }
          break;
        default:
          throw new NativeAotAdmissionError({
            code: "hydration_failed",
            detail: "unsupported_command",
            command,
          });
      }
    }
  } catch (cause: unknown) {
    budget.releaseWorkingMemory(output.byteLength);
    throw cause;
  }
  const hydrated = output.subarray(0, outputLength);
  const sha256 = sha256Hex(hydrated);
  image.addOverlay({ base, sizeBytes: outputLength, sha256, bytes: hydrated });
  return { base, sizeBytes: outputLength, sha256 };
};

const discoverTables = (
  image: PeImage,
  hydrated: { readonly base: bigint; readonly sizeBytes: number } | null,
  budget: NativeAotParserBudget,
): {
  tables: MethodTableIndex;
  pointerCount: number;
  pointerSlotsExamined: number;
  scanBytesExamined: number;
  scanBytesOmitted: number;
  methodTableValidationItemsExamined: number;
  truncated: boolean;
} => {
  const ranges: { start: bigint; end: bigint }[] = [];
  for (const section of image.sections) {
    if (
      (section.characteristics & 0x40000000) === 0 ||
      (section.characteristics & 0x20000000) !== 0
    )
      continue;
    const extent = fileBackedVirtualExtent(section);
    if (extent > 0) {
      ranges.push({
        start: image.addressForRva(section.rva),
        end: image.addressForRva(section.rva + extent),
      });
    }
  }
  if (
    hydrated !== null &&
    image.sections.some(
      (candidate) =>
        (candidate.characteristics & 0x40000000) !== 0 &&
        (candidate.characteristics & 0x20000000) === 0 &&
        hydrated.base >= image.addressForRva(candidate.rva) &&
        hydrated.base + BigInt(hydrated.sizeBytes) <=
          image.addressForRva(candidate.rva + virtualExtent(candidate)),
    )
  )
    ranges.push({
      start: hydrated.base,
      end: hydrated.base + BigInt(hydrated.sizeBytes),
    });
  ranges.sort((left, right) => (left.start < right.start ? -1 : 1));
  const merged: { start: bigint; end: bigint }[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous !== undefined && range.start <= previous.end) {
      if (range.end > previous.end) previous.end = range.end;
    } else {
      merged.push({ ...range });
    }
  }
  const totalScanBytes = merged.reduce(
    (total, range) => total + Number(range.end - range.start),
    0,
  );
  let pointerCount = 0,
    pointerSlotsExamined = 0,
    scanBytesExamined = 0,
    truncated = false;
  const validation = { itemsExamined: 0 };
  const candidates = new MethodTableIndex(budget);
  scan: for (const range of merged) {
    let address = (range.start + 7n) & ~7n;
    while (address + 8n <= range.end) {
      if (!budget.consumeWork(8)) {
        truncated = true;
        break scan;
      }
      const value = readMappedPointer(image, address, budget);
      if (budget.truncationReason !== undefined) {
        truncated = true;
        break scan;
      }
      pointerSlotsExamined++;
      scanBytesExamined += 8;
      if (value !== null && value !== 0n) pointerCount++;
      const candidateAddress = address - 8n;
      const candidate = parseMethodTable(
        image,
        candidateAddress,
        budget,
        validation,
      );
      if (budget.truncationReason !== undefined) {
        truncated = true;
        break scan;
      }
      if (candidate !== null && !candidates.append(candidate)) {
        truncated = true;
        break scan;
      }
      address += 8n;
    }
  }
  let objectRoot = -1;
  let objectCount = 0;
  candidates.forEach((candidate, index) => {
    if (
      candidate.flags !== 0x50000000 ||
      candidate.baseSize !== 0x18 ||
      candidate.related !== 0n ||
      candidate.slotsCount !== 3 ||
      candidate.interfacesCount !== 0
    )
      return;
    // The root heuristic samples its three declared slots and one following
    // word. That extra word is outside the declared slot/interface arrays.
    const sampleBytes = (candidate.slotsCount + 1) * NATIVE_AOT_POINTER_BYTES;
    if (!budget.consumeWork(sampleBytes)) {
      truncated = true;
      return;
    }
    const vtable = image.read(
      methodTablePointerAddress(candidate, methodTableSlotOffset(0)),
      sampleBytes,
      budget,
    );
    if (vtable === null) return;
    const sample = new BinaryReader(vtable, true, METHOD_TABLE_FORMAT);
    if (
      image.isExecutable(sample.word(0, 64), budget) &&
      image.isExecutable(sample.word(NATIVE_AOT_POINTER_BYTES, 64), budget) &&
      image.isExecutable(
        sample.word(2 * NATIVE_AOT_POINTER_BYTES, 64),
        budget,
      ) &&
      !image.isExecutable(sample.word(3 * NATIVE_AOT_POINTER_BYTES, 64), budget)
    ) {
      objectRoot = index;
      objectCount++;
    }
  });
  truncated ||= budget.truncationReason !== undefined;
  if (objectCount !== 1 || objectRoot < 0 || truncated)
    return {
      tables: candidates,
      pointerCount,
      pointerSlotsExamined,
      scanBytesExamined,
      scanBytesOmitted: Math.max(0, totalScanBytes - scanBytesExamined),
      methodTableValidationItemsExamined: validation.itemsExamined,
      truncated,
    };
  truncated = !candidates.includeReachable(objectRoot, image);
  return {
    tables: candidates,
    pointerCount,
    pointerSlotsExamined,
    scanBytesExamined,
    scanBytesOmitted: Math.max(0, totalScanBytes - scanBytesExamined),
    methodTableValidationItemsExamined: validation.itemsExamined,
    truncated,
  };
};

/** Parse only the captured x64 PE snapshot. No file reads or Ghidra database writes occur here. */
export const parseNativeAotPe = (
  bytes: Buffer,
  expectedSha256: string,
  maximumSummaryBytes: number,
  loadedImageBase?: string,
  limits = nativeAotParserLimitsFor(bytes.byteLength),
): NativeAotPeResult => {
  if (!Number.isSafeInteger(maximumSummaryBytes) || maximumSummaryBytes < 0)
    throw new AnalysisInputError("parse_native_aot_pe", undefined, [
      {
        path: ["maximumSummaryBytes"],
        reason: "out_of_range",
        minimum: 0,
        ...(Number.isFinite(maximumSummaryBytes)
          ? { observed: maximumSummaryBytes }
          : {}),
      },
    ]);
  const invalidLimit = (
    Object.entries(limits) as readonly (readonly [string, number])[]
  ).find(([, limit]) => !Number.isSafeInteger(limit) || limit < 0);
  if (invalidLimit !== undefined)
    throw new AnalysisInputError("parse_native_aot_pe", undefined, [
      {
        path: ["limits", invalidLimit[0]],
        reason: "out_of_range",
        minimum: 0,
        ...(Number.isFinite(invalidLimit[1])
          ? { observed: invalidLimit[1] }
          : {}),
      },
    ]);
  if (bytes.byteLength > limits.sourceBytes)
    return parsedSummary(
      nativeAotSnapshotOverCapacity(
        expectedSha256,
        bytes.byteLength,
        maximumSummaryBytes,
        limits,
      ),
      maximumSummaryBytes,
    );
  const sha256 = sha256Hex(bytes);
  if (sha256 !== expectedSha256)
    throw new NativeAotSnapshotIdentityError(expectedSha256, sha256);
  let image: PeImage;
  try {
    image = new PeImage(bytes);
  } catch (cause: unknown) {
    if (!(cause instanceof NativeAotAdmissionError)) throw cause;
    return parsedSummary(
      notApplicable(sha256, cause.reason, "unsupported-layout"),
      maximumSummaryBytes,
    );
  }
  if (
    loadedImageBase !== undefined &&
    BigInt(loadedImageBase) !== image.imageBase
  )
    return parsedSummary(
      notApplicable(sha256, { code: "rebased_image" }, "unsupported-layout"),
      maximumSummaryBytes,
    );
  const budget = new NativeAotParserBudget(limits);
  const directorySearch = findDirectory(image, bytes, budget);
  if (directorySearch.truncated)
    return parsedSummary(
      {
        ...notApplicable(
          sha256,
          { code: "rtr_scan_budget", runtime_override: false },
          "no-rtr-header",
        ),
        status: "partial",
        truncated: true,
        types_omitted: 0,
        frozen_strings_omitted: 0,
        output_budget_bytes: maximumSummaryBytes,
        coverage: {
          pointer_candidates_examined: 0,
          pointer_slots_examined: 0,
          scan_bytes_examined: directorySearch.scanBytesExamined,
          scan_bytes_omitted: directorySearch.scanBytesOmitted,
          rtr_signature_scan_bytes_examined: directorySearch.scanBytesExamined,
          rtr_signature_scan_bytes_omitted: directorySearch.scanBytesOmitted,
          method_tables_recovered: 0,
          frozen_string_candidates: 0,
          work_units_examined: budget.workUnits,
          work_budget_units: budget.limits.workUnits,
          source_byte_budget_bytes: budget.limits.sourceBytes,
          working_memory_budget_bytes: budget.limits.workingMemoryBytes,
          working_memory_bytes_peak: budget.workingMemoryBytesPeak,
          ...(budget.truncationReason === undefined
            ? {}
            : { truncation_reason: budget.truncationReason }),
          basis: "no-rtr-header",
        },
        diagnostics: ["rtr_scan_incomplete"],
      },
      maximumSummaryBytes,
    );
  if (directorySearch.directory === null && directorySearch.matches === 0)
    return parsedSummary(
      notApplicable(sha256, { code: "no_rtr_directory" }, "no-rtr-header"),
      maximumSummaryBytes,
    );
  if (directorySearch.matches !== 1 || directorySearch.directory === null)
    return parsedSummary(
      notApplicable(
        sha256,
        { code: "ambiguous_rtr_directory" },
        "unsupported-layout",
      ),
      maximumSummaryBytes,
    );
  const directory = directorySearch.directory;
  if (directory.major !== 9 || directory.minor !== 1)
    return parsedSummary(
      {
        ...notApplicable(
          sha256,
          {
            code: "unsupported_rtr_version",
            format_major: directory.major,
            format_minor: directory.minor,
          },
          "unsupported-layout",
        ),
        status: "partial",
        header_address: hex(directory.address),
        discovery: "signature-heuristic",
        format_major: directory.major,
        format_minor: directory.minor,
      },
      maximumSummaryBytes,
    );
  const byType = keyedBy(directory.sections, ({ type }) => type);
  const dehydrated = allKeyed(byType, DEHYDRATED_DATA);
  if (dehydrated.length !== 1)
    return parsedSummary(
      {
        ...notApplicable(
          sha256,
          { code: "dehydrated_section_count" },
          "unsupported-layout",
        ),
        status: "partial",
        header_address: hex(directory.address),
        discovery: "signature-heuristic",
        format_major: directory.major,
        format_minor: directory.minor,
      },
      maximumSummaryBytes,
    );
  let overlay: ReturnType<typeof hydrate> = null;
  let hydration: NativeAotHydrationFacts | null = null;
  try {
    overlay = hydrate(image, dehydrated[0] as RtrSection, budget);
  } catch (cause: unknown) {
    hydration = nativeAotHydrationFailure(cause, budget);
  }
  const discovered = discoverTables(image, overlay, budget);
  // Repeated regions are ambiguous: the scan reads neither rather than
  // choosing one by position, and the report is partial.
  const frozenRegion = uniqueKeyed(byType, FROZEN_OBJECT_REGION);
  const frozen = frozenRegion.ok ? frozenRegion.value : undefined;
  const isRecoveredStringTable = (address: bigint): boolean => {
    const index = discovered.tables.find(address, budget);
    if (
      budget.truncationReason !== undefined ||
      index < 0 ||
      !discovered.tables.isIncluded(index)
    )
      return false;
    const table = discovered.tables.at(index);
    if (
      table === undefined ||
      (table.flags & 0x7c000000) >>> 26 !== 0x14 ||
      table.baseSize !== 0x16 ||
      table.related === 0n
    )
      return false;
    const related = discovered.tables.find(table.related, budget);
    if (budget.truncationReason !== undefined) return false;
    return related >= 0 && discovered.tables.isIncluded(related);
  };
  const types: NativeAotType[] = [];
  const frozenStrings: NativeAotString[] = [];
  let frozenCandidates = 0;
  let frozenStringsOmitted = 0;
  let frozenScanBytesExamined = 0;
  let frozenStringDataBytesExamined = 0;
  let frozenScanTruncated = false;
  const frozenFirstCandidate =
    frozen === undefined ? 0n : (frozen.start + 7n) & ~7n;
  const frozenCandidateBound =
    frozen === undefined || frozen.end < frozenFirstCandidate + 14n
      ? 0
      : Number((frozen.end - 14n - frozenFirstCandidate) / 8n + 1n);
  const hydrationAttachment = hydration === null ? {} : { hydration };
  const discoveryReason: NativeAotReason | null =
    discovered.truncated && discovered.tables.includedCount === 0
      ? {
          code: "system_object_root_unproven",
          runtime_override: false,
          ...hydrationAttachment,
        }
      : discovered.tables.includedCount === 0
        ? { code: "no_system_object_root", ...hydrationAttachment }
        : hydration !== null
          ? nativeAotHydrationReason(hydration)
          : frozenRegion.ok
            ? null
            : { code: "ambiguous_frozen_object_region" };
  const reportLimitations = [
    "Only x64 PE32+ with RTR 9.1 is supported.",
    "No Ghidra database types, labels, functions, or bytes are created or changed.",
    "Names are address identities; original managed type names are unavailable.",
    "Metadata rows omitted to fit the NativeAOT report-byte budget are counted explicitly.",
    "Parser work, parser-owned typed buffers, NativeAOT report JSON, and MCP delivery have separate byte budgets; incomplete scans report examined and unexamined coverage.",
    ...(!frozenRegion.ok
      ? [
          `The RTR directory declares ${String(frozenRegion.error.ordinals.length)} FROZEN_OBJECT_REGION sections, so none was read.`,
        ]
      : frozen === undefined
        ? ["The RTR directory has no FROZEN_OBJECT_REGION section."]
        : []),
  ];
  const reportFacts = {
    format: "dotnet-nativeaot" as const,
    reason: discoveryReason,
    analysis_artifact_sha256: sha256,
    analysis_mode: "read-only-derived-overlay" as const,
    header_address: hex(directory.address),
    discovery: "signature-heuristic" as const,
    format_major: directory.major,
    format_minor: directory.minor,
    method_tables: discovered.tables.includedCount,
    output_budget_bytes: maximumSummaryBytes,
    derived_overlay:
      overlay === null
        ? null
        : {
            address: hex(overlay.base),
            size_bytes: overlay.sizeBytes,
            sha256: overlay.sha256,
          },
    derived_memory: null as null,
    diagnostics: hydration === null ? [] : [hydration.detail],
    limitations: reportLimitations,
  };
  const coverageFacts = {
    pointer_candidates_examined: discovered.pointerCount,
    pointer_slots_examined: discovered.pointerSlotsExamined,
    scan_bytes_examined: discovered.scanBytesExamined,
    scan_bytes_omitted: discovered.scanBytesOmitted,
    rtr_signature_scan_bytes_examined: directorySearch.scanBytesExamined,
    rtr_signature_scan_bytes_omitted: directorySearch.scanBytesOmitted,
    method_table_validation_items_examined:
      discovered.methodTableValidationItemsExamined,
    work_budget_units: budget.limits.workUnits,
    source_byte_budget_bytes: budget.limits.sourceBytes,
    working_memory_budget_bytes: budget.limits.workingMemoryBytes,
    method_tables_recovered: discovered.tables.includedCount,
    basis:
      overlay === null
        ? "raw-image-pointer-scan"
        : "raw-image-and-rehydrated-pointer-scan",
  } satisfies Omit<NativeAotReport["coverage"], "frozen_string_candidates">;
  const budgetSkeleton = {
    ...reportFacts,
    // A later truncated report replaces a null discovery reason. Reserve the
    // longest truncation code so that replacement still fits the same budget.
    reason:
      discoveryReason ??
      ({
        code: "truncated",
        truncation_reason: "working-memory-budget",
      } satisfies NativeAotReason),
    status: "complete",
    types: [],
    frozen_strings: [],
    truncated: true,
    types_omitted: discovered.tables.includedCount,
    frozen_strings_omitted: frozenCandidateBound,
    coverage: {
      ...coverageFacts,
      // Reserve the largest numeric encodings used by the eventual coverage
      // fields so the summary budget remains valid after frozen-region work.
      work_units_examined: budget.limits.workUnits,
      working_memory_bytes_peak: budget.limits.workingMemoryBytes,
      truncation_reason: "working-memory-budget",
      frozen_string_candidates: 0,
      frozen_scan_bytes_examined: frozenCandidateBound * 8,
      frozen_string_data_bytes_examined:
        frozen === undefined ? 0 : Number(frozen.end - frozen.start),
      frozen_scan_bytes_omitted: frozenCandidateBound * 8,
    },
  };
  let remainingSummaryBytes =
    maximumSummaryBytes - Buffer.byteLength(JSON.stringify(budgetSkeleton));
  if (remainingSummaryBytes < 0)
    throw reportBudgetRefusal("summary_exceeds_budget", maximumSummaryBytes);
  let typesOmitted = 0;
  discovered.tables.forEachIncluded((table) => {
    const addr = hex(table.address);
    const rowBytes =
      TYPE_ROW_FIXED_BYTES + addr.length + (types.length > 0 ? 1 : 0);
    if (rowBytes > remainingSummaryBytes) {
      typesOmitted++;
      return;
    }
    types.push({ address: addr, type: null });
    remainingSummaryBytes -= rowBytes;
  });
  if (frozen !== undefined) {
    let address = frozenFirstCandidate;
    while (address + 14n <= frozen.end) {
      if (!budget.consumeWork(8)) {
        frozenScanTruncated = true;
        break;
      }
      const table = readMappedPointer(image, address, budget);
      if (budget.truncationReason !== undefined) {
        frozenScanTruncated = true;
        break;
      }
      frozenScanBytesExamined += 8;
      const recovered = table !== null && isRecoveredStringTable(table);
      if (budget.truncationReason !== undefined) {
        frozenScanTruncated = true;
        break;
      }
      if (!recovered) {
        address += 8n;
        continue;
      }
      frozenCandidates++;
      const rawLength = image.readAt(address + 8n, 4, budget);
      if (budget.truncationReason !== undefined) {
        frozenScanTruncated = true;
        break;
      }
      const length =
        rawLength === null ? null : rawLength.reader.u32(rawLength.offset);
      if (length === null || address + 14n + BigInt(length) * 2n > frozen.end) {
        address += 8n;
        continue;
      }
      const stringBytes = length * 2 + 2;
      if (!budget.consumeWork(stringBytes)) {
        frozenScanTruncated = true;
        break;
      }
      // NativeAOT's System.String layout is the object header, 32-bit length,
      // UTF-16 payload, then the terminating code unit. The payload starts at
      // +12, not +16 (the latter silently shifts every decoded string by two
      // characters and includes adjacent object padding).
      const rawLoc = image.readAt(address + 12n, stringBytes, budget);
      if (budget.truncationReason !== undefined) {
        frozenScanTruncated = true;
        break;
      }
      frozenStringDataBytesExamined += stringBytes;
      if (
        rawLoc === null ||
        rawLoc.reader.u16(rawLoc.offset + length * 2) !== 0
      ) {
        address += 8n;
        continue;
      }
      if (!budget.consumeWork(stringBytes)) {
        frozenScanTruncated = true;
        break;
      }
      const addrHex = hex(address);
      const rowBytes =
        STRING_ROW_FIXED_BYTES +
        addrHex.length +
        jsonUtf16StringBytes(rawLoc.reader, length, rawLoc.offset) +
        (frozenStrings.length > 0 ? 1 : 0);
      if (rowBytes > remainingSummaryBytes) {
        frozenStringsOmitted++;
        address += 8n;
        continue;
      }
      const raw = rawLoc.reader.bytes.subarray(
        rawLoc.offset,
        rawLoc.offset + stringBytes,
      );
      const row: NativeAotString = {
        address: addrHex,
        value: raw.toString("utf16le", 0, length * 2),
      };
      frozenStrings.push(row);
      remainingSummaryBytes -= rowBytes;
      address += 8n;
    }
  }
  const truncated =
    discovered.truncated ||
    frozenScanTruncated ||
    typesOmitted > 0 ||
    frozenStringsOmitted > 0;
  const truncationReason =
    budget.truncationReason ??
    (typesOmitted > 0 || frozenStringsOmitted > 0
      ? "response-budget"
      : undefined);
  const partial = truncated || discoveryReason !== null;
  const publishedReason: NativeAotReason = discoveryReason ?? {
    code: "truncated",
    truncation_reason: truncationReason ?? "response-budget",
  };
  const examinedCoverage = {
    ...coverageFacts,
    work_units_examined: budget.workUnits,
    working_memory_bytes_peak: budget.workingMemoryBytesPeak,
    frozen_string_candidates: frozenCandidates,
    frozen_scan_bytes_examined: frozenScanBytesExamined,
    frozen_string_data_bytes_examined: frozenStringDataBytesExamined,
    frozen_scan_bytes_omitted: Math.max(
      0,
      frozenCandidateBound * 8 - frozenScanBytesExamined,
    ),
    ...(truncationReason === undefined
      ? {}
      : { truncation_reason: truncationReason }),
  };
  const summary: NativeAotReport = partial
    ? truncated
      ? {
          ...reportFacts,
          status: "partial",
          reason: publishedReason,
          types,
          frozen_strings: frozenStrings,
          truncated: true,
          types_omitted: typesOmitted,
          frozen_strings_omitted: frozenStringsOmitted,
          coverage: examinedCoverage,
        }
      : {
          ...reportFacts,
          status: "partial",
          reason: publishedReason,
          types,
          frozen_strings: frozenStrings,
          truncated: false,
          types_omitted: 0,
          frozen_strings_omitted: 0,
          coverage: examinedCoverage,
        }
    : {
        ...reportFacts,
        status: "complete",
        reason: null,
        types,
        frozen_strings: frozenStrings,
        truncated: false,
        types_omitted: 0,
        frozen_strings_omitted: 0,
        coverage: examinedCoverage,
      };
  if (Buffer.byteLength(JSON.stringify(summary)) > maximumSummaryBytes)
    throw reportBudgetRefusal(
      "summary_exceeded_after_serialization",
      maximumSummaryBytes,
    );
  const readTypeDetail = (
    address: string,
    maximumBytes: number,
  ): NativeMetadataRecovery | undefined => {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0)
      return undefined;
    if (!/^0x[0-9a-f]+$/iu.test(address)) return undefined;
    let tableAddress: bigint;
    try {
      tableAddress = BigInt(address);
    } catch {
      return undefined;
    }
    const detailBudget = new NativeAotParserBudget(limits);
    const tableIndex = discovered.tables.find(tableAddress, detailBudget);
    if (tableIndex < 0 || !discovered.tables.isIncluded(tableIndex))
      return undefined;
    const table = discovered.tables.at(tableIndex);
    if (table === undefined) return undefined;
    const metadata: NativeMetadataRecovery = {
      source: "read-only-derived-overlay",
      format: "dotnet-nativeaot",
      status: "complete",
      header_address: hex(directory.address),
      format_major: directory.major,
      format_minor: directory.minor,
      method_table_address: hex(table.address),
      name_origin: "generated",
      original_name: null,
      base_size_bytes: table.baseSize,
      related_type:
        table.related === 0n
          ? null
          : { address: hex(table.related), type: null },
      interfaces: [],
      virtual_slots: [],
      derived_memory: null,
      truncated: true,
      virtual_slots_omitted: table.slotsCount,
      interfaces_omitted: table.interfacesCount,
      output_budget_bytes: maximumBytes,
      diagnostics: [],
      limitations: [
        "Address-derived MethodTable identity; no original managed type name is available.",
        "This result is parser-derived and does not claim that Ghidra defined a database DataType.",
        "Slot and interface details are generated only for the requested address and bounded by the NativeAOT report-byte budget.",
      ],
    };
    let remaining = maximumBytes - Buffer.byteLength(JSON.stringify(metadata));
    if (remaining < 0) {
      metadata.diagnostics.push("detail_budget_too_small");
      metadata.truncated = true;
      metadata.status = "partial";
      return Buffer.byteLength(JSON.stringify(metadata)) <= maximumBytes
        ? metadata
        : undefined;
    }
    const maxInterfaceRowBytes = Buffer.byteLength(
      JSON.stringify({ address: `0x${"f".repeat(16)}`, type: null }),
    );
    let interfacesOmitted = 0;
    for (let index = 0; index < table.interfacesCount; index++) {
      if (remaining < maxInterfaceRowBytes) {
        interfacesOmitted += table.interfacesCount - index;
        break;
      }
      if (!detailBudget.consumeWork(NATIVE_AOT_POINTER_BYTES)) {
        interfacesOmitted += table.interfacesCount - index;
        break;
      }
      const row = {
        address: hex(table.address),
        type: null,
      };
      const value = readMappedPointer(
        image,
        methodTablePointerAddress(
          table,
          methodTableInterfaceOffset(table.slotsCount, index),
        ),
        detailBudget,
      );
      if (value === null) {
        interfacesOmitted += table.interfacesCount - index;
        break;
      }
      row.address = hex(value);
      const rowBytes =
        Buffer.byteLength(JSON.stringify(row)) +
        (metadata.interfaces.length > 0 ? 1 : 0);
      if (rowBytes > remaining) {
        interfacesOmitted++;
        continue;
      }
      metadata.interfaces.push(row);
      remaining -= rowBytes;
    }
    const maxVirtualSlotRowBytes = Buffer.byteLength(
      JSON.stringify({
        slot: 65535,
        slot_address: `0x${"f".repeat(16)}`,
        target_address: `0x${"f".repeat(16)}`,
        procedure_name: null,
        basis: "method-table-pointer",
      }),
    );
    let slotsOmitted = 0;
    for (let slot = 0; slot < table.slotsCount; slot++) {
      if (remaining < maxVirtualSlotRowBytes) {
        slotsOmitted += table.slotsCount - slot;
        break;
      }
      if (!detailBudget.consumeWork(NATIVE_AOT_POINTER_BYTES)) {
        slotsOmitted += table.slotsCount - slot;
        break;
      }
      const slotAddress = methodTablePointerAddress(
        table,
        methodTableSlotOffset(slot),
      );
      const value = readMappedPointer(image, slotAddress, detailBudget);
      if (value === null) {
        slotsOmitted += table.slotsCount - slot;
        break;
      }
      const row = {
        slot,
        slot_address: hex(slotAddress),
        target_address: value === 0n ? null : hex(value),
        procedure_name: null,
        basis: "method-table-pointer" as const,
      };
      const rowBytes =
        Buffer.byteLength(JSON.stringify(row)) +
        (metadata.virtual_slots.length > 0 ? 1 : 0);
      if (rowBytes > remaining) {
        slotsOmitted++;
        continue;
      }
      metadata.virtual_slots.push(row);
      remaining -= rowBytes;
    }
    const tableBytes = methodTableByteLength(
      table.slotsCount,
      table.interfacesCount,
    );
    // The descriptor size is independent of the source table size. Admit the
    // output representation first, then bound source hashing by parser work.
    const descriptor = {
      address: hex(table.address),
      size_bytes: tableBytes,
      sha256: "0".repeat(64),
      file_offset: null,
    };
    const withDescriptor = { ...metadata, derived_memory: descriptor };
    const descriptorBytes =
      Buffer.byteLength(JSON.stringify(withDescriptor)) -
      Buffer.byteLength(JSON.stringify(metadata));
    if (descriptorBytes <= remaining && detailBudget.consumeWork(tableBytes)) {
      const raw = image.read(table.address, tableBytes, detailBudget);
      if (raw !== null) {
        metadata.derived_memory = {
          ...descriptor,
          sha256: sha256Hex(raw),
        };
        remaining -= descriptorBytes;
      }
    }
    if (detailBudget.truncationReason !== undefined)
      metadata.diagnostics.push("method_table_hash_work_budget");
    metadata.interfaces_omitted = interfacesOmitted;
    metadata.virtual_slots_omitted = slotsOmitted;
    metadata.truncated =
      discovered.truncated ||
      hydration !== null ||
      detailBudget.truncationReason !== undefined ||
      interfacesOmitted > 0 ||
      slotsOmitted > 0 ||
      metadata.derived_memory === null;
    if (metadata.truncated) metadata.status = "partial";
    if (Buffer.byteLength(JSON.stringify(metadata)) > maximumBytes) {
      metadata.derived_memory = null;
      metadata.interfaces_omitted += metadata.interfaces.length;
      metadata.interfaces.length = 0;
      metadata.virtual_slots_omitted += metadata.virtual_slots.length;
      metadata.virtual_slots.length = 0;
      metadata.diagnostics.push("detail_rows_omitted");
      metadata.truncated = true;
      metadata.status = "partial";
      if (Buffer.byteLength(JSON.stringify(metadata)) > maximumBytes)
        return undefined;
    }
    return metadata;
  };
  return { summary, readTypeDetail };
};
