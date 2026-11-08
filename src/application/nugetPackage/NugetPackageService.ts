import { isAbsolute } from "node:path";
import {
  artifactFileCancellationCause,
  artifactFilePrimaryFacts,
} from "../../artifacts/ArtifactFileOperation.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import type { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { readStableArtifact } from "../../artifacts/readStableArtifact.js";
import { ZipArtifactReader } from "../../artifacts/ZipArtifactReader.js";
import {
  projectStableArtifactFailure,
  stableArtifactInputRecovery,
} from "../../artifacts/StableArtifactFailure.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../../domain/artifactOperationError.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  NUGET_PACKAGE_MAX_NUSPEC_BYTES,
  NUGET_PACKAGE_OPERATION as operation,
  NUGET_PACKAGE_PROVIDER,
  type NugetPackage,
  type NugetPackageArtifact,
} from "../../domain/nugetPackage/nugetPackage.js";
import {
  inspectNugetPackageInputSchema,
  type InspectNugetPackageInput,
} from "../../domain/nugetPackage/nugetPackageQuery.js";
import {
  parseNugetPackage,
  type NugetArchiveMember,
} from "../../domain/nugetPackage/parseNugetPackage.js";
import { err, ok, type Result } from "../../domain/result.js";
import { isSelectedRegularFileError } from "../../filesystem/RegularFile.js";
import { parseAnalysisInput } from "../AnalysisInput.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";

const inputFailure = (message: string, cause?: unknown) =>
  new AnalysisInputError(
    operation,
    {
      cause,
      ...(isSelectedRegularFileError(cause)
        ? {
            conformsToInputContract: true,
            remediationAction:
              "Check that the selected path exists and is a readable regular file on the host running REA.",
          }
        : {}),
      ...(cause instanceof ArtifactReaderFailure
        ? stableArtifactInputRecovery(cause)
        : {}),
    },
    [{ path: ["path"], reason: "invalid_format", message }],
  );

/** Keep the reader's typed reasons instead of flattening every failure into "io". */
const readFailure = (
  failure: unknown,
  input: InspectNugetPackageInput,
): AnalysisError => {
  const { cause, origin } = artifactFilePrimaryFacts(failure);
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure
  ) {
    if (cause.reason === "cancelled")
      return new AnalysisCancelledError(operation, {
        cause: artifactFileCancellationCause(cause),
      });
    if (cause.reason === "integrity")
      return new AnalysisArtifactChangedError(
        operation,
        input.path,
        cause.message,
        { cause },
      );
    if (cause.reason === "limit")
      return new AnalysisResourceConstraintError(
        operation,
        cause.boundary ?? "file-size",
        cause.message,
        { max_file_bytes: input.max_file_bytes },
        {
          cause,
          retryable: false,
          remediationAction:
            "Select a package within max_file_bytes; entry paging does not change this file admission.",
        },
      );
    if (cause.reason === "path" || cause.reason === "format")
      return inputFailure(cause.message, cause);
  }
  if (cause instanceof Error && "code" in cause) {
    if (cause.code === "EACCES" || cause.code === "EPERM")
      return new AnalysisAccessDeniedError(operation, input.path, cause.code, {
        cause,
      });
    if (isSelectedRegularFileError(cause))
      return inputFailure(
        `Selected package could not be read (${cause.code}): ${input.path}`,
        cause,
      );
  }
  return new ArtifactOperationError(
    operation,
    "io",
    undefined,
    "NuGet package read failed.",
    { cause: failure },
  );
};

const readArchive = async (
  input: InspectNugetPackageInput,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<Result<{ bytes: Buffer; sha256: string }, AnalysisError>> => {
  try {
    const source = await resources.run(() =>
      readStableArtifact(
        input.path,
        input.max_file_bytes,
        signal,
        undefined,
        resources,
      ),
    );
    return ok(source);
  } catch (failure: unknown) {
    return err(
      projectStableArtifactFailure(
        failure,
        readFailure(failure, input),
        input.path,
        NUGET_PACKAGE_PROVIDER.id,
        operation,
      ),
    );
  }
};

/**
 * Drain one member into a bounded buffer. `.nuspec` text is the only member
 * this step interprets; every other member is inventoried from the directory
 * alone and never decompressed.
 */
const readMemberText = async (
  reader: ZipArtifactReader,
  entry: Parameters<ZipArtifactReader["open"]>[0],
  signal?: AbortSignal,
): Promise<string | undefined> => {
  if ((entry.declaredSize ?? 0) > NUGET_PACKAGE_MAX_NUSPEC_BYTES)
    return undefined;
  const stream = await reader.open(entry, signal);
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stream) {
    if (!Buffer.isBuffer(chunk)) return undefined;
    length += chunk.length;
    if (length > NUGET_PACKAGE_MAX_NUSPEC_BYTES) {
      stream.destroy();
      return undefined;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length).toString("utf8");
};

const isNuspec = (path: string): boolean =>
  path.replace(/\\/gu, "/").toLowerCase().endsWith(".nuspec");

const inventoryMembers = async (
  reader: ZipArtifactReader,
  input: InspectNugetPackageInput,
  signal?: AbortSignal,
): Promise<NugetArchiveMember[]> => {
  const members: NugetArchiveMember[] = [];
  for await (const entry of reader.entries(signal)) {
    if (members.length >= input.max_entries) break;
    const text =
      entry.kind === "file" && !entry.encrypted && isNuspec(entry.path)
        ? await readMemberText(reader, entry, signal)
        : undefined;
    members.push({
      path: entry.path,
      bytes: entry.declaredSize,
      directory: entry.kind === "directory",
      encrypted: entry.encrypted || entry.kind === "symlink",
      text,
    });
  }
  return members;
};

export interface NugetPackageInspection {
  readonly evidence: Evidence;
  /** The verified file snapshot, retained when cancellation follows the read. */
  readonly observation: NugetPackage["artifact"];
}

/** Shared CLI/MCP import: one verified file read, no network, no restore, no execution. */
export const inspectNugetPackageEvidence = async (
  rawInput: unknown,
  resources: ArtifactResourceScope,
  options: { readonly signal?: AbortSignal } = {},
): Promise<Result<NugetPackageInspection, AnalysisError>> => {
  const admitted = parseAnalysisInput(
    operation,
    rawInput,
    inspectNugetPackageInputSchema,
    options.signal,
  );
  if (!admitted.ok) return admitted;
  const input = admitted.value;
  if (!isAbsolute(input.path))
    return err(
      inputFailure("Expected an absolute filesystem path on this host."),
    );
  const source = await readArchive(input, resources, options.signal);
  if (!source.ok) return source;
  const { bytes, sha256 } = source.value;
  const artifact: NugetPackageArtifact = {
    path: input.path,
    sha256,
    bytes: bytes.length,
  };
  const reader = new ZipArtifactReader(input.path, "zip");
  let members: NugetArchiveMember[];
  try {
    members = await resources.run(() =>
      inventoryMembers(reader, input, options.signal),
    );
  } catch (failure: unknown) {
    return err(readFailure(failure, input));
  } finally {
    await reader.close().catch(() => undefined);
  }
  const parsed = parseNugetPackage(artifact, members, {
    maxEntries: input.max_entries,
  });
  if (!parsed.ok) return err(inputFailure(parsed.error.message));
  const inventory = parsed.value;
  const evidence = createEvidence(
    { path: input.path, format: "file", sha256 },
    NUGET_PACKAGE_PROVIDER,
    {
      operation,
      predicateType: "rea.nuget-package-inventory",
      parameters: {
        path: input.path,
        format: input.format,
        max_file_bytes: input.max_file_bytes,
        max_entries: input.max_entries,
      },
      result: inventory,
      confidence: "observed",
      limitations: inventory.limitations,
      locations: [{ kind: "artifact-path", path: input.path }],
    },
  );
  const completed = completeProviderEvidence(evidence, options.signal);
  return completed.ok
    ? ok({ evidence: completed.value, observation: artifact })
    : completed;
};
