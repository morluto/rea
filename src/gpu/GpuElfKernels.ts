import { readCudaTarget } from "./CudaTarget.js";
import {
  type AmdGpuAbi,
  type AmdGpuTargetIdentity,
  readAmdGpuElfAbi,
  readAmdGpuElfProcessor,
  readAmdGpuNoteTarget,
} from "./AmdGpuTarget.js";
import type { GpuPayloadTarget } from "./GpuObject.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  ELF_NOTE_HEADER_BYTES,
  elfNoteSectionStorage,
  readElfNoteFrame,
} from "../domain/native/elfNoteLayout.js";
import {
  CudaMetadataBudget,
  readCudaInfo,
  readCudaParameters,
} from "./CudaInfo.js";
import type { GpuKernel, GpuLocation } from "../domain/gpu/gpuCodeObjects.js";
import { AmdPalMetadataReader, type AmdPalNotes } from "./AmdGpuPalMetadata.js";
import type { ZstandardFramePause } from "../domain/compression/zstandardExactFrame.js";
import {
  BinaryReader,
  BinaryFormatFailure,
  BinaryResourceFailure,
} from "../domain/binaryContainer.js";
import {
  readElfSectionDirectory,
  type NativeSection,
  type NativeSectionDirectory,
} from "../domain/native/nativeSectionDirectory.js";
import { readElfStringBytes } from "../domain/native/elfStringBytes.js";
import { decodeElfExportName } from "../domain/native/nativeExports.js";
import { elfSymbolSize, readElfSymbol } from "../domain/elfSymbol.js";
import {
  ELF_SHN_XINDEX,
  ElfSymbolSectionIndexTables,
  readElfSymbolSectionReference,
} from "../domain/elfSymbolSectionIndex.js";
import {
  gpuCount,
  readGpuNativeDirectory,
  rejectGpu,
  type GpuSource,
} from "./GpuSource.js";
import {
  DEFAULT_GPU_METADATA_BYTES,
  GPU_METADATA_BYTES_LIMIT,
  formatGpuByteBudget,
  type GpuCodeObjectsBudgets,
} from "../domain/gpu/gpuCodeObjectsBudgets.js";
import {
  AmdMetadataValueBudget,
  amdCount,
  amdRecord,
  amdString,
  readAmdMetadata,
} from "./AmdGpuMetadata.js";
const sectionBytes = (
  source: GpuSource,
  section: NativeSection,
  budget?: CudaMetadataBudget,
): Promise<Buffer> => {
  if (!section.file_backed || section.compressed)
    rejectGpu("GPU metadata section has no supported uncompressed file range");
  budget?.read(gpuCount(section.size));
  return source.read(gpuCount(section.offset), gpuCount(section.size));
};
const site = (
  source: GpuSource,
  section: NativeSection,
  offset = 0,
  size = gpuCount(section.size),
): GpuLocation => ({
  container_id: source.containerId,
  offset: gpuCount(section.offset) + offset,
  size,
  section_index: section.index,
  section_name: section.name,
});
const blankKernel = (
  source: GpuSource,
  id: string,
  name: string,
  location: GpuLocation,
): GpuKernel => ({
  id: `${source.containerId!}/${id}`,
  object_id: source.containerId!,
  representation: "cuda-elf-metadata",
  name,
  symbol: name,
  parameter_count: null,
  parameter_bytes: null,
  parameters: [],
  registers: {
    physical: null,
    sgpr: null,
    vgpr: null,
    agpr: null,
    virtual: [],
  },
  shared_bytes: null,
  private_bytes: null,
  location,
  sources: { parameters: null, registers: null, shared: null, private: null },
  limitations: [],
});
/** CUDA symbol names are ELF bytes; keep valid UTF-8 and disclose a Latin-1 fallback. */
const cudaSymbolKernel = (
  source: GpuSource,
  id: string,
  nameBytes: Buffer,
  location: GpuLocation,
): GpuKernel => {
  const decoded = decodeElfExportName(nameBytes);
  const kernel = blankKernel(source, id, decoded.name, location);
  if (!decoded.name_utf8_decodable)
    kernel.limitations.push(
      `CUDA kernel symbol name is not valid UTF-8; name shows its bytes as Latin-1 (base64 ${decoded.name_bytes_base64!})`,
    );
  return kernel;
};
export const readGpuElfKernels = async (
  source: GpuSource,
  kind: "cubin" | "amdgpu",
  onKernel: (kernel: GpuKernel) => void,
  pause: ZstandardFramePause,
  preparedAmd?: AmdElfMetadata,
  onTarget?: (target: GpuPayloadTarget) => void,
  budgets?: GpuCodeObjectsBudgets,
): Promise<{
  limitations: string[];
  coverage: "complete" | "partial";
}> => {
  if (kind === "amdgpu" && preparedAmd !== undefined)
    return amdKernels(source, preparedAmd, onKernel, onTarget);
  const directory = await readGpuNativeDirectory(
    source,
    readElfSectionDirectory(
      source.size,
      budgets?.maxStructureBytes === undefined
        ? undefined
        : { structureBytes: budgets.maxStructureBytes },
    ),
    pause,
    budgets?.maxStructureBytes,
  );
  if (directory.machine !== (kind === "cubin" ? 190 : 224))
    rejectGpu("GPU entry kind disagrees with ELF machine");
  if (kind === "cubin") {
    onTarget?.(readCudaTarget(source, directory));
    const coverage = await cudaKernels(source, directory, onKernel, budgets);
    return {
      coverage,
      limitations: [
        ...(directory.sections.some((s) => s.name === null)
          ? [
              "Some ELF section names are unknown; named metadata coverage is partial",
            ]
          : []),
        ...(directory.sections.some((s) => s.type === 2 || s.type === 11)
          ? []
          : [
              "No CUBIN symbol table was available; kernel declaration coverage is unknown",
            ]),
      ],
    };
  }
  const metadata = await readAmdElfMetadata(source, directory, budgets);
  const parsed = amdKernels(
    source,
    metadata.ok ? metadata.value : metadata.error.partial,
    onKernel,
    onTarget,
  );
  if (!metadata.ok) throw metadata.error.cause;
  return parsed;
};
const indexCudaMetadata = async (
  source: GpuSource,
  directory: NativeSectionDirectory,
  budgets?: GpuCodeObjectsBudgets,
) => {
  const infosByText = new Map<number, NativeSection[]>(),
    sharedByText = new Map<number, NativeSection[]>();
  const registerFacts = new Map<string, Map<number, GpuLocation>>();
  const budget = new CudaMetadataBudget(budgets),
    seenMetadata = new Set<string>();
  for (const row of directory.sections) {
    const map =
      row.type === 8 && row.name?.startsWith(".nv.shared.") === true
        ? sharedByText
        : row.type === 0x70000000 && row.name?.startsWith(".nv.info.") === true
          ? infosByText
          : undefined;
    const global = row.type === 0x70000000 && row.name === ".nv.info";
    if (map === undefined && !global) continue;
    // The same scoped byte declaration may be aliased by many ELF headers.
    const key = `${row.type}:${row.flags}:${row.name}:${row.offset}:${row.size}:${row.link}:${row.info}`;
    if (seenMetadata.has(key)) continue;
    budget.retain(key);
    seenMetadata.add(key);
    if (map !== undefined) {
      budget.retain({ text: row.info, section: row.index });
      const values = map.get(row.info) ?? [];
      values.push(row);
      map.set(row.info, values);
    }
    if (global) {
      const infoBytes = await sectionBytes(source, row, budget);
      const infoReader = new BinaryReader(infoBytes, directory.little, "elf");
      for (const record of readCudaInfo(infoBytes, directory.little, budget)) {
        if (record.format !== 4 || record.attribute !== 0x2f) continue;
        if (record.data.length !== 8)
          rejectGpu("CUDA register count record has an unsupported extent");
        const base = record.offset + 4,
          key = `${row.link}:${infoReader.u32(base)}`;
        const values = registerFacts.get(key) ?? new Map<number, GpuLocation>();
        const value = infoReader.u32(base + 4);
        if (!values.has(value)) {
          const location = site(source, row, record.offset, record.length);
          budget.retain({ symbol: key, value, location });
          values.set(value, location);
          registerFacts.set(key, values);
        }
      }
    }
  }
  const allNamesKnown = directory.sections.every((row) => row.name !== null);
  return {
    source,
    directory,
    infosByText,
    sharedByText,
    registerFacts,
    allNamesKnown,
    budget,
    parameters: new Map<number, ReturnType<typeof readCudaParameters>>(),
  };
};
type CudaMetadataIndex = Awaited<ReturnType<typeof indexCudaMetadata>>;

const attachCudaResources = (
  kernel: GpuKernel,
  text: NativeSection,
  index: CudaMetadataIndex,
  symbolKey: string,
): "complete" | "partial" => {
  const { source, directory } = index;
  const registerRows = index.registerFacts.get(symbolKey);
  const registerValues = new Set(registerRows?.keys());
  const sectionRegisters = text.info >>> 24;
  const singleInfoRegister =
    registerValues.size === 1 ? [...registerValues][0]! : null;
  const registerConflict =
    registerValues.size > 1 ||
    (singleInfoRegister !== null &&
      sectionRegisters !== 0 &&
      singleInfoRegister !== sectionRegisters);
  if (registerConflict) {
    kernel.limitations.push(
      "Conflicting CUDA register declarations; physical count remains unknown",
    );
  } else if (singleInfoRegister !== null) {
    kernel.registers.physical = singleInfoRegister;
    kernel.sources.registers = registerRows!.values().next().value!;
  } else if (sectionRegisters !== 0) {
    kernel.registers.physical = sectionRegisters;
    kernel.sources.registers = {
      container_id: source.containerId,
      offset: text.header_offset,
      size: directory.bits === 64 ? 64 : 40,
      section_index: text.index,
      section_name: text.name,
    };
  }
  const shared = index.sharedByText.get(text.index) ?? [];
  const sharedConflict = shared.length > 1;
  kernel.shared_bytes =
    shared.length === 1
      ? gpuCount(shared[0]!.size)
      : shared.length === 0 && index.allNamesKnown
        ? 0
        : null;
  if (shared.length === 1)
    kernel.sources.shared = {
      container_id: source.containerId,
      offset: shared[0]!.header_offset,
      size: directory.bits === 64 ? 64 : 40,
      section_index: shared[0]!.index,
      section_name: shared[0]!.name,
    };
  if (sharedConflict) {
    kernel.limitations.push(
      "Conflicting CUDA shared memory declarations; shared byte count remains unknown",
    );
  }
  // With an unreadable section name a shared section cannot be ruled out, so the count is
  // unknown for the same reason the inventory is partial: the kernel says which fact it
  // could not establish instead of leaving a bare null.
  const sharedUnknown = shared.length === 0 && !index.allNamesKnown;
  if (sharedUnknown) {
    kernel.limitations.push(
      "CUDA section names are not all known, so a shared memory section cannot be ruled out; shared byte count remains unknown",
    );
  }
  return registerConflict || sharedConflict || sharedUnknown
    ? "partial"
    : "complete";
};

const cudaKernels = async (
  source: GpuSource,
  directory: NativeSectionDirectory,
  onKernel: (kernel: GpuKernel) => void,
  budgets?: GpuCodeObjectsBudgets,
): Promise<"complete" | "partial"> => {
  const index = await indexCudaMetadata(source, directory, budgets);
  const extendedTables = new ElfSymbolSectionIndexTables(directory.sections);
  let complete = index.allNamesKnown;
  let symbolTables = 0;
  for (const section of directory.sections) {
    if (section.type !== 2 && section.type !== 11) continue;
    symbolTables++;
    const width = gpuCount(section.entry_size),
      minimum = elfSymbolSize(directory.bits);
    if (width < minimum || section.size % BigInt(width) !== 0n)
      rejectGpu("CUBIN symbol table width is invalid");
    const namesSection = directory.sections[section.link];
    if (namesSection === undefined || namesSection.type !== 3)
      rejectGpu("CUBIN symbol string table is invalid");
    const names = await sectionBytes(source, namesSection!, index.budget);
    const bytes = await sectionBytes(source, section, index.budget);
    const symbolCount = bytes.length / width;
    let extendedIndices: Buffer | null = null;
    for (let offset = 0; offset < bytes.length; offset += width) {
      index.budget.visit();
      const parsedSymbol = readElfSymbol(
        bytes.subarray(offset, offset + width),
        directory.bits,
        directory.little,
      );
      if (!parsedSymbol.ok)
        throw new BinaryFormatFailure(
          parsedSymbol.error.kind,
          parsedSymbol.error.message,
        );
      const symbol = parsedSymbol.value;
      // STO_CUDA_ENTRY distinguishes launchable kernels from ordinary device functions.
      if (symbol.type !== 2 || (symbol.other & 0x10) === 0) continue;
      const sectionIndex = symbol.section_index;
      if (sectionIndex === ELF_SHN_XINDEX) {
        if (extendedIndices === null) {
          const extended = extendedTables.tableFor(
            section.index,
            BigInt(symbolCount),
          );
          if (!extended.ok) return rejectGpu(`CUBIN ${extended.error.message}`);
          extendedIndices = await sectionBytes(
            source,
            extended.value,
            index.budget,
          );
        }
      }
      const resolved = readElfSymbolSectionReference(
        sectionIndex,
        offset / width,
        directory.sections.length,
        directory.little,
        extendedIndices ?? undefined,
      );
      if (!resolved.ok) return rejectGpu(`CUBIN ${resolved.error.message}`);
      const text =
        resolved.value.kind === "section"
          ? directory.sections[resolved.value.index]
          : undefined;
      if (text === undefined || text.type !== 1 || (text.flags & 4n) === 0n)
        rejectGpu("CUBIN kernel symbol has no executable section");
      const kernel = cudaSymbolKernel(
        source,
        `sym:${section.index}:${offset / width}`,
        readElfStringBytes(names, symbol.name_offset),
        site(source, section, offset, width),
      );
      if (
        attachCudaResources(
          kernel,
          text!,
          index,
          `${section.index}:${offset / width}`,
        ) === "partial"
      )
        complete = false;
      const infos = index.infosByText.get(text!.index) ?? [];
      if (infos.length === 1) {
        const info = infos[0]!;
        let decoded = index.parameters.get(info.index);
        if (decoded === undefined) {
          decoded = readCudaParameters(
            await sectionBytes(source, info, index.budget),
            directory.little,
            index.budget,
          );
          index.budget.retain({ parameter_section: info.index });
          index.parameters.set(info.index, decoded);
        }
        if (decoded.limitations.length > 0) complete = false;
        kernel.sources.parameters = site(source, infos[0]!);
        kernel.parameter_bytes = decoded.parameter_bytes;
        kernel.parameter_count = decoded.parameter_count;
        kernel.parameters = decoded.parameters;
        kernel.limitations.push(...decoded.limitations);
      } else {
        complete = false;
        kernel.limitations.push(
          "Exactly one matching CUDA nv.info parameter section was not available",
        );
      }
      kernel.limitations.push(
        "CUDA metadata fields are declarations from ELF symbols, section headers and nv.info; SASS and runtime behavior were not inspected",
      );
      onKernel(kernel);
    }
  }
  return complete && symbolTables > 0 ? "complete" : "partial";
};
export interface AmdElfMetadata {
  readonly target: string | null;
  readonly targetIdentity: AmdGpuTargetIdentity | null;
  readonly targetMetadata: import("../domain/gpu/gpuCodeObjects.js").GpuObject["amd_target_metadata"];
  readonly limitations: string[];
  /** PAL-ABI pipeline declarations; null unless the ELF declares the PAL ABI. */
  readonly pal: AmdPalNotes | null;
  /** HSA-ABI kernel declaration arrays, retained for selected projection. */
  readonly notes: {
    section: NativeSection;
    noteOffset: number;
    desc: number;
    size: number;
    kernels: unknown[];
  }[];
}
/** HSA notes declare an optional target and the kernel declaration array. */
const readHsaNote = (metadata: Record<string, unknown>) => {
  const target = amdString(metadata["amdhsa.target"]);
  const kernels = metadata["amdhsa.kernels"];
  return {
    target,
    target_state: !Object.hasOwn(metadata, "amdhsa.target")
      ? ("absent" as const)
      : target === null
        ? ("invalid" as const)
        : ("declared" as const),
    kernels: Array.isArray(kernels) ? (kernels as unknown[]) : null,
  };
};
/**
 * NT_AMD_HSA_METADATA/ISA_NAME (10/11) carry HSA YAML; NT_AMD_PAL_METADATA
 * (12) is PAL's legacy register-pair blob. Neither is MessagePack.
 */
const legacyAmdNoteLimitation = (abi: AmdGpuAbi, type: number) =>
  abi === "amdhsa" && (type === 10 || type === 11)
    ? "Legacy AMDGPU YAML metadata is outside MessagePack coverage"
    : abi === "amdpal" && type === 12
      ? "Legacy AMDGPU PAL register metadata is outside MessagePack coverage"
      : null;
/** One bounded parsed owner for target discovery and later selected kernel projection. */
export const readAmdElfMetadata = async (
  source: GpuSource,
  directory: NativeSectionDirectory,
  budgets?: Pick<
    GpuCodeObjectsBudgets,
    | "maxMetadataBytes"
    | "maxParserVisits"
    | "maxParserEntries"
    | "maxTokenBytes"
  >,
): Promise<
  Result<
    AmdElfMetadata,
    { kind: "incomplete-amd-metadata"; cause: unknown; partial: AmdElfMetadata }
  >
> => {
  const maxMetadataBytes =
    budgets?.maxMetadataBytes ?? DEFAULT_GPU_METADATA_BYTES;
  const limitations: string[] = [];
  const notes: AmdElfMetadata["notes"] = [];
  let retainedBytes = 0;
  let unsupportedNotes = false;
  let targetMetadata: AmdElfMetadata["targetMetadata"] = null;
  let pal: AmdPalMetadataReader | null = null;
  const valueBudget = new AmdMetadataValueBudget();
  const observed = (): AmdElfMetadata => {
    const targets = new Set(
      (targetMetadata?.notes ?? []).flatMap(({ target }) =>
        target === null ? [] : [target],
      ),
    );
    const processor = targetMetadata?.processor ?? null;
    const noteTarget = targets.size === 1 ? [...targets][0]! : null;
    const noteIdentity =
      noteTarget === null ? null : readAmdGpuNoteTarget(noteTarget);
    const noteConflict = targets.size > 1;
    const processorConflict =
      processor !== null &&
      noteIdentity !== null &&
      processor !== noteIdentity.processor;
    const invalidTarget = (targetMetadata?.notes ?? []).some(
      ({ target_state }) => target_state === "invalid",
    );
    const conflict = noteConflict || processorConflict || invalidTarget;
    const limitation = invalidTarget
      ? "AMDGPU note target is not a string; processor identity is unknown"
      : noteConflict
        ? "AMDGPU notes declare conflicting processor targets; processor identity is unknown"
        : processorConflict
          ? "AMDGPU ELF processor flags conflict with target note metadata; processor identity is unknown"
          : null;
    if (limitation !== null && !limitations.includes(limitation))
      limitations.push(limitation);
    const target = conflict ? null : (noteTarget ?? processor);
    // LLVM notes use both the empty and explicit `unknown` environment forms.
    const targetIdentity = conflict
      ? null
      : (noteIdentity ??
        (noteTarget === null && processor !== null
          ? { key: processor, processor }
          : null));
    return {
      target,
      targetIdentity,
      targetMetadata,
      limitations,
      pal: pal?.result() ?? null,
      notes,
    };
  };
  try {
    if (directory.machine !== 224 || directory.elf_os_abi === null)
      rejectGpu("AMDGPU metadata requires an AMDGPU ELF machine");
    const osAbi = directory.elf_os_abi!;
    const abi = readAmdGpuElfAbi(osAbi);
    targetMetadata = {
      flags: `0x${directory.flags.toString(16).padStart(8, "0")}`,
      processor: readAmdGpuElfProcessor(directory.flags),
      os_abi: osAbi,
      abi,
      header_location: {
        container_id: source.containerId,
        offset: 0,
        size: directory.bits === 64 ? 64 : 52,
        section_index: null,
        section_name: null,
      },
      note_coverage: "partial",
      notes: [],
    };
    // Each ABI defines its own note schema. Mesa3D and unrecognized ABIs have
    // none within coverage, so their notes stay unexamined rather than being
    // read under another ABI's schema.
    if (abi === "mesa3d" || abi === "unknown")
      throw new BinaryFormatFailure(
        "unsupported",
        abi === "mesa3d"
          ? "AMDGPU Mesa3D-ABI metadata is outside HSA kernel and PAL pipeline coverage"
          : `AMDGPU ELF OS ABI ${String(osAbi)} is not a recognized AMDGPU runtime ABI; its metadata is outside coverage`,
      );
    if (abi === "amdpal") pal = new AmdPalMetadataReader();

    for (const section of directory.sections) {
      if (elfNoteSectionStorage(section) === "not-note") continue;
      const sectionSize = gpuCount(section.size);
      if (sectionSize > maxMetadataBytes - retainedBytes)
        throw new BinaryResourceFailure(
          "structure",
          maxMetadataBytes,
          `AMDGPU ELF note discovery exceeds the ${formatGpuByteBudget(maxMetadataBytes)} retained metadata budget`,
          GPU_METADATA_BYTES_LIMIT,
          "bytes",
        );
      retainedBytes += sectionSize;
      const bytes = await sectionBytes(source, section);
      for (let p = 0; p < bytes.length;) {
        // AMDGPU metadata uses four-byte note padding regardless of section alignment.
        const frame = readElfNoteFrame(
          bytes.subarray(p, p + ELF_NOTE_HEADER_BYTES),
          directory.little,
          4,
          bytes.length - p,
        );
        if (!frame.ok) return rejectGpu(frame.error.message);
        const {
          namesz,
          descsz: size,
          type,
          descriptor,
          next,
          framing,
        } = frame.value;
        if (framing !== "complete")
          rejectGpu("ELF note entry exceeds its declared note section");
        const nameOffset = p + ELF_NOTE_HEADER_BYTES;
        const desc = p + descriptor;
        const vendor = bytes
          .subarray(nameOffset, nameOffset + namesz)
          .toString("latin1")
          .replace(/\0$/u, "");
        if (vendor === "AMDGPU" && type === 32) {
          const location = site(source, section, desc, size);
          const metadata = amdRecord(
            readAmdMetadata(
              bytes.subarray(desc, desc + size),
              // PAL register maps are keyed by unsigned register offsets.
              pal === null ? "string" : "string-or-unsigned",
              valueBudget,
              budgets,
            ),
          );
          if (metadata === null) rejectGpu("AMDGPU metadata is not a map");
          // The PAL schema declares no target; e_flags identify the processor.
          const hsa = pal === null ? readHsaNote(metadata!) : null;
          targetMetadata.notes.push({
            target: hsa?.target ?? null,
            target_state: hsa?.target_state ?? "absent",
            location,
          });
          if (hsa?.target_state === "invalid") unsupportedNotes = true;
          if (hsa === null) pal!.read(metadata!, location);
          else if (hsa.kernels === null)
            return rejectGpu("AMDGPU metadata has no valid kernel array");
          else
            notes.push({
              section,
              noteOffset: p,
              desc,
              size,
              kernels: hsa.kernels,
            });
        } else if (vendor === "AMD") {
          const legacy = legacyAmdNoteLimitation(abi, type);
          if (legacy !== null) {
            unsupportedNotes = true;
            limitations.push(legacy);
          }
        }
        p += next;
      }
    }
    targetMetadata.note_coverage =
      unsupportedNotes || directory.sections.length === 0
        ? "partial"
        : "complete";
    if (pal !== null) {
      if (pal.result() === null)
        throw new BinaryFormatFailure(
          "unsupported",
          "No AMDGPU PAL MessagePack pipeline metadata was available",
        );
    } else if (notes.length === 0)
      throw new BinaryFormatFailure(
        "unsupported",
        "No AMDGPU v3+ MessagePack kernel metadata was available",
      );
    return ok(observed());
  } catch (cause) {
    return err({ kind: "incomplete-amd-metadata", cause, partial: observed() });
  }
};

const amdKernels = (
  source: GpuSource,
  prepared: AmdElfMetadata,
  onKernel: (kernel: GpuKernel) => void,
  onTarget?: (target: GpuPayloadTarget) => void,
): { limitations: string[]; coverage: "complete" | "partial" } => {
  onTarget?.({
    value: prepared.target,
    identity: prepared.targetIdentity,
    amdMetadata: prepared.targetMetadata,
    amdPal: prepared.pal?.metadata ?? null,
    scope: "amdgpu",
  });
  for (const {
    section,
    noteOffset,
    desc,
    size,
    kernels: rows,
  } of prepared.notes) {
    for (let index = 0; index < rows.length; index++) {
      const value = amdRecord(rows[index]);
      const name = value === null ? null : amdString(value[".name"]);
      if (value === null || name === null)
        rejectGpu("AMDGPU kernel metadata has no name");
      const kernel = blankKernel(
        source,
        `note:${section.index}:${noteOffset}:${index}`,
        name!,
        site(source, section, desc, size),
      );
      kernel.representation = "amdgpu-metadata";
      kernel.sources = {
        parameters: kernel.location,
        registers: kernel.location,
        shared: kernel.location,
        private: kernel.location,
      };
      kernel.symbol = amdString(value![".symbol"]);
      kernel.parameter_bytes = amdCount(value![".kernarg_segment_size"]);
      kernel.shared_bytes = amdCount(value![".group_segment_fixed_size"]);
      kernel.private_bytes = amdCount(value![".private_segment_fixed_size"]);
      kernel.registers.sgpr = amdCount(value![".sgpr_count"]);
      kernel.registers.vgpr = amdCount(value![".vgpr_count"]);
      kernel.registers.agpr = amdCount(value![".agpr_count"]);
      const args = value![".args"];
      if (Array.isArray(args)) {
        kernel.parameter_count = args.length;
        kernel.parameters = args.map((argument, ordinal) => {
          const row = amdRecord(argument);
          if (row === null) rejectGpu("Malformed AMDGPU argument metadata");
          const kind = amdString(row![".value_kind"]);
          return {
            ordinal,
            name: amdString(row![".name"]),
            offset: amdCount(row![".offset"]),
            size: amdCount(row![".size"]),
            type: amdString(row![".type_name"]),
            hidden: kind === null ? null : kind.startsWith("hidden_"),
          };
        });
      }
      kernel.limitations.push(
        "AMDGPU parameter count includes hidden ABI arguments when present; missing fields remain unknown. Kernel metadata is a declaration, not runtime verification.",
      );
      onKernel(kernel);
    }
  }
  const limitations = [
    ...prepared.limitations,
    ...(prepared.pal?.limitations ?? []),
  ];
  return {
    limitations,
    coverage: limitations.length === 0 ? "complete" : "partial",
  };
};
