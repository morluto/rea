import { insideArtifact } from "./artifactRange.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { PeCertificatesPort } from "../../ports/binaryDiagnostics/PeCertificatesPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  inspectPeCertificatesInputSchema,
  peCertificatesSchema,
  type PeCertificates,
} from "../../domain/native/peCertificates.js";
import { peSubjectArchitecture } from "../../domain/peMachine.js";
import type { Result } from "../../domain/result.js";
import { executeArtifactInspection } from "../ArtifactInspectionExecution.js";

const OPERATION = "inspect_pe_certificates";

/** Shared caller validation, output parsing and Evidence provenance for CLI/MCP. */
export class PeCertificatesService {
  constructor(readonly provider: PeCertificatesPort) {}

  close(): Promise<void> {
    return this.provider.close?.() ?? Promise.resolve();
  }

  inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    return executeArtifactInspection(
      {
        operation: OPERATION,
        inputSchema: inspectPeCertificatesInputSchema,
        outputSchema: peCertificatesSchema,
        provider: this.provider,
        invalidOutputMessage:
          "PE certificate provider returned malformed output or changed artifact identity.",
        toParameters: (input) => input,
        validateReport: (report, parameters) =>
          report.artifact.path === parameters.path &&
          validReport(report, parameters.max_entries),
        buildEvidence: (value, identity, parameters) => {
          const architecture = peSubjectArchitecture(
            value.machine,
            value.format,
          );
          const locations = [
            { kind: "artifact-path" as const, path: value.artifact.path },
            ...(value.table === null
              ? []
              : [
                  {
                    kind: "file-offset-range" as const,
                    start: value.table.location.offset,
                    end:
                      value.table.location.offset + value.table.location.bytes,
                  },
                ]),
          ];
          return createEvidence(
            {
              path: value.artifact.path,
              format: "pe",
              sha256: value.artifact.sha256,
              ...(architecture === undefined ? {} : { architecture }),
            },
            identity,
            {
              operation: OPERATION,
              parameters,
              result: value,
              confidence: "observed",
              limitations: value.limitations,
              locations,
            },
          );
        },
      },
      rawInput,
      options,
    );
  }
}

const validReport = (report: PeCertificates, maxEntries: number): boolean => {
  const inside = insideArtifact(report.artifact.bytes);
  if (
    report.coverage.examined_entries > maxEntries ||
    report.coverage.examined_entries !== report.entries.length ||
    report.coverage.certificates !==
      report.entries.reduce(
        (count, entry) => count + (entry.pkcs7?.certificates.length ?? 0),
        0,
      )
  )
    return false;
  if (
    report.coverage.status === "complete" &&
    report.entries.some((entry) =>
      entry.pkcs7?.signers.some((signer) =>
        Array.isArray(signer.unsigned_attribute_oids),
      ),
    )
  )
    return false;
  if (report.table === null) return report.entries.length === 0;
  if (
    !inside(report.table.location) ||
    !inside(report.table.data_directory_location)
  )
    return false;
  const table = report.table;
  const contains = (
    outer: { offset: number; bytes: number },
    inner: { offset: number; bytes: number },
  ) =>
    inner.offset >= outer.offset &&
    inner.offset - outer.offset <= outer.bytes - inner.bytes;
  return report.entries.every(
    (entry) =>
      contains(table.location, entry.location) &&
      contains(entry.location, entry.payload.location) &&
      (entry.pkcs7?.certificates.every((certificate) =>
        contains(entry.payload.location, certificate.location),
      ) ??
        true),
  );
};
