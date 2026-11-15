import {
  ARM64_32_HOST_SUBTYPE_PREFERENCE,
  ARM64_HOST_SUBTYPE_PREFERENCE,
  machoCpuSubtypeBase,
  X86_64_HOST_SUBTYPE_PREFERENCE,
  X86_HOST_SUBTYPE_PREFERENCE,
} from "./machoCpuIdentity.js";

/** Domain-owned subtype preference order for one Mach-O CPU family. */
const preferredSubtypes = <Subtype extends number>(
  order: readonly Subtype[],
  names: { readonly [Key in Subtype]: string },
): { readonly subtype: Subtype; readonly name: string }[] =>
  order.map((subtype) => ({ subtype, name: names[subtype] }));

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
  x86: {
    cpuType: 7,
    subtypes: preferredSubtypes(X86_HOST_SUBTYPE_PREFERENCE, { 3: "i386" }),
  },
  x86_64: {
    cpuType: 0x01000007,
    subtypes: preferredSubtypes(X86_64_HOST_SUBTYPE_PREFERENCE, {
      3: "x86_64",
    }),
  },
  arm: { cpuType: 12, subtypes: [], variantName: /^arm$/u },
  arm64: {
    cpuType: 0x0100000c,
    subtypes: preferredSubtypes(ARM64_HOST_SUBTYPE_PREFERENCE, {
      0: "arm64",
      2: "arm64e",
      1: "arm64v8",
    }),
    variantName: /^arm64e\.[A-Za-z0-9_]+$/u,
  },
  arm64_32: {
    cpuType: 0x0200000c,
    subtypes: preferredSubtypes(ARM64_32_HOST_SUBTYPE_PREFERENCE, {
      1: "arm64_32",
    }),
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
