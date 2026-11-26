import {
  isParseLimit,
  parseLimitConstraint,
} from "../../domain/parseFailureAnalysisError.js";
import {
  closeArtifactResources,
  projectStableArtifactFailure,
  ArtifactReaderFailure,
  readStableArtifact,
  artifactFilePrimaryFacts,
  assertArtifactReadActive,
  type StableArtifactSnapshot,
  ArtifactResourceScope,
} from "../../resources/index.js";
import {
  hasElfMagic,
  BinaryFormatFailure,
  isNativeStructureFailure,
} from "../../domain/binaryContainer.js";
import { nativeStructureConstraint } from "../../domain/native/nativeStructureBudget.js";
import type { NativeInitializersPort } from "../../ports/binaryDiagnostics/NativeInitializersPort.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";
import { classifyProviderFailure } from "../../providers/classifyProviderFailure.js";
import { offlineArtifactFailureDialect } from "../../providers/offlineArtifactFailure.js";
import { fixedAllowanceOptions } from "../../domain/fixedAllowanceRemediation.js";
import {
  nativeInitializersFileLimit,
  type InspectNativeInitializersInput,
  type NativeInitializerInspection,
  type NativeInitializers,
  type NativeInitializerSlice,
} from "../../domain/native/nativeInitializers.js";
import { err, ok } from "../../domain/result.js";
import { NATIVE_INITIALIZERS_PROVIDER } from "../../domain/investigationProviders.js";
import {
  ELF_POINTER_RELOCATION_FORMAT,
  ElfPointerRelocationFailure,
} from "../../domain/native/elfPointerRelocations.js";
import { hasMachoMagic } from "../../domain/apple/machoContainer.js";
import { requireSelectedNativeImage } from "../../domain/apple/machoSliceSelection.js";
import { readElfInitializers } from "./ElfInitializers.js";
import { readMachoInitializers } from "./MachoInitializers.js";

const OPERATION = "inspect_native_initializers";

/** Portable ELF and Mach-O initializer reader over one stable regular file. */
export class NativeInitializersProvider implements NativeInitializersPort {
  readonly identity = NATIVE_INITIALIZERS_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  close(): Promise<void> {
    return closeArtifactResources(
      () => this.#resources.close(),
      NATIVE_INITIALIZERS_PROVIDER,
      OPERATION,
    );
  }

  async inspect(
    input: InspectNativeInitializersInput,
    options?: ExecutionOptions,
  ) {
    let snapshot: StableArtifactSnapshot | undefined;
    try {
      return await this.#resources.run(async () => {
        snapshot = await readStableArtifact(
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
      return err(nativeInitializersFailure(cause, input, snapshot));
    }
  }
}

/** Decode one stable buffer. ELF is read whole; Mach-O uses the selected slice. */
export const readNativeInitializers = async (
  bytes: Buffer,
  artifact: NativeInitializers["artifact"],
  input: Pick<
    InspectNativeInitializersInput,
    "offset" | "limit" | "architecture" | "path" | "max_structure_bytes"
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
  const inspection = await inspectSelected(
    bytes,
    selected,
    page,
    signal,
    input.max_structure_bytes,
  );
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
  structureBytes: number | undefined,
): Promise<NativeInitializerInspection> => {
  if (hasElfMagic(selected.bytes)) {
    if (selected.selection !== null)
      throw new BinaryFormatFailure(
        "malformed",
        "ELF bytes are not a Mach-O slice",
      );
    return readElfInitializers(selected.bytes, page, signal, structureBytes);
  }
  if (!hasMachoMagic(container) && !hasMachoMagic(selected.bytes))
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
    structureBytes,
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

const nativeInitializersFailure = (
  cause: unknown,
  input: InspectNativeInitializersInput,
  snapshot?: StableArtifactSnapshot,
): AnalysisError => {
  const facts = artifactFilePrimaryFacts(cause);
  const primary = classifyProviderFailure(
    facts.cause,
    offlineArtifactFailureDialect(facts, {
      providerId: NATIVE_INITIALIZERS_PROVIDER.id,
      operation: OPERATION,
      path: input.path,
      description: "image",
      recognise: (failure, origin) => {
        if (
          failure instanceof ElfPointerRelocationFailure &&
          isParseLimit(failure, ELF_POINTER_RELOCATION_FORMAT)
        )
          return parseLimitConstraint(OPERATION, "capacity", failure, {
            path: input.path,
            ...fixedAllowanceOptions(
              "The native initializer structural allowance",
              "parser",
              {
                limit: failure.failure.limit.maximum,
                ...(failure.unit === undefined ? {} : { unit: failure.unit }),
              },
            ),
          });
        if (isNativeStructureFailure(failure))
          return nativeStructureConstraint(OPERATION, failure, input.path);
        if (
          origin === "owned-or-classified" &&
          failure instanceof ArtifactReaderFailure &&
          failure.reason === "limit"
        )
          return new AnalysisResourceConstraintError(
            OPERATION,
            "file-size",
            failure.message,
            { max_file_bytes: input.max_file_bytes },
            {
              cause: failure,
              retryable: false,
              limit: nativeInitializersFileLimit(input.max_file_bytes),
            },
          );
        return undefined;
      },
    }),
  );
  return projectStableArtifactFailure(
    cause,
    primary,
    input.path,
    NATIVE_INITIALIZERS_PROVIDER.id,
    OPERATION,
    snapshot,
  );
};
