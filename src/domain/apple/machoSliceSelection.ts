import {
  readUniversalMachoImage,
  readUniversalMachoImageFromReader,
  readUniversalMachoSlice,
  validateUniversalMachoSliceFromReader,
  type MachoImageSelectionFailure,
} from "./machoImageSelection.js";
import {
  readMachoHeaderPrefixFacts,
  type FatSliceDeclaration,
} from "./machoContainer.js";
import {
  MACHO_CPU_TYPES,
  machoSliceFamily,
  machoSliceSubtypeSelector,
  type MachoSliceArchitecture,
  type MachoTargetSelection,
} from "./machoTargetSelection.js";
import {
  AnalysisInputError,
  AnalysisTargetFailureError,
  AnalysisUnsupportedTargetError,
} from "../analysisErrorCore.js";
import type { AnalysisError } from "../analysisErrorBase.js";
import { ParseFailureError } from "../parseFailure.js";
import { err, ok, type Result } from "../result.js";
import { MACHO_ARCHITECTURE_POLICIES } from "./machoArchitectureSelection.js";
import { sha256Hex } from "../../kernel/sha256Hex.js";
import type { ByteSource } from "../byteSource.js";

const cpuName = (cpuType: number, cpuSubtype: number): string => {
  const name = Object.entries(MACHO_CPU_TYPES).find(
    ([, type]) => type === cpuType,
  )?.[0];
  const subtype = `0x${cpuSubtype.toString(16)}`;
  return name === undefined
    ? `cpu type 0x${cpuType.toString(16)} subtype ${subtype}`
    : `${name} (subtype ${subtype})`;
};

/** The one thin image an inspector reads, and where it lies in the selected file. */
export interface SelectedNativeImage {
  readonly bytes: Buffer;
  /** File offset of `bytes`; add it to image-relative offsets to locate them in the file. */
  readonly fileOffset: number;
  /** Selected universal slice identity; null when the file is not a universal Mach-O. */
  readonly selection: MachoTargetSelection | null;
  /** Other slices of the selected CPU family that this inspection does not read, and how to select each. */
  readonly limitations: readonly string[];
}

/**
 * The caller's architecture field and spellings for a slice selection.
 * Messages name selectors through `spelling`, and a selector without a
 * spelling is never offered as a choice.
 */
export interface SliceSelectionInput {
  readonly architectureField: string;
  readonly spelling: Readonly<Partial<Record<MachoSliceArchitecture, string>>>;
}

/** The shared `architecture` input, spelled as the selector values. */
export const SHARED_SLICE_SELECTION_INPUT: SliceSelectionInput = {
  architectureField: "architecture",
  spelling: {
    x86: "x86",
    x86_64: "x86_64",
    arm: "arm",
    arm64: "arm64",
    arm64e: "arm64e",
  },
};

/** File range target admission chose. Readers must not rank slices again. */
export interface AdmittedMachoSlice {
  readonly offset: number;
  readonly size: number;
}

/**
 * Which slice a reader asks for. `admitted` reads the image target admission
 * bound to the session: a universal image only at the admitted range, which
 * must be declared for the architecture's CPU family, and a thin image only
 * when its header is of that family. `architecture` resolves the caller's
 * selector against the universal table by CPU family and subtype.
 */
export type MachoSliceRequest =
  | {
      readonly mode: "admitted";
      readonly architecture: string;
      readonly slice: AdmittedMachoSlice | undefined;
    }
  | {
      readonly mode: "architecture";
      readonly architecture: MachoSliceArchitecture | undefined;
      readonly input?: SliceSelectionInput;
    };

/**
 * A selection the request and the file do not agree on. The file may be
 * well formed; the request names no slice in it, more than one slice, or a
 * slice admission did not declare.
 */
export interface MachoSliceSelectionRefusal {
  readonly kind:
    | "architecture_not_present"
    | "ambiguous_architecture"
    | "admitted_slice_mismatch";
  readonly message: string;
}

/**
 * Why no image could be selected: a refused request, or the universal
 * file's own format failure.
 */
export type MachoSliceSelectionFailure =
  | MachoSliceSelectionRefusal
  | MachoImageSelectionFailure;

/**
 * The public refusal for a failed architecture selection. A refused request
 * is the caller's `architecture` value; a format failure belongs to the
 * selected file's bytes, so it is a malformed or unsupported target at
 * `path`, never an invalid `path` argument.
 */
const selectionError = (
  operation: string,
  path: string,
  failure: MachoSliceSelectionFailure,
  input: SliceSelectionInput,
): AnalysisError => {
  if (failure.kind !== "format")
    return new AnalysisInputError(operation, undefined, [
      {
        path: [input.architectureField],
        reason: "invalid_value",
        message: failure.message,
      },
    ]);
  const parsed = failure.failure;
  const cause = new ParseFailureError(parsed);
  return parsed.kind === "unsupported"
    ? new AnalysisUnsupportedTargetError(operation, path, parsed.detail, {
        cause,
      })
    : new AnalysisTargetFailureError(operation, path, parsed, { cause });
};

interface FatSlice {
  readonly cpuType: number;
  readonly cpuSubtype: number;
  readonly offset: number;
}

/** Whether a value names a subtype, not only a CPU family. */
const namesSubtype = (architecture: MachoSliceArchitecture): boolean =>
  architecture === "arm64" ||
  architecture === "arm64e" ||
  architecture === "x86_64";

/** The architecture values that address slices of this value's CPU family. */
const familyValues = (
  architecture: MachoSliceArchitecture,
): readonly MachoSliceArchitecture[] =>
  architecture === "arm64" || architecture === "arm64e"
    ? ["arm64", "arm64e"]
    : [architecture];

/**
 * The slices one value addresses within its CPU family: a family name reads
 * the family's only slice, and otherwise the value must name a subtype.
 */
const addressedSlices = <Slice extends FatSlice>(
  family: readonly Slice[],
  architecture: MachoSliceArchitecture,
): readonly Slice[] =>
  architecture !== "arm64e" && family.length === 1
    ? family
    : family.filter(
        (slice) =>
          machoSliceSubtypeSelector(slice.cpuType, slice.cpuSubtype) ===
          architecture,
      );

type UniversalMachoHeader = NonNullable<
  Extract<ReturnType<typeof readUniversalMachoImage>, { ok: true }>["value"]
>;

/**
 * Select the thin image one reader reads, without lipo, in the request's
 * mode. The container is read once here for both modes, so a universal image
 * is admitted by the same rules whichever reader asks; a refused request is a
 * typed refusal, never a format failure.
 */
export const selectMachoSlice = (
  bytes: Buffer,
  request: MachoSliceRequest,
): Result<SelectedNativeImage, MachoSliceSelectionFailure> => {
  const container = readUniversalMachoImage(bytes);
  if (!container.ok) return container;
  return request.mode === "admitted"
    ? selectAdmittedSlice(bytes, container.value, request)
    : selectArchitectureSlice(
        bytes,
        container.value,
        request.architecture,
        request.input ?? SHARED_SLICE_SELECTION_INPUT,
      );
};

const selectAdmittedSlice = (
  bytes: Buffer,
  fat: UniversalMachoHeader | null,
  {
    architecture,
    slice: admitted,
  }: Extract<MachoSliceRequest, { mode: "admitted" }>,
): Result<SelectedNativeImage, MachoSliceSelectionFailure> => {
  const cpuType = MACHO_ARCHITECTURE_POLICIES[architecture]?.cpuType;
  if (fat === null && admitted !== undefined)
    return err({
      kind: "admitted_slice_mismatch",
      message:
        "Admission bound a universal slice, but the file is not a universal Mach-O",
    });
  if (fat === null) {
    // The layout reader reports a truncated or unrecognized header, and a
    // big-endian 64-bit image it decodes for no architecture.
    const { identity, format } = readMachoHeaderPrefixFacts(bytes);
    if (
      identity !== null &&
      format !== null &&
      bytes.length >= format.headerSize &&
      !(format.wide && !format.littleEndian) &&
      identity.cpuType !== cpuType
    )
      return err({
        kind: "architecture_not_present",
        message: `Mach-O CPU type does not match requested architecture ${architecture}`,
      });
    return ok({ bytes, fileOffset: 0, selection: null, limitations: [] });
  }
  if (cpuType === undefined)
    return err({
      kind: "architecture_not_present",
      message: `Universal Mach-O metadata does not read architecture ${architecture}`,
    });
  // Target admission owns slice choice; ranking here again could read a
  // different slice than the one the session's Evidence names.
  if (admitted === undefined)
    return err({
      kind: "admitted_slice_mismatch",
      message: "Universal Mach-O metadata needs the admitted slice",
    });
  // The container admits no overlapping ranges, so a range is declared once.
  const declared = fat.slices.find(
    ({ offset, size }) => offset === admitted.offset && size === admitted.size,
  );
  if (declared === undefined)
    return err({
      kind: "admitted_slice_mismatch",
      message: "Admitted FAT slice is not declared",
    });
  if (declared.cpuType !== cpuType)
    return err({
      kind: "admitted_slice_mismatch",
      message: "Admitted FAT slice does not match the requested architecture",
    });
  return selectedFatImage(bytes, fat, declared, []);
};

/** Read and validate one declared slice, binding its container identity. */
const selectedFatImage = (
  bytes: Buffer,
  fat: UniversalMachoHeader,
  slice: FatSliceDeclaration,
  limitations: readonly string[],
): Result<SelectedNativeImage, MachoSliceSelectionFailure> => {
  const selected = readUniversalMachoSlice(bytes, fat, slice);
  if (!selected.ok) return selected;
  return ok({
    bytes: selected.value,
    fileOffset: slice.offset,
    selection: {
      kind: "macho-selected-image-v1",
      container: "fat",
      offset: slice.offset,
      byte_length: slice.size,
      cpu_type: slice.cpuType,
      cpu_subtype: slice.cpuSubtype,
      container_table_sha256: sha256Hex(bytes.subarray(0, fat.tableEnd)),
    },
    limitations,
  });
};

/**
 * A universal Mach-O needs the caller's architecture. A family name selects
 * the family's only slice; when several slices share the family, the value
 * must name one slice's subtype exactly, and no slice is chosen by
 * preference. Any other file is returned whole and rejects an architecture
 * rather than ignoring it.
 */
function* selectArchitectureSliceSteps(
  fat: UniversalMachoHeader | null,
  architecture: MachoSliceArchitecture | undefined,
  input: SliceSelectionInput,
): Generator<
  FatSliceDeclaration,
  Result<
    {
      readonly slice: FatSliceDeclaration | null;
      readonly limitations: readonly string[];
    },
    MachoSliceSelectionFailure
  >,
  Result<unknown, { readonly message: string }>
> {
  const field = input.architectureField;
  const spelled = (value: MachoSliceArchitecture): string =>
    input.spelling[value] ?? value;
  if (fat === null)
    return architecture === undefined
      ? ok({ slice: null, limitations: [] })
      : err({
          kind: "architecture_not_present",
          message: `${field} ${spelled(architecture)} was selected, but the file is not a universal Mach-O; omit ${field}.`,
        });
  const available = () =>
    fat.slices
      .map(({ cpuType, cpuSubtype }) => cpuName(cpuType, cpuSubtype))
      .join(", ");
  if (architecture === undefined)
    return err({
      kind: "ambiguous_architecture",
      message: `Universal Mach-O holds ${available()}; select one architecture.`,
    });
  const sameFamily = fat.slices.filter(
    ({ cpuType }) =>
      cpuType === MACHO_CPU_TYPES[machoSliceFamily(architecture)],
  );
  const matches = addressedSlices(sameFamily, architecture);
  const [slice] = matches;
  // A selector must be unambiguous in the declared table before its slice
  // header can establish whether the choice works.
  const alternatives = familyValues(architecture).flatMap((value) => {
    if (value === architecture || input.spelling[value] === undefined)
      return [];
    const [declared, competing] = addressedSlices(sameFamily, value);
    return declared === undefined || competing !== undefined
      ? []
      : [{ value, declared }];
  });
  if (slice === undefined || matches.length > 1) {
    const choices: MachoSliceArchitecture[] = [];
    for (const { value, declared } of alternatives)
      if ((yield declared).ok) choices.push(value);
    const select =
      choices.length === 0
        ? ""
        : ` Select ${field} ${choices.map(spelled).join(" or ")}.`;
    return err({
      kind:
        matches.length > 1
          ? "ambiguous_architecture"
          : "architecture_not_present",
      message:
        sameFamily.length === 0
          ? `Universal Mach-O holds ${available()}, not ${spelled(architecture)}.${select}`
          : matches.length === 0 && namesSubtype(architecture)
            ? `Universal Mach-O holds ${available()}; no slice has the ${spelled(architecture)} subtype.${select}`
            : `Universal Mach-O holds several ${spelled(architecture)} slices (${available()}); no slice was selected.${select}`,
    });
  }
  const unread: string[] = [];
  for (const other of sameFamily) {
    if (other === slice) continue;
    const place = `${cpuName(other.cpuType, other.cpuSubtype)} at file offset ${String(other.offset)}`;
    const read = yield other;
    if (!read.ok) {
      unread.push(
        `${place} (unverified: ${read.error.message}; no ${field} value reads it)`,
      );
      continue;
    }
    const selector = alternatives.find(
      ({ declared }) => declared === other,
    )?.value;
    unread.push(
      `${place} (${selector === undefined ? `no ${field} value selects it` : `${field} ${spelled(selector)} selects it`})`,
    );
  }
  return ok({
    slice,
    limitations:
      unread.length === 0
        ? []
        : [
            `Only the selected ${spelled(architecture)} slice (${cpuName(slice.cpuType, slice.cpuSubtype)} at file offset ${String(slice.offset)}) was read; this universal Mach-O also holds ${unread.join(", ")}.`,
          ],
  });
}

const selectArchitectureSlice = (
  bytes: Buffer,
  fat: UniversalMachoHeader | null,
  architecture: MachoSliceArchitecture | undefined,
  input: SliceSelectionInput,
): Result<SelectedNativeImage, MachoSliceSelectionFailure> => {
  const steps = selectArchitectureSliceSteps(fat, architecture, input);
  let next = steps.next();
  while (!next.done)
    next = steps.next(readUniversalMachoSlice(bytes, fat!, next.value));
  if (!next.value.ok) return next.value;
  const { slice, limitations } = next.value.value;
  return slice === null
    ? ok({ bytes, fileOffset: 0, selection: null, limitations })
    : selectedFatImage(bytes, fat!, slice, limitations);
};

/** The one thin image an inspector reads over a random-access handle, and where it lies in the selected file. */
export interface SelectedNativeImageSource {
  readonly source: ByteSource;
  /** File offset of `source`; add it to image-relative offsets to locate them in the file. */
  readonly fileOffset: number;
  /** Selected universal slice identity; null when the file is not a universal Mach-O. */
  readonly selection: MachoTargetSelection | null;
  /** Other slices of the selected CPU family that this inspection does not read, and how to select each. */
  readonly limitations: readonly string[];
}

const sliceByteSource = (
  source: ByteSource,
  sliceOffset: number,
  sliceSize: number,
): ByteSource => ({
  size: sliceSize,
  ...(source.prefix !== undefined && sliceOffset < source.prefix.length
    ? {
        prefix: source.prefix.subarray(
          sliceOffset,
          Math.min(source.prefix.length, sliceOffset + sliceSize),
        ),
      }
    : {}),
  readRange: (offset, length) => {
    if (offset < 0 || length <= 0 || offset >= sliceSize)
      return Promise.resolve(Buffer.alloc(0));
    const clamped = Math.min(length, sliceSize - offset);
    return source.readRange(sliceOffset + offset, clamped);
  },
});

/**
 * Same architecture selection as {@link requireSelectedNativeImage}, reading only
 * the universal header and 16-byte slice prefixes without buffering the full image.
 */
export const requireSelectedNativeImageFromReader = async (
  operation: string,
  path: string,
  source: ByteSource,
  architecture: MachoSliceArchitecture | undefined,
  input: SliceSelectionInput = SHARED_SLICE_SELECTION_INPUT,
): Promise<SelectedNativeImageSource> => {
  const failSelection = (failure: MachoSliceSelectionFailure): never => {
    throw selectionError(operation, path, failure, input);
  };
  const container = await readUniversalMachoImageFromReader(source);
  if (!container.ok) return failSelection(container.error);
  const parsed = container.value;
  const steps = selectArchitectureSliceSteps(
    parsed?.header ?? null,
    architecture,
    input,
  );
  let next = steps.next();
  while (!next.done)
    next = steps.next(
      await validateUniversalMachoSliceFromReader(
        source,
        parsed!.header,
        next.value,
      ),
    );
  if (!next.value.ok) return failSelection(next.value.error);
  const { slice, limitations } = next.value.value;
  if (slice === null || parsed === null)
    return { source, fileOffset: 0, selection: null, limitations };
  const { header: fat, tableBytes } = parsed;
  const validated = await validateUniversalMachoSliceFromReader(
    source,
    fat,
    slice,
  );
  if (!validated.ok) return failSelection(validated.error);
  return {
    source: sliceByteSource(source, slice.offset, slice.size),
    fileOffset: slice.offset,
    selection: {
      kind: "macho-selected-image-v1",
      container: "fat",
      offset: slice.offset,
      byte_length: slice.size,
      cpu_type: slice.cpuType,
      cpu_subtype: slice.cpuSubtype,
      container_table_sha256: sha256Hex(tableBytes),
    },
    limitations,
  };
};

/**
 * Select the image for one inspection, or fail: the architecture field for a
 * missing or mismatched selection, and a malformed, truncated or unsupported
 * target at `path` for the universal file's own format failure.
 */
export const requireSelectedNativeImage = (
  operation: string,
  path: string,
  bytes: Buffer,
  architecture: MachoSliceArchitecture | undefined,
  input: SliceSelectionInput = SHARED_SLICE_SELECTION_INPUT,
): SelectedNativeImage => {
  const selected = selectMachoSlice(bytes, {
    mode: "architecture",
    architecture,
    input,
  });
  if (selected.ok) return selected.value;
  throw selectionError(operation, path, selected.error, input);
};
