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
  isZeroFilledSpan,
  type BinaryContainer,
  type FileMappingIndex,
} from "../domain/binaryContainer.js";
import {
  readBinaryContainer,
  readBinaryContainerCooperative,
} from "../domain/native/readBinaryContainer.js";
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
  readElfPointerValuesSteps,
  ElfPointerRelocationFailure,
  type ElfVirtualPointerWrites,
} from "../domain/native/elfPointerRelocations.js";
import {
  Il2cppBinaryFormatFailure,
  IL2CPP_BINARY_BYTES,
} from "./Il2cppBinaryFormat.js";

/** Selection failures name the binary's architecture input and IL2CPP's public spellings. */
const IL2CPP_SLICE_SELECTION_INPUT: SliceSelectionInput = {
  architectureField: "binary_architecture",
  spelling: Object.fromEntries(
    Object.entries(IL2CPP_SLICE_SELECTORS).map(([publicName, selector]) => [
      selector,
      publicName,
    ]),
  ),
};

/**
 * Select the thin image of the caller's binary: IL2CPP's `binary_architecture`
 * maps onto the shared slice selector here, once. A refused selection names
 * `binary_architecture`; a universal container format failure is a target
 * refusal at the binary's own path.
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
  /** Stored file coordinates only; virtual translation and fixups stay separate. */
  readonly stored: BinaryReader;
  readonly container: BinaryContainer;
  /** One image's immutable load mappings, shared by stored and loader-aware reads. */
  readonly fileMappings: FileMappingIndex;
  /** Indexed executable load mappings for constant/log-time code ownership checks. */
  readonly executableMappings: FileMappingIndex;
  readonly imageBase: bigint;
  /** ELF loader writes retain virtual identity; source bytes stay unchanged. */
  readonly elfPointerOverlay?: ElfVirtualPointerWrites;
  /** Mach-O loader fixups shared by every native pointer consumer. */
  readonly machoPointerFixups?: PointerFixups;
}

const OPERATION = "inspect_il2cpp_metadata";

const rejectContainer = (cause: unknown): never => {
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
      cause.message,
    );
  throw cause;
};

const readContainer = (image: Buffer): BinaryContainer => {
  try {
    return readBinaryContainer(image, OPERATION);
  } catch (cause) {
    return rejectContainer(cause);
  }
};

export const readIl2cppBinaryContainerCooperative = async (
  image: Buffer,
  pause: () => Promise<void>,
): Promise<BinaryContainer> => {
  try {
    return await readBinaryContainerCooperative(image, OPERATION, pause);
  } catch (cause) {
    return rejectContainer(cause);
  }
};

/** Open one thin image; a universal Mach-O slice is selected before this. */
export function* openImageSteps(
  image: Buffer,
  preparedContainer?: BinaryContainer,
): Generator<void, NativeImage> {
  const container = preparedContainer ?? readContainer(image);
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
        selected.error.kind === "format" &&
          selected.error.failure.kind !== "unsupported"
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
    stored: new BinaryReader(image, true, container.format),
    container,
    fileMappings: createFileMappingIndex(
      container.mappings,
      container.zero_fills,
    ),
    executableMappings: createFileMappingIndex(
      container.executable_mappings ?? [],
      [],
    ),
    imageBase,
    ...(elfPointerOverlay === undefined ? {} : { elfPointerOverlay }),
    ...(machoPointerFixups === undefined ? {} : { machoPointerFixups }),
  };
}

/** Stored bytes only; loader interpretation belongs to readSlot. */
const readStoredWord = (image: NativeImage, address: bigint): bigint | null => {
  try {
    const offset = image.fileMappings.offset(address, 8);
    return image.stored.word(offset, 64);
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
    return image.stored.u32(image.fileMappings.offset(address, 4));
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
  const end = address + BigInt(count) * 8n;
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
    const size = Number(((stop - cursor) / 8n) * 8n);
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
    return offset === image.executableMappings.offset(address, 1);
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
      const value = image.elfPointerOverlay.unsignedAt(address, 8);
      if (value !== undefined) return value;
      if (image.elfPointerOverlay.hasWrites(address, 8)) return "unknown";
    }
    // A successful indexed read already excludes zero-fill aliases. Only a
    // non-file-backed slot needs the zero-fill ownership walk.
    let raw = readStoredWord(image, address);
    if (raw === null && isZeroFilled(image, address, 8)) raw = 0n;
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
