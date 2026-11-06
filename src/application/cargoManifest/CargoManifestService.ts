import { isAbsolute } from "node:path";
import { constants } from "node:buffer";
import { parse as parseToml } from "smol-toml";
import type { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { readStableArtifact } from "../../artifacts/readStableArtifact.js";
import { projectStableArtifactFailure } from "../../artifacts/StableArtifactFailure.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisError as AnalysisErrorClass } from "../../domain/analysisErrorBase.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../../domain/artifactOperationError.js";
import {
  CARGO_MANIFEST_OPERATION as operation,
  CARGO_MANIFEST_PROVIDER,
  type CargoManifestArtifact,
} from "../../domain/cargoManifest/cargoManifest.js";
import {
  inspectCargoManifestInputSchema,
  type InspectCargoManifestInput,
} from "../../domain/cargoManifest/cargoManifestQuery.js";
import { parseCargoManifest } from "../../domain/cargoManifest/parseCargoManifest.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { err, ok, type Result } from "../../domain/result.js";
import { parseAnalysisInput } from "../AnalysisInput.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";

const inputFailure = (message: string, cause?: unknown) =>
  new AnalysisInputError(operation, { cause }, [
    { path: ["path"], reason: "invalid_format", message },
  ]);

/** smol-toml is a dependency of the client-configuration owner, not of a Cargo workflow. */
const decodeManifest = (
  bytes: Buffer,
  path: string,
): Result<unknown, AnalysisError> => {
  if (bytes.includes(0))
    return err(
      inputFailure(
        "Manifest bytes contain a NUL byte, so the file is not TOML text.",
      ),
    );
  const text = bytes.toString("utf8");
  if (
    text.length > constants.MAX_STRING_LENGTH ||
    Buffer.byteLength(text, "utf8") !== bytes.length
  )
    return err(
      inputFailure(`Manifest at ${path} is not valid UTF-8 TOML text.`),
    );
  try {
    return ok(parseToml(text));
  } catch (cause: unknown) {
    return err(inputFailure("Manifest is not valid TOML.", cause));
  }
};

const readManifest = async (
  input: InspectCargoManifestInput,
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
  } catch (cause: unknown) {
    const primary =
      cause instanceof AnalysisErrorClass
        ? cause
        : new ArtifactOperationError(
            operation,
            "io",
            undefined,
            "Manifest read failed.",
            { cause },
          );
    return err(
      projectStableArtifactFailure(
        cause,
        primary,
        input.path,
        CARGO_MANIFEST_PROVIDER.id,
        operation,
      ),
    );
  }
};

/** Shared CLI/MCP import: one verified file read, no Cargo, network or build execution. */
export const inspectCargoManifestEvidence = async (
  rawInput: unknown,
  resources: ArtifactResourceScope,
  options: { readonly signal?: AbortSignal } = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const admitted = parseAnalysisInput(
    operation,
    rawInput,
    inspectCargoManifestInputSchema,
    options.signal,
  );
  if (!admitted.ok) return admitted;
  const input = admitted.value;
  if (!isAbsolute(input.path))
    return err(
      inputFailure("Expected an absolute filesystem path on this host."),
    );
  const source = await readManifest(input, resources, options.signal);
  if (!source.ok) return source;
  const { bytes, sha256 } = source.value;
  const document = decodeManifest(bytes, input.path);
  if (!document.ok) return document;
  const artifact: CargoManifestArtifact = {
    path: input.path,
    sha256,
    bytes: bytes.length,
  };
  const parsed = parseCargoManifest(document.value, artifact);
  if (!parsed.ok) return parsed;
  const result = parsed.value;
  return completeProviderEvidence(
    createEvidence(
      { path: input.path, format: "file", sha256 },
      CARGO_MANIFEST_PROVIDER,
      {
        operation,
        predicateType: "rea.cargo-manifest-inventory",
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
};
