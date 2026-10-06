import { join, isAbsolute } from "node:path";
import { z } from "zod";
import type { FirmwareAnalysisPort } from "../application/FirmwareAnalysisPort.js";
import {
  createAnalysisExecution,
  type ExecutionOptions,
} from "../application/AnalysisProvider.js";
import {
  firmwareResultSchemas,
  type FirmwareRequest,
} from "../domain/firmwareAnalysis.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok } from "../domain/result.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import { publishFirmwareExtraction } from "./FirmwarePublication.js";
import {
  FIRMWARE_LIMITS,
  FIRMWARE_RELEASES,
  BINWALK_PROVIDER_IDENTITY,
  UNBLOB_PROVIDER_IDENTITY,
} from "./FirmwareRelease.js";
import {
  resolveFirmwareCommand,
  runFirmwareCommand,
  readFirmwareCommandReport,
  type FirmwareLauncher,
} from "./FirmwareCommand.js";
import { inventoryFirmwareOutput, snapshotFirmware } from "./FirmwareFiles.js";
import {
  normalizeBinwalkReport,
  normalizeUnblobReport,
} from "./FirmwareReports.js";

type Outcome = Awaited<ReturnType<FirmwareAnalysisPort["execute"]>>;
const waitForPredecessor = (
  predecessor: Promise<void>,
  operation: string,
  signal?: AbortSignal,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const abort = () => reject(new AnalysisCancelledError(operation));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted === true) abort();
    void predecessor.then(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    });
  });
const limitations = [
  "Signature matches and reported sizes do not establish partition validity, encryption or runtime mappings. Binwalk may infer unknown lengths before emitting its report.",
  "Only Linux is supported by this integration. One worker, inherited per-process address-space/file-size/CPU limits and a deadline constrain execution; staging byte and entry budgets are polled and may transiently overshoot. Limits are not aggregate process-memory or filesystem quotas.",
  "Unblob's default sandbox and skip rules remain enabled. Missing external extractors, unknown chunks, encrypted chunks and depth limits yield partial coverage. Extracted code is never executed; only regular files are published, without executable permission bits.",
  "The actual launcher executable is hashed. Interpreter, shared libraries and installed Python package dependencies are not independently attested; source revision remains unknown for caller-supplied builds.",
] as const;

/** Queued bring-your-own firmware adapters with private snapshots and owned cleanup. */
export class FirmwareProvider implements FirmwareAnalysisPort {
  #tail: Promise<void> = Promise.resolve();
  #cleanupFailure: AnalysisError | undefined;
  constructor(
    readonly environment: Readonly<
      Record<string, string | undefined>
    > = process.env,
    readonly launcher?: FirmwareLauncher,
  ) {}

  /** Inspect regions or explicitly extract selected bytes without changing the source. */
  async execute(
    request: FirmwareRequest,
    options?: ExecutionOptions,
  ): Promise<Outcome> {
    const predecessor = this.#tail;
    let release = () => {};
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Cancel the caller promptly without letting a later request bypass its predecessor.
    try {
      await waitForPredecessor(predecessor, request.operation, options?.signal);
    } catch (cause: unknown) {
      void predecessor.then(release);
      return err(
        cause instanceof AnalysisError
          ? cause
          : new AnalysisCancelledError(request.operation),
      );
    }
    try {
      return await this.#execute(request, options);
    } finally {
      release();
    }
  }

  async #execute(
    request: FirmwareRequest,
    options?: ExecutionOptions,
  ): Promise<Outcome> {
    let root: PrivateRuntimeRoot | undefined;
    const engineName =
      request.operation === "inspect_firmware_regions" ? "binwalk" : "unblob";
    const deadline = AbortSignal.timeout(FIRMWARE_LIMITS.timeoutMs);
    const signal =
      options?.signal === undefined
        ? deadline
        : AbortSignal.any([options.signal, deadline]);
    let outcome: Outcome;
    try {
      if (this.#cleanupFailure !== undefined) return err(this.#cleanupFailure);
      if (signal.aborted) throw new AnalysisCancelledError(request.operation);
      const command = await resolveFirmwareCommand(
        this.environment,
        engineName,
        request.operation,
      );
      root = await PrivateRuntimeRoot.create({ prefix: "rea-firmware-" });
      const target = await snapshotFirmware(request, root.path, signal);
      const run = (
        args: readonly string[],
        outputBudget?: { root: string; bytes: number; entries: number },
      ) =>
        runFirmwareCommand({
          engine: engineName,
          operation: request.operation,
          ...command,
          args,
          cwd: root?.path ?? "",
          environment: this.environment,
          signal,
          ...(this.launcher === undefined ? {} : { launcher: this.launcher }),
          ...(outputBudget === undefined
            ? {}
            : { outputBudget, acceptReportedExtractionFailure: true }),
        });
      const versionRun = await run(["--version"]);
      const version = versionRun.stdout.text.trim();
      const expected = FIRMWARE_RELEASES[engineName].version;
      if (
        versionRun.stdout.bytes > 1024 ||
        (engineName === "binwalk"
          ? version !== `binwalk ${expected}`
          : version !== expected)
      )
        throw new AnalysisCapabilityUnavailableError(
          engineName,
          request.operation,
          `Unsupported tool version ${version}; this adapter is verified against ${expected}`,
        );
      const engine = {
        name: engineName,
        version: expected,
        executable_path: command.command,
        executable_sha256: command.sha256,
        source_revision: null,
        worker_count: 1 as const,
      };
      const reportPath = join(root.path, "report.json");
      let result: unknown;
      let raw: unknown;
      if (request.operation === "inspect_firmware_regions") {
        const processRun = await run([
          "--quiet",
          "--search-all",
          "--threads",
          "1",
          "--log",
          reportPath,
          target.inputPath,
        ]);
        const report = await readFirmwareCommandReport({
          path: reportPath,
          engine: engineName,
          operation: request.operation,
          execution: processRun,
        });
        result = firmwareResultSchemas.inspect_firmware_regions.parse({
          engine,
          input_size: target.size,
          regions: normalizeBinwalkReport(
            report,
            target.inputPath,
            target.size,
          ),
          coverage: "signature_scan",
        });
        raw = { report, execution: processRun, version_execution: versionRun };
      } else {
        if (!isAbsolute(request.input.output_directory))
          throw new AnalysisInputError(request.operation, undefined, [
            {
              path: ["output_directory"],
              reason: "invalid_format",
              message: "Extraction output directory must be absolute",
            },
          ]);
        const outputRoot = join(root.path, "extracted");
        const processRun = await run(
          [
            "--process-num",
            "1",
            "--depth",
            String(request.input.max_depth),
            "--randomness-depth",
            "0",
            "--report",
            reportPath,
            "--log",
            join(root.path, "unblob.log"),
            "--extract-dir",
            outputRoot,
            target.inputPath,
          ],
          {
            root: outputRoot,
            bytes: request.input.max_output_bytes,
            entries: request.input.max_output_files,
          },
        );
        const report = await readFirmwareCommandReport({
          path: reportPath,
          engine: engineName,
          operation: request.operation,
          execution: processRun,
        });
        const normalized = normalizeUnblobReport(report, {
          inputPath: target.inputPath,
          outputRoot,
          ...target.selection,
          maxDepth: request.input.max_depth,
        });
        if (processRun.exit_code === 1 && normalized.diagnostics.length === 0)
          throw new AnalysisOutputError(
            request.operation,
            "Unblob failed without a reported extraction diagnostic",
          );
        const entries = await inventoryFirmwareOutput(
          outputRoot,
          request.input.max_output_bytes,
          request.input.max_output_files,
          request.operation,
          signal,
        );
        result = await publishFirmwareExtraction({
          outputDirectory: request.input.output_directory,
          entries,
          normalized,
          selection: target.selection,
          engine,
          signal,
        });
        raw = { report, execution: processRun, version_execution: versionRun };
      }
      outcome = ok(
        createAnalysisExecution(
          result,
          engineName === "binwalk"
            ? BINWALK_PROVIDER_IDENTITY
            : UNBLOB_PROVIDER_IDENTITY,
          {
            subject: target.subject,
            rawResult: raw,
            limitations,
            locations: [
              {
                kind: "file-offset-range",
                start: target.selection.offset,
                end: target.selection.offset + target.selection.length,
              },
            ],
          },
        ),
      );
    } catch (cause: unknown) {
      outcome = err(
        cause instanceof ProviderCleanupError
          ? cause
          : options?.signal?.aborted === true
            ? new AnalysisCancelledError(request.operation)
            : deadline.aborted
              ? new AnalysisTimeoutError(
                  request.operation,
                  FIRMWARE_LIMITS.timeoutMs,
                )
              : cause instanceof AnalysisError
                ? cause
                : cause instanceof z.ZodError
                  ? new AnalysisOutputError(
                      request.operation,
                      "Tool report violated the pinned producer protocol",
                      { cause },
                    )
                  : new ProviderAdapterError(engineName, request.operation, {
                      cause,
                      diagnostics: {
                        reason:
                          cause instanceof Error
                            ? cause.message
                            : String(cause),
                      },
                    }),
      );
      if (!outcome.ok && outcome.error.cleanupIncomplete) {
        this.#cleanupFailure =
          root === undefined ||
          outcome.error.cleanupResources.includes(root.path)
            ? outcome.error
            : new ProviderCleanupError(
                engineName,
                [...outcome.error.cleanupResources, root.path],
                outcome.error instanceof ProviderAdapterError
                  ? (outcome.error.diagnostics ?? {
                      reason: outcome.error.message,
                    })
                  : { reason: outcome.error.message },
                { cause: outcome.error },
              );
      }
    }
    // Never remove a workspace while process ownership remains uncertain.
    if (this.#cleanupFailure !== undefined) return err(this.#cleanupFailure);
    try {
      await root?.close();
    } catch (cause: unknown) {
      this.#cleanupFailure = new ProviderCleanupError(
        engineName,
        [
          root?.path ?? "unknown",
          ...(outcome.ok && request.operation === "extract_firmware"
            ? [request.input.output_directory]
            : []),
        ],
        {
          reason: cause instanceof Error ? cause.message : String(cause),
          previous_result: outcome.ok ? outcome.value.result : null,
        },
      );
      return err(this.#cleanupFailure);
    }
    return outcome;
  }
}
