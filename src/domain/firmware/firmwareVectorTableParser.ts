import { readUint32At } from "../binaryContainer.js";
import { CoverageAccumulator } from "../coverageAccumulator.js";
import {
  decodeLimit,
  malformedInput,
  type ParseFailureError,
} from "../parseFailure.js";
import { err, ok, type Result } from "../result.js";
import { decodeRiscvVectorSlots } from "./firmwareRiscvTrapVector.js";
import type { SvdIrqLookupEntry } from "./firmwareSvdInterrupts.js";
import {
  DEFAULT_SVD_EXPANDED_CHARS,
  type ArmVectorEntry,
  type FirmwareVectorArchitecture,
  type FirmwareVectorTable,
  type SharedHandlerGroup,
} from "./firmwareVectorTable.js";

const hex32 = (value: number): string => `0x${(value >>> 0).toString(16)}`;

const ARMV6M_SYSTEM_EXCEPTIONS: Readonly<Record<number, string>> = {
  1: "Reset",
  2: "NMI",
  3: "HardFault",
  11: "SVCall",
  14: "PendSV",
  15: "SysTick",
};

const ARMV7M_SYSTEM_EXCEPTIONS: Readonly<Record<number, string>> = {
  ...ARMV6M_SYSTEM_EXCEPTIONS,
  4: "MemManage",
  5: "BusFault",
  6: "UsageFault",
  12: "DebugMonitor",
};

const ARMV8M_SYSTEM_EXCEPTIONS: Readonly<Record<number, string>> = {
  ...ARMV7M_SYSTEM_EXCEPTIONS,
  7: "SecureFault",
};

const armSystemExceptionsFor = (
  architecture: Exclude<FirmwareVectorArchitecture, "riscv">,
): Readonly<Record<number, string>> => {
  if (architecture === "armv6-m") return ARMV6M_SYSTEM_EXCEPTIONS;
  if (architecture === "armv7-m") return ARMV7M_SYSTEM_EXCEPTIONS;
  return ARMV8M_SYSTEM_EXCEPTIONS;
};

type ArmSlotIdentity = Pick<
  ArmVectorEntry,
  | "kind"
  | "exception_number"
  | "irq_number"
  | "name"
  | "name_basis"
  | "peripheral_name"
  | "ambiguous_profile_names"
>;

const svdEntryChars = (svd: SvdIrqLookupEntry): number =>
  svd.expandedChars ??
  (svd.primaryName !== null
    ? svd.primaryName.length + (svd.primaryPeripheral?.length ?? 0)
    : svd.ambiguousNames.reduce((sum, item) => sum + item.length, 0));

const decodeArmSlotIdentity = (
  slotIndex: number,
  architecture: Exclude<FirmwareVectorArchitecture, "riscv">,
  svdMap: ReadonlyMap<number, SvdIrqLookupEntry>,
): { readonly identity: ArmSlotIdentity; readonly svdChars: number } => {
  if (slotIndex === 0) {
    return {
      svdChars: 0,
      identity: {
        kind: "initial_stack_pointer",
        exception_number: null,
        irq_number: null,
        name: "InitialSP",
        name_basis: "architecture_manual",
        peripheral_name: null,
        ambiguous_profile_names: [],
      },
    };
  }
  if (slotIndex < 16) {
    const manualName = armSystemExceptionsFor(architecture)[slotIndex];
    if (manualName !== undefined) {
      return {
        svdChars: 0,
        identity: {
          kind: "system_exception",
          exception_number: slotIndex,
          irq_number: null,
          name: manualName,
          name_basis: "architecture_manual",
          peripheral_name: null,
          ambiguous_profile_names: [],
        },
      };
    }
    return {
      svdChars: 0,
      identity: {
        kind: "reserved",
        exception_number: slotIndex,
        irq_number: null,
        name: null,
        name_basis: "architecture_manual",
        peripheral_name: null,
        ambiguous_profile_names: [],
      },
    };
  }
  const irqNumber = slotIndex - 16;
  const svd = svdMap.get(irqNumber);
  if (svd !== undefined && svd.primaryName !== null) {
    return {
      svdChars: svdEntryChars(svd),
      identity: {
        kind: "external_irq",
        exception_number: slotIndex,
        irq_number: irqNumber,
        name: svd.primaryName,
        name_basis: "explicit_profile",
        peripheral_name: svd.primaryPeripheral,
        ambiguous_profile_names: [],
      },
    };
  }
  return {
    svdChars: svd === undefined ? 0 : svdEntryChars(svd),
    identity: {
      kind: "external_irq",
      exception_number: slotIndex,
      irq_number: irqNumber,
      name: null,
      name_basis: "observed_slot",
      peripheral_name: null,
      ambiguous_profile_names: svd ? [...svd.ambiguousNames] : [],
    },
  };
};

const decodeArmWordStatus = (
  kind: ArmVectorEntry["kind"],
  rawWord: number,
): Pick<ArmVectorEntry, "target_code_address" | "thumb_bit_set" | "status"> => {
  if (kind === "initial_stack_pointer") {
    return {
      target_code_address: null,
      thumb_bit_set: null,
      status: "stack_pointer",
    };
  }
  if (rawWord === 0) {
    return {
      target_code_address: null,
      thumb_bit_set: null,
      status: "null_entry",
    };
  }
  if (rawWord === 0xffffffff) {
    return {
      target_code_address: null,
      thumb_bit_set: null,
      status: "erased_entry",
    };
  }
  if (kind === "reserved") {
    return {
      target_code_address: null,
      thumb_bit_set: (rawWord & 1) === 1,
      status: "nonzero_reserved",
    };
  }
  const thumbBit = (rawWord & 1) === 1;
  if (!thumbBit) {
    return {
      target_code_address: hex32(rawWord),
      thumb_bit_set: false,
      status: "invalid_even_thumb_address",
    };
  }
  return {
    target_code_address: hex32((rawWord & ~1) >>> 0),
    thumb_bit_set: true,
    status: "active",
  };
};

const collectSharedHandlers = (
  targets: readonly { readonly slotIndex: number; readonly address: string }[],
): SharedHandlerGroup[] => {
  const byAddr = new Map<string, number[]>();
  for (const item of targets) {
    const list = byAddr.get(item.address);
    if (list === undefined) byAddr.set(item.address, [item.slotIndex]);
    else list.push(item.slotIndex);
  }
  return [...byAddr.entries()]
    .filter(([, slots]) => slots.length >= 2)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([target_code_address, slot_indices]) => ({
      target_code_address,
      slot_count: slot_indices.length,
      slot_indices,
      likely_default_stub: slot_indices.length >= 2,
    }));
};

const summarizeSvdBindings = (options: {
  readonly supplied: boolean;
  readonly activeIrqNumbers: readonly number[];
  readonly svdMap: ReadonlyMap<number, SvdIrqLookupEntry>;
}) => {
  const { supplied, activeIrqNumbers, svdMap } = options;
  if (!supplied) {
    return {
      supplied: false,
      mapped_irq_count: 0,
      ambiguous_irq_count: 0,
      unmapped_active_irq_count: activeIrqNumbers.length,
    };
  }
  // not-an-allowance: summary tallies over decoded vector entries
  let mapped = 0;
  // not-an-allowance: summary tallies over decoded vector entries
  let ambiguous = 0;
  // not-an-allowance: summary tallies over decoded vector entries
  let unmapped = 0;
  for (const irq of activeIrqNumbers) {
    const hit = svdMap.get(irq);
    if (hit === undefined) unmapped += 1;
    else if (hit.primaryName !== null) mapped += 1;
    else ambiguous += 1;
  }
  return {
    supplied: true,
    mapped_irq_count: mapped,
    ambiguous_irq_count: ambiguous,
    unmapped_active_irq_count: unmapped,
  };
};

export interface ParseFirmwareVectorTableOptions {
  readonly artifact: {
    readonly path: string;
    readonly sha256: string;
    readonly bytes: number;
  };
  readonly architecture: FirmwareVectorArchitecture;
  readonly baseAddressHex: string;
  readonly vectorTableOffset: number;
  readonly maxEntries: number;
  readonly tableBytes: Buffer;
  readonly svdSupplied: boolean;
  readonly svdMap: ReadonlyMap<number, SvdIrqLookupEntry>;
  readonly maxSvdExpandedChars?: number;
}

const decodeArmVectorEntries = (
  options: ParseFirmwareVectorTableOptions,
  architecture: Exclude<FirmwareVectorArchitecture, "riscv">,
  vtorAddress: number,
  entryCount: number,
  anomalies: string[],
): Result<
  {
    readonly entries: ArmVectorEntry[];
    readonly activeTargets: readonly {
      readonly slotIndex: number;
      readonly address: string;
    }[];
    readonly activeIrqs: readonly number[];
  },
  ParseFailureError<"limit">
> => {
  const maxSvdExpandedChars =
    options.maxSvdExpandedChars ?? DEFAULT_SVD_EXPANDED_CHARS;
  const entries: ArmVectorEntry[] = [];
  const activeTargets: { slotIndex: number; address: string }[] = [];
  const activeIrqs: number[] = [];
  let emittedSvdChars = 0;

  for (let i = 0; i < entryCount; i += 1) {
    const rel = i * 4;
    const rawWord = readUint32At(options.tableBytes, rel, true);
    const { identity, svdChars } = decodeArmSlotIdentity(
      i,
      architecture,
      options.svdMap,
    );
    if (svdChars > 0) {
      const nextEmitted = emittedSvdChars + svdChars;
      if (nextEmitted > maxSvdExpandedChars) {
        return err(
          decodeLimit(
            "cmsis-svd",
            `Expanded CMSIS-SVD slot metadata exceeded ${String(maxSvdExpandedChars)} characters`,
            {
              name: "max_svd_expanded_chars",
              maximum: maxSvdExpandedChars,
              required: nextEmitted,
            },
          ),
        );
      }
      emittedSvdChars = nextEmitted;
    }
    const wordStatus = decodeArmWordStatus(identity.kind, rawWord);
    const slotAddress = hex32((vtorAddress + rel) >>> 0);
    if (wordStatus.status === "invalid_even_thumb_address") {
      anomalies.push(
        `Slot ${String(i)} (${identity.name ?? `IRQ ${String(identity.irq_number)}`}) holds even address ${hex32(rawWord)} without Thumb bit 0 set.`,
      );
    } else if (wordStatus.status === "nonzero_reserved") {
      anomalies.push(
        `Architecturally reserved slot ${String(i)} is non-zero (${hex32(rawWord)}).`,
      );
    }
    if (
      wordStatus.status === "active" &&
      wordStatus.target_code_address !== null
    ) {
      activeTargets.push({
        slotIndex: i,
        address: wordStatus.target_code_address,
      });
      if (identity.irq_number !== null) activeIrqs.push(identity.irq_number);
    }
    entries.push({
      slot_index: i,
      file_offset: options.vectorTableOffset + rel,
      slot_address: slotAddress,
      ...identity,
      raw_word: hex32(rawWord),
      ...wordStatus,
    });
  }
  return ok({ entries, activeTargets, activeIrqs });
};

interface ReportContext {
  readonly options: ParseFirmwareVectorTableOptions;
  readonly baseAddress: number;
  readonly vtorUnsigned: number;
  readonly entryCount: number;
  readonly coverageStatus: "complete" | "partial";
  readonly limitations: string[];
  readonly anomalies: string[];
}

const buildRiscvVectorReport = (
  ctx: ReportContext,
): Result<FirmwareVectorTable, ParseFailureError<"limit">> => {
  const { options, baseAddress, vtorUnsigned, entryCount, limitations } = ctx;
  const availableFromOffset =
    options.artifact.bytes - options.vectorTableOffset;
  const examinedBytes = entryCount * 4;
  if ((vtorUnsigned & 0x3) !== 0) {
    ctx.anomalies.push(
      `Trap table address ${hex32(vtorUnsigned)} is not 4-byte aligned as required by RISC-V mtvec.BASE.`,
    );
  }
  limitations.push(
    "RISC-V mtvec Direct vs Vectored dispatch is controlled at runtime by mtvec.MODE; static slot decoding reports jump-stub structure without proving runtime CSR state.",
  );
  const decoded = decodeRiscvVectorSlots({
    tableBytes: options.tableBytes,
    vectorTableOffset: options.vectorTableOffset,
    vtorAddress: vtorUnsigned,
    entryCount,
    svdMap: options.svdMap,
    ...(options.maxSvdExpandedChars === undefined
      ? {}
      : { maxSvdExpandedChars: options.maxSvdExpandedChars }),
  });
  if (!decoded.ok) return decoded;
  const { slots, activeTargets, activeIrqs } = decoded.value;
  const jumpSlots = slots.filter(
    (s) =>
      s.encoding === "jal" ||
      s.encoding === "c_j" ||
      s.encoding === "auipc_jalr",
  ).length;
  const shape: FirmwareVectorTable["riscv_table_shape"] =
    jumpSlots >= 2
      ? "vectored_jumps"
      : slots[0]?.encoding !== "zero_or_erased" &&
          slots[0]?.encoding !== "unrecognized"
        ? "single_entry_or_inline"
        : "empty_or_unrecognized";

  return ok({
    artifact: options.artifact,
    architecture: options.architecture,
    base_address: hex32(baseAddress),
    vector_table_offset: options.vectorTableOffset,
    vector_table_address: hex32(vtorUnsigned),
    vtor_aligned: null,
    examined_entries: entryCount,
    table_file_range: {
      start: options.vectorTableOffset,
      end: options.vectorTableOffset + examinedBytes,
    },
    coverage: {
      status: ctx.coverageStatus,
      examined_bytes: examinedBytes,
      available_from_offset_bytes: availableFromOffset,
    },
    initial_stack_pointer: null,
    // RISC-V mtvec slot 0 is the synchronous exception / trap entry, not CPU reset.
    reset_code_address: null,
    trap_entry_address: slots[0]?.target_code_address ?? null,
    riscv_table_shape: shape,
    arm_entries: [],
    riscv_slots: slots,
    shared_handler_groups: collectSharedHandlers(activeTargets),
    svd_interrupts: summarizeSvdBindings({
      supplied: options.svdSupplied,
      activeIrqNumbers: activeIrqs,
      svdMap: options.svdMap,
    }),
    anomalies: ctx.anomalies,
    limitations,
  });
};

const buildArmVectorReport = (
  ctx: ReportContext,
  architecture: Exclude<FirmwareVectorArchitecture, "riscv">,
): Result<FirmwareVectorTable, ParseFailureError<"limit">> => {
  const { options, baseAddress, vtorUnsigned, entryCount, anomalies } = ctx;
  const availableFromOffset =
    options.artifact.bytes - options.vectorTableOffset;
  const examinedBytes = entryCount * 4;
  const vtorAligned = (vtorUnsigned & 0x7f) === 0;
  if (!vtorAligned) {
    anomalies.push(
      `Vector table address ${hex32(vtorUnsigned)} is not 128-byte aligned as required by ARM M-profile VTOR.`,
    );
  }
  if (!options.svdSupplied) {
    ctx.limitations.push(
      "No svd_xml profile was supplied; external IRQ slots (index >= 16) preserve observed handler addresses with name: null.",
    );
  }
  const decoded = decodeArmVectorEntries(
    options,
    architecture,
    vtorUnsigned,
    entryCount,
    anomalies,
  );
  if (!decoded.ok) return decoded;
  const { entries, activeTargets, activeIrqs } = decoded.value;
  const initialSp = entries[0]?.raw_word ?? null;
  const resetEntry = entries[1];
  if (
    initialSp !== null &&
    (initialSp === "0x0" || initialSp === "0xffffffff")
  ) {
    anomalies.push(
      `Slot 0 InitialSP is ${initialSp}, which is not an initialized SRAM stack pointer.`,
    );
  }
  return ok({
    artifact: options.artifact,
    architecture: options.architecture,
    base_address: hex32(baseAddress),
    vector_table_offset: options.vectorTableOffset,
    vector_table_address: hex32(vtorUnsigned),
    vtor_aligned: vtorAligned,
    examined_entries: entryCount,
    table_file_range: {
      start: options.vectorTableOffset,
      end: options.vectorTableOffset + examinedBytes,
    },
    coverage: {
      status: ctx.coverageStatus,
      examined_bytes: examinedBytes,
      available_from_offset_bytes: availableFromOffset,
    },
    initial_stack_pointer: initialSp,
    reset_code_address:
      resetEntry?.status === "active" ? resetEntry.target_code_address : null,
    trap_entry_address: null,
    riscv_table_shape: null,
    arm_entries: entries,
    riscv_slots: [],
    shared_handler_groups: collectSharedHandlers(activeTargets),
    svd_interrupts: summarizeSvdBindings({
      supplied: options.svdSupplied,
      activeIrqNumbers: activeIrqs,
      svdMap: options.svdMap,
    }),
    anomalies,
    limitations: ctx.limitations,
  });
};

/** Decode ARM M-profile or RISC-V interrupt/trap vector slots from `tableBytes`. */
export const parseFirmwareVectorTable = (
  options: ParseFirmwareVectorTableOptions,
): Result<
  FirmwareVectorTable,
  ParseFailureError<"malformed"> | ParseFailureError<"limit">
> => {
  const { artifact, architecture, vectorTableOffset, maxEntries, tableBytes } =
    options;
  const baseAddress =
    Number.parseInt(options.baseAddressHex.slice(2), 16) >>> 0;
  if (
    vectorTableOffset >= artifact.bytes ||
    artifact.bytes - vectorTableOffset < 8
  ) {
    return err(
      malformedInput(
        "firmware-vector-table",
        `vector_table_offset ${String(vectorTableOffset)} leaves fewer than 8 bytes in the ${String(artifact.bytes)}-byte image.`,
      ),
    );
  }
  const vtorUnsigned = baseAddress + vectorTableOffset;
  if (vtorUnsigned > 0xffffffff) {
    return err(
      malformedInput(
        "firmware-vector-table",
        "base_address + vector_table_offset overflows the 32-bit address space.",
      ),
    );
  }

  const availableFromOffset = artifact.bytes - vectorTableOffset;
  const entryCount = Math.min(maxEntries, Math.floor(tableBytes.length / 4));
  const examinedBytes = entryCount * 4;
  const anomalies: string[] = [];
  const limitations: string[] = [];
  const coverageAcc = new CoverageAccumulator().recordComplete();
  if (examinedBytes < availableFromOffset) {
    const omission = `Decoded ${String(entryCount)} slots (${String(examinedBytes)} bytes) up to max_entries; bytes past offset ${String(vectorTableOffset + examinedBytes)} were not interpreted as vector slots.`;
    coverageAcc.recordOmission(omission);
    limitations.push(omission);
  }

  const ctx: ReportContext = {
    options,
    baseAddress,
    vtorUnsigned,
    entryCount,
    coverageStatus: coverageAcc.finalizeKnown(),
    limitations,
    anomalies,
  };
  return architecture === "riscv"
    ? buildRiscvVectorReport(ctx)
    : buildArmVectorReport(ctx, architecture);
};
