import { constants } from "node:buffer";
import { isAbsolute } from "node:path";
import type { Element } from "@xmldom/xmldom";
import {
  ArtifactReaderFailure,
  projectStableArtifactFailure,
  readStableArtifact,
  stableArtifactInputRecovery,
  type ArtifactResourceScope,
} from "../../resources/index.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisInputError,
} from "../../domain/analysisErrorCore.js";
import { classifyProviderFailure } from "../../providers/classifyProviderFailure.js";
import { parseLimitConstraint } from "../../domain/parseFailureAnalysisError.js";
import { decodeStrictUtf8 } from "../../domain/strictUtf8.js";
import { ArtifactOperationError } from "../../domain/artifactOperationError.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  MAVEN_POM_OPERATION as operation,
  MAVEN_POM_PROVIDER,
  MAVEN_POM_MAX_XML_NODES,
  type MavenPom,
  type MavenPomArtifact,
} from "../../domain/mavenPom/mavenPom.js";
import {
  inspectMavenPomInputSchema,
  type InspectMavenPomInput,
} from "../../domain/mavenPom/mavenPomQuery.js";
import { parseMavenPom } from "../../domain/mavenPom/parseMavenPom.js";
import { ParseFailureError, decodeLimit } from "../../domain/parseFailure.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  parseXmlDocument,
  XmlDocumentNodeLimitError,
} from "../../domain/xmlDocument.js";
import {
  callerAnalysisParameters,
  parseAnalysisInput,
} from "../AnalysisInput.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";

const inputFailure = (message: string, cause?: unknown) =>
  new AnalysisInputError(
    operation,
    {
      cause,
      ...(cause instanceof ArtifactReaderFailure
        ? stableArtifactInputRecovery(cause)
        : {}),
    },
    [{ path: ["path"], reason: "invalid_format", message }],
  );

const UTF16LE = new TextDecoder("utf-16le", { fatal: true });
const UTF16BE = new TextDecoder("utf-16be", { fatal: true });
const SUPPORTED_MODEL_VERSION = "4.0.0";

/**
 * XML 1.0 permits several encodings. A UTF-16 byte order mark, in either order,
 * selects the matching UTF-16 decoder; everything else is read as UTF-8 and a
 * failure is reported as an unsupported encoding rather than as malformed XML,
 * because the bytes may be well-formed in an encoding this reader does not
 * implement.
 */
const decodeXmlText = (bytes: Buffer): Result<string, string> => {
  try {
    // The WHATWG decoder this replaced stripped a leading BOM, which is the
    // strip-signature policy rather than content-preserving UTF-8.
    if (bytes[0] === 0xff && bytes[1] === 0xfe)
      return ok(UTF16LE.decode(bytes));
    if (bytes[0] === 0xfe && bytes[1] === 0xff)
      return ok(UTF16BE.decode(bytes));
    return ok(decodeStrictUtf8(bytes, "strip-signature"));
  } catch {
    return err(
      "not valid UTF-8 XML text (only UTF-8 and byte-order-marked UTF-16 are supported)",
    );
  }
};

/**
 * Decode and parse one POM. Document type declarations are rejected before the
 * DOM is built, so an external entity reference never reaches a resolver.
 */
const decodePom = (
  bytes: Buffer,
  artifact: MavenPomArtifact,
): Result<MavenPom, AnalysisError> => {
  const { path } = artifact;
  const decoded = decodeXmlText(bytes);
  if (!decoded.ok)
    return err(inputFailure(`POM at ${path}: ${decoded.error}.`));
  const source = decoded.value;
  if (source.length > constants.MAX_STRING_LENGTH)
    return err(
      inputFailure(
        `POM at ${path} exceeds the maximum in-memory string length.`,
      ),
    );
  const document = parseXmlDocument(source, {
    doctype: "reject",
    lineEndings: "normalize",
    maxNodes: MAVEN_POM_MAX_XML_NODES,
  });
  if (!document.ok && document.error instanceof XmlDocumentNodeLimitError)
    return err(
      parseLimitConstraint(operation, "memory", document.error, {
        retryable: false,
        remediationAction:
          "Select a POM within the XML node allowance; paging does not change it.",
      }),
    );
  if (!document.ok)
    return err(inputFailure(document.error.message, document.error));
  const root = document.value.documentElement;
  if (root === null || root.localName !== "project")
    return err(
      inputFailure(
        `POM at ${path} has no <project> document element, so it is not a Maven POM.`,
      ),
    );
  // An Ant build file shares the <project> root name; a direct child
  // <modelVersion> is what separates a Maven POM from other project XML.
  const modelVersionElement = Array.from(
    { length: root.childNodes.length },
    (_, index) => root.childNodes.item(index),
  ).find(
    (node): node is Element =>
      node !== null &&
      node.nodeType === 1 &&
      (node as unknown as Element).localName === "modelVersion",
  );
  const declaredModel =
    modelVersionElement === undefined
      ? null
      : (modelVersionElement.textContent ?? "").trim();
  if (declaredModel !== SUPPORTED_MODEL_VERSION)
    return err(
      inputFailure(
        `POM at ${path} declares modelVersion ${declaredModel ?? "(none)"}; Maven model ${SUPPORTED_MODEL_VERSION} is the only one this reader supports.`,
      ),
    );
  try {
    return ok(parseMavenPom(document.value, artifact));
  } catch (cause: unknown) {
    if (!(cause instanceof ParseFailureError) || cause.kind !== "limit")
      throw cause;
    return err(
      parseLimitConstraint(operation, "memory", cause, {
        retryable: false,
        remediationAction:
          "Select a POM whose declarations fit max_file_bytes; the retained-facts allowance is not adjustable and paging does not change it.",
      }),
    );
  }
};

/**
 * A file read the artifact reader refused at one of its own allowances. The
 * reader names the bound it enforced and the resource it bounds, so the
 * refusal keeps that boundary rather than relabelling every limit as memory
 * (`max_file_bytes` is `file-size`; other bounds name their own category).
 */
const fileReadLimitFailure = (
  cause: ArtifactReaderFailure,
  input: InspectMavenPomInput,
): AnalysisError => {
  const boundary = cause.boundary ?? "file-size";
  return parseLimitConstraint(
    operation,
    boundary,
    decodeLimit("maven-pom", cause.message, {
      name: boundary === "file-size" ? "max_file_bytes" : boundary,
      maximum: input.max_file_bytes,
    }),
    {
      retryable: false,
      remediationAction:
        boundary === "file-size"
          ? "Select a POM within max_file_bytes; paging does not change this file admission."
          : "Select a POM whose declarations fit the reported allowance; the ceiling is not adjustable and paging does not change it.",
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
    // The shared classifier owns cancellation, integrity, selected-file and
    // file-size-limit projections; this provider supplies only its dialect.
    const primary = classifyProviderFailure(failure, {
      providerId: MAVEN_POM_PROVIDER.id,
      operation,
      file: {
        path: input.path,
        description: "POM",
        fileSize: (cause: ArtifactReaderFailure) =>
          fileReadLimitFailure(cause, input),
        retainCompletedIdentity: true,
      },
      unclassified: (cause) =>
        new ArtifactOperationError(operation, "io", undefined, "POM read failed.", {
          cause,
        }),
    });
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
  // Capture what the caller selected before defaults are resolved, so saved
  // Evidence distinguishes a chosen control from one the app filled in.
  const selectedParameters = callerAnalysisParameters(rawInput);
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
        parameters: selectedParameters({
          path: input.path,
          format: input.format,
          max_file_bytes: input.max_file_bytes,
        }),
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
