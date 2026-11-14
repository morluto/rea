import { BinaryFormatFailure } from "../metadata/BinaryContainer.js";
import {
  projectSelectedArtifactFileFailure,
  projectOwnedArtifactIdentityFailure,
  projectStableArtifactFailure,
  stableArtifactInputFailure,
  projectArtifactCloseFailure,
} from "../../artifacts/StableArtifactFailure.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import {
  type StableArtifactSnapshot,
  readStableArtifact,
} from "../../artifacts/readStableArtifact.js";
import {
  artifactFilePrimaryFacts,
  type ArtifactFilePrimaryFacts,
} from "../../artifacts/ArtifactFileOperation.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import type { PeCertificatesPort } from "../../application/binaryDiagnostics/PeCertificatesPort.js";
import type { ExecutionOptions } from "../../application/AnalysisProvider.js";
import { ArtifactOperationError } from "../../domain/artifactOperationError.js";
import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
} from "../../domain/analysisErrorCore.js";
import {
  MAX_INSPECT_PE_CERTIFICATE_ENTRIES,
  MAX_INSPECT_PE_CERTIFICATE_FILE_BYTES,
  type InspectPeCertificatesInput,
} from "../../domain/native/peCertificates.js";
import { err, ok } from "../../domain/result.js";
import { fixedAllowanceOptions } from "../../domain/fixedAllowanceRemediation.js";
import { PE_CERTIFICATES_PROVIDER } from "../../domain/investigationProviders.js";
import {
  PeCertificateAsn1Failure,
  type PeCertificateDecodeAllowance,
} from "./PeCertificateAsn1.js";
import { parsePeCertificates } from "./PeCertificateParser.js";

const OPERATION = "inspect_pe_certificates";

/** Portable parser over one bounded, identity-checked regular file. */
export class PeCertificatesProvider implements PeCertificatesPort {
  readonly identity = PE_CERTIFICATES_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      throw projectArtifactCloseFailure(
        cause,
        PE_CERTIFICATES_PROVIDER.id,
        OPERATION,
      );
    }
  }

  async inspect(input: InspectPeCertificatesInput, options?: ExecutionOptions) {
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
        return ok(
          parsePeCertificates(
            snapshot.bytes,
            {
              path: input.path,
              sha256: snapshot.sha256,
              bytes: snapshot.bytes.length,
            },
            input,
          ),
        );
      });
    } catch (cause) {
      return err(peCertificatesFailure(cause, input, snapshot));
    }
  }
}

const inputBudgetRemediation = (
  boundary: "file-size" | "capacity",
  input: InspectPeCertificatesInput,
): string =>
  boundary === "file-size"
    ? input.max_file_bytes >= MAX_INSPECT_PE_CERTIFICATE_FILE_BYTES
      ? `The image exceeds the ${String(MAX_INSPECT_PE_CERTIFICATE_FILE_BYTES)}-byte input ceiling this operation accepts; select a smaller artifact.`
      : `Raise max_file_bytes above ${String(input.max_file_bytes)} bytes or select a smaller artifact; the limit is the caller-selected input read budget.`
    : input.max_entries >= MAX_INSPECT_PE_CERTIFICATE_ENTRIES
      ? `The image exceeds the ${String(MAX_INSPECT_PE_CERTIFICATE_ENTRIES)}-entry certificate-table ceiling this operation accepts; select a smaller artifact.`
      : `Raise max_entries above ${String(input.max_entries)} or select a smaller artifact; the limit is the caller-selected certificate entry budget.`;

/** A fixed PKCS#7 decoder allowance; neither request fields nor retries raise it. */
const decoderAllowanceFailure = (
  cause: PeCertificateAsn1Failure,
  { allowance, limit }: PeCertificateDecodeAllowance,
) => {
  const selected = {
    "asn1-nodes": {
      limits: { max_asn1_values: limit },
      description: `The PE certificate ASN.1 allowance of ${String(limit)} values per PKCS#7 payload (this release has no runtime override)`,
    },
    "asn1-depth": {
      limits: { max_asn1_depth: limit },
      description: `The PE certificate ASN.1 allowance of ${String(limit)} nesting levels per PKCS#7 payload (this release has no runtime override)`,
    },
    "decoded-text": {
      limits: { max_decoded_text_bytes: limit },
      description: `The PE certificate decoded-text allowance of ${String(limit)} bytes per PKCS#7 payload (this release has no runtime override)`,
    },
    "oid-bytes": {
      limits: { max_oid_bytes: limit },
      description: `The PE certificate OBJECT IDENTIFIER allowance of ${String(limit)} bytes per OID (this release has no runtime override)`,
    },
    "oid-arc-bytes": {
      limits: { max_oid_arc_bytes: limit },
      description: `The PE certificate OBJECT IDENTIFIER allowance of ${String(limit)} bytes per base-128 arc (this release has no runtime override)`,
    },
  }[allowance];
  return new AnalysisResourceConstraintError(
    OPERATION,
    "memory",
    `PKCS#7 signedData exceeds a fixed decoder allowance: ${cause.message}`,
    selected.limits,
    {
      cause,
      ...fixedAllowanceOptions(selected.description, "parser"),
    },
  );
};

const peCertificatesFailurePrimary = (
  facts: ArtifactFilePrimaryFacts,
  input: InspectPeCertificatesInput,
) => {
  const { cause, origin } = facts;
  if (cause instanceof BinaryFormatFailure && cause.kind === "unsupported")
    return new AnalysisUnsupportedTargetError(
      OPERATION,
      input.path,
      cause.message,
      { cause },
    );

  const identityFailure = projectOwnedArtifactIdentityFailure(
    facts,
    OPERATION,
    input.path,
  );
  if (identityFailure !== undefined) return identityFailure;
  if (
    origin === "owned-or-classified" &&
    cause instanceof PeCertificateAsn1Failure &&
    cause.exhausted !== null
  )
    return decoderAllowanceFailure(cause, cause.exhausted);
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure
  ) {
    if (cause.reason === "limit")
      return new AnalysisResourceConstraintError(
        OPERATION,
        cause.boundary ?? "memory",
        cause.message,
        {
          max_file_bytes: input.max_file_bytes,
          max_entries: input.max_entries,
        },
        {
          cause,
          ...(cause.boundary === undefined || cause.boundary === "memory"
            ? {}
            : {
                retryable: false,
                remediationAction: inputBudgetRemediation(
                  cause.boundary,
                  input,
                ),
              }),
        },
      );
    if (cause.reason === "path" || cause.reason === "format")
      return stableArtifactInputFailure(cause, OPERATION);
  }
  const fileFailure = projectSelectedArtifactFileFailure(
    cause,
    OPERATION,
    input.path,
    "PE image",
  );
  if (fileFailure !== undefined) return fileFailure;
  return new ArtifactOperationError(
    OPERATION,
    origin === "owned-or-classified" && cause instanceof ArtifactReaderFailure
      ? cause.reason
      : "io",
    undefined,
    cause instanceof Error
      ? cause.message
      : "PE certificate inspection failed.",
    { cause },
  );
};

const peCertificatesFailure = (
  cause: unknown,
  input: InspectPeCertificatesInput,
  snapshot?: StableArtifactSnapshot,
) => {
  const primary = peCertificatesFailurePrimary(
    artifactFilePrimaryFacts(cause),
    input,
  );
  return projectStableArtifactFailure(
    cause,
    primary,
    input.path,
    PE_CERTIFICATES_PROVIDER.id,
    OPERATION,
    snapshot,
  );
};
