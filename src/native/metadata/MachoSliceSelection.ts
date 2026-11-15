import { createHash } from "node:crypto";

import {
  readUniversalMachoImage,
  readUniversalMachoSlice,
} from "../../domain/apple/machoImageSelection.js";
import {
  MACHO_CPU_TYPES,
  machoSliceFamily,
  machoSliceSubtypeSelector,
  type MachoSliceArchitecture,
  type MachoTargetSelection,
} from "../../domain/apple/machoTargetSelection.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { err, ok, type Result } from "../../domain/result.js";

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
 * The caller's input fields and spellings for a slice selection. Messages name
 * selectors through `spelling`, and a selector without a spelling is never
 * offered as a choice.
 */
export interface SliceSelectionInput {
  readonly pathField: string;
  readonly architectureField: string;
  readonly spelling: Readonly<Partial<Record<MachoSliceArchitecture, string>>>;
}

/** The shared `path` and `architecture` inputs, spelled as the selector values. */
export const SHARED_SLICE_SELECTION_INPUT: SliceSelectionInput = {
  pathField: "path",
  architectureField: "architecture",
  spelling: {
    x86: "x86",
    x86_64: "x86_64",
    arm: "arm",
    arm64: "arm64",
    arm64e: "arm64e",
  },
};

/** Why no image could be selected; `architecture` issues are the caller's to correct. */
export interface MachoSliceSelectionIssue {
  readonly kind: "architecture" | "malformed";
  readonly message: string;
}

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

/**
 * Select the thin image to inspect without lipo. A universal Mach-O needs the
 * caller's architecture. A family name selects the family's only slice; when
 * several slices share the family, the value must name one slice's subtype
 * exactly, and no slice is chosen by preference. Any other file is returned
 * whole and rejects an architecture rather than ignoring it.
 */
export const selectNativeImage = (
  bytes: Buffer,
  architecture: MachoSliceArchitecture | undefined,
  input: SliceSelectionInput = SHARED_SLICE_SELECTION_INPUT,
): Result<SelectedNativeImage, MachoSliceSelectionIssue> => {
  const field = input.architectureField;
  const spelled = (value: MachoSliceArchitecture): string =>
    input.spelling[value] ?? value;
  const container = readUniversalMachoImage(bytes);
  if (!container.ok) return container;
  const fat = container.value;
  if (fat === null)
    return architecture === undefined
      ? ok({ bytes, fileOffset: 0, selection: null, limitations: [] })
      : err({
          kind: "architecture",
          message: `${field} ${spelled(architecture)} was selected, but the file is not a universal Mach-O; omit ${field}.`,
        });
  const available = fat.slices
    .map(({ cpuType, cpuSubtype }) => cpuName(cpuType, cpuSubtype))
    .join(", ");
  if (architecture === undefined)
    return err({
      kind: "architecture",
      message: `Universal Mach-O holds ${available}; select one architecture.`,
    });
  const sameFamily = fat.slices.filter(
    ({ cpuType }) =>
      cpuType === MACHO_CPU_TYPES[machoSliceFamily(architecture)],
  );
  // Selectors are advertised only for slices whose header agrees with their
  // FAT declaration; an unverified declaration is not a working choice.
  const identityIssues = new Map(
    sameFamily.map((declared) => {
      const read = readUniversalMachoSlice(bytes, fat, declared);
      return [declared, read.ok ? undefined : read.error.message] as const;
    }),
  );
  const verifiedSliceFor = (value: MachoSliceArchitecture) => {
    const addressed = addressedSlices(sameFamily, value);
    return addressed.length === 1 &&
      addressed[0] !== undefined &&
      identityIssues.get(addressed[0]) === undefined
      ? addressed[0]
      : undefined;
  };
  const matches = addressedSlices(sameFamily, architecture);
  const [slice] = matches;
  if (slice === undefined || matches.length > 1) {
    const choices = familyValues(architecture).filter(
      (value) =>
        value !== architecture &&
        input.spelling[value] !== undefined &&
        verifiedSliceFor(value) !== undefined,
    );
    const select =
      choices.length === 0
        ? ""
        : ` Select ${field} ${choices.map(spelled).join(" or ")}.`;
    return err({
      kind: "architecture",
      message:
        sameFamily.length === 0
          ? `Universal Mach-O holds ${available}, not ${spelled(architecture)}.${select}`
          : matches.length === 0 && namesSubtype(architecture)
            ? `Universal Mach-O holds ${available}; no slice has the ${spelled(architecture)} subtype.${select}`
            : `Universal Mach-O holds several ${spelled(architecture)} slices (${available}); no slice was selected.${select}`,
    });
  }
  const selected = readUniversalMachoSlice(bytes, fat, slice);
  if (!selected.ok) return selected;
  const unread = sameFamily
    .filter((other) => other !== slice)
    .map((other) => {
      const place = `${cpuName(other.cpuType, other.cpuSubtype)} at file offset ${String(other.offset)}`;
      const issue = identityIssues.get(other);
      if (issue !== undefined)
        return `${place} (unverified: ${issue}; no ${field} value reads it)`;
      const selector = familyValues(architecture).find(
        (value) =>
          input.spelling[value] !== undefined &&
          verifiedSliceFor(value) === other,
      );
      return `${place} (${selector === undefined ? `no ${field} value selects it` : `${field} ${spelled(selector)} selects it`})`;
    });
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
      container_table_sha256: createHash("sha256")
        .update(bytes.subarray(0, fat.tableEnd))
        .digest("hex"),
    },
    limitations:
      unread.length === 0
        ? []
        : [
            `Only the selected ${spelled(architecture)} slice (${cpuName(slice.cpuType, slice.cpuSubtype)} at file offset ${String(slice.offset)}) was read; this universal Mach-O also holds ${unread.join(", ")}.`,
          ],
  });
};

/**
 * Select the image for one inspection, or fail with the input to correct:
 * the architecture field for a missing or mismatched selection, the path field
 * for a malformed universal container.
 */
export const requireSelectedNativeImage = (
  operation: string,
  path: string,
  bytes: Buffer,
  architecture: MachoSliceArchitecture | undefined,
  input: SliceSelectionInput = SHARED_SLICE_SELECTION_INPUT,
): SelectedNativeImage => {
  const selected = selectNativeImage(bytes, architecture, input);
  if (selected.ok) return selected.value;
  const { kind, message } = selected.error;
  throw new AnalysisInputError(operation, undefined, [
    kind === "architecture"
      ? { path: [input.architectureField], reason: "invalid_value", message }
      : {
          path: [input.pathField],
          reason: "invalid_format",
          message: `Selected artifact ${path}: ${message}`,
        },
  ]);
};
