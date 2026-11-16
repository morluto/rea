import { parseFailureFromCause } from "../domain/parseFailure.js";
import { binaryMetadataArchitecture } from "../domain/binaryMetadataArchitecture.js";
import {
  IL2CPP_SLICE_SELECTORS,
  type Il2cppBinaryArchitecture,
} from "../domain/il2cpp/il2cppMetadata.js";
import {
  BinaryFormatFailure,
  BinaryMappingFailure,
  BinaryReader,
  BinaryResourceFailure,
  createFileMappingIndex,
  mappedFileOffset,
  isZeroFilledSpan,
  type BinaryContainer,
  type FileMappingIndex,
  UnrecognizedBinaryFailure,
} from "../domain/binaryContainer.js";
import { readBinaryContainer } from "../domain/native/readBinaryContainer.js";
import {
  requireSelectedNativeImage,
  type SelectedNativeImage,
  type SliceSelectionInput,
  selectMachoSlice,
} from "../domain/apple/machoSliceSelection.js";
import {
  parsePointerFixupsSteps,
  type PointerFixups,
} from "../domain/apple/appleMachoFixups.js";
import { parseMachoLayout } from "../domain/apple/appleMachoSelection.js";
import {
  WASM_PAGE_BYTES,
  WasmModuleFailure,
  type WasmTableSlots,
  readInitialLinearMemorySteps,
  readWasmModuleImageSteps,
} from "../wasm/WasmModuleImage.js";
import {
  readElfPointerValuesSteps,
  ElfPointerRelocationFailure,
  type ElfVirtualPointerWrites,
} from "../domain/native/elfPointerRelocations.js";
import {
  Il2cppBinaryFormatFailure,
  IL2CPP_BINARY_BYTES,
} from "./Il2cppBinaryFormat.js";

/** Selection failures name the binary's inputs and IL2CPP's public spellings. */
const IL2CPP_SLICE_SELECTION_INPUT: SliceSelectionInput = {
  pathField: "binary_path",
  architectureField: "binary_architecture",
  spelling: Object.fromEntries(
    Object.entries(IL2CPP_SLICE_SELECTORS).map(([publicName, selector]) => [
      selector,
      publicName,
    ]),
  ),
};

/** A wasm32 module's initial linear memory, read as one image. */
export interface WasmImageContainer {
  readonly format: "wasm";
  readonly architecture: "wasm32";
  readonly bits: 32;
  readonly byte_order: "little";
  readonly mappings: BinaryContainer["mappings"];
  readonly zero_fills: BinaryContainer["zero_fills"];
  readonly executable_mappings: BinaryContainer["mappings"];
  /** A module has no native sections. */
  readonly sections: BinaryContainer["sections"];
}

/** Table 0 of a wasm32 module: slot to function index, and how many functions are imports. */
export interface WasmFunctionTable {
  readonly slots: WasmTableSlots;
  readonly importedFunctionCount: number;
}

/**
 * Select the thin image of the caller's binary: IL2CPP's `binary_architecture`
 * maps onto the shared slice selector here, once, and a selection failure
 * names `binary_architecture` or `binary_path`.
 */
export const requireIl2cppBinaryImage = (
  operation: string,
  path: string,
  bytes: Buffer,
  architecture: Il2cppBinaryArchitecture | undefined,
): SelectedNativeImage =>
  requireSelectedNativeImage(
    operation,
    path,
    bytes,
    architecture === undefined
      ? undefined
      : IL2CPP_SLICE_SELECTORS[architecture],
    IL2CPP_SLICE_SELECTION_INPUT,
  );

export interface NativeImage {
  readonly bytes: Buffer;
  readonly container: BinaryContainer | WasmImageContainer;
  /** One image's immutable load mappings, shared by stored and loader-aware reads. */
  readonly fileMappings: FileMappingIndex;
  readonly imageBase: bigint;
  /** Bytes per pointer slot: 8 for the 64-bit native images, 4 for wasm32. */
  readonly pointerSize: 4 | 8;
  /** ELF loader writes retain virtual identity; source bytes stay unchanged. */
  readonly elfPointerOverlay?: ElfVirtualPointerWrites;
  /** Mach-O loader fixups shared by every native pointer consumer. */
  readonly machoPointerFixups?: PointerFixups;
  /** Present only for wasm32: method pointers are slots in this table. */
  readonly wasmTable?: WasmFunctionTable;
}

const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d]);

/** Whether the binary is a WebAssembly module, from its magic alone. */
export const isWasmModule = (bytes: Buffer): boolean =>
  bytes.subarray(0, 4).equals(WASM_MAGIC);
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

/**
 * Initial linear memory from active data segments, mapped from the lowest
 * segment start to a short zero tail past the highest end; the rest of the
 * initial memory is zero fill.
 * Bytes below the lowest segment stay unmapped, so a pointer into them is not
 * read as zero.
 */
function* openWasmImageSteps(bytes: Buffer): Generator<void, NativeImage> {
  let module;
  let memory;
  // Reconstruction allowances are bytes; the reader's other allowances are counts,
  // apart from its 1 GiB input cap, which the 1 GiB binary read refuses first.
  let rebuilding = false;
  try {
    module = yield* readWasmModuleImageSteps(bytes);
    // A host-supplied memory may already hold bytes that data segments do not
    // overwrite, so the initial memory is not known.
    if (module.memory?.imported === true)
      throw new WasmModuleFailure(
        "unsupported",
        "the module imports its memory, whose initial bytes the module does not determine",
      );
    // A host-supplied table may hold functions in slots the module never fills.
    if (module.tableImported)
      throw new WasmModuleFailure(
        "unsupported",
        "the module imports its function table, whose slots the module does not determine",
      );
    rebuilding = true;
    memory = yield* readInitialLinearMemorySteps(module, bytes.length);
  } catch (cause) {
    if (cause instanceof WasmModuleFailure) {
      if (cause.failure.kind === "limit" && cause.unit !== undefined)
        throw new Il2cppBinaryFormatFailure(
          rebuilding ? "wasm-memory-capacity" : "wasm-module-capacity",
          cause.message,
          cause.failure.limit.maximum,
          cause.unit,
        );
      throw new Il2cppBinaryFormatFailure(
        cause.kind === "unsupported"
          ? "unsupported-container"
          : "malformed-container",
        cause.message,
      );
    }
    throw cause;
  }
  // The view carries a short zero tail past the last segment, so a value that
  // straddles that boundary reads whole; the rest of the initial memory is a
  // zero-fill range that reads resolve but searches skip.
  const mappings =
    memory.bytes.length === 0
      ? []
      : [
          {
            address: BigInt(memory.address),
            offset: 0,
            size: memory.bytes.length,
          },
        ];
  const end = BigInt(memory.address + memory.bytes.length);
  const initial =
    BigInt(module.memory?.initialPages ?? 0) * BigInt(WASM_PAGE_BYTES);
  const zero_fills: BinaryContainer["zero_fills"] =
    memory.bytes.length > 0 && initial > end
      ? [{ address: end, size: initial - end }]
      : [];
  return {
    bytes: memory.bytes,
    container: {
      format: "wasm",
      architecture: "wasm32",
      bits: 32,
      byte_order: "little",
      mappings,
      zero_fills,
      executable_mappings: [],
      sections: [],
    },
    fileMappings: createFileMappingIndex(mappings, zero_fills),
    imageBase: 0n,
    pointerSize: 4,
    wasmTable: {
      slots: module.table,
      importedFunctionCount: module.importedFunctionCount,
    },
  };
}

/** The refusal for a binary that is none of the formats IL2CPP links. */
export const IL2CPP_UNRECOGNIZED_BINARY =
  "Only ELF, PE, thin Mach-O, and uncompressed WebAssembly (wasm32) images are supported";

/** Open one thin image; a universal Mach-O slice is selected before this. */
export function* openImageSteps(image: Buffer): Generator<void, NativeImage> {
  const head = image.subarray(0, 4);
  if (head.equals(WASM_MAGIC) || head.subarray(0, 2).equals(GZIP_MAGIC))
    return yield* openWasmImageSteps(image);
  let container: BinaryContainer;
  try {
    container = readBinaryContainer(image);
  } catch (cause) {
    if (cause instanceof BinaryResourceFailure)
      throw new Il2cppBinaryFormatFailure(
        "native-index-capacity",
        cause.message,
        cause.failure.limit.maximum,
        "bytes",
      );
    if (cause instanceof BinaryFormatFailure)
      throw new Il2cppBinaryFormatFailure(
        cause.kind === "unsupported"
          ? "unsupported-container"
          : "malformed-container",
        // The shared reader names native formats only; IL2CPP also links wasm32.
        cause instanceof UnrecognizedBinaryFailure
          ? IL2CPP_UNRECOGNIZED_BINARY
          : cause.message,
      );
    throw cause;
  }
  if (container.bits !== 64 || container.byte_order !== "little")
    throw new Il2cppBinaryFormatFailure(
      "unsupported-container",
      `only 64-bit little-endian images are supported, not ${container.bits}-bit ${container.byte_order}-endian`,
    );
  let elfPointerOverlay: ElfVirtualPointerWrites | undefined;
  try {
    if (container.format === "elf")
      elfPointerOverlay = yield* readElfPointerValuesSteps(
        image,
        {
          bits: 64,
          little: true,
          machine: container.elf.machine,
          dynamicSegments: container.elf.dynamicSegments,
          mappings: container.mappings,
          zeroFills: container.zero_fills,
        },
        IL2CPP_BINARY_BYTES,
        { symbolResolution: "image-definitions" },
      );
  } catch (cause) {
    if (cause instanceof ElfPointerRelocationFailure) {
      if (cause.failure.kind === "limit" && cause.unit !== undefined)
        throw new Il2cppBinaryFormatFailure(
          "native-index-capacity",
          cause.message,
          cause.failure.limit.maximum,
          cause.unit,
        );
      if (cause.reason !== "native-index-capacity")
        throw new Il2cppBinaryFormatFailure(cause.reason, cause.message);
    }
    if (cause instanceof BinaryFormatFailure)
      throw new Il2cppBinaryFormatFailure("malformed-container", cause.message);
    throw cause;
  }
  if (container.format === "macho" && container.macho_chained_fixups === true)
    throw new Il2cppBinaryFormatFailure(
      "unsupported-pointer-encoding",
      "Mach-O chained fixups are not decoded",
    );
  let machoPointerFixups: PointerFixups | undefined;
  if (container.format === "macho") {
    const selected = selectMachoSlice(image, {
      mode: "admitted",
      architecture:
        binaryMetadataArchitecture(container.architecture) ??
        container.architecture,
      slice: undefined,
    });
    // The image is the thin slice already selected; a refusal means the
    // container's architecture names no CPU family this reader decodes.
    if (!selected.ok)
      throw new Il2cppBinaryFormatFailure(
        selected.error.kind === "malformed"
          ? "malformed-container"
          : "unsupported-container",
        selected.error.message,
      );
    try {
      const layout = parseMachoLayout(image, selected.value);
      machoPointerFixups = yield* parsePointerFixupsSteps(
        image,
        layout.fixups,
        layout.segments,
        layout.baseAddress,
      );
    } catch (cause) {
      const failure = parseFailureFromCause(cause);
      if (failure !== undefined)
        throw new Il2cppBinaryFormatFailure(
          failure.kind === "unsupported"
            ? "unsupported-container"
            : "malformed-container",
          failure.message,
        );
      throw cause;
    }
  }
  if (container.format === "pe" && container.image_base === undefined)
    throw new Il2cppBinaryFormatFailure(
      "malformed-container",
      "PE image base was not observed",
    );
  const imageBase =
    container.image_base ??
    container.mappings.find((mapping) => mapping.offset === 0)?.address ??
    container.mappings.reduce<bigint | undefined>(
      (lowest, mapping) =>
        lowest === undefined || mapping.address < lowest
          ? mapping.address
          : lowest,
      undefined,
    ) ??
    0n;
  return {
    bytes: image,
    container,
    fileMappings: createFileMappingIndex(
      container.mappings,
      container.zero_fills,
    ),
    imageBase,
    pointerSize: 8,
    ...(elfPointerOverlay === undefined ? {} : { elfPointerOverlay }),
    ...(machoPointerFixups === undefined ? {} : { machoPointerFixups }),
  };
}

/** Stored bytes only; loader interpretation belongs to readSlot. */
const readStoredWord = (image: NativeImage, address: bigint): bigint | null => {
  try {
    const offset = image.fileMappings.offset(address, image.pointerSize);
    return new BinaryReader(image.bytes, true, image.container.format).word(
      offset,
      image.pointerSize === 8 ? 64 : 32,
    );
  } catch (cause) {
    if (cause instanceof BinaryFormatFailure) return null;
    throw cause;
  }
};

/** A UInt32 field owns four bytes; reading a pointer would also require unrelated padding. */
export const readUInt32 = (
  image: NativeImage,
  address: bigint,
): number | "unknown" | null => {
  if (image.machoPointerFixups?.hasUnresolvedLegacyBytes(address, 4) === true)
    return "unknown";
  try {
    if (image.elfPointerOverlay?.hasWrites(address, 4) === true) {
      const value = image.elfPointerOverlay.unsignedAt(address, 4);
      return value === undefined ? "unknown" : Number(value);
    }
    return image.bytes.readUInt32LE(image.fileMappings.offset(address, 4));
  } catch (cause) {
    if (cause instanceof BinaryFormatFailure) return null;
    throw cause;
  }
};

/** Exact lowercase hexadecimal form of an address in reports and issues. */
export const hexAddress = (value: bigint) => `0x${value.toString(16)}`;

export const isMapped = (image: NativeImage, address: bigint, size: number) => {
  try {
    image.fileMappings.offset(address, size);
    return true;
  } catch (cause) {
    if (cause instanceof BinaryFormatFailure) return false;
    throw cause;
  }
};

// An array of slots that all lack a body can sit wholly in zero-fill (.bss):
// an iOS-only assembly in an Android build has its pointers there.
export const isZeroFilled = (
  image: NativeImage,
  address: bigint,
  size: number,
) =>
  isZeroFilledSpan(
    image.container.mappings,
    image.container.zero_fills,
    address,
    size,
  );

/** Admit readable slots across loader ranges without walking every pointer.
 * Each chunk uses the format owner's alias checks; a gap or split slot is refused.
 */
export const hasPointerArrayCoverage = (
  image: NativeImage,
  address: bigint,
  count: number,
): boolean => {
  const width = BigInt(image.pointerSize);
  const end = address + BigInt(count) * width;
  let cursor = address;
  while (cursor < end) {
    let fileEnd = cursor;
    for (const range of image.container.mappings)
      if (
        range.address <= cursor &&
        range.address + BigInt(range.size) > fileEnd
      )
        fileEnd = range.address + BigInt(range.size);
    let coveredEnd = fileEnd;
    if (fileEnd === cursor)
      for (const range of image.container.zero_fills)
        if (range.address <= cursor && range.address + range.size > coveredEnd)
          coveredEnd = range.address + range.size;
    const stop = coveredEnd < end ? coveredEnd : end;
    const size = Number(((stop - cursor) / width) * width);
    if (size <= 0) return false;
    try {
      if (fileEnd === cursor) {
        if (!isZeroFilled(image, cursor, size)) return false;
      } else {
        image.fileMappings.offset(cursor, size);
      }
    } catch (cause) {
      if (cause instanceof BinaryFormatFailure) return false;
      throw cause;
    }
    cursor += BigInt(size);
  }
  return true;
};

/** Both executable coverage and the unique full loader mapping must agree. */
export const isExecutable = (image: NativeImage, address: bigint): boolean => {
  try {
    const offset = image.fileMappings.offset(address, 1);
    return (
      offset ===
      mappedFileOffset(image.container.executable_mappings ?? [], address, 1)
    );
  } catch (cause) {
    if (cause instanceof BinaryFormatFailure) return false;
    throw cause;
  }
};

export const readSlot = (
  image: NativeImage,
  address: bigint,
): bigint | "unknown" | null => {
  try {
    if (image.elfPointerOverlay !== undefined) {
      const value = image.elfPointerOverlay.unsignedAt(
        address,
        image.pointerSize,
      );
      if (value !== undefined) return value;
      if (image.elfPointerOverlay.hasWrites(address, image.pointerSize))
        return "unknown";
    }
    // A successful indexed read already excludes zero-fill aliases. Only a
    // non-file-backed slot needs the zero-fill ownership walk.
    let raw = readStoredWord(image, address);
    if (raw === null && isZeroFilled(image, address, image.pointerSize))
      raw = 0n;
    if (raw === null) return null;
    if (image.machoPointerFixups !== undefined) {
      const resolution = image.machoPointerFixups.decode(address, raw);
      if (resolution.kind === "bind" || resolution.kind === "unknown")
        return "unknown";
      if (resolution.kind === "unsupported")
        throw new Il2cppBinaryFormatFailure(
          "unsupported-pointer-encoding",
          resolution.reason,
        );
      return resolution.target;
    }
    return raw;
  } catch (cause) {
    if (cause instanceof BinaryMappingFailure) return null;
    if (cause instanceof BinaryFormatFailure)
      throw new Il2cppBinaryFormatFailure("malformed-container", cause.message);
    throw cause;
  }
};

/** Require an observed resolved pointer; unknown and unmapped slots stay null. */
export const readPointer = (
  image: NativeImage,
  address: bigint,
): bigint | null => {
  const value = readSlot(image, address);
  return typeof value === "bigint" ? value : null;
};
