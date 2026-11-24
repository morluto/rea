import {
  elfSectionHeaderWidth,
  readElfSectionHeader,
} from "./elfSectionHeader.js";
import {
  elfProgramHeaderWidth,
  readElfProgramHeader,
  PT_INTERP,
} from "./elfProgramHeader.js";
import { readElfRawTableDeclarations } from "./elfRawTableDeclarations.js";
import { readElfFixedHeader, type ElfFixedHeader } from "./elfFixedHeader.js";
import { err, ok, type Result } from "./result.js";

const SHN_LORESERVE = 0xff00;

export type ElfSectionRangePolicy = "strict" | "observe";

/** Optional/trailing section-table or section-payload truncation observed in `"observe"` mode. */
export type ElfSectionTruncation =
  | {
      readonly kind: "truncated_section_table";
      readonly offset: bigint;
      readonly declaredCount: bigint;
      readonly examinedCount: number;
      readonly fileSize: number;
      readonly reason: string;
    }
  | {
      readonly kind: "truncated_section_payload";
      readonly sectionIndex: number;
      readonly offset: bigint;
      readonly size: bigint;
      readonly fileSize: number;
      readonly reason: string;
    };

export interface ElfDeclaredRangeFacts {
  readonly hasInterpreter: boolean;
  readonly sectionTruncation?: ElfSectionTruncation;
}

/** Positional source requests; the caller owns the descriptor and cancellation. */
export interface ElfDeclarationRead {
  readonly offset: number;
  readonly size: number;
}

interface ElfDeclaredTable {
  readonly offset: bigint;
  readonly count: number;
  readonly width: number;
}

export interface ElfTableDeclarations {
  readonly header: ElfFixedHeader;
  readonly programs: ElfDeclaredTable;
  readonly sections: ElfDeclaredTable & { readonly namesIndex: number };
}

/** Zero-sized/inactive declarations own no file bytes. Arithmetic stays exact. */
const rangeFailure = (
  label: string,
  offset: bigint,
  size: bigint,
  fileSize: number,
): string | undefined =>
  size !== 0n && (offset > BigInt(fileSize) || size > BigInt(fileSize) - offset)
    ? `truncated ELF ${label}: declared file range ${String(offset)}..${String(offset + size)} exceeds the ${String(fileSize)}-byte file`
    : undefined;

interface RawTableDeclaration {
  readonly offset: bigint;
  readonly count: bigint;
  readonly width: number;
}

const tableStructureFailure = (
  kind: "program" | "section",
  table: RawTableDeclaration,
  header: ElfFixedHeader,
): string | undefined => {
  if (table.count === 0n) return undefined;
  const minimumWidth =
    kind === "program"
      ? elfProgramHeaderWidth(header.elfClass)
      : elfSectionHeaderWidth(header.elfClass);
  const label = `${kind} header table`;
  if (table.width < minimumWidth) return `invalid ELF ${label} entry width`;
  // e_ehsize can extend past the class minimum. Bytes below it are the header.
  if (table.offset < BigInt(header.headerSize))
    return `ELF ${label} overlaps the fixed header`;
  return undefined;
};

const tableRangeFailure = (
  kind: "program" | "section",
  table: RawTableDeclaration,
  fileSize: number,
): string | undefined =>
  table.count === 0n
    ? undefined
    : rangeFailure(
        `${kind} header table`,
        table.offset,
        table.count * BigInt(table.width),
        fileSize,
      );

const tableFailure = (
  kind: "program" | "section",
  table: RawTableDeclaration,
  header: ElfFixedHeader,
  fileSize: number,
): string | undefined =>
  tableStructureFailure(kind, table, header) ??
  tableRangeFailure(kind, table, fileSize);

interface TableCounts {
  programCount: bigint;
  sectionCount: bigint;
  namesIndex: number;
}

const extendedCounts = (
  first: Buffer,
  header: ElfFixedHeader,
  initial: TableCounts,
): Result<TableCounts, string> => {
  if (first.length !== elfSectionHeaderWidth(header.elfClass))
    return err("truncated ELF extended section-zero header");
  const parsed = readElfSectionHeader(
    first,
    header.elfClass,
    header.byteOrder === "little",
  );
  if (!parsed.ok) return err(parsed.error.message);
  const zero = parsed.value;
  if (zero.type !== 0)
    return err(
      "ELF extended numbering requires an inactive SHT_NULL section zero",
    );
  const counts = { ...initial };
  if (counts.sectionCount === 0n) {
    counts.sectionCount = zero.size;
    if (counts.sectionCount < BigInt(SHN_LORESERVE))
      return err("invalid ELF extended section count");
  }
  if (counts.namesIndex === 0xffff) {
    counts.namesIndex = zero.link;
    if (counts.namesIndex < SHN_LORESERVE)
      return err("invalid ELF extended section-name index");
  }
  if (counts.programCount === 0xffffn) {
    counts.programCount = BigInt(zero.info);
    if (counts.programCount < 0xffffn)
      return err("invalid ELF extended program count");
  }
  return ok(counts);
};

/** Admit the fixed section table declarations before inspecting any rows. */
export const validateElfSectionTableFields = (tables: {
  readonly programs: { readonly count: number };
  readonly sections: {
    readonly offset: bigint;
    readonly count: number;
    readonly namesIndex: number;
  };
}): Result<null, string> => {
  if (tables.sections.count >= SHN_LORESERVE)
    return err("ELF e_shnum uses a reserved direct section count");
  if (
    tables.sections.offset === 0n &&
    (tables.sections.count !== 0 ||
      tables.sections.namesIndex !== 0 ||
      tables.programs.count === 0xffff)
  )
    return err("ELF section table is missing");
  return ok(null);
};

interface TableDeclarationsWithObservation {
  readonly declarations: ElfTableDeclarations;
  readonly sectionTruncation?: ElfSectionTruncation;
}

function* readElfTableDeclarationsWithPolicy(
  bytes: Buffer,
  fileSize: number,
  sectionRanges: ElfSectionRangePolicy,
): Generator<
  ElfDeclarationRead,
  Result<TableDeclarationsWithObservation, string>,
  Buffer
> {
  const fixed = readElfFixedHeader(bytes, fileSize);
  if (!fixed.ok) return fixed;
  const header = fixed.value;
  const raw = readElfRawTableDeclarations(bytes, header);
  if (!raw.ok) return err(raw.error.message);
  const { programs, sections } = raw.value;
  const programOffset = programs.offset;
  const sectionOffset = sections.offset;
  const programWidth = programs.width;
  const sectionWidth = sections.width;
  let programCount = BigInt(programs.count);
  let sectionCount = BigInt(sections.count);
  let namesIndex = sections.namesIndex;
  const sectionTable = validateElfSectionTableFields(raw.value);
  if (!sectionTable.ok) return sectionTable;
  if (
    sectionOffset !== 0n &&
    (sectionCount === 0n || namesIndex === 0xffff || programCount === 0xffffn)
  ) {
    const failure = tableFailure(
      "section",
      { offset: sectionOffset, count: 1n, width: sectionWidth },
      header,
      fileSize,
    );
    if (failure !== undefined) return err(failure);
    const first = yield {
      offset: Number(sectionOffset),
      size: elfSectionHeaderWidth(header.elfClass),
    };
    const counts = extendedCounts(first, header, {
      programCount,
      sectionCount,
      namesIndex,
    });
    if (!counts.ok) return counts;
    ({ programCount, sectionCount, namesIndex } = counts.value);
  }
  const programFailure = tableFailure(
    "program",
    { offset: programOffset, count: programCount, width: programWidth },
    header,
    fileSize,
  );
  if (programFailure !== undefined) return err(programFailure);
  const sectionStructureFailure = tableStructureFailure(
    "section",
    { offset: sectionOffset, count: sectionCount, width: sectionWidth },
    header,
  );
  if (sectionStructureFailure !== undefined)
    return err(sectionStructureFailure);
  if (sectionCount !== 0n && BigInt(namesIndex) >= sectionCount)
    return err(
      "ELF section-name index lies outside the declared section table",
    );
  const sectionRangeError = tableRangeFailure(
    "section",
    { offset: sectionOffset, count: sectionCount, width: sectionWidth },
    fileSize,
  );
  let sectionTruncation: ElfSectionTruncation | undefined;
  let examinedSectionCount = sectionCount;
  if (sectionRangeError !== undefined) {
    if (sectionRanges === "strict") return err(sectionRangeError);
    const availableBytes =
      sectionOffset >= BigInt(fileSize) ? 0n : BigInt(fileSize) - sectionOffset;
    const examinedCount = Number(availableBytes / BigInt(sectionWidth));
    examinedSectionCount = BigInt(examinedCount);
    sectionTruncation = {
      kind: "truncated_section_table",
      offset: sectionOffset,
      declaredCount: sectionCount,
      examinedCount,
      fileSize,
      reason: sectionRangeError,
    };
  }
  // A validated table (or the captured prefix of one) fits the host-sized file,
  // so its examined record count is exact.
  return ok({
    declarations: {
      header,
      programs: {
        offset: programOffset,
        count: Number(programCount),
        width: programWidth,
      },
      sections: {
        offset: sectionOffset,
        count: Number(examinedSectionCount),
        width: sectionWidth,
        namesIndex,
      },
    },
    ...(sectionTruncation === undefined ? {} : { sectionTruncation }),
  });
}

/** Canonical table declarations, including extended counts in inactive section zero. */
export function* readElfTableDeclarations(
  bytes: Buffer,
  fileSize: number,
): Generator<ElfDeclarationRead, Result<ElfTableDeclarations, string>, Buffer> {
  const result = yield* readElfTableDeclarationsWithPolicy(
    bytes,
    fileSize,
    "strict",
  );
  return result.ok ? ok(result.value.declarations) : result;
}

/** Examine only header records; referenced payloads are range-checked, never copied. */
function* inspectTableRanges(
  kind: "program" | "section",
  table: ElfDeclaredTable,
  header: ElfFixedHeader,
  fileSize: number,
  sectionRanges: ElfSectionRangePolicy = "strict",
): Generator<
  ElfDeclarationRead,
  Result<
    {
      readonly hasInterpreter: boolean;
      readonly sectionTruncation?: ElfSectionTruncation;
    },
    string
  >,
  Buffer
> {
  let hasInterpreter = false;
  const perRead = Math.max(1, Math.floor((64 * 1024) / table.width));
  for (let index = 0; index < table.count; index += perRead) {
    const count = Math.min(perRead, table.count - index);
    const size = count * table.width;
    const bytes = yield {
      offset: Number(table.offset) + index * table.width,
      size,
    };
    if (bytes.length !== size) return err(`truncated ELF ${kind} header table`);
    for (let item = 0; item < count; item++) {
      const at = item * table.width;
      const parsed =
        kind === "program"
          ? readElfProgramHeader(
              bytes.subarray(at, at + table.width),
              header.elfClass,
              header.byteOrder === "little",
            )
          : readElfSectionHeader(
              bytes.subarray(at, at + table.width),
              header.elfClass,
              header.byteOrder === "little",
            );
      if (!parsed.ok) return err(parsed.error.message);
      const facts = parsed.value;
      if (facts.type === 0 || (kind === "section" && facts.type === 8))
        continue;
      const offset = facts.offset;
      const length = "fileSize" in facts ? facts.fileSize : facts.size;
      const failure = rangeFailure(
        `${kind} ${String(index + item)}`,
        offset,
        length,
        fileSize,
      );
      if (failure !== undefined) {
        if (kind === "section" && sectionRanges === "observe")
          return ok({
            hasInterpreter: false,
            sectionTruncation: {
              kind: "truncated_section_payload",
              sectionIndex: index + item,
              offset,
              size: length,
              fileSize,
              reason: failure,
            },
          });
        return err(failure);
      }
      if (kind === "program" && facts.type === PT_INTERP) {
        // The declared range must fit at least one pathname byte and its NUL.
        if (length < 2n) return err("invalid ELF PT_INTERP file size");
        hasInterpreter = true;
      }
    }
  }
  return ok({ hasInterpreter });
}

/**
 * Physical extent admission, independent of section names, CPU lanes and decoder budgets.
 * Under `sectionRanges: "strict"` (default), any out-of-file section table or payload fails
 * closed. Under `sectionRanges: "observe"`, fatal framing and program-header checks still fail
 * closed while trailing section-table/payload truncation is surfaced as `sectionTruncation`.
 */
export function* validateElfDeclaredRanges(
  prefix: Buffer,
  fileSize: number,
  options?: { readonly sectionRanges?: ElfSectionRangePolicy },
): Generator<
  ElfDeclarationRead,
  Result<ElfDeclaredRangeFacts, string>,
  Buffer
> {
  const sectionRanges = options?.sectionRanges ?? "strict";
  const resolved = yield* readElfTableDeclarationsWithPolicy(
    prefix,
    fileSize,
    sectionRanges,
  );
  if (!resolved.ok) return resolved;
  const { header, programs, sections } = resolved.value.declarations;
  let hasInterpreter = false;
  let sectionTruncation = resolved.value.sectionTruncation;
  if (programs.count > 0) {
    const inspected = yield* inspectTableRanges(
      "program",
      programs,
      header,
      fileSize,
      "strict",
    );
    if (!inspected.ok) return inspected;
    hasInterpreter = inspected.value.hasInterpreter;
  }
  // Inspect every complete captured section header even when the table is
  // truncated so an out-of-file section payload still overrides table-only
  // truncation and prevents admission.
  if (sections.count > 0) {
    const inspected = yield* inspectTableRanges(
      "section",
      sections,
      header,
      fileSize,
      sectionRanges,
    );
    if (!inspected.ok) return inspected;
    if (inspected.value.sectionTruncation !== undefined)
      sectionTruncation = inspected.value.sectionTruncation;
  }
  return ok({
    hasInterpreter,
    ...(sectionTruncation === undefined ? {} : { sectionTruncation }),
  });
}
