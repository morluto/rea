import type { ZipPackageFormat } from "./zipPackageFormat.js";

/** Provider-neutral CPU families detected from supported executable headers. */
export const BINARY_ARCHITECTURES = [
  "x86",
  "x86_64",
  "arm",
  "arm64",
  "mips",
  "riscv",
] as const;
export type BinaryArchitecture = (typeof BINARY_ARCHITECTURES)[number];

/**
 * ELF header facts for a family whose ISA and ABI are not established by the
 * family name alone. Consumers admit a lane from these declarations rather than
 * re-reading the header.
 */
export interface ElfFamilyMetadata {
  readonly elfClass: 32 | 64;
  readonly byteOrder: "little" | "big";
  readonly type: number;
  readonly flags: number;
}

/** Families whose parsed target variant carries `ElfFamilyMetadata`. */
export const ELF_METADATA_ARCHITECTURES = [
  "mips",
  "riscv",
] as const satisfies readonly BinaryArchitecture[];
export type ElfMetadataArchitecture =
  (typeof ELF_METADATA_ARCHITECTURES)[number];

/** Families whose ISA and ABI need a separate ELF declaration to be admitted. */
export const isElfMetadataArchitecture = (
  architecture: BinaryArchitecture,
): architecture is ElfMetadataArchitecture =>
  (ELF_METADATA_ARCHITECTURES as readonly string[]).includes(architecture);

/** Recognized family with no ELF metadata member; the header alone is the fact. */
export type HeaderArchitecture = Exclude<
  BinaryArchitecture,
  ElfMetadataArchitecture
>;

/** Raw ELF facts; family recognition does not establish ISA or ABI support. */
export interface MipsElfMetadata extends ElfFamilyMetadata {
  /** Undefined until inspected; null means no ABI record was observed. */
  readonly abiFlags?: MipsAbiFlags | null;
  /** Unavailable declaration sources; missing records there remain unknown. */
  readonly limitations?: readonly string[];
  /** Complete dynamic REL declarations, or the reason they could not be inspected. */
  readonly sharedLoad?:
    | {
        readonly status: "complete";
        readonly relocationCount: number;
        readonly relocationTypes: readonly number[];
        readonly symbolRelativeCount: number;
      }
    | { readonly status: "unavailable"; readonly reason: string };
}

/** Declared fields of the 24-byte MIPS ABI flags record, not inferred semantics. */
export interface MipsAbiFlags {
  readonly version: number;
  readonly isaLevel: number;
  readonly isaRevision: number;
  readonly gprSize: number;
  readonly cpr1Size: number;
  readonly cpr2Size: number;
  readonly fpAbi: number;
  readonly isaExtension: number;
  readonly ases: number;
  readonly flags1: number;
  readonly flags2: number;
}

/**
 * ELF class and flags retain the width and ABI declarations used by this lane.
 * ISA extensions in `.riscv.attributes` are not inspected by this header parser.
 */
export type RiscvElfMetadata = ElfFamilyMetadata;

/** Byte range of the selected slice inside its universal Mach-O container. */
export interface UniversalMachOSlice {
  readonly offset: number;
  readonly size: number;
}

interface BinaryTargetIdentity {
  readonly path: string;
  readonly sourcePath?: string;
  /** Info.plist of the app bundle the target was resolved from. */
  readonly bundleInfoPlist?: string;
  readonly sha256: string;
}

type NonExecutableMetadata = {
  readonly architecture?: never;
  readonly availableArchitectures?: never;
  readonly executableRole?: never;
  readonly managed?: never;
};

type ExecutableTarget = BinaryTargetIdentity & {
  readonly kind: "executable";
  readonly architecture: HeaderArchitecture;
  readonly availableArchitectures: readonly HeaderArchitecture[];
};

/**
 * Canonical local target identity and provider-neutral file classification.
 * Each variant carries only metadata established for that exact file kind.
 */
export type BinaryTarget =
  | (BinaryTargetIdentity & {
      readonly kind: "executable";
      readonly format: "elf";
      readonly architecture: "mips";
      readonly availableArchitectures: readonly "mips"[];
      readonly mips: MipsElfMetadata;
      readonly executableRole?: never;
      readonly managed?: never;
    })
  | (BinaryTargetIdentity & {
      readonly kind: "executable";
      readonly format: "elf";
      readonly architecture: "riscv";
      readonly availableArchitectures: readonly "riscv"[];
      readonly riscv: RiscvElfMetadata;
      readonly executableRole?: never;
      readonly managed?: never;
    })
  | (ExecutableTarget & {
      readonly format: "mach-o" | "elf" | "dos-mz" | "dos-com";
      readonly universalSlice?: never;
      readonly executableRole?: never;
      readonly managed?: never;
    })
  | (ExecutableTarget & {
      readonly format: "mach-o-universal";
      /** Selected slice range a provider must analyze instead of the container. */
      readonly universalSlice: UniversalMachOSlice;
      readonly executableRole?: never;
      readonly managed?: never;
    })
  | (ExecutableTarget & {
      readonly format: "raw-binary";
      readonly entryPoint: string;
      readonly entryPointSource: string;
      readonly executableRole?: never;
      readonly managed?: never;
    })
  | (ExecutableTarget & {
      readonly format: "pe";
      /** Provider-neutral PE image role observed from COFF characteristics. */
      readonly executableRole:
        | "application"
        | "shared-library"
        | "non-executable";
      /** Whether the PE declares a non-empty CLI header data-directory entry. */
      readonly managed: boolean;
    })
  | (BinaryTargetIdentity &
      NonExecutableMetadata & {
        readonly kind: "database";
        readonly format: "analysis-database";
      })
  | (BinaryTargetIdentity &
      NonExecutableMetadata & {
        readonly kind: "archive";
        readonly format: ZipPackageFormat | "asar" | "dmg" | "pkg";
      })
  | (BinaryTargetIdentity &
      NonExecutableMetadata & {
        readonly kind: "artifact";
        readonly format: "plist" | "javascript" | "source-map";
      });

/** Whether an executable target contains a thin or universal Mach-O image. */
export const isMachOFormat = (
  format: unknown,
): format is "mach-o" | "mach-o-universal" =>
  format === "mach-o" || format === "mach-o-universal";
