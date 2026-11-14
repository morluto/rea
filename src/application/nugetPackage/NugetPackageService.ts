import { isAbsolute } from "node:path";
import {
  artifactFileCancellationCause,
  artifactFilePrimaryFacts,
  bindArtifactFileCleanup,
} from "../../artifacts/ArtifactFileOperation.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import type { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { ArtifactFileSource } from "../../artifacts/ArtifactFileSource.js";
import { hashReadableToCompletion } from "../../artifacts/ArtifactHash.js";
import { readFileHandleChunks } from "../../filesystem/readFileHandleChunks.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { ZipArtifactReader } from "../../artifacts/ZipArtifactReader.js";
import {
  projectStableArtifactFailure,
  stableArtifactInputRecovery,
} from "../../artifacts/StableArtifactFailure.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
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
  isSafeMemberPath,
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

/**
 * The ZIP reader can refuse after the carrier passed `max_file_bytes`. Naming
 * that setting as the failing limit would tell a caller to pick a smaller
 * package that fails the same way, so report the reader's own allowance.
 */
const ZIP_LIMIT_RECOVERY =
  "The archive's members exceed this ZIP expansion or decoder allowance, which a smaller file does not necessarily fix; inspect a package that stays within it.";

/** Keep the reader's typed reasons instead of flattening every failure into "io". */
const readFailure = (
  failure: unknown,
  input: InspectNugetPackageInput,
): AnalysisError => {
  if (failure instanceof AnalysisError) return failure;
  const { cause: primary, origin } = artifactFilePrimaryFacts(failure);
  const cause =
    origin === "owned-or-classified" &&
    primary instanceof ArtifactReaderFailure &&
    primary.reason === "io"
      ? primary.cause
      : primary;
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
      return cause.boundary === undefined || cause.boundary === "file-size"
        ? new AnalysisResourceConstraintError(
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
          )
        : new AnalysisResourceConstraintError(
            operation,
            cause.boundary,
            cause.message,
            { failed_limit: cause.boundary },
            { cause, retryable: false, remediationAction: ZIP_LIMIT_RECOVERY },
          );
    // "unavailable" is the reader's own refusal of a method or codec it cannot
    // decode; leaving it to the generic branch would report an I/O failure for
    // a file that was read fine.
    if (
      cause.reason === "path" ||
      cause.reason === "format" ||
      cause.reason === "unavailable"
    )
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

/**
 * Drain one member into a bounded buffer. `.nuspec` text is the only member
 * this step interprets; every other member is inventoried from the directory
 * alone and never decompressed. A member past the read allowance is reported as
 * oversized rather than as unreadable.
 */
type MemberText =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "oversized" }
  | { readonly kind: "unreadable" };

const readMemberText = async (
  reader: ZipArtifactReader,
  entry: Parameters<ZipArtifactReader["open"]>[0],
  signal?: AbortSignal,
): Promise<MemberText> => {
  if ((entry.declaredSize ?? 0) > NUGET_PACKAGE_MAX_NUSPEC_BYTES)
    return { kind: "oversized" };
  const stream = await reader.open(entry, signal);
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stream) {
    if (!Buffer.isBuffer(chunk)) return { kind: "unreadable" };
    length += chunk.length;
    if (length > NUGET_PACKAGE_MAX_NUSPEC_BYTES) {
      stream.destroy();
      return { kind: "oversized" };
    }
    chunks.push(chunk);
  }
  return decodeNuspecText(Buffer.concat(chunks, length));
};

/**
 * A `.nuspec` is XML, so its encoding comes from its own byte-order mark: NuGet
 * packages written on Windows are UTF-16. Decoding those as UTF-8 would turn
 * every other byte into NUL and discard declarations the file really states.
 * Bytes with no mark and no valid UTF-8 are unreadable rather than replaced.
 */
const decodeNuspecText = (
  bytes: Buffer,
):
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "unreadable" } => {
  const label =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? "utf-16be"
        : "utf-8";
  try {
    return {
      kind: "text",
      text: new TextDecoder(label, { fatal: true }).decode(bytes),
    };
  } catch {
    return { kind: "unreadable" };
  }
};

const isNuspec = (path: string): boolean =>
  path.replace(/\\/gu, "/").toLowerCase().endsWith(".nuspec");

const inventoryMembers = async (
  reader: ZipArtifactReader,
  input: InspectNugetPackageInput,
  signal?: AbortSignal,
): Promise<{
  readonly members: NugetArchiveMember[];
  readonly complete: boolean;
}> => {
  const members: NugetArchiveMember[] = [];
  for await (const entry of reader.entries(signal)) {
    if (members.length >= input.max_entries)
      return { members, complete: false };
    // Admit the owning path before opening the member: a `../x.nuspec` entry
    // is refused as an unsafe path by the parser, and opening it first would
    // let a read failure report the archive as unreadable instead.
    const read =
      entry.kind === "file" &&
      !entry.encrypted &&
      isNuspec(entry.path) &&
      isSafeMemberPath(entry.path)
        ? await readMemberText(reader, entry, signal)
        : undefined;
    members.push({
      path: entry.path,
      sourcePath: entry.sourcePath,
      nameVerified: entry.nameVerified,
      bytes: entry.declaredSize,
      directory: entry.kind === "directory",
      encrypted: entry.encrypted,
      symlink: entry.kind === "symlink",
      text: read?.kind === "text" ? read.text : undefined,
      oversized: read?.kind === "oversized",
      limitations: entry.limitations,
    });
  }
  return { members, complete: true };
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
  try {
    return await resources.run(async () => {
      const source = new ArtifactFileSource(input.path, "NuGet package");
      let reader: ZipArtifactReader | undefined;
      // ZIP borrows the descriptor; its streams must release before the file owner.
      const owner = {
        kind: "lease" as const,
        resource: input.path,
        lease: {
          release: async () => {
            await reader?.close();
            await source.close();
          },
        },
      };
      let artifact: NugetPackageArtifact | undefined;
      let outcome: Result<NugetPackageInspection, AnalysisError>;
      try {
        const admittedFile = await source.readSelectedPath(options.signal);
        if (admittedFile.initial.size > input.max_file_bytes)
          throw new ArtifactReaderFailure(
            "limit",
            `Selected artifact exceeds ${String(input.max_file_bytes)} bytes: ${input.path}`,
            { boundary: "file-size" },
          );
        const hashed = await hashReadableToCompletion(
          readFileHandleChunks(admittedFile.handle, {
            end: input.max_file_bytes,
            signal: options.signal,
            cancellationFailure: (reason) =>
              new ArtifactReaderFailure(
                "cancelled",
                "NuGet package read cancelled",
                { cause: reason },
              ),
          }),
          options.signal,
        );
        if (hashed.bytes > input.max_file_bytes)
          throw new ArtifactReaderFailure(
            "limit",
            `Selected artifact grew beyond its byte limit: ${input.path}`,
            { boundary: "file-size" },
          );
        await source.readSelectedPath();
        if (hashed.bytes !== admittedFile.initial.size)
          throw new ArtifactReaderFailure(
            "integrity",
            `NuGet package changed during hashing: ${input.path}`,
          );
        artifact = {
          path: input.path,
          sha256: hashed.sha256,
          bytes: hashed.bytes,
        };
        reader = new ZipArtifactReader(
          input.path,
          "zip",
          undefined,
          admittedFile,
        );
        const inventoryMembersResult = await inventoryMembers(
          reader,
          input,
          options.signal,
        );
        await source.readSelectedPath();
        const parsed = parseNugetPackage(
          artifact,
          inventoryMembersResult.members,
          {
            maxEntries: input.max_entries,
            inventoryComplete: inventoryMembersResult.complete,
          },
        );
        if (!parsed.ok) throw inputFailure(parsed.error.message);
        const inventory = parsed.value;
        const evidence = createEvidence(
          { path: input.path, format: "file", sha256: artifact.sha256 },
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

        outcome = ok({ evidence, observation: artifact });
      } catch (failure: unknown) {
        const refusal = readFailure(failure, input);
        if (artifact !== undefined)
          refusal.retainPartialObservation({
            kind: "file-snapshot-hash",
            ...artifact,
          });
        outcome = err(refusal);
      }
      const released = await resources.release(owner);
      if (released.kind === "failed") {
        const failure = resources.cleanupFailure(
          outcome.ok
            ? { kind: "completed" }
            : { kind: "failed", cause: outcome.error },
          [released],
          outcome.ok
            ? outcome.value.evidence
            : outcome.error.partialObservation,
        );
        if (!outcome.ok)
          return err(
            projectStableArtifactFailure(
              failure,
              outcome.error,
              input.path,
              NUGET_PACKAGE_PROVIDER.id,
              operation,
            ),
          );
        const cleanup = new ProviderCleanupError(
          NUGET_PACKAGE_PROVIDER.id,
          resources.cleanupResources,
          { reason: failure.message },
          {
            operation,
            cause: failure,
            completedObservation: outcome.value.evidence,
          },
        );
        cleanup.retainPartialObservation(outcome.value.evidence);
        bindArtifactFileCleanup(failure, cleanup);
        return err(cleanup);
      }
      if (!outcome.ok) return outcome;
      const completed = completeProviderEvidence(
        outcome.value.evidence,
        options.signal,
      );
      return completed.ok ? outcome : completed;
    });
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
