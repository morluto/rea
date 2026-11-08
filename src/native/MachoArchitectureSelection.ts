import { machoCpuSubtypeBase } from "../domain/apple/machoCpuIdentity.js";
import type { LipoArchitecture } from "./parsers/lipo.js";

export interface MachoArchitecturePolicy {
  readonly cpuType: number;
  readonly subtypes: readonly {
    readonly subtype: number;
    readonly name: string;
  }[];
  readonly variantName?: RegExp;
}

type MachoCpuSliceIdentity =
  | { readonly cpuType: number; readonly cpuSubtype: number }
  | { readonly cpuType: number; readonly cpuSubtypeBase: number };

const sliceCpuSubtypeBase = (slice: MachoCpuSliceIdentity): number =>
  "cpuSubtypeBase" in slice
    ? slice.cpuSubtypeBase
    : machoCpuSubtypeBase(slice.cpuSubtype);

/** One preference order for FAT subtype identities and Apple tool slice names. */
export const MACHO_ARCHITECTURE_POLICIES: Readonly<
  Record<string, MachoArchitecturePolicy>
> = {
  x86: { cpuType: 7, subtypes: [{ subtype: 3, name: "i386" }] },
  x86_64: {
    cpuType: 0x01000007,
    subtypes: [{ subtype: 3, name: "x86_64" }],
  },
  arm: { cpuType: 12, subtypes: [], variantName: /^arm$/u },
  arm64: {
    cpuType: 0x0100000c,
    subtypes: [
      { subtype: 0, name: "arm64" },
      { subtype: 2, name: "arm64e" },
      { subtype: 1, name: "arm64v8" },
    ],
    variantName: /^arm64e\.[A-Za-z0-9_]+$/u,
  },
  arm64_32: {
    cpuType: 0x0200000c,
    subtypes: [{ subtype: 1, name: "arm64_32" }],
  },
};

/** Unlisted subtypes follow the preferred slices in FAT table order. */
export const machoSubtypeRank = (
  policy: MachoArchitecturePolicy,
  subtype: number,
): number => {
  const rank = policy.subtypes.findIndex(
    (candidate) => candidate.subtype === machoCpuSubtypeBase(subtype),
  );
  return rank < 0 ? policy.subtypes.length : rank;
};

/**
 * Whether a container declares the same `(cpuType, cpuSubtypeBase)` more than
 * once for `cpuType`, leaving whole-container consumers without a unique slice.
 */
export const hasDuplicateMachoCpuSubtype = (
  cpuType: number,
  slices: readonly MachoCpuSliceIdentity[],
): boolean => {
  const seen = new Set<number>();
  for (const slice of slices) {
    if (slice.cpuType !== cpuType) continue;
    const base = sliceCpuSubtypeBase(slice);
    if (seen.has(base)) return true;
    seen.add(base);
  }
  return false;
};

export type RankedMachoSliceSelection<T> =
  | { readonly status: "selected"; readonly slice: T }
  | { readonly status: "absent" }
  | { readonly status: "ambiguous" };

/**
 * Select one slice for `policy` by subtype preference, keeping FAT table order
 * across distinct equal-ranked subtypes and rejecting duplicate base subtypes at
 * the winning rank as ambiguous.
 */
export const selectRankedMachoSlice = <T extends MachoCpuSliceIdentity>(
  policy: MachoArchitecturePolicy,
  slices: readonly T[],
): RankedMachoSliceSelection<T> => {
  let best: T | undefined;
  let bestBase = 0;
  let bestRank = Number.POSITIVE_INFINITY;
  let ambiguous = false;
  for (const slice of slices) {
    if (slice.cpuType !== policy.cpuType) continue;
    const base = sliceCpuSubtypeBase(slice);
    const rank = machoSubtypeRank(policy, base);
    if (best !== undefined && rank >= bestRank) {
      // Equal ranks keep FAT table order unless the slices share a subtype.
      if (rank === bestRank && base === bestBase) ambiguous = true;
      continue;
    }
    best = slice;
    bestBase = base;
    bestRank = rank;
    ambiguous = false;
  }
  if (best === undefined) return { status: "absent" };
  return ambiguous
    ? { status: "ambiguous" }
    : { status: "selected", slice: best };
};

/** codesign's architecture name for one FAT CPU identity, when known. */
const codeSignArchitectureName = (
  cpuType: number,
  cpuSubtype: number,
): string | undefined => {
  const capabilities = (cpuSubtype >>> 24) & 0xff;
  const base = machoCpuSubtypeBase(cpuSubtype);
  // codesign names arm64e by its base subtype whatever its versioned
  // pointer-authentication ABI (CPU_SUBTYPE_PTRAUTH_ABI plus a version), and
  // x86_64 LIB64 as x86_64. Other capability variants may have distinct
  // names; do not collapse them.
  if (
    capabilities !== 0 &&
    !(cpuType === 0x0100000c && base === 2 && (capabilities & 0xf0) === 0x80) &&
    !(cpuType === 0x01000007 && base === 3 && capabilities === 0x80)
  )
    return undefined;
  return Object.values(MACHO_ARCHITECTURE_POLICIES)
    .find((policy) => policy.cpuType === cpuType)
    ?.subtypes.find(({ subtype }) => subtype === base)?.name;
};

/**
 * Return the codesign selector that names exactly the FAT slice at `index`.
 * codesign resolves a name to the first slice in table order with that CPU
 * type and base subtype, whatever its capability bits. A later slice sharing
 * them has no exact selector, even behind an earlier variant whose own name
 * is unknown.
 */
export const machoKnownCodeSignSelector = (
  slices: readonly { readonly cpuType: number; readonly cpuSubtype: number }[],
  index: number,
): string | undefined => {
  const slice = slices[index];
  if (slice === undefined) return undefined;
  const base = machoCpuSubtypeBase(slice.cpuSubtype);
  return slices.findIndex(
    (other) =>
      other.cpuType === slice.cpuType &&
      machoCpuSubtypeBase(other.cpuSubtype) === base,
  ) === index
    ? codeSignArchitectureName(slice.cpuType, slice.cpuSubtype)
    : undefined;
};

/** Keep the selected lipo record, including its container coordinates. */
export const selectMachoArchitecture = (
  policy: MachoArchitecturePolicy,
  available: readonly LipoArchitecture[],
): LipoArchitecture | undefined => {
  let selected: LipoArchitecture | undefined;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const architecture of available) {
    if (
      architecture.cpu_type_code !== null &&
      architecture.cpu_type_code !== policy.cpuType
    )
      continue;
    const namedSubtype = policy.subtypes.find(
      ({ name }) => name === architecture.name,
    );
    const recognizedName =
      namedSubtype !== undefined || policy.variantName?.test(architecture.name);
    if (
      !recognizedName &&
      (architecture.cpu_type_code === null ||
        architecture.cpu_subtype_base === null)
    )
      continue;
    // Parsed identity is authoritative. Names support thin/partial lipo records.
    const subtype = architecture.cpu_subtype_base ?? namedSubtype?.subtype;
    const rank =
      subtype === undefined
        ? policy.subtypes.length
        : machoSubtypeRank(policy, subtype);
    if (rank >= bestRank) continue;
    selected = architecture;
    bestRank = rank;
  }
  return selected;
};

/** lipo may label ARM64 V8 as arm64 even though tools select it as arm64v8. */
export const machoToolArchitectureName = (
  policy: MachoArchitecturePolicy,
  architecture: LipoArchitecture,
): string => {
  const named = policy.subtypes.find(({ name }) => name === architecture.name);
  const actual = policy.subtypes.find(
    ({ subtype }) => subtype === architecture.cpu_subtype_base,
  );
  return named !== undefined && actual !== undefined && named !== actual
    ? actual.name
    : architecture.name;
};
