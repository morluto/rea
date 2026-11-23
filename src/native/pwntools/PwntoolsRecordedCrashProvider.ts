import type { HostPlatform } from "../../platform/HostPlatform.js";
import {
  AnalysisOutputError,
  cancelledBy,
} from "../../domain/analysisErrorCore.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  recordedCrashPayloadSchema,
  safeParseProjectedRecordedCrash,
  safeParseRecordedCrashDebuggerEnrichment,
  type InspectRecordedCrashInput,
  type RecordedCrash,
  type RecordedCrashPartialObservation,
} from "../../domain/native/recordedCrash.js";
import type { RecordedCrashPort } from "../../ports/binaryDiagnostics/RecordedCrashPort.js";
import { PrivateRuntimeRoot } from "../../process/PrivateRuntimeRoot.js";
import { PwntoolsDecoder, type PwntoolsLauncher } from "./PwntoolsDecoder.js";
import { PWNTOOLS_PROVIDER_IDENTITY } from "./PwntoolsProviderIdentity.js";
import { validateCoreFileMappingAuthority } from "../pwndbg/CoreFileMappingAuthority.js";
import { validateRecordedCrashSources } from "./RecordedCrashSourceBindings.js";
import { validateRecordedCrashStructure } from "./RecordedCrashStructureBindings.js";
import {
  inspectPwndbgCore,
  pwndbgContextFinalizationFailure,
  recordedCrashStageOutput,
} from "../pwndbg/PwndbgCoreContext.js";
import type { z } from "zod";

const LINUX_CORE_OWNER_BASE64 = "Q09SRQA=";
const LINUX_CORE_OWNER_BYTES = Buffer.from("CORE\0");

const verifySnapshotBase64Bytes = (
  raw: string,
  range: { readonly offset: string; readonly bytes: string },
  snapshotBytes: Buffer,
  diagnostics: RecordedCrash["decoder_diagnostics"],
): void => {
  const start =
    range.offset.length <= 15
      ? Number(range.offset)
      : Number(BigInt(range.offset));
  const length =
    range.bytes.length <= 15
      ? Number(range.bytes)
      : Number(BigInt(range.bytes));
  if (length === 0) {
    if (raw.length !== 0)
      throw new AnalysisOutputError(
        "inspect_recorded_crash",
        "Reported raw note bytes differ from the selected snapshot.",
        { capturedOutput: diagnostics },
      );
    return;
  }
  if (raw === LINUX_CORE_OWNER_BASE64) {
    if (
      length !== LINUX_CORE_OWNER_BYTES.length ||
      LINUX_CORE_OWNER_BYTES.compare(
        snapshotBytes,
        start,
        start + LINUX_CORE_OWNER_BYTES.length,
      ) !== 0
    )
      throw new AnalysisOutputError(
        "inspect_recorded_crash",
        "Reported raw note bytes differ from the selected snapshot.",
        { capturedOutput: diagnostics },
      );
    return;
  }
  const decoded = Buffer.from(raw, "base64");
  if (
    decoded.length !== length ||
    decoded.compare(snapshotBytes, start, start + length) !== 0
  )
    throw new AnalysisOutputError(
      "inspect_recorded_crash",
      "Reported raw note bytes differ from the selected snapshot.",
      { capturedOutput: diagnostics },
    );
};

/** Preserve every recorded thread while optionally enriching the same owned snapshot. */
export class PwntoolsRecordedCrashProvider
  extends PwntoolsDecoder<
    InspectRecordedCrashInput,
    z.output<typeof recordedCrashPayloadSchema>,
    RecordedCrash
  >
  implements RecordedCrashPort
{
  constructor(
    environment: Readonly<NodeJS.ProcessEnv>,
    launcher?: PwntoolsLauncher,
    createRuntime: () => Promise<
      Pick<PrivateRuntimeRoot, "path" | "close">
    > = () => PrivateRuntimeRoot.create({ prefix: "rea-recorded-crash-" }),
    host?: HostPlatform,
  ) {
    super(
      {
        identity: PWNTOOLS_PROVIDER_IDENTITY,
        operation: "inspect_recorded_crash",
        bridge: new URL(
          "../../../bridge/pwntools/recorded_crash.py",
          import.meta.url,
        ),
        payloadSchema: recordedCrashPayloadSchema,
        project: ({ input, payload, snapshot, diagnostics }): RecordedCrash => {
          const checked = safeParseProjectedRecordedCrash(payload, {
            artifact: {
              path: input.path,
              sha256: snapshot.sha256,
              bytes: snapshot.bytes.length,
            },
            debugger: { status: "not-requested" },
            decoder_diagnostics: diagnostics,
            diagnostics,
          });
          if (!checked.success)
            throw new AnalysisOutputError(
              "inspect_recorded_crash",
              `Recorded core reply is invalid: ${checked.error.issues[0]?.message ?? "schema mismatch"}`,
              { capturedOutput: diagnostics },
            );
          const value = checked.data;
          validateRecordedCrashStructure(value, snapshot.bytes, diagnostics);
          for (const note of value.notes) {
            verifySnapshotBase64Bytes(
              note.owner_bytes_base64,
              note.owner_location,
              snapshot.bytes,
              diagnostics,
            );
            verifySnapshotBase64Bytes(
              note.descriptor_bytes_base64,
              note.descriptor_location,
              snapshot.bytes,
              diagnostics,
            );
          }
          for (const padding of value.note_padding)
            verifySnapshotBase64Bytes(
              padding.bytes_base64,
              padding.location,
              snapshot.bytes,
              diagnostics,
            );
          validateRecordedCrashSources(value, snapshot.bytes, diagnostics);
          return value;
        },
        partialObservation: (input, value) =>
          input.include_debugger_context ? unavailableDebugger(value) : value,
        enrich: async ({
          environment,
          input,
          report: value,
          snapshot,
          rootPath,
          resources,
          options,
          runCommand,
          timeoutMs,
          producerLimits,
        }) => {
          if (!input.include_debugger_context) return value;
          const diagnostics = value.decoder_diagnostics;
          try {
            if (options?.signal?.aborted)
              throw cancelledBy("inspect_recorded_crash", options.signal, {
                capturedOutput: diagnostics,
              });
            const authority = validateCoreFileMappingAuthority(
              value,
              snapshot.bytes,
            );
            if (!authority.ok) throw authority.error;
            const completed = await inspectPwndbgCore({
              environment,
              architecture: value.architecture,
              rootPath,
              resources,
              diagnostics,
              options,
              runCommand,
              timeoutMs,
              producerLimits,
            });
            const context = completed.context;
            const enriched = safeParseRecordedCrashDebuggerEnrichment(
              value,
              context,
              recordedCrashStageOutput(diagnostics, context.diagnostics),
            );
            if (!enriched.success)
              throw pwndbgContextFinalizationFailure(
                new AnalysisOutputError(
                  "inspect_recorded_crash",
                  `Recorded debugger context is invalid: ${enriched.error.issues[0]?.message ?? "schema mismatch"}`,
                  {
                    capturedOutput: recordedCrashStageOutput(
                      diagnostics,
                      context.diagnostics,
                    ),
                  },
                ),
                completed.finalization,
              );
            if (completed.finalization !== undefined)
              throw completed.finalization.retainPartialObservation(
                enriched.data,
              );
            return enriched.data;
          } catch (cause: unknown) {
            if (cause instanceof AnalysisError)
              cause.retainPartialObservation(unavailableDebugger(value));
            throw cause;
          }
        },
      },
      environment,
      launcher,
      createRuntime,
      host,
    );
  }
}

const unavailableDebugger = (
  value: RecordedCrash,
): RecordedCrashPartialObservation => ({
  ...value,
  debugger: { status: "unavailable", requested: true },
});
