/** Provider-neutral CPU families detected from supported executable headers. */
export type BinaryArchitecture = "x86" | "x86_64" | "arm" | "arm64";

interface BinaryTargetIdentity {
  readonly path: string;
  readonly sourcePath?: string;
  /** Info.plist of the app bundle the target was resolved from. */
  readonly bundleInfoPlist?: string;
  readonly sha256: string;
}

/** Explicit selection within an existing analysis project. */
export interface AnalysisProjectSelection {
  readonly markerPath: string;
  readonly storagePath: string;
  readonly projectName: string;
  /** Absolute domain-file path within the project, using `/` separators. */
  readonly documentPath: string;
}

type NonExecutableMetadata = {
  readonly architecture?: never;
  readonly availableArchitectures?: never;
  readonly executableRole?: never;
  readonly managed?: never;
};

type ExecutableTarget = BinaryTargetIdentity & {
  readonly kind: "executable";
  readonly architecture: BinaryArchitecture;
  readonly availableArchitectures: readonly BinaryArchitecture[];
};

/**
 * Canonical local target identity and provider-neutral file classification.
 * Each variant carries only metadata established for that exact file kind.
 */
export type BinaryTarget =
  | (ExecutableTarget & {
      readonly format: "mach-o" | "elf" | "dos-mz" | "dos-com";
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
        readonly analysisProject?: AnalysisProjectSelection;
      })
  | (BinaryTargetIdentity &
      NonExecutableMetadata & {
        readonly kind: "archive";
        readonly format:
          | "zip"
          | "ipa"
          | "apk"
          | "msix"
          | "appx"
          | "asar"
          | "dmg"
          | "pkg";
      })
  | (BinaryTargetIdentity &
      NonExecutableMetadata & {
        readonly kind: "artifact";
        readonly format: "plist" | "javascript" | "source-map";
      });
