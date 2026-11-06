import { constants } from "node:buffer";
import { isAbsolute } from "node:path";
import type { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import {
  artifactFileCancellationCause,
  artifactFilePrimaryFacts,
} from "../../artifacts/ArtifactFileOperation.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { readStableArtifact } from "../../artifacts/readStableArtifact.js";
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
  MAVEN_POM_OPERATION as operation,
  MAVEN_POM_PROVIDER,
  type MavenPom,
  type MavenPomArtifact,
} from "../../domain/mavenPom/mavenPom.js";
import {
  inspectMavenPomInputSchema,
  type InspectMavenPomInput,
} from "../../domain/mavenPom/mavenPomQuery.js";
import { parseMavenPom } from "../../domain/mavenPom/parseMavenPom.js";
import { err, ok, type Result } from "../../domain/result.js";
import { parseXmlDocument } from "../../domain/xmlDocument.js";
import { parseAnalysisInput } from "../AnalysisInput.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";

const inputFailure = (message: string, cause?: unknown) =>
  new AnalysisInputError(operation, { cause }, [
    { path: ["path"], reason: "invalid_format", message },
  ]);

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Decode and parse one POM. Document type declarations are rejected before the
 * DOM is built, so an external entity reference never reaches a resolver.
 */
const decodePom = (
  bytes: Buffer,
  artifact: MavenPomArtifact,
): Result<MavenPom, AnalysisError> => {
  const { path } = artifact;
  if (bytes.includes(0))
    return err(
      inputFailure(
        `POM bytes at ${path} contain a NUL byte, so they are not XML text.`,
      ),
    );
  let source: string;
  try {
    source = UTF8.decode(bytes);
  } catch (cause: unknown) {
    return err(
      inputFailure(`POM at ${path} is not valid UTF-8 XML text.`, cause),
    );
  }
  if (source.length > constants.MAX_STRING_LENGTH)
    return err(
      inputFailure(
        `POM at ${path} exceeds the maximum in-memory string length.`,
      ),
    );
  const document = parseXmlDocument(source, {
    doctype: "reject",
    lineEndings: "normalize",
  });
  if (!document.ok)
    return err(inputFailure(document.error.message, document.error));
  const root = document.value.documentElement;
  if (root === null || root.localName !== "project")
    return err(
      inputFailure(
        `POM at ${path} has no <project> document element, so it is not a Maven POM.`,
      ),
    );
  return ok(parseMavenPom(document.value, artifact));
};

const readFailure = (
  failure: unknown,
  input: InspectMavenPomInput,
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
            "Select a POM within max_file_bytes; paging does not change this file admission.",
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
  }
  return new ArtifactOperationError(
    operation,
    "io",
    undefined,
    "POM read failed.",
    {
      cause: failure,
    },
  );
};

const readPom = async (
  input: InspectMavenPomInput,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<Result<{ bytes: Buffer; sha256: string }, AnalysisError>> => {
  try {
    return ok(
      await resources.run(() =>
        readStableArtifact(
          input.path,
          input.max_file_bytes,
          signal,
          undefined,
          resources,
        ),
      ),
    );
  } catch (failure: unknown) {
    const primary = readFailure(failure, input);
    return err(
      projectStableArtifactFailure(
        failure,
        primary,
        input.path,
        MAVEN_POM_PROVIDER.id,
        operation,
      ),
    );
  }
};

/** Shared CLI/MCP import: one verified file read, no Maven, network or build execution. */
export interface MavenPomInspection {
  readonly evidence: Evidence;
  /** The verified read, retained as partial evidence when parsing fails. */
  readonly observation: MavenPomArtifact;
}

export const inspectMavenPomEvidence = async (
  rawInput: unknown,
  resources: ArtifactResourceScope,
  options: { readonly signal?: AbortSignal } = {},
): Promise<Result<MavenPomInspection, AnalysisError>> => {
  const admitted = parseAnalysisInput(
    operation,
    rawInput,
    inspectMavenPomInputSchema,
    options.signal,
  );
  if (!admitted.ok) return admitted;
  const input = admitted.value;
  if (!isAbsolute(input.path))
    return err(
      inputFailure("Expected an absolute filesystem path on this host."),
    );
  const source = await readPom(input, resources, options.signal);
  if (!source.ok) return source;
  const { bytes, sha256 } = source.value;
  const artifact: MavenPomArtifact = {
    path: input.path,
    sha256,
    bytes: bytes.length,
  };

  const retain = <T>(result: Result<T, AnalysisError>) => {
    if (!result.ok)
      result.error.retainPartialObservation({
        kind: "file-snapshot-hash",
        path: input.path,
        sha256,
        bytes: bytes.length,
      });
    return result;
  };
  const decoded = retain(decodePom(bytes, artifact));
  if (!decoded.ok) return decoded;
  const result = decoded.value;

  const evidence = await completeProviderEvidence(
    createEvidence(
      { path: input.path, format: "file", sha256 },
      MAVEN_POM_PROVIDER,
      {
        operation,
        predicateType: "rea.maven-pom-inventory",
        parameters: {
          path: input.path,
          format: input.format,
          max_file_bytes: input.max_file_bytes,
        },
        result,
        confidence: "observed",
        limitations: result.limitations,
        locations: [{ kind: "artifact-path", path: input.path }],
      },
    ),
    options.signal,
  );
  return evidence.ok
    ? ok({ evidence: evidence.value, observation: artifact })
    : evidence;
};
