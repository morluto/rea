import type {
  BinaryTarget,
  ElfSectionExtent,
  ElfSectionOverlap,
  ElfSectionWitness,
  RiscvElfMetadata,
  RiscvIsaDeclaration,
} from "../domain/binaryTargetTypes.js";
import type { JsonValue } from "../domain/jsonValue.js";
import {
  riscvAbiName,
  riscvFloatAbi,
  type RiscvFloatAbi,
} from "../domain/riscvIsaDeclaration.js";
import type { GhidraLanguageOverride } from "../config/ghidraLanguageOverride.js";

/** Calling-convention policy ids an analysis profile can commit. */
export const GHIDRA_RISCV_CALLING_CONVENTION_IDS = [
  "ilp32-prototype-v1",
  "ilp32f-prototype-v1",
] as const;
export type GhidraRiscvCallingConvention =
  (typeof GHIDRA_RISCV_CALLING_CONVENTION_IDS)[number];

/**
 * The ABI and prototype of each policy REA applies after analysis.
 * `ReaGhidraRiscvCallingConvention.java` derives each prototype from the
 * pinned language's default `riscv32-fp.cspec` model, which is ilp32d;
 * docs/providers/ghidra-riscv.md states the rules of each ABI.
 */
const GHIDRA_RISCV_CALLING_CONVENTIONS: Readonly<
  Record<
    GhidraRiscvCallingConvention,
    { readonly abi: string; readonly prototype: string }
  >
> = {
  "ilp32-prototype-v1": { abi: "ilp32", prototype: "__rea_ilp32" },
  "ilp32f-prototype-v1": { abi: "ilp32f", prototype: "__rea_ilp32f" },
};

/** Admitted load models for each lane. */
type GhidraRiscvLoadModel = "exec" | "pie";

/** One admitted ELF class and declared float ABI. */
interface GhidraRiscvLane {
  readonly elfClass: 32 | 64;
  readonly floatAbi: RiscvFloatAbi;
  readonly loadModels: readonly GhidraRiscvLoadModel[];
  /** Absent: Ghidra's stock double-float model applies unchanged. */
  readonly callingConvention?: GhidraRiscvCallingConvention;
  /** Extensions `Tag_RISCV_arch` must declare for the float ABI to exist. */
  readonly requiredExtensions?: readonly string[];
  /** Extensions the lane's model is wrong with, and what goes wrong. */
  readonly excludedExtensions?: {
    readonly names: readonly string[];
    readonly reason: string;
  };
}

/** Every class and float ABI pair the Ghidra lane admits; others are refused. */
const GHIDRA_RISCV_LANES: readonly GhidraRiscvLane[] = [
  { elfClass: 64, floatAbi: "double", loadModels: ["exec", "pie"] },
  { elfClass: 32, floatAbi: "double", loadModels: ["exec", "pie"] },
  {
    elfClass: 32,
    floatAbi: "soft",
    loadModels: ["exec"],
    callingConvention: "ilp32-prototype-v1",
  },
  {
    elfClass: 32,
    floatAbi: "single",
    loadModels: ["exec"],
    callingConvention: "ilp32f-prototype-v1",
    requiredExtensions: ["f"],
    excludedExtensions: {
      names: ["d", "zcd"],
      reason:
        "ilp32f then preserves only the low 32 bits of fs0-fs11 across calls, and Ghidra's model preserves all 64",
    },
  },
];

/** Lane ids are built from their fields, so a new ABI or load model adds a value. */
const ghidraRiscvSupportLane = (lane: {
  readonly elfClass: 32 | 64;
  readonly floatAbi: RiscvFloatAbi;
  readonly loadModel?: GhidraRiscvLoadModel;
}): string =>
  `elf${lane.elfClass}-${lane.loadModel ?? "exec"}-le-${lane.floatAbi}-float-generic-v1`;

/**
 * Extensions Ghidra 12.1.4's generic RV32 language implements with p-code, by
 * the names `Tag_RISCV_arch` records. Lanes with a calling-convention policy
 * admit an image only when it declares an RV32I base and only these.
 */
const GHIDRA_RISCV32_DECODED_EXTENSIONS: ReadonlySet<string> = new Set([
  "m",
  "a",
  "f",
  "d",
  "c",
  "zicsr",
  "zifencei",
  "zmmul",
  "zaamo",
  "zalrsc",
  "zca",
  "zcf",
  "zcd",
]);

/** The memory-map preparation policy an analysis profile can commit. */
export const GHIDRA_RISCV_LOAD_PREPARATION = "nobits-reservation-overlay-v1";

/**
 * Before analysis, `ReaGhidraPrepareElfLoad.java` gives an executable section
 * that a NOBITS reservation shares addresses with the default address space,
 * and the reservation an overlay instead.
 */
export interface GhidraRiscvLoadPreparation {
  readonly policy: typeof GHIDRA_RISCV_LOAD_PREPARATION;
  readonly code: ElfSectionExtent & { readonly offset: string };
  readonly reservation: ElfSectionExtent;
}

/** A memory block as the pre-analysis script left it, and its space before. */
export interface GhidraPreparedBlock {
  readonly name: string;
  readonly address: string;
  readonly size: string;
  readonly space_before: string;
  readonly space_after: string;
}

/**
 * Outcome the pre-analysis script records for the bridge handshake. It echoes
 * the blocks it found, so the client compares them with the committed sections.
 */
export type GhidraRiscvLoadPreparationReport =
  | {
      readonly policy: typeof GHIDRA_RISCV_LOAD_PREPARATION;
      readonly outcome: "moved";
      readonly code: GhidraPreparedBlock & { readonly file_offset: string };
      readonly reservation: GhidraPreparedBlock;
      readonly functions: number;
      readonly entry_points: number;
      readonly reservation_labels: number;
    }
  | {
      readonly policy: typeof GHIDRA_RISCV_LOAD_PREPARATION;
      readonly outcome: "canonical";
      readonly code: GhidraPreparedBlock & { readonly file_offset: string };
    }
  | {
      readonly policy: typeof GHIDRA_RISCV_LOAD_PREPARATION;
      readonly refused: string;
    };

/**
 * Outcome the post-analysis script records for the bridge handshake. Every
 * policy instead refuses an image whose DWARF defines functions in a language
 * other than C, C++ or assembly, and the ilp32f policy also refuses one whose
 * signatures its prototype misplaces.
 */
export type GhidraRiscvCallingConventionReport =
  | {
      readonly policy: GhidraRiscvCallingConvention;
      readonly functions: number;
      readonly definitions: number;
    }
  | { readonly policy: GhidraRiscvCallingConvention; readonly refused: string };

/**
 * Bound on the bridge's refusal reason. The script names at most eight
 * signatures, each cut to 160 characters, so a longer report is malformed.
 */
export const GHIDRA_RISCV_REFUSAL_MAX_LENGTH = 2048;

const EF_RISCV_RVC = 0x0001;
const EF_RISCV_FLOAT_ABI = 0x0006;
const EF_RISCV_RVE = 0x0008;
const EF_RISCV_TSO = 0x0010;

const ET_REL = 1;
const ET_EXEC = 2;
const ET_DYN = 3;

/**
 * Bits this lane reads. Anything else in `e_flags` — reserved today or defined by
 * a newer psABI — is refused rather than assumed compatible.
 */
const EF_RISCV_DECLARED_BITS = EF_RISCV_RVC | EF_RISCV_FLOAT_ABI;

/** The lane a class and declared float ABI select, if the table admits one. */
const ghidraRiscvLane = (
  metadata: RiscvElfMetadata,
): GhidraRiscvLane | undefined => {
  const floatAbi = riscvFloatAbi(metadata.flags);
  return GHIDRA_RISCV_LANES.find(
    (lane) => lane.elfClass === metadata.elfClass && lane.floatAbi === floatAbi,
  );
};

/** Name what a refused float ABI lacks, from the table admission reads. */
const ghidraRiscvFloatAbiRefusal = (metadata: RiscvElfMetadata): string => {
  const floatAbi = riscvFloatAbi(metadata.flags);
  const name = riscvAbiName(metadata.elfClass, floatAbi);
  const admitted = GHIDRA_RISCV_LANES.filter(
    (lane) => lane.elfClass === metadata.elfClass,
  ).map((lane) => `${lane.floatAbi}-float`);
  return `This Ghidra RISC-V lane admits ELF${metadata.elfClass} images that declare the ${
    admitted.length < 3
      ? admitted.join(" or ")
      : `${admitted.slice(0, -1).join(", ")} or ${admitted.slice(-1).join("")}`
  } ABI; the ${floatAbi}-float ABI${
    name === null ? "" : ` (${name})`
  } declared by e_flags has no verified calling-convention policy.`;
};

/**
 * Lanes with a calling-convention policy admit declared, decoded RV32I only,
 * with every extension their float ABI requires and none their model excludes.
 */
const ghidraRiscvIsaRefusal = (
  isa: RiscvIsaDeclaration | undefined,
  lane: GhidraRiscvLane,
): string | null => {
  if (isa === undefined)
    return "This RISC-V lane requires the image's .riscv.attributes ISA declaration, which was not inspected.";
  if (isa.status === "absent")
    return "This RISC-V lane requires a Tag_RISCV_arch declaration in .riscv.attributes; the image declares none, so its extensions are unknown.";
  if (isa.status === "unavailable")
    return `This RISC-V lane requires a readable Tag_RISCV_arch declaration: ${isa.reason}.`;
  if (isa.xlen !== 32 || isa.base !== "i")
    return `Tag_RISCV_arch declares ${isa.arch}; this lane requires the RV32I base.`;
  const outside = isa.extensions.filter(
    (extension) => !GHIDRA_RISCV32_DECODED_EXTENSIONS.has(extension),
  );
  if (outside.length > 0)
    return `Tag_RISCV_arch declares extensions outside the set this lane decodes: ${outside.join(
      ", ",
    )}. Ghidra 12.1.4's generic RV32 language implements only ${[
      ...GHIDRA_RISCV32_DECODED_EXTENSIONS,
    ].join(", ")} with p-code; see docs/providers/ghidra-riscv.md.`;
  const missing = (lane.requiredExtensions ?? []).filter(
    (extension) => !isa.extensions.includes(extension),
  );
  const name = riscvAbiName(lane.elfClass, lane.floatAbi);
  if (missing.length > 0)
    return `Tag_RISCV_arch declares ${isa.arch} without ${missing.join(
      ", ",
    )}, which the ${lane.floatAbi}-float ABI${
      name === null ? "" : ` (${name})`
    } declared by e_flags requires.`;
  const exclusion = lane.excludedExtensions;
  const excluded = (exclusion?.names ?? []).filter((extension) =>
    isa.extensions.includes(extension),
  );
  return exclusion === undefined || excluded.length === 0
    ? null
    : `Tag_RISCV_arch declares ${isa.arch} with ${excluded.join(", ")}: ${
        exclusion.reason
      }; see docs/providers/ghidra-riscv.md.`;
};

const sectionLabel = (extent: ElfSectionExtent): string =>
  extent.name === null || extent.name === ""
    ? `section [${extent.index}]`
    : `\`${extent.name}\``;

const witnessLabel = (witness: ElfSectionWitness): string =>
  `${sectionLabel(witness)} (${[
    ...(witness.executable ? ["executable"] : []),
    ...(witness.nobits ? ["NOBITS"] : []),
    `${witness.address}, ${witness.size} bytes`,
  ].join(", ")})`;

/**
 * Every lane needs the section table: a section that shares an executable
 * section's addresses decides where Ghidra 12.2 loads that code.
 */
const ghidraRiscvSectionOverlapRefusal = (
  overlap: ElfSectionOverlap | undefined,
  loadModel: GhidraRiscvLoadModel,
): string | null => {
  if (overlap === undefined)
    return "This RISC-V lane requires the image's section table, which was not inspected; overlapping sections decide where Ghidra loads code.";
  if (overlap.status === "unavailable")
    return `This RISC-V lane requires a readable section table: ${overlap.reason}.`;
  if (overlap.status === "code-reservation" && loadModel === "pie")
    return `Section ${sectionLabel(overlap.reservation)} reserves the addresses of executable section ${sectionLabel(overlap.code)}; this lane verifies that preparation for fixed-address ET_EXEC images only, so a position-independent executable (PIE) with it needs separate load verification.`;
  if (overlap.status !== "unsupported") return null;
  const [first, second] = overlap.witnesses;
  return `Sections ${witnessLabel(first)} and ${witnessLabel(second)} share addresses, so Ghidra 12.2's ELF loader would put one of them in an overlay address space. This lane prepares only one NOBITS section that starts at an executable PROGBITS section's address and covers it, with no other section overlapping either; see docs/providers/ghidra-riscv.md.`;
};

/**
 * Keep family recognition separate from the deliberately bounded Ghidra lane.
 *
 * Ghidra 12.1.4 selects `RISCV:LE:32:AndeStar_v5` for an ordinary RV32 ELF: its
 * `riscv.opinion` pins `variant="default"` for the 64-bit constraint and leaves
 * the 32-bit one with the comment that the loader "must choose between 'default'
 * and 'AndeStar' variants". The lane therefore pins the language instead of
 * accepting the header-based guess.
 */
export const ghidraRiscvUnsupportedReason = (
  target: BinaryTarget,
): string | null => {
  if (target.kind !== "executable" || target.architecture !== "riscv")
    return null;
  const metadata = target.riscv;
  if (target.format !== "elf")
    return "RISC-V analysis requires ELF header metadata; a family name alone does not select an ISA or ABI.";
  if (metadata.byteOrder !== "little")
    return "This Ghidra RISC-V lane supports little-endian images only; Ghidra 12.1.4 ships no big-endian RISC-V language.";
  if (metadata.elfClass !== 32 && metadata.elfClass !== 64)
    return "This Ghidra RISC-V lane requires ELF32 or ELF64; the class decides which generic language is pinned.";
  if ((metadata.flags & EF_RISCV_RVE) !== 0)
    return "EF_RISCV_RVE declares the embedded 16-register ABI (x0-x15), which needs its own processor specification and compiler verification.";
  if ((metadata.flags & EF_RISCV_TSO) !== 0)
    return "EF_RISCV_TSO declares the total-store-order memory model; this lane verifies the baseline model only.";
  if (metadata.type === ET_DYN && !metadata.hasInterpreter)
    return "This Ghidra RISC-V lane supports fixed-address ET_EXEC and position-independent executables (PIE) only; shared libraries without PT_INTERP need separate load verification.";
  if (metadata.type !== ET_EXEC && metadata.type !== ET_DYN)
    return `This Ghidra RISC-V lane supports fixed-address ET_EXEC and position-independent executables (PIE) only; ${
      metadata.type === ET_REL ? "relocatable" : `e_type ${metadata.type}`
    } images need separate load verification.`;
  const lane = ghidraRiscvLane(metadata);
  if (lane === undefined) return ghidraRiscvFloatAbiRefusal(metadata);
  const loadModel: GhidraRiscvLoadModel =
    metadata.type === ET_DYN ? "pie" : "exec";
  if (!lane.loadModels.includes(loadModel))
    return `This Ghidra RISC-V ${lane.floatAbi}-float lane supports fixed-address ET_EXEC only; position-independent executables (PIE) need separate load verification.`;
  const unsupportedFlags = (metadata.flags & ~EF_RISCV_DECLARED_BITS) >>> 0;
  if (unsupportedFlags !== 0)
    return `RISC-V e_flags declares bits outside the verified lane (0x${unsupportedFlags.toString(16)}); reserved or newer declarations are not treated as compatible with this profile.`;
  const isa =
    lane.callingConvention === undefined
      ? null
      : ghidraRiscvIsaRefusal(metadata.isa, lane);
  return (
    isa ?? ghidraRiscvSectionOverlapRefusal(metadata.sectionOverlap, loadModel)
  );
};

/** The memory-map preparation an admitted target's sections need, if any. */
export const ghidraRiscvLoadPreparation = (
  target: BinaryTarget,
): GhidraRiscvLoadPreparation | undefined => {
  if (
    target.kind !== "executable" ||
    target.architecture !== "riscv" ||
    ghidraRiscvUnsupportedReason(target) !== null
  )
    return undefined;
  const overlap = target.riscv.sectionOverlap;
  return overlap?.status === "code-reservation"
    ? {
        policy: GHIDRA_RISCV_LOAD_PREPARATION,
        code: overlap.code,
        reservation: overlap.reservation,
      }
    : undefined;
};

const sectionParameters = (
  extent: ElfSectionExtent,
): { [key: string]: JsonValue } => ({
  index: extent.index,
  name: extent.name,
  address: extent.address,
  size: extent.size,
});

/** The committed form of a preparation; the profile digest covers every field. */
export const ghidraRiscvLoadPreparationParameters = (
  preparation: GhidraRiscvLoadPreparation,
): JsonValue => ({
  policy: preparation.policy,
  code: {
    ...sectionParameters(preparation.code),
    offset: preparation.code.offset,
  },
  reservation: sectionParameters(preparation.reservation),
});

/** The calling-convention policy an admitted target's lane applies, if any. */
export const ghidraRiscvCallingConvention = (
  target: BinaryTarget,
): GhidraRiscvCallingConvention | undefined =>
  target.kind === "executable" &&
  target.architecture === "riscv" &&
  ghidraRiscvUnsupportedReason(target) === null
    ? ghidraRiscvLane(target.riscv)?.callingConvention
    : undefined;

/** Pin a language only for declarations admitted by the same lane boundary. */
export const ghidraRiscvLanguageOverride = (
  target: BinaryTarget,
): GhidraLanguageOverride | undefined =>
  target.kind === "executable" &&
  target.architecture === "riscv" &&
  ghidraRiscvUnsupportedReason(target) === null
    ? {
        languageId: `RISCV:LE:${target.riscv.elfClass}:default`,
        compilerSpecId: "gcc",
      }
    : undefined;

/**
 * Commit source ELF interpretation without confusing target ISA with host CPU.
 * Lanes with a calling-convention policy also commit the declarations that
 * admitted them; double-float profiles keep their original parameters.
 */
export const ghidraRiscvProfileParameters = (
  target: BinaryTarget,
): Readonly<Record<string, JsonValue>> => {
  if (
    target.kind !== "executable" ||
    target.architecture !== "riscv" ||
    target.riscv === undefined
  )
    return {};
  const isPie = target.riscv.type === ET_DYN;
  const floatAbi = riscvFloatAbi(target.riscv.flags);
  const convention = ghidraRiscvCallingConvention(target);
  const preparation = ghidraRiscvLoadPreparation(target);
  const isa = target.riscv.isa;
  return {
    riscv_elf: {
      elf_class: target.riscv.elfClass,
      byte_order: target.riscv.byteOrder,
      type: target.riscv.type,
      flags: target.riscv.flags,
      float_abi_double: floatAbi === "double",
      rvc_declared: (target.riscv.flags & EF_RISCV_RVC) !== 0,
      rve_declared: (target.riscv.flags & EF_RISCV_RVE) !== 0,
      tso_declared: (target.riscv.flags & EF_RISCV_TSO) !== 0,
      ...(convention === undefined || isa?.status !== "declared"
        ? {}
        : { float_abi: floatAbi, arch: isa.arch }),
      ...(isPie
        ? {
            has_interpreter: true,
            load_model: "pie",
            expected_default_image_base:
              target.riscv.elfClass === 32 ? "0x10000" : "0x100000",
          }
        : {}),
    },
    ...(convention === undefined
      ? {}
      : { riscv_calling_convention: convention }),
    // Present only when needed, so other images keep their profile digests.
    ...(preparation === undefined
      ? {}
      : {
          elf_load_preparation:
            ghidraRiscvLoadPreparationParameters(preparation),
        }),
    riscv_support_lane: ghidraRiscvSupportLane({
      elfClass: target.riscv.elfClass,
      floatAbi,
      ...(isPie ? { loadModel: "pie" } : {}),
    }),
  };
};

/** The pinned language is an analysis convention, not proof of the producer. */
export const ghidraRiscvLimitations = (
  target: BinaryTarget,
): readonly string[] => {
  if (target.kind !== "executable" || target.architecture !== "riscv")
    return [];
  const convention = ghidraRiscvCallingConvention(target);
  const floatAbi = riscvFloatAbi(target.riscv.flags);
  const isa = target.riscv.isa;
  return [
    `RISC-V ELF: REA pins Ghidra's generic \`RISCV:LE:${target.riscv.elfClass}:default\` language with the \`gcc\` compiler specification instead of accepting the loader's header-based choice, which selects \`RISCV:LE:32:AndeStar_v5\` for ordinary RV32 images on Ghidra 12.1.4.`,
    convention === undefined
      ? "The pinned generic language models the double-float ABI declared by `e_flags`; the declaration is recorded as an ELF fact and is not evidence of the original compiler or of verified instruction semantics."
      : `The ELF header declares the ${floatAbi}-float ABI (${
          GHIDRA_RISCV_CALLING_CONVENTIONS[convention].abi
        }); the pinned language's compiler specification models ilp32d, so REA applies its \`${
          GHIDRA_RISCV_CALLING_CONVENTIONS[convention].prototype
        }\` prototype instead. The declaration is recorded as an ELF fact and is not evidence of the original compiler.`,
    ...(convention !== undefined && isa?.status === "declared"
      ? [
          `\`.riscv.attributes\` declares \`${isa.arch}\`. Every declared extension is in the set this lane decodes; the declaration does not prove that every instruction belongs to it.`,
        ]
      : []),
    target.riscv.type === ET_DYN
      ? `Position-independent executable (PIE): Ghidra assigns analysis coordinates from its default image base (${target.riscv.elfClass === 32 ? "0x10000" : "0x100000"}). Runtime load addresses and dynamic linker relocation are not executed or verified by this lane.`
      : "Admission reads `e_type` and section overlaps: a fixed-address ET_EXEC declaration does not establish static linkage, and an ET_EXEC image's `PT_INTERP` and dynamic dependencies do not change its admission or analysis.",
  ];
};

/**
 * Fail closed unless the bridge applied exactly the committed policy. A policy
 * that refused the image's signatures is a failure with the bridge's reason.
 */
export const ghidraRiscvCallingConventionFailure = (
  expected: GhidraRiscvCallingConvention | undefined,
  report: GhidraRiscvCallingConventionReport | undefined,
): string | undefined =>
  expected !== report?.policy
    ? expected === undefined
      ? "The Ghidra session reported a RISC-V calling-convention policy that the profile did not commit."
      : `The Ghidra session did not report the committed RISC-V calling-convention policy ${expected}.`
    : report !== undefined && "refused" in report
      ? `RISC-V calling-convention policy ${report.policy} refused this image, so REA does not serve its analysis: ${report.refused} See docs/providers/ghidra-riscv.md.`
      : undefined;

/**
 * Compilers pass such a class through a hidden pointer. Ghidra keeps only its
 * fields, and GCC's DWARF does not record the rule, so no policy can detect it.
 */
export const GHIDRA_RISCV_HIDDEN_REFERENCE_LIMITATION =
  "Ghidra shows a C++ class with a non-trivial copy constructor or destructor as passed by value, although compilers pass it through a hidden pointer. REA cannot detect such a signature, so its storage is unverified.";

/**
 * The bridge refuses an image whose DWARF defines functions in another
 * language. Code that DWARF does not describe cannot be checked.
 */
export const GHIDRA_RISCV_SOURCE_LANGUAGE_LIMITATION =
  "REA refuses an image whose DWARF compile units define functions in a language other than C, C++ or assembly, because the prototype models the C psABI. Functions that no DWARF compile unit describes, such as every function of a stripped image, are not checked and are taken to follow the C psABI.";

/**
 * Ghidra's DWARF import erases what these types' ilp32f storage depends on: it
 * keeps no vector marker on an array, and resolves `_Atomic`, which GCC ignores
 * and Clang does not, to its base type.
 */
export const GHIDRA_RISCV_ERASED_TYPE_LIMITATION =
  "Ghidra's DWARF import erases two ilp32f distinctions, and REA does not refuse them, so their storage is unverified. A GNU vector in a structure shows as an array of floats, although compilers use integer registers. `_Atomic(float)` shows as a `float`, which matches GCC, although Clang uses integer registers.";

/** State the prototype REA applies, and its outcome once the bridge reports it. */
export const ghidraRiscvCallingConventionLimitations = (
  expected: GhidraRiscvCallingConvention | undefined,
  report?: GhidraRiscvCallingConventionReport,
): readonly string[] => {
  if (expected === undefined) return [];
  const { abi, prototype } = GHIDRA_RISCV_CALLING_CONVENTIONS[expected];
  return [
    `RISC-V ${abi}: Ghidra's generic RV32 compiler specification models ilp32d. After analysis REA installs a program-specific \`${prototype}\` prototype, derived from the default prototype by policy ${expected} (docs/providers/ghidra-riscv.md), and assigns it with dynamic storage to every function, external function and function definition. Thunks follow their targets.`,
    ...(report === undefined || "refused" in report
      ? []
      : [
          `RISC-V calling-convention outcome: ${report.functions} functions and ${report.definitions} function definitions use ${prototype}.`,
        ]),
    "Ghidra recovers a variadic call's arguments from the registers the caller writes, not from their types: a padding register can appear as an argument, and arguments after an unwritten register are omitted.",
    GHIDRA_RISCV_SOURCE_LANGUAGE_LIMITATION,
    GHIDRA_RISCV_HIDDEN_REFERENCE_LIMITATION,
    ...(expected === "ilp32f-prototype-v1"
      ? [GHIDRA_RISCV_ERASED_TYPE_LIMITATION]
      : []),
  ];
};

/** Where a prepared block must be, before and after the pre-analysis script. */
type PreparedSpaces = readonly [
  before: "default" | "overlay",
  after: "default" | "overlay",
];

/** The first echoed coordinate or space that differs from the committed section's. */
const preparedMismatch = (
  committed: ElfSectionExtent & { readonly offset?: string },
  block: GhidraPreparedBlock & { readonly file_offset?: string },
  [before, after]: PreparedSpaces,
  defaultSpace: string,
): string | undefined => {
  // Block names are display only, as section names are, so they are not compared.
  const coordinate = (
    [
      ["address", committed.address, block.address],
      ["size", committed.size, block.size],
      ["file offset", committed.offset, block.file_offset],
    ] as const
  ).find(
    ([, expected, reported]) => expected !== undefined && expected !== reported,
  );
  if (coordinate !== undefined)
    return `${sectionLabel(committed)}: Ghidra's block reports ${coordinate[0]} ${String(coordinate[2])}, not ${coordinate[1]}`;
  const space = (
    [
      ["before", before, block.space_before],
      ["after", after, block.space_after],
    ] as const
  ).find(
    ([, expected, reported]) =>
      (reported === defaultSpace) !== (expected === "default"),
  );
  return space === undefined
    ? undefined
    : `${sectionLabel(committed)}: Ghidra's block reports space \`${space[2]}\` ${space[0]} the preparation, not ${space[1] === "default" ? `the default space \`${defaultSpace}\`` : "an overlay space"}`;
};

/** Fail closed unless the pre-analysis script applied exactly the committed preparation. */
export const ghidraRiscvLoadPreparationFailure = (
  expected: GhidraRiscvLoadPreparation | undefined,
  report: GhidraRiscvLoadPreparationReport | undefined,
  defaultSpace: string,
): string | undefined => {
  if (expected === undefined)
    return report === undefined
      ? undefined
      : "The Ghidra session reported a RISC-V load preparation that the profile did not commit.";
  if (report === undefined)
    return `The Ghidra session did not report the committed RISC-V load preparation ${expected.policy}.`;
  if ("refused" in report)
    return `REA could not prepare Ghidra's memory map for ${sectionLabel(expected.code)}: ${report.refused}`;
  if (report.policy !== expected.policy)
    return `The Ghidra session did not report the committed RISC-V load preparation ${expected.policy}.`;
  // A moved code block and its reservation trade spaces; canonical code stays put.
  const mismatch =
    report.outcome === "moved"
      ? (preparedMismatch(
          expected.code,
          report.code,
          ["overlay", "default"],
          defaultSpace,
        ) ??
        preparedMismatch(
          expected.reservation,
          report.reservation,
          ["default", "overlay"],
          defaultSpace,
        ))
      : preparedMismatch(
          expected.code,
          report.code,
          ["default", "default"],
          defaultSpace,
        );
  return mismatch === undefined
    ? undefined
    : `The RISC-V load preparation did not act on the committed sections. ${mismatch}.`;
};

/** State the preparation REA applies, and its outcome once the bridge reports it. */
export const ghidraRiscvLoadPreparationLimitations = (
  expected: GhidraRiscvLoadPreparation | undefined,
  report?: GhidraRiscvLoadPreparationReport,
): readonly string[] => {
  if (expected === undefined) return [];
  const code = sectionLabel(expected.code);
  const reservation = sectionLabel(expected.reservation);
  return [
    `RISC-V ELF load layout: NOBITS section ${reservation} reserves the addresses of executable section ${code} (${expected.code.address}, ${expected.code.size} bytes). When the reservation follows the code in the section table, Ghidra 12.2's ELF loader puts the code in an overlay address space, which its DWARF import, call-frame entries and default-space references do not reach; see docs/providers/ghidra-riscv.md.`,
    report === undefined || "refused" in report
      ? `Before analysis REA moves ${code} out of such an overlay into the default address space, with the same file bytes and offsets, and keeps ${reservation} as an uninitialized overlay.`
      : report.outcome === "moved"
        ? `RISC-V load preparation outcome: before analysis REA moved ${code} from overlay space \`${report.code.space_before}\` into default space \`${report.code.space_after}\`, with the same file bytes and offsets, and kept ${reservation} as uninitialized overlay space \`${report.reservation.space_after}\`. Functions in the moved block: ${report.functions}; entry points: ${report.entry_points}; labels in the overlay: ${report.reservation_labels}.`
        : `RISC-V load preparation outcome: Ghidra loaded ${code} in default space \`${report.code.space_after}\`, so REA changed nothing.`,
  ];
};
