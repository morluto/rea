import {
  ARM64_32_HOST_SUBTYPE_PREFERENCE,
  ARM64_HOST_SUBTYPE_PREFERENCE,
  machoCpuSubtypeBase,
  X86_64_HOST_SUBTYPE_PREFERENCE,
  X86_HOST_SUBTYPE_PREFERENCE,
} from "../domain/apple/machoCpuIdentity.js";
import { keyedBy, uniqueKeyed } from "../domain/keyedCollection.js";
import { err, ok, type Result } from "../domain/result.js";
import type {
  AdmittedMachoSlice,
  MachoSliceSelectionRefusal,
} from "./metadata/MachoSliceSelection.js";
import type { LipoArchitecture } from "../domain/apple/lipo.js";

/** Apple tool names for the domain-owned host subtype preference. */
const preferredSubtypes = <Subtype extends number>(
  order: readonly Subtype[],
  names: { readonly [Key in Subtype]: string },
): { readonly subtype: Subtype; readonly name: string }[] =>
  order.map((subtype) => ({ subtype, name: names[subtype] }));

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

/**
 * Each policy's subtypes by Apple tool name. The table is this module's
 * static configuration, and every name in it is distinct, so a name lookup
 * selects no member of parsed data.
 */
const SUBTYPES_BY_NAME: ReadonlyMap<
  MachoArchitecturePolicy,
  ReadonlyMap<string, MachoArchitecturePolicy["subtypes"][number]>
> = new Map(
  Object.values(MACHO_ARCHITECTURE_POLICIES).map((policy) => [
    policy,
    new Map(policy.subtypes.map((subtype) => [subtype.name, subtype])),
  ]),
);

const subtypeNamed = (policy: MachoArchitecturePolicy, name: string) =>
  SUBTYPES_BY_NAME.get(policy)?.get(name);

/** Unlisted subtypes follow the preferred slices in FAT table order. */
const machoSubtypeRank = (
  policy: MachoArchitecturePolicy,
  subtype: number,
): number => {
  const rank = policy.subtypes.findIndex(
    (candidate) => candidate.subtype === machoCpuSubtypeBase(subtype),
  );
  return rank < 0 ? policy.subtypes.length : rank;
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
const selectPreferredArchitecture = (
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
    const namedSubtype = subtypeNamed(policy, architecture.name);
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
const machoToolArchitectureName = (
  policy: MachoArchitecturePolicy,
  architecture: LipoArchitecture,
): string => {
  const named = subtypeNamed(policy, architecture.name);
  const actual = policy.subtypes.find(
    ({ subtype }) => subtype === architecture.cpu_subtype_base,
  );
  return named !== undefined && actual !== undefined && named !== actual
    ? actual.name
    : architecture.name;
};

/**
 * lipo appends the pointer-auth ABI version to arm64e (`arm64e.v1`). Only
 * dyld_info accepts that spelling; the other Apple tools select the slice by
 * its CPU-family name. Other variants are distinct subtypes (`arm64e.x1`)
 * that the tools address only by their exact name.
 */
export const architectureBaseName = (architecture: string): string =>
  architecture.replace(/\.v\d+$/u, "");

/** The lipo record one request addresses, and the name tools select it by. */
export interface SelectedLipoArchitecture {
  readonly architecture: LipoArchitecture;
  readonly toolName: string;
}

/**
 * Select the lipo record slice tools read, in the same modes as
 * `selectMachoSlice`: an admitted universal slice by its file range, or a
 * caller's architecture by CPU policy (by lipo name when REA has no policy
 * for it). A selector that tools would resolve to more than one record is
 * refused rather than associated with one record's offset.
 */
export const selectLipoArchitecture = (
  request:
    | {
        readonly mode: "admitted";
        readonly architecture: string;
        readonly slice: AdmittedMachoSlice;
      }
    | { readonly mode: "architecture"; readonly architecture: string },
  available: readonly LipoArchitecture[],
): Result<SelectedLipoArchitecture, MachoSliceSelectionRefusal> => {
  const policy = MACHO_ARCHITECTURE_POLICIES[request.architecture];
  const toolName = (record: LipoArchitecture): string =>
    policy === undefined
      ? record.name
      : machoToolArchitectureName(policy, record);
  const spelled =
    request.architecture === "x86" ? "i386" : request.architecture;
  const absent = (
    kind: "architecture_not_present" | "admitted_slice_mismatch",
  ): Result<never, MachoSliceSelectionRefusal> =>
    err({
      kind,
      message: `lipo did not list ${spelled}; refusing to read another slice`,
    });
  const ambiguous = (
    selector: string,
  ): Result<never, MachoSliceSelectionRefusal> =>
    err({
      kind: "ambiguous_architecture",
      message: `lipo listed multiple slices addressable as ${selector}; refusing to associate a slice offset with an ambiguous tool selection`,
    });
  if (request.mode === "admitted") {
    const { slice } = request;
    const matches = available.filter(
      (candidate) =>
        candidate.file_offset === slice.offset &&
        (candidate.size === null || candidate.size === slice.size),
    );
    const [admitted] = matches;
    if (admitted === undefined) return absent("admitted_slice_mismatch");
    if (matches.length > 1) return ambiguous(spelled);
    return ok({ architecture: admitted, toolName: toolName(admitted) });
  }
  let selected: LipoArchitecture | undefined;
  if (policy === undefined) {
    const named = uniqueKeyed(
      keyedBy(available, ({ name }) => name),
      spelled,
    );
    if (!named.ok) return ambiguous(spelled);
    selected = named.value;
  } else selected = selectPreferredArchitecture(policy, available);
  if (selected === undefined) return absent("architecture_not_present");
  const name = toolName(selected);
  const selector = architectureBaseName(name);
  return available.some(
    (candidate) =>
      candidate !== selected &&
      architectureBaseName(toolName(candidate)) === selector,
  )
    ? ambiguous(selector)
    : ok({ architecture: selected, toolName: name });
};
