import {
  projectSelectedArtifactFileFailure,
  projectOwnedArtifactIdentityFailure,
  projectOwnedArtifactInputFailure,
  projectStableArtifactFailure,
  projectArtifactCloseFailure,
  ArtifactReaderFailure,
  withStableArtifactHandle,
  artifactFilePrimaryFacts,
  type ArtifactFilePrimaryFacts,
  ArtifactResourceScope,
} from "../../resources/index.js";
import type { PeCertificatesPort } from "../../ports/binaryDiagnostics/PeCertificatesPort.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import { ArtifactOperationError } from "../../domain/artifactOperationError.js";
import { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";
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
import { parsePeCertificatesFromHandle } from "./PeCertificateParser.js";

const OPERATION = "inspect_pe_certificates";
const PE_HEADER_PREFIX_BYTES = 4096;

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
    let observed:
      | { readonly sha256: string; readonly bytes: number }
      | undefined;
    try {
      return await this.#resources.run(async () =>
        withStableArtifactHandle(
          input.path,
          input.max_file_bytes,
          {
            retainBytes: (size) => Math.min(size, PE_HEADER_PREFIX_BYTES),
            signal: options?.signal,
            resourceScope: this.#resources,
            onIdentity: (identity) => {
              observed = identity;
            },
          },
          async (handle) =>
            ok(
              await parsePeCertificatesFromHandle(
                handle,
                {
                  path: input.path,
                  sha256: handle.sha256,
                  bytes: handle.size,
                },
                input,
              ),
            ),
        ),
      );
    } catch (cause) {
      return err(peCertificatesFailure(cause, input, observed));
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
      name: "The PE certificate ASN.1 value allowance",
      unit: "values per PKCS#7 payload",
    },
    "asn1-depth": {
      limits: { max_asn1_depth: limit },
      name: "The PE certificate ASN.1 nesting allowance",
      unit: "nesting levels per PKCS#7 payload",
    },
    "decoded-text": {
      limits: { max_decoded_text_bytes: limit },
      name: "The PE certificate decoded-text allowance",
      unit: "bytes per PKCS#7 payload",
    },
    "oid-bytes": {
      limits: { max_oid_bytes: limit },
      name: "The PE certificate OBJECT IDENTIFIER allowance",
      unit: "bytes per OID",
    },
    "oid-arc-bytes": {
      limits: { max_oid_arc_bytes: limit },
      name: "The PE certificate OBJECT IDENTIFIER arc allowance",
      unit: "bytes per base-128 arc",
    },
  }[allowance];
  return new AnalysisResourceConstraintError(
    OPERATION,
    "memory",
    `PKCS#7 signedData exceeds a fixed decoder allowance: ${cause.message}`,
    selected.limits,
    {
      cause,
      ...fixedAllowanceOptions(selected.name, "parser", {
        limit,
        unit: selected.unit,
      }),
    },
  );
};

const peCertificatesFailurePrimary = (
  facts: ArtifactFilePrimaryFacts,
  input: InspectPeCertificatesInput,
) => {
  const { cause, origin } = facts;
  const identityFailure = projectOwnedArtifactIdentityFailure(
    facts,
    OPERATION,
    input.path,
  );
  if (identityFailure !== undefined) return identityFailure;
  const inputFailure = projectOwnedArtifactInputFailure(
    facts,
    OPERATION,
    input.path,
  );
  if (inputFailure !== undefined) return inputFailure;
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
  observed?: { readonly sha256: string; readonly bytes: number },
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
    observed,
  );
};
