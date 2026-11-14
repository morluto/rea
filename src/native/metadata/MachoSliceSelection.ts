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
): Result<SelectedNativeImage, MachoSliceSelectionIssue> => {
  const container = readUniversalMachoImage(bytes);
  if (!container.ok) return container;
  const fat = container.value;
  if (fat === null)
    return architecture === undefined
      ? ok({ bytes, fileOffset: 0, selection: null, limitations: [] })
      : err({
          kind: "architecture",
          message: `architecture ${architecture} was selected, but the file is not a universal Mach-O; omit architecture.`,
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
        value !== architecture && verifiedSliceFor(value) !== undefined,
    );
    const select =
      choices.length === 0
        ? ""
        : ` Select architecture ${choices.join(" or ")}.`;
    return err({
      kind: "architecture",
      message:
        sameFamily.length === 0
          ? `Universal Mach-O holds ${available}, not ${architecture}.${select}`
          : matches.length === 0 && namesSubtype(architecture)
            ? `Universal Mach-O holds ${available}; no slice has the ${architecture} subtype.${select}`
            : `Universal Mach-O holds several ${architecture} slices (${available}); no slice was selected.${select}`,
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
        return `${place} (unverified: ${issue}; no architecture value reads it)`;
      const selector = familyValues(architecture).find(
        (value) => verifiedSliceFor(value) === other,
      );
      return `${place} (${selector === undefined ? "no architecture value selects it" : `architecture ${selector} selects it`})`;
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
            `Only the selected ${architecture} slice (${cpuName(slice.cpuType, slice.cpuSubtype)} at file offset ${String(slice.offset)}) was read; this universal Mach-O also holds ${unread.join(", ")}.`,
          ],
  });
};

/**
 * Select the image for one inspection, or fail with the input to correct:
 * `architecture` for a missing or mismatched selection, `path` for a malformed
 * universal container.
 */
export const requireSelectedNativeImage = (
  operation: string,
  path: string,
  bytes: Buffer,
  architecture: MachoSliceArchitecture | undefined,
): SelectedNativeImage => {
  const selected = selectNativeImage(bytes, architecture);
  if (selected.ok) return selected.value;
  const { kind, message } = selected.error;
  throw new AnalysisInputError(operation, undefined, [
    kind === "architecture"
      ? { path: ["architecture"], reason: "invalid_value", message }
      : {
          path: ["path"],
          reason: "invalid_format",
          message: `Selected artifact ${path}: ${message}`,
        },
  ]);
};
