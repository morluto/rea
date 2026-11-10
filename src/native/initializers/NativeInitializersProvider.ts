import {
  projectArtifactCloseFailure,
  projectStableArtifactFailure,
} from "../../artifacts/StableArtifactFailure.js";
import { isSelectedRegularFileError } from "../../filesystem/RegularFile.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { readStableArtifact } from "../../artifacts/readStableArtifact.js";
import {
  artifactFileCancellationCause,
  artifactFilePrimaryFacts,
  assertArtifactReadActive,
  type ArtifactFilePrimaryFacts,
} from "../../artifacts/ArtifactFileOperation.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import type { NativeInitializersPort } from "../../application/binaryDiagnostics/NativeInitializersPort.js";
import type { ExecutionOptions } from "../../application/AnalysisProvider.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
} from "../../domain/analysisErrorCore.js";
import { fixedAllowanceOptions } from "../../domain/fixedAllowanceRemediation.js";
import {
  MAX_INSPECT_NATIVE_INITIALIZERS_FILE_BYTES,
  type InspectNativeInitializersInput,
  type NativeInitializerInspection,
  type NativeInitializers,
  type NativeInitializerSlice,
} from "../../domain/native/nativeInitializers.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { err, ok } from "../../domain/result.js";
import { NATIVE_INITIALIZERS_PROVIDER } from "../../domain/investigationProviders.js";
import {
  BinaryFormatFailure,
  BinaryResourceFailure,
} from "../metadata/BinaryContainer.js";
import { ElfPointerRelocationFailure } from "../metadata/ElfPointerRelocations.js";
import { requireSelectedNativeImage } from "../metadata/MachoSliceSelection.js";
import { readElfInitializers } from "./ElfInitializers.js";
import { readMachoInitializers } from "./MachoInitializers.js";

const OPERATION = "inspect_native_initializers";

const MACHO_MAGICS = new Set([
  0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca,
  0xcafebabf, 0xbfbafeca,
]);

const isElf = (bytes: Buffer): boolean =>
  bytes.length >= 4 &&
  bytes[0] === 0x7f &&
  bytes[1] === 0x45 &&
  bytes[2] === 0x4c &&
  bytes[3] === 0x46;

const isMacho = (bytes: Buffer): boolean =>
  bytes.length >= 4 && MACHO_MAGICS.has(bytes.readUInt32BE(0));

/** Portable ELF and Mach-O initializer reader over one stable regular file. */
export class NativeInitializersProvider implements NativeInitializersPort {
  readonly identity = NATIVE_INITIALIZERS_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      throw projectArtifactCloseFailure(
        cause,
        NATIVE_INITIALIZERS_PROVIDER.id,
        OPERATION,
      );
    }
  }

  async inspect(
    input: InspectNativeInitializersInput,
    options?: ExecutionOptions,
  ) {
    try {
      return await this.#resources.run(async () => {
        const snapshot = await readStableArtifact(
          input.path,
          input.max_file_bytes,
          options?.signal,
          undefined,
          this.#resources,
        );
        assertArtifactReadActive(options?.signal);
        const report = await readNativeInitializers(
          snapshot.bytes,
          {
            path: input.path,
            sha256: snapshot.sha256,
            bytes: snapshot.bytes.length,
          },
          input,
          options?.signal,
        );
        assertArtifactReadActive(options?.signal);
        return ok(report);
      });
    } catch (cause) {
      return err(nativeInitializersFailure(cause, input));
    }
  }
}

/** Decode one stable buffer. ELF is read whole; Mach-O uses the selected slice. */
export const readNativeInitializers = async (
  bytes: Buffer,
  artifact: NativeInitializers["artifact"],
  input: Pick<
    InspectNativeInitializersInput,
    "offset" | "limit" | "architecture" | "path"
  >,
  signal?: AbortSignal,
): Promise<NativeInitializers> => {
  assertArtifactReadActive(signal);
  const selected = requireSelectedNativeImage(
    OPERATION,
    input.path,
    bytes,
    input.architecture,
  );
  const page = { offset: input.offset, limit: input.limit };
  const inspection = await inspectSelected(bytes, selected, page, signal);
  return {
    artifact,
    ...inspection,
    limitations: [...inspection.limitations, ...selected.limitations],
  };
};

const inspectSelected = async (
  container: Buffer,
  selected: ReturnType<typeof requireSelectedNativeImage>,
  page: { readonly offset: number; readonly limit: number },
  signal: AbortSignal | undefined,
): Promise<NativeInitializerInspection> => {
  if (isElf(selected.bytes)) {
    if (selected.selection !== null)
      throw new BinaryFormatFailure(
        "malformed",
        "ELF bytes are not a Mach-O slice",
      );
    return readElfInitializers(selected.bytes, page, signal);
  }
  if (!isMacho(container) && !isMacho(selected.bytes))
    throw new BinaryFormatFailure(
      "malformed",
      "Selected file is not an ELF or Mach-O image",
    );
  const selection = selected.selection;
  const slice: NativeInitializerSlice | null =
    selection === null
      ? null
      : {
          file_offset: selection.offset,
          size: selection.byte_length,
          cpu_type: selection.cpu_type,
          cpu_subtype: selection.cpu_subtype,
          architecture: architectureName(selection.cpu_type),
        };
  return readMachoInitializers(
    { bytes: selected.bytes, fileBase: selected.fileOffset, slice },
    page,
    signal,
  );
};

const architectureName = (cpuType: number): string => {
  switch (cpuType >>> 0) {
    case 7:
      return "x86";
    case 0x01000007:
      return "x86_64";
    case 12:
      return "arm";
    case 0x0100000c:
      return "arm64";
    default:
      return `cpu-0x${(cpuType >>> 0).toString(16)}`;
  }
};

const fileSizeRemediation = (input: InspectNativeInitializersInput): string =>
  input.max_file_bytes >= MAX_INSPECT_NATIVE_INITIALIZERS_FILE_BYTES
    ? `The image exceeds the ${String(MAX_INSPECT_NATIVE_INITIALIZERS_FILE_BYTES)}-byte input ceiling this operation accepts. This release has no runtime override. Select a smaller artifact.`
    : `Raise max_file_bytes above ${String(input.max_file_bytes)} bytes or select a smaller artifact; the limit is the caller-selected input read budget.`;

const failurePrimary = (
  facts: ArtifactFilePrimaryFacts,
  input: InspectNativeInitializersInput,
): AnalysisError => {
  const { cause, origin } = facts;
  if (origin === "owned-or-classified" && cause instanceof AnalysisError)
    return cause;
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure &&
    cause.reason === "integrity"
  )
    return new AnalysisArtifactChangedError(
      OPERATION,
      input.path,
      cause.message,
      { cause },
    );
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure &&
    cause.reason === "cancelled"
  )
    return new AnalysisCancelledError(OPERATION, {
      cause: artifactFileCancellationCause(cause),
    });
  if (
    cause instanceof ElfPointerRelocationFailure &&
    cause.reason === "native-index-capacity"
  )
    return new AnalysisResourceConstraintError(
      OPERATION,
      "capacity",
      `Selected artifact ${input.path}: ${cause.message}`,
      { boundary: "structure" },
      {
        cause,
        ...fixedAllowanceOptions(
          "The native initializer structural allowance",
          "parser",
        ),
      },
    );
  if (cause instanceof BinaryResourceFailure)
    return new AnalysisResourceConstraintError(
      OPERATION,
      "capacity",
      `Selected artifact ${input.path}: ${cause.message}`,
      { boundary: cause.boundary, maximum: cause.maximum_bytes },
      {
        cause,
        ...fixedAllowanceOptions(
          "The native initializer structural allowance",
          "parser",
        ),
      },
    );
  if (cause instanceof BinaryFormatFailure)
    return cause.kind === "unsupported"
      ? new AnalysisUnsupportedTargetError(
          OPERATION,
          input.path,
          cause.message,
          { cause },
        )
      : new AnalysisInputError(OPERATION, { cause }, [
          {
            path: ["path"],
            reason: "invalid_format",
            message: `Selected artifact ${input.path}: ${cause.message}`,
          },
        ]);
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure
  ) {
    if (cause.reason === "limit")
      return new AnalysisResourceConstraintError(
        OPERATION,
        "file-size",
        cause.message,
        { max_file_bytes: input.max_file_bytes },
        {
          cause,
          retryable: false,
          remediationAction: fileSizeRemediation(input),
        },
      );
    if (cause.reason === "path" || cause.reason === "format")
      return new AnalysisInputError(OPERATION, { cause }, [
        { path: ["path"], reason: "invalid_format", message: cause.message },
      ]);
  }
  if (cause instanceof Error && "code" in cause) {
    if (cause.code === "EACCES" || cause.code === "EPERM")
      return new AnalysisAccessDeniedError(OPERATION, input.path, cause.code, {
        cause,
      });
    if (isSelectedRegularFileError(cause))
      return new AnalysisInputError(OPERATION, { cause }, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: `Selected image could not be read (${String(cause.code)}): ${input.path}.`,
        },
      ]);
  }
  return new ProviderAdapterError(NATIVE_INITIALIZERS_PROVIDER.id, OPERATION, {
    cause,
    diagnostics: {
      path: input.path,
      reason: cause instanceof Error ? cause.message : String(cause),
    },
  });
};

const nativeInitializersFailure = (
  cause: unknown,
  input: InspectNativeInitializersInput,
): AnalysisError =>
  projectStableArtifactFailure(
    cause,
    failurePrimary(artifactFilePrimaryFacts(cause), input),
    input.path,
    NATIVE_INITIALIZERS_PROVIDER.id,
    OPERATION,
  );
