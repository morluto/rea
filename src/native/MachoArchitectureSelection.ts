import { machoCpuSubtypeBase } from "../domain/apple/machoCpuIdentity.js";
import type { LipoArchitecture } from "./parsers/lipo.js";

interface MachoArchitecturePolicy {
  readonly cpuType: number;
  readonly subtypes: readonly {
    readonly subtype: number;
    readonly name: string;
  }[];
  readonly variantName?: RegExp;
}

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

/** Select a tool spelling using the same preference order as FAT selection. */
export const selectMachoArchitectureName = (
  policy: MachoArchitecturePolicy,
  available: readonly LipoArchitecture[],
): string | undefined => {
  let selected: string | undefined;
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
    selected = architecture.name;
    bestRank = rank;
  }
  return selected;
};
