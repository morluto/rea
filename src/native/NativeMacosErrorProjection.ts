import {
  readerIntegrityFailure,
  bindArtifactFileCleanup,
  artifactFileCompletion,
  artifactFilePrimaryFacts,
  artifactFileCancellationCause,
  ArtifactFileCleanupFailure,
  type ArtifactFilePrimaryFacts,
  ArtifactResourceScope,
  ArtifactReaderFailure,
} from "../resources/index.js";
import { InternalInvariantError } from "../domain/internalInvariant.js";
import { translateNativeCommandFailure } from "./NativeCommandAnalysisError.js";
import {
  unreadablePlist,
  type NativePlistSelection,
} from "./NativePlistSource.js";
import { NATIVE_MACOS_PROVIDER_IDENTITY as IDENTITY } from "./NativeMacosProviderIdentity.js";
import { realpath } from "node:fs/promises";
import { createAnalysisExecutionEvidence } from "../domain/analysisObservation.js";

import { z } from "zod";

import {
  createAnalysisExecution,
  type AnalysisOperation,
} from "../ports/AnalysisProvider.js";
import {
  NATIVE_TOOL_CONTRACTS,
  type NativeToolName,
} from "../contracts/native/nativeToolContracts.js";
import {
  isMachOFormat,
  type BinaryTarget,
} from "../domain/binaryTargetTypes.js";
import type { EvidenceLocation } from "../domain/evidence.js";
import {
  AnalysisOutputError,
  cancelledBy,
  carriedReason,
} from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  jsonValueSchema,
  ownedJsonValueSchema,
  type JsonValue,
} from "../domain/jsonValue.js";
import {
  projectPlistValue,
  nonFiniteRealLimitation,
  negativeZeroRealLimitation,
  unknownDateLimitation,
  unknownScalarLimitation,
} from "../domain/apple/plistValue.js";
import { createPlistNumberProjection } from "../domain/apple/plistNumbers.js";
import { parseXmlPropertyList } from "../domain/propertyListKeys.js";
import { plistDuplicateKeyLimitations } from "../domain/apple/plistDuplicateKeys.js";
import { machoKnownCodeSignSelector } from "../domain/apple/machoArchitectureSelection.js";
import {
  inspectPlistSchema,
  type NativeCommandInvocation,
} from "../domain/native/nativeInspection.js";
import type { Result } from "../domain/result.js";
import {
  NativeCommandFailure,
  failureCapture,
  type NativeCommandCleanupFailure,
  type NativeCommandCapture,
} from "../providers/NativeCommandRunner.js";
import type { ParsedPlist } from "./parsers/plist.js";
import { ParseFailureError } from "../domain/parseFailure.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { analysisErrorWithCancellation } from "../domain/analysisErrorCancellation.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { NativeMachoSourceVerificationFailure } from "./NativeMachoSource.js";
import {
  isParseLimit,
  parseFailureAnalysisError,
  parseLimitConstraint,
} from "../domain/parseFailureAnalysisError.js";
import type { ResolvedAppBundleResourceRoot } from "../domain/apple/bundleResourceRoot.js";

export const nativeCommandCleanupFailure = (
  failures: readonly NativeCommandCleanupFailure[],
): ProviderCleanupError => {
  const failure = new ProviderCleanupError(
    IDENTITY.id,
    [...new Set(failures.flatMap(({ resources }) => resources))],
    {
      reason: "Native command process cleanup remains incomplete",
      failures: failures.map(({ reason, resources }) => ({
        reason,
        resources: [...resources],
      })),
    },
  );
  if (
    failures.length === 0 ||
    failures.some(({ marker }) => marker === undefined)
  )
    return failure;
  const markers = failures.flatMap(({ marker }) =>
    marker === undefined ? [] : [marker],
  );
  return markers.length === 0
    ? failure
    : failure.bindCleanupDependencies(markers);
};

/** Each file workflow retains its own exact resource set through client close. */
export const closeNativeFileScope = async (
  scope: ArtifactResourceScope,
  resource: string,
): Promise<AnalysisError | undefined> => {
  try {
    await scope.close();
    return undefined;
  } catch (cause: unknown) {
    const observation = ArtifactReaderFailure.cleanupObservation(
      cause,
      resource,
    );
    const failure = new ProviderCleanupError(
      IDENTITY.id,
      observation.resources,
      { reason: observation.reason },
      { operation: "close_binary", cause },
    );
    bindArtifactFileCleanup(cause, failure);
    return failure;
  }
};

/**
 * Project a producer failure. A broken internal assumption is a REA defect, not
 * native output, so it is rethrown rather than reported as output parsing.
 */
export const nativeOutputFailure = (
  operation: AnalysisOperation,
  cause: unknown,
): AnalysisError => {
  if (cause instanceof InternalInvariantError) throw cause;
  return new AnalysisOutputError(operation, "Native output parsing failed", {
    cause,
  });
};

const nativeMachoCompletedFailure = (
  value: unknown,
): AnalysisError | undefined =>
  value !== null &&
  typeof value === "object" &&
  "ok" in value &&
  value.ok === false &&
  "error" in value &&
  value.error instanceof AnalysisError
    ? value.error
    : undefined;

const nativeMachoSourcePrimary = (
  { cause }: ArtifactFilePrimaryFacts,
  path: string,
  operation: "inspect_macho" | "list_architectures",
): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  if (isParseLimit(cause, "macho"))
    return parseLimitConstraint(operation, "memory", cause, {
      retryable: false,
    });
  const formatFailure = parseFailureAnalysisError(operation, path, cause);
  if (formatFailure !== undefined) return formatFailure;
  const completed =
    cause instanceof NativeMachoSourceVerificationFailure
      ? cause.completed
      : undefined;
  const failed =
    cause instanceof NativeMachoSourceVerificationFailure &&
    cause.outcome.kind === "failed"
      ? nativeMachoSourcePrimary(
          artifactFilePrimaryFacts(cause.outcome.cause),
          path,
          operation,
        )
      : undefined;
  const completedFailure = nativeMachoCompletedFailure(completed);
  const previous = failed ?? completedFailure;
  const optionsWithoutCause =
    previous === undefined
      ? {}
      : {
          diagnostics: {
            previous_error: jsonValueSchema.parse(
              projectAnalysisError(previous),
            ),
          },
        };
  const options = { cause, ...optionsWithoutCause };
  if (cause instanceof ArtifactReaderFailure && cause.reason === "cancelled") {
    // A returned failure is already the producer's physical outcome. A later
    // cancelled identity check must not replace its output or cleanup owner.
    if (completedFailure !== undefined)
      return analysisErrorWithCancellation(
        completedFailure,
        cancelledBy(
          operation,
          carriedReason(artifactFileCancellationCause(cause)),
        ),
      );
    return cancelledBy(
      operation,
      carriedReason(artifactFileCancellationCause(cause)),
      optionsWithoutCause,
    );
  }
  if (cause instanceof ArtifactReaderFailure && cause.reason === "format")
    return new AnalysisOutputError(operation, cause.message, options);
  if (cause instanceof ArtifactReaderFailure && cause.reason === "integrity")
    return readerIntegrityFailure(operation, path, cause, options);
  return new ProviderAdapterError(IDENTITY.id, operation, {
    ...options,
    userMessage: "The selected Mach-O source could not be read safely.",
    remediationAction:
      "Inspect the selected path and its read access, then retry.",
  });
};

const nativeMachoCompletion = (
  cause: unknown,
  target: BinaryTarget,
  parameters: Readonly<Record<string, JsonValue>>,
  operation: "inspect_macho" | "list_architectures",
) => {
  const completion = artifactFileCompletion(cause);
  // The file operation only completes after the producer result has passed
  // the final identity check. Both Mach-O command workflows own their callbacks.
  const outcome = completion?.value as
    | Result<NativeObservation, AnalysisError>
    | undefined;
  const observation =
    outcome?.ok === true
      ? createAnalysisExecutionEvidence(
          operation,
          parameters,
          {
            ...createAnalysisExecution(outcome.value.result, IDENTITY, {
              limitations: outcome.value.limitations,
              locations: outcome.value.locations,
            }),
            subject: target,
          },
          "observed",
          { immutable: true },
        )
      : undefined;
  const completedFailure = nativeMachoCompletedFailure(completion?.value);
  const completionCancellation =
    completion?.cancellation === undefined
      ? undefined
      : cancelledBy(
          operation,
          carriedReason(completion.cancellation.reason),
          completedFailure === undefined ||
            completedFailure.cleanupIncomplete ||
            (cause instanceof ArtifactReaderFailure &&
              cause.cleanup !== undefined)
            ? {}
            : {
                diagnostics: {
                  previous_error: jsonValueSchema.parse(
                    projectAnalysisError(completedFailure),
                  ),
                },
              },
        );
  return { observation, completedFailure, completionCancellation };
};

/** Every native reclassification retains the command and independent file owners. */
export const nativeFailureWithCommandCleanup = (
  primary: AnalysisError,
  producer: AnalysisError,
  operation: string,
  descriptorCleanup?: AnalysisError,
): AnalysisError => {
  if (!producer.cleanupIncomplete) return primary;
  const cleanup = descriptorCleanup ?? producer;
  return cleanup === primary
    ? primary
    : analysisErrorWithCleanupFailure(
        primary,
        cleanup,
        operation,
      ).bindCleanupDependencies([
        primary,
        producer,
        ...(descriptorCleanup === undefined ? [] : [descriptorCleanup]),
      ]);
};

/** The exact callback error remains an owner even if verification reclassifies it. */
const nativeMachoProducerFailure = (
  cause: unknown,
): AnalysisError | undefined => {
  if (cause instanceof AnalysisError) return cause;
  if (!(cause instanceof NativeMachoSourceVerificationFailure))
    return undefined;
  return cause.outcome.kind === "failed"
    ? nativeMachoProducerFailure(cause.outcome.cause)
    : nativeMachoCompletedFailure(cause.outcome.value);
};

export const nativeMachoSourceFailure = (
  cause: unknown,
  target: BinaryTarget,
  parameters: Readonly<Record<string, JsonValue>>,
  operation: "inspect_macho" | "list_architectures",
): AnalysisError => {
  const { observation, completedFailure, completionCancellation } =
    nativeMachoCompletion(cause, target, parameters, operation);
  const source = artifactFilePrimaryFacts(cause);
  const producerFailure =
    completedFailure ?? nativeMachoProducerFailure(source.cause);
  // Classification and ownership are independent: neither a changed source nor
  // a released descriptor settles the command's retained cleanup capability.
  const retainOwnedCleanup = (
    selected: AnalysisError,
    descriptorCleanup?: AnalysisError,
  ): AnalysisError => {
    if (!producerFailure?.cleanupIncomplete) return selected;
    const primary =
      selected === descriptorCleanup
        ? (descriptorCleanup.cleanupPrimary ?? producerFailure)
        : selected === completionCancellation
          ? producerFailure
          : selected;
    if (completionCancellation !== undefined)
      analysisErrorWithCancellation(primary, completionCancellation);
    return nativeFailureWithCommandCleanup(
      primary,
      producerFailure,
      operation,
      descriptorCleanup,
    );
  };
  if (cause instanceof ArtifactReaderFailure && cause.cleanup !== undefined) {
    const physical =
      cause instanceof ArtifactFileCleanupFailure
        ? cause.fileCleanupFailure
        : undefined;
    const previous =
      physical?.outcome.kind === "failed"
        ? nativeMachoSourcePrimary(
            artifactFilePrimaryFacts(cause),
            target.path,
            operation,
          )
        : physical?.outcome.kind === "completed"
          ? (completedFailure ?? completionCancellation)
          : completionCancellation;
    const failure = new ProviderCleanupError(
      IDENTITY.id,
      cause.cleanup.resources,
      {
        reason: cause.cleanup.reason,
        previous_error:
          previous === undefined
            ? null
            : jsonValueSchema.parse(projectAnalysisError(previous)),
        ...(completionCancellation !== undefined &&
        previous !== completionCancellation
          ? {
              completion_cancellation: jsonValueSchema.parse(
                projectAnalysisError(completionCancellation),
              ),
            }
          : {}),
      },
      {
        operation,
        cause,
        cleanupPrimary: previous,
        partialObservation: observation,
        ...(completionCancellation === undefined && observation !== undefined
          ? { completedObservation: observation }
          : {}),
      },
    );
    // Do not embed the potentially large observation in the projected
    // cancellation diagnostics as well as the cleanup error's observation.
    if (observation !== undefined)
      completionCancellation?.retainPartialObservation(observation);
    bindArtifactFileCleanup(cause, failure);
    return retainOwnedCleanup(failure, failure);
  }
  if (completionCancellation !== undefined) {
    if (observation !== undefined)
      completionCancellation.retainPartialObservation(observation);
    return retainOwnedCleanup(completionCancellation);
  }
  return retainOwnedCleanup(
    nativeMachoSourcePrimary(source, target.path, operation),
  );
};

export interface NativeObservation {
  readonly result: JsonValue;
  readonly limitations: readonly string[];
  readonly locations: readonly EvidenceLocation[];
}

export const isNativeOperation = (
  operation: AnalysisOperation,
): operation is NativeToolName =>
  NATIVE_TOOL_CONTRACTS.some(({ name }) => name === operation);

const translateCodeSignExitFailure = (
  capture: NativeCommandCapture,
  resources: ArtifactResourceScope,
): AnalysisError =>
  translateNativeCommandFailure(
    "inspect_signature",
    new NativeCommandFailure(
      "codesign",
      "nonzero-exit",
      capture.exitCode,
      undefined,
      // Accepted output stays complete until the provider decides it failed.
      failureCapture(capture, false),
    ),
    resources,
  );

/**
 * Accept only codesign's exact unsigned diagnostic for the bound snapshot,
 * optionally preceded by its verified Executable path echo.
 * The operand is framed byte-for-byte so caller-controlled path text cannot
 * supply the phrase that determines signature state.
 */
export const isNonzeroUnsignedObservation = (
  capture: NativeCommandCapture,
  snapshotPath: string,
  executablePaths: readonly string[],
): boolean => {
  if (
    capture.exitCode === null ||
    capture.exitCode === 0 ||
    capture.signal !== null ||
    capture.arguments.at(-1) !== snapshotPath ||
    capture.stdout !== ""
  )
    return false;
  const diagnostic = `${snapshotPath}: code object is not signed at all`;
  return [
    "",
    ...executablePaths.flatMap((path) => [
      `Executable=${path}\n`,
      `Executable=${path}\r\n`,
    ]),
  ].some((prefix) =>
    [diagnostic, `${diagnostic}\n`, `${diagnostic}\r\n`].some(
      (body) => capture.stderr === `${prefix}${body}`,
    ),
  );
};

export const canonicalPath = async (path: string): Promise<string[]> => {
  try {
    return [await realpath(path)];
  } catch {
    return [];
  }
};

export const codeSignCaptureFailure = (
  resources: ArtifactResourceScope,
  capture: NativeCommandCapture,
  snapshotPath: string,
  executablePaths: readonly string[],
): AnalysisError | null =>
  capture.exitCode === 0 ||
  isNonzeroUnsignedObservation(capture, snapshotPath, executablePaths)
    ? null
    : translateCodeSignExitFailure(capture, resources);

export const codeSignArchitectures = (
  format: string | null,
  target: BinaryTarget,
): { architectures: string[]; unknownSlices: boolean } => {
  // An architecture-selected codesign display describes the selected slice,
  // not the admitted container. The target owns the container's slice list.
  if (target.kind === "executable" && target.format === "mach-o-universal") {
    if (target.universalSlices === undefined)
      return { architectures: [], unknownSlices: true };
    const slices = target.universalSlices;
    // Each known selector names exactly one slice, so known names are unique.
    const names = slices.map((_, index) =>
      machoKnownCodeSignSelector(slices, index),
    );
    const known = names.filter((name): name is string => name !== undefined);
    return {
      architectures: known,
      unknownSlices: known.length !== names.length,
    };
  }
  const universal = /^Mach-O universal \(([^)\r\n]+)\)$/u.exec(
    format ?? "",
  )?.[1];
  if (universal !== undefined) {
    const architectures = universal
      .split(/\s+/u)
      .filter((architecture) => /^[A-Za-z][A-Za-z0-9_.]*$/u.test(architecture));
    if (architectures.length > 0)
      return {
        architectures: [...new Set(architectures)],
        unknownSlices: false,
      };
  }
  if (format?.startsWith("Mach-O thin ") === true)
    return { architectures: [], unknownSlices: false };
  if (target.kind !== "executable" || !isMachOFormat(target.format))
    return { architectures: [], unknownSlices: false };
  return {
    architectures: target.availableArchitectures.map((architecture) =>
      architecture === "x86" ? "i386" : architecture,
    ),
    unknownSlices: false,
  };
};

export const invocation = (
  capture: NativeCommandCapture,
  artifactPath: string,
  alias = "$ARTIFACT",
): NativeCommandInvocation => ({
  tool: capture.tool,
  command: [
    capture.executable,
    ...capture.arguments.map((argument) =>
      argument === artifactPath ? alias : argument,
    ),
  ],
  tool_version: capture.toolVersion,
  version_reason: capture.versionReason,
  executable_sha256: capture.executableSha256,
  exit: { code: capture.exitCode, signal: capture.signal },
  stdout_bytes: capture.stdoutBytes,
  stderr_bytes: capture.stderrBytes,
});

export const nativePlistObservation = (input: {
  readonly parsed: ParsedPlist;
  readonly format: z.infer<typeof inspectPlistSchema>["format"];
  readonly path: string;
  readonly sourceSha256: string;
  readonly resourceRoot: ResolvedAppBundleResourceRoot | undefined;
  readonly provenance: readonly NativeCommandInvocation[];
}): NativeObservation => {
  const { parsed, format, path, sourceSha256, resourceRoot, provenance } =
    input;
  const result = inspectPlistSchema.parse({
    format,
    value: parsed.value,
    bundle: parsed.bundle,
    source_path: path,
    source_sha256: sourceSha256,
    ...(resourceRoot === undefined
      ? {}
      : {
          resource_root: {
            caller_path: resourceRoot.callerPath,
            canonical_path: resourceRoot.canonicalPath,
            info_plist_path: resourceRoot.infoPlistPath,
            layout: resourceRoot.layout,
            executable_sha256: resourceRoot.executableSha256,
          },
        }),
    provenance,
    limitations: parsed.limitations,
  });
  return {
    result: ownedJsonValueSchema.parse(result),
    limitations: parsed.limitations,
    locations: [{ kind: "artifact-path", path }],
  };
};

export const parseEntitlements = (
  output: string,
): {
  readonly value: JsonValue;
  readonly limitations: readonly string[];
} => {
  const start = output.indexOf("<?xml");
  const end = output.lastIndexOf("</plist>");
  if (start < 0 || end < start) return { value: null, limitations: [] };
  const decoded = parseXmlPropertyList(
    output.slice(start, end + "</plist>".length),
  );
  const projected = projectPlistValue(decoded.value);
  const numbers = createPlistNumberProjection(decoded.numberLiterals);
  const value = numbers.project(projected.value);
  return {
    value,
    limitations: [
      ...numbers.limitations(),
      ...plistDuplicateKeyLimitations(decoded.duplicateKeys),
      ...(projected.nonFiniteRealCount === 0
        ? []
        : [nonFiniteRealLimitation(projected.nonFiniteRealCount)]),
      ...(projected.negativeZeroRealCount === 0
        ? []
        : [negativeZeroRealLimitation(projected.negativeZeroRealCount)]),
      ...(projected.unknownDateCount === 0
        ? []
        : [unknownDateLimitation(projected.unknownDateCount)]),
      ...(projected.unknownScalarCount === 0
        ? []
        : [unknownScalarLimitation(projected.unknownScalarCount)]),
    ],
  };
};

/** Native admission failures preserve the selected/default source and physical command output. */
export const nativePlistDecodeFailure = (
  selection: NativePlistSelection,
  command: NativeCommandCapture,
  operand: string,
): AnalysisError => {
  const capture = failureCapture(command, false);
  return unreadablePlist(
    selection,
    `plutil could not decode it as a property list (${plutilDiagnostic(capture, operand, selection.path)})`,
    {
      capturedOutput: {
        stdout: capture.stdout,
        stderr: capture.stderr,
        truncated: capture.truncated,
        stdout_bytes: capture.stdoutBytes,
        stderr_bytes: capture.stderrBytes,
        exit_code: capture.exitCode,
        signal: capture.signal,
      },
    },
  );
};

/**
 * The reason REA's XML reader refused a plist's syntax. CoreFoundation accepts
 * some documents that strict XML rejects (#12234), so plutil decides those.
 * Plist structure errors and refused document types are not syntax refusals.
 */
export const xmlSyntaxRefusal = (error: unknown): string | undefined => {
  const cause = error instanceof AnalysisOutputError ? error.cause : undefined;
  return cause instanceof ParseFailureError &&
    cause.failure.format === "xml" &&
    cause.kind === "malformed"
    ? cause.message
    : undefined;
};

const plutilDiagnostic = (
  capture: Pick<NativeCommandCapture, "stdout" | "stderr">,
  operand: string,
  sourcePath: string,
): string => {
  const diagnostics = [capture.stderr, capture.stdout]
    .map((stream) => {
      const text = stream.trim();
      const path = [operand, sourcePath].find((path) =>
        text.startsWith(`${path}: `),
      );
      return path === undefined ? text : text.slice(path.length + 2);
    })
    .filter((text) => text.length > 0);
  return diagnostics.length === 0
    ? "plutil printed no diagnostic"
    : diagnostics.join("\n");
};
