import { readUint32At } from "../binaryContainer.js";
import { CoverageAccumulator } from "../coverageAccumulator.js";
import type { ArchitectureVariant } from "../architectureVariant.js";
import { malformedInput, type ParseFailureError } from "../parseFailure.js";
import { err, ok, type Result } from "../result.js";
import {
  ARM_MIN_VTOR_ALIGNMENT_BYTES,
  ARM_SYSTEM_EXCEPTIONS,
} from "./firmwareArmExceptions.js";
import { decodeRiscvVectorSlots } from "./firmwareRiscvTrapVector.js";
import type { SvdIrqLookupEntry } from "./firmwareSvdInterrupts.js";
import {
  hex32,
  type ArmVectorEntry,
  type FirmwareVectorArchitecture,
  type FirmwareVectorTable,
  type SharedHandlerGroup,
} from "./firmwareVectorTable.js";

/** InitialSP and Reset: the two words every ARM M-profile table begins with. */
const ARM_REQUIRED_LEADING_SLOTS = 2;
/** Number of architectural exception slots before external interrupt 0. */
const ARM_EXTERNAL_IRQ_BASE = 16;
const WORD_BYTES = 4;
/** Words left after the 32-bit address space ends. */
const ADDRESS_SPACE_END = 0x1_0000_0000;

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

const decodeArmSlotIdentity = (
  slotIndex: number,
  architecture: ArchitectureVariant,
  svdMap: ReadonlyMap<number, SvdIrqLookupEntry>,
): ArmSlotIdentity => {
  if (slotIndex === 0) {
    return {
      kind: "initial_stack_pointer",
      exception_number: null,
      irq_number: null,
      name: "InitialSP",
      name_basis: "architecture_manual",
      peripheral_name: null,
      ambiguous_profile_names: [],
    };
  }
  if (slotIndex < ARM_EXTERNAL_IRQ_BASE) {
    const manualName = ARM_SYSTEM_EXCEPTIONS[architecture][slotIndex];
    if (manualName !== undefined) {
      return {
        kind: "system_exception",
        exception_number: slotIndex,
        irq_number: null,
        name: manualName,
        name_basis: "architecture_manual",
        peripheral_name: null,
        ambiguous_profile_names: [],
      };
    }
    return {
      kind: "reserved",
      exception_number: slotIndex,
      irq_number: null,
      name: null,
      name_basis: "architecture_manual",
      peripheral_name: null,
      ambiguous_profile_names: [],
    };
  }
  const irqNumber = slotIndex - ARM_EXTERNAL_IRQ_BASE;
  const svd = svdMap.get(irqNumber);
  if (svd !== undefined && svd.primaryName !== null) {
    return {
      kind: "external_irq",
      exception_number: slotIndex,
      irq_number: irqNumber,
      name: svd.primaryName,
      name_basis: "explicit_profile",
      peripheral_name: svd.primaryPeripheral,
      ambiguous_profile_names: [],
    };
  }
  return {
    kind: "external_irq",
    exception_number: slotIndex,
    irq_number: irqNumber,
    name: null,
    name_basis: "observed_slot",
    peripheral_name: null,
    ambiguous_profile_names: svd ? [...svd.ambiguousNames] : [],
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
  const groups: SharedHandlerGroup[] = [];
  for (const [target_code_address, slot_indices] of byAddr) {
    if (slot_indices.length >= 2) {
      groups.push({
        target_code_address,
        slot_count: slot_indices.length,
        slot_indices,
      });
    }
  }
  groups.sort((a, b) => b.slot_count - a.slot_count);
  return groups;
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
  /** CMSIS-SVD declarations the profile parser could not bind. */
  readonly svdSkipped: readonly string[];
}

const decodeArmVectorEntries = (
  options: ParseFirmwareVectorTableOptions,
  architecture: ArchitectureVariant,
  vtorAddress: number,
  entryCount: number,
  anomalies: string[],
): {
  readonly entries: ArmVectorEntry[];
  readonly activeTargets: readonly {
    readonly slotIndex: number;
    readonly address: string;
  }[];
  readonly activeIrqs: readonly number[];
} => {
  const entries: ArmVectorEntry[] = [];
  const activeTargets: { slotIndex: number; address: string }[] = [];
  const activeIrqs: number[] = [];

  for (let i = 0; i < entryCount; i += 1) {
    const rel = i * WORD_BYTES;
    const rawWord = readUint32At(options.tableBytes, rel, true);
    const identity = decodeArmSlotIdentity(i, architecture, options.svdMap);
    const wordStatus = decodeArmWordStatus(identity.kind, rawWord);
    const slotAddress = hex32(vtorAddress + rel);
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
  return { entries, activeTargets, activeIrqs };
};

/** Minimum byte length required to decode the leading slots of `architecture`. */
export const minimumVectorTableBytes = (
  architecture: FirmwareVectorArchitecture,
): number =>
  (architecture === "riscv" ? 1 : ARM_REQUIRED_LEADING_SLOTS) * WORD_BYTES;

interface ReportContext {
  readonly options: ParseFirmwareVectorTableOptions;
  readonly baseAddress: number;
  readonly vtorUnsigned: number;
  readonly entryCount: number;
  readonly addressableEntries: number;
  readonly limitations: string[];
  readonly anomalies: string[];
}

const finalizeTableCoverage = (
  options: ParseFirmwareVectorTableOptions,
  entryCount: number,
  addressableEntries: number,
  consumedBytes: number,
  limitations: string[],
): FirmwareVectorTable["coverage"] => {
  const availableFromOffset =
    options.artifact.bytes - options.vectorTableOffset;
  const coverageAcc = new CoverageAccumulator().recordComplete();
  if (consumedBytes < availableFromOffset) {
    const afterConsumedOffset = options.vectorTableOffset + consumedBytes;
    const omission =
      entryCount === addressableEntries && entryCount < options.maxEntries
        ? `Decoded ${String(entryCount)} slots (${String(consumedBytes)} bytes); later slots would lie past the end of the 32-bit address space and were not interpreted.`
        : entryCount < options.maxEntries
          ? `Decoded ${String(entryCount)} slots (${String(consumedBytes)} bytes); ${String(availableFromOffset - consumedBytes)} trailing byte(s) past offset ${String(afterConsumedOffset)} do not form a complete 32-bit slot.`
          : `Decoded ${String(entryCount)} slots (${String(consumedBytes)} bytes) up to max_entries; bytes past offset ${String(afterConsumedOffset)} were not interpreted as vector slots.`;
    coverageAcc.recordOmission(omission);
    limitations.push(omission);
  }
  return {
    status: coverageAcc.finalizeKnown(),
    examined_bytes: consumedBytes,
    available_from_offset_bytes: availableFromOffset,
  };
};

const buildRiscvVectorReport = (ctx: ReportContext): FirmwareVectorTable => {
  const { options, baseAddress, vtorUnsigned, entryCount, limitations } = ctx;
  if ((vtorUnsigned & 0x3) !== 0) {
    ctx.anomalies.push(
      `Trap table address ${hex32(vtorUnsigned)} is not 4-byte aligned as required by RISC-V mtvec.BASE.`,
    );
  }
  const { slots, activeTargets, activeIrqs, consumedBytes } =
    decodeRiscvVectorSlots({
      tableBytes: options.tableBytes,
      vectorTableOffset: options.vectorTableOffset,
      vtorAddress: vtorUnsigned,
      entryCount,
      svdMap: options.svdMap,
    });
  const coverage = finalizeTableCoverage(
    options,
    entryCount,
    ctx.addressableEntries,
    consumedBytes,
    limitations,
  );
  limitations.push(
    "RISC-V mtvec Direct vs Vectored dispatch is controlled at runtime by mtvec.MODE; static slot decoding reports jump-stub structure without proving runtime CSR state. In vectored mode slot 0 also receives every synchronous exception.",
    "A CLIC table (mtvec.MODE 0b11 with mtvt) holds handler addresses, not jump instructions, so its slots decode as unrecognized.",
  );
  if (options.svdSupplied)
    limitations.push(
      "CMSIS-SVD interrupt values are bound to RISC-V slots as mcause codes 16 and up; a platform whose SVD numbers its interrupts differently binds the wrong names.",
    );
  let jumpSlots = 0;
  for (const slot of slots) {
    if (
      slot.encoding === "jal" ||
      slot.encoding === "c_j" ||
      slot.encoding === "auipc_jalr"
    ) {
      jumpSlots += 1;
    }
  }
  const shape: FirmwareVectorTable["riscv_table_shape"] =
    jumpSlots >= 2
      ? "vectored_jumps"
      : slots[0]?.encoding !== "zero_or_erased" &&
          slots[0]?.encoding !== "unrecognized"
        ? "single_entry_or_inline"
        : "empty_or_unrecognized";

  return {
    artifact: options.artifact,
    architecture: options.architecture,
    base_address: hex32(baseAddress),
    vector_table_offset: options.vectorTableOffset,
    vector_table_address: hex32(vtorUnsigned),
    vtor_aligned: null,
    examined_entries: entryCount,
    table_file_range: {
      start: options.vectorTableOffset,
      end: options.vectorTableOffset + consumedBytes,
    },
    coverage,
    initial_stack_pointer: null,
    // RISC-V mtvec slot 0 is the synchronous exception / trap entry, not CPU reset.
    reset_code_address: null,
    trap_entry_address: slots[0]?.target_code_address ?? null,
    riscv_table_shape: shape,
    arm_entries: [],
    active_arm_entry_count: 0,
    riscv_slots: slots,
    // Every slot with a jump target is an active target.
    recognized_riscv_slot_count: activeTargets.length,
    shared_handler_groups: collectSharedHandlers(activeTargets),
    svd_interrupts: summarizeSvdBindings({
      supplied: options.svdSupplied,
      activeIrqNumbers: activeIrqs,
      svdMap: options.svdMap,
    }),
    anomalies: ctx.anomalies,
    limitations,
  };
};

const buildArmVectorReport = (
  ctx: ReportContext,
  architecture: ArchitectureVariant,
): FirmwareVectorTable => {
  const { options, baseAddress, vtorUnsigned, entryCount, anomalies } = ctx;
  const consumedBytes = entryCount * WORD_BYTES;
  const coverage = finalizeTableCoverage(
    options,
    entryCount,
    ctx.addressableEntries,
    consumedBytes,
    ctx.limitations,
  );
  const minimumAlignment = ARM_MIN_VTOR_ALIGNMENT_BYTES[architecture];
  const vtorAligned =
    minimumAlignment === null ? null : vtorUnsigned % minimumAlignment === 0;
  if (vtorAligned === false) {
    anomalies.push(
      `Vector table address ${hex32(vtorUnsigned)} is not ${String(minimumAlignment)}-byte aligned, the minimum ${architecture} VTOR alignment.`,
    );
  }
  ctx.limitations.push(
    minimumAlignment === null
      ? "ARMv6-M VTOR is optional and its alignment is implementation-defined, so vtor_aligned is unknown; without VTOR the table must be at address 0."
      : "VTOR also requires alignment to the next power of two of the implemented exception count, which the image does not record; vtor_aligned checks only the 128-byte minimum.",
  );
  if (architecture === "armv8-m.main" || architecture === "armv8.1-m.main")
    ctx.limitations.push(
      "Slot 7 is named SecureFault, which exists only when the Security Extension is implemented; otherwise it is reserved.",
    );
  if (!options.svdSupplied) {
    ctx.limitations.push(
      "No svd_xml profile was supplied; external IRQ slots (index >= 16) preserve observed handler addresses with name: null.",
    );
  }
  const { entries, activeTargets, activeIrqs } = decodeArmVectorEntries(
    options,
    architecture,
    vtorUnsigned,
    entryCount,
    anomalies,
  );
  const initialSpWord =
    entryCount > 0 ? readUint32At(options.tableBytes, 0, true) : null;
  const resetEntry = entries[1];
  if (initialSpWord === 0 || initialSpWord === 0xffff_ffff) {
    anomalies.push(
      `Slot 0 InitialSP is ${hex32(initialSpWord)}, which is not an initialized stack pointer.`,
    );
  } else if (initialSpWord !== null && (initialSpWord & 0x3) !== 0) {
    // SP_main bits [1:0] are RAZ/WI, so the processor would start with a different stack pointer.
    anomalies.push(
      `Slot 0 InitialSP ${hex32(initialSpWord)} is not word-aligned; the processor ignores its low two bits.`,
    );
  }
  return {
    artifact: options.artifact,
    architecture: options.architecture,
    base_address: hex32(baseAddress),
    vector_table_offset: options.vectorTableOffset,
    vector_table_address: hex32(vtorUnsigned),
    vtor_aligned: vtorAligned,
    examined_entries: entryCount,
    table_file_range: {
      start: options.vectorTableOffset,
      end: options.vectorTableOffset + consumedBytes,
    },
    coverage,
    initial_stack_pointer: initialSpWord === null ? null : hex32(initialSpWord),
    reset_code_address:
      resetEntry?.status === "active" ? resetEntry.target_code_address : null,
    trap_entry_address: null,
    riscv_table_shape: null,
    arm_entries: entries,
    // Every active entry, and only those, is an active target.
    active_arm_entry_count: activeTargets.length,
    riscv_slots: [],
    recognized_riscv_slot_count: 0,
    shared_handler_groups: collectSharedHandlers(activeTargets),
    svd_interrupts: summarizeSvdBindings({
      supplied: options.svdSupplied,
      activeIrqNumbers: activeIrqs,
      svdMap: options.svdMap,
    }),
    anomalies,
    limitations: ctx.limitations,
  };
};

/** Decode ARM M-profile or RISC-V interrupt/trap vector slots from `tableBytes`. */
export const parseFirmwareVectorTable = (
  options: ParseFirmwareVectorTableOptions,
): Result<FirmwareVectorTable, ParseFailureError<"malformed">> => {
  const { artifact, architecture, vectorTableOffset, maxEntries, tableBytes } =
    options;
  const baseAddress =
    Number.parseInt(options.baseAddressHex.slice(2), 16) >>> 0;
  // An ARM table starts with the initial stack pointer and Reset; a RISC-V
  // Direct-mode table can be a single instruction.
  const minimumBytes = minimumVectorTableBytes(architecture);
  if (
    vectorTableOffset >= artifact.bytes ||
    artifact.bytes - vectorTableOffset < minimumBytes
  ) {
    return err(
      malformedInput(
        "firmware-vector-table",
        `vector_table_offset ${String(vectorTableOffset)} leaves fewer than ${String(minimumBytes)} bytes in the ${String(artifact.bytes)}-byte image.`,
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

  // Slots past the end of the 32-bit address space have no address; they are
  // not decoded rather than wrapped to low memory.
  const addressableEntries = Math.floor(
    (ADDRESS_SPACE_END - vtorUnsigned) / WORD_BYTES,
  );
  const entryCount = Math.min(
    maxEntries,
    Math.floor(tableBytes.length / WORD_BYTES),
    addressableEntries,
  );
  const ctx: ReportContext = {
    options,
    baseAddress,
    vtorUnsigned,
    entryCount,
    addressableEntries,
    limitations: [],
    anomalies: [...options.svdSkipped],
  };
  return ok(
    architecture === "riscv"
      ? buildRiscvVectorReport(ctx)
      : buildArmVectorReport(ctx, architecture),
  );
};
