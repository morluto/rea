import { setImmediate as immediate } from "node:timers/promises";
import { sha256Hex } from "../../kernel/sha256Hex.js";
import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../../ports/AnalysisProvider.js";
import type { FirmwareLiteralPoolsPort } from "../../ports/binaryDiagnostics/FirmwareLiteralPoolsPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisInputError,
  AnalysisOutputError,
  cancelledBy,
} from "../../domain/analysisErrorCore.js";
import {
  createEvidence,
  createImmutableEvidenceSteps,
  type Evidence,
} from "../../domain/evidence.js";
import { freezeOwnedJsonSnapshotSteps } from "../../domain/immutableJson.js";
import { jsonValueValidationSteps } from "../../domain/jsonValue.js";
import {
  firmwareLiteralPoolsReportSchema,
  inspectFirmwareLiteralPoolsInputSchema,
  type FirmwareLiteralPoolsReport,
  type InspectFirmwareLiteralPoolsInput,
} from "../../domain/firmware/firmwareLiteralPools.js";
import { validateLiteralPoolAddressAlignment } from "../../domain/firmware/firmwareLiteralPoolScanner.js";
import { err, type Result } from "../../domain/result.js";
import {
  callerAnalysisParameters,
  parseAnalysisInput,
} from "../AnalysisInput.js";
import {
  completeProviderEvidence,
  retainCompletedArtifactEvidence,
} from "../ProviderOperationExecution.js";

const OPERATION = "inspect_firmware_literal_pools";

const validLiteralPoolsReport = (
  report: FirmwareLiteralPoolsReport,
  input: InspectFirmwareLiteralPoolsInput,
): boolean => {
  if (report.artifact.path !== input.path) return false;
  if (report.isa !== input.isa) return false;
  if (report.artifact.bytes > input.max_file_bytes) return false;
  if (report.references.length > input.max_references) return false;
  if (report.references.length !== report.counts.resolved_pool_loads)
    return false;
  if (report.coverage.retained_references !== report.references.length)
    return false;
  if (report.coverage.omitted_references !== 0) return false;
  if (report.scan_range.scanned_bytes > input.max_scan_bytes) return false;
  if (report.scan_range.end > report.artifact.bytes) return false;
  return true;
};

const isSignalAborted = (signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true;

const stepCooperatively = async <T>(
  steps: Generator<void, T>,
  signal: AbortSignal | undefined,
): Promise<T> => {
  if (isSignalAborted(signal)) throw cancelledBy(OPERATION, signal!);
  for (;;) {
    const next = steps.next();
    if (next.done === true) return next.value;
    await immediate();
    if (isSignalAborted(signal)) throw cancelledBy(OPERATION, signal!);
  }
};

const buildEvidenceObservation = (
  value: FirmwareLiteralPoolsReport,
  selected: Readonly<Record<string, unknown>>,
) => {
  const { svd_xml, ...restSelected } = selected;
  const evidenceParams =
    typeof svd_xml !== "string"
      ? restSelected
      : {
          ...restSelected,
          svd_xml_sha256: sha256Hex(svd_xml),
        };
  return {
    operation: OPERATION,
    parameters: evidenceParams as FirmwareLiteralPoolsEvidenceParameters,
    result: value,
    confidence: "derived" as const,
    limitations: value.limitations,
    locations: [
      { kind: "artifact-path" as const, path: value.artifact.path },
      {
        kind: "file-offset-range" as const,
        start: value.scan_range.start,
        end: value.scan_range.end,
      },
    ],
  };
};

type FirmwareLiteralPoolsEvidenceParameters = Readonly<
  Record<string, string | number | boolean | null>
>;

const createLiteralPoolsEvidenceCooperatively = async (
  value: FirmwareLiteralPoolsReport,
  identity: ProviderIdentity,
  selected: Readonly<Record<string, unknown>>,
  signal: AbortSignal | undefined,
): Promise<Evidence> => {
  const snapshot = await stepCooperatively(
    freezeOwnedJsonSnapshotSteps(value),
    signal,
  );
  await stepCooperatively(jsonValueValidationSteps(snapshot), signal);
  return stepCooperatively(
    createImmutableEvidenceSteps(
      {
        path: snapshot.artifact.path,
        format: "file",
        sha256: snapshot.artifact.sha256,
      },
      identity,
      buildEvidenceObservation(snapshot, selected),
    ),
    signal,
  );
};

/** Shared caller validation, output parsing, and cooperative Evidence provenance for CLI/MCP. */
export class FirmwareLiteralPoolsService {
  constructor(readonly provider: FirmwareLiteralPoolsPort) {}

  close(): Promise<void> {
    return this.provider.close?.() ?? Promise.resolve();
  }

  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const parsedInput = parseAnalysisInput(
      OPERATION,
      rawInput,
      inspectFirmwareLiteralPoolsInputSchema,
      options?.signal,
    );
    if (!parsedInput.ok) return parsedInput;
    const staticCheck = validateLiteralPoolAddressAlignment({
      isa: parsedInput.value.isa,
      baseAddressHex: parsedInput.value.base_address,
      scanOffset: parsedInput.value.scan_offset,
    });
    if (staticCheck.issues.length > 0) {
      return err(
        new AnalysisInputError(OPERATION, undefined, staticCheck.issues),
      );
    }

    const parameters = parsedInput.value;
    const selectCallerParameters = callerAnalysisParameters(rawInput);
    const inspected = await this.provider.inspect(parameters, options);
    const rawReport = inspected.ok
      ? inspected.value
      : inspected.error.partialObservation;
    if (!inspected.ok && rawReport === undefined) return inspected;

    const checked = firmwareLiteralPoolsReportSchema.safeParse(rawReport);
    if (!checked.success || !validLiteralPoolsReport(checked.data, parameters))
      return inspected.ok
        ? err(
            new AnalysisOutputError(
              OPERATION,
              "Firmware literal-pools provider returned malformed output or mismatched artifact identity.",
            ),
          )
        : inspected;

    const selected = selectCallerParameters(parameters);
    if (!inspected.ok) {
      const retained = createEvidence(
        {
          path: checked.data.artifact.path,
          format: "file",
          sha256: checked.data.artifact.sha256,
        },
        this.provider.identity,
        buildEvidenceObservation(checked.data, selected),
      );
      retainCompletedArtifactEvidence(inspected.error, retained);
      return inspected;
    }

    try {
      const evidence = await createLiteralPoolsEvidenceCooperatively(
        checked.data,
        this.provider.identity,
        selected,
        options?.signal,
      );
      return completeProviderEvidence(evidence, options?.signal);
    } catch (cause) {
      if (options?.signal?.aborted === true) {
        return err(cancelledBy(OPERATION, options.signal));
      }
      throw cause;
    }
  }
}
