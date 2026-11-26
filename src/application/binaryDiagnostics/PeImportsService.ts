import { insideArtifact } from "./artifactRange.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { PeImportsPort } from "../../ports/binaryDiagnostics/PeImportsPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Evidence } from "../../domain/evidence.js";
import {
  inspectPeImportsInputSchema,
  peImportsSchema,
  type PeImportFunction,
  type PeImports,
} from "../../domain/native/peImports.js";
import { peVa } from "../../domain/native/peAddressSpace.js";
import { observedPeEvidence } from "./observedPeEvidence.js";
import type { Result } from "../../domain/result.js";
import { executeArtifactInspection } from "../ArtifactInspectionExecution.js";

const OPERATION = "inspect_pe_imports";

/** Shared caller validation, output parsing and Evidence provenance for CLI/MCP. */
export class PeImportsService {
  constructor(readonly provider: PeImportsPort) {}

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
        inputSchema: inspectPeImportsInputSchema,
        outputSchema: peImportsSchema,
        provider: this.provider,
        invalidOutputMessage:
          "PE import provider returned malformed output or changed artifact identity.",
        toParameters: (input) => input,
        validateReport: (report, input) =>
          report.artifact.path === input.path && validReport(report, input),
        buildEvidence: (value, identity, parameters) =>
          observedPeEvidence(value, identity, OPERATION, parameters, [
            ...fileRange(value.import_directory),
            ...fileRange(value.delay_import_directory),
          ]),
      },
      rawInput,
      options,
    );
  }
}

const fileRange = (
  directory: PeImports["import_directory"],
): readonly {
  kind: "file-offset-range";
  start: number;
  end: number;
}[] =>
  directory === null
    ? []
    : directory.locations.map(({ offset, bytes }) => ({
        kind: "file-offset-range" as const,
        start: offset,
        end: offset + bytes,
      }));

const validReport = (
  report: PeImports,
  input: {
    readonly max_dlls: number;
    readonly max_functions: number;
  },
): boolean => {
  const inside = insideArtifact(report.artifact.bytes);
  const dllCount = report.imports.length + report.delay_imports.length;
  if (
    report.coverage.examined_dlls > input.max_dlls ||
    dllCount > report.coverage.examined_dlls ||
    (report.coverage.status === "complete" &&
      (dllCount !== report.coverage.examined_dlls || report.issues.length > 0))
  )
    return false;
  const importCount = report.imports.reduce(
    (count, dll) => count + dll.functions.length,
    0,
  );
  const delayImportCount = report.delay_imports.reduce(
    (count, dll) => count + dll.functions.length,
    0,
  );
  if (
    importCount !== report.coverage.imports ||
    delayImportCount !== report.coverage.delay_imports ||
    importCount + delayImportCount > input.max_functions
  )
    return false;
  for (const directory of [
    report.import_directory,
    report.delay_import_directory,
  ]) {
    if (
      directory !== null &&
      (!directory.locations.every(inside) ||
        (directory.locations.length === 0 &&
          report.coverage.status === "complete"))
    )
      return false;
  }
  const descriptorsFit = (
    rows: readonly { location: { offset: number; bytes: number } }[],
  ) => rows.every((row) => inside(row.location));
  // A slot VA is the image base plus its RVA; a report that disagrees
  // cannot be cited as a provider address.
  const base = report.image_base;
  const vasAgree = (
    rows: readonly { functions: readonly PeImportFunction[] }[],
  ) =>
    rows.every(({ functions }) =>
      functions.every(
        ({ iat_rva, iat_va }) =>
          iat_va === undefined ||
          (base !== undefined && iat_va === peVa(BigInt(base), iat_rva)),
      ),
    );
  return (
    descriptorsFit(report.imports) &&
    descriptorsFit(report.delay_imports) &&
    vasAgree(report.imports) &&
    vasAgree(report.delay_imports)
  );
};
