/**
 * Lifecycle regression coverage for every provider id in
 * `CAPABILITY_DECLARATIONS`.
 *
 * Each stage names a regression by file and title at its registration site,
 * or states why the stage does not apply. The coverage check reports any
 * applicable stage still marked as a gap.
 *
 * Stages: `launch` starts the owned process (including launch failure and
 * refusal at the launch boundary); `handshake` is the first readiness or
 * identity exchange after launch; `operation` is a completed analysis request;
 * `cancel` is caller cancellation of admitted work; `cleanup` retains and
 * reports a failed or unproven cleanup; `retry` releases a retained cleanup on
 * a later attempt.
 *
 * Providers that run in-process (no owned process or connection) are tracked
 * for operation and cancellation only. Their descriptor and snapshot cleanup
 * belongs to the resource owners' own tests.
 */

export const LIFECYCLE_STAGES = [
  "launch",
  "handshake",
  "operation",
  "cancel",
  "cleanup",
  "retry",
] as const;

export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

export interface LifecycleRegression {
  /** Repository-relative test file. */
  readonly path: string;
  /** Title at the test registration site, before any parameter expansion. */
  readonly title: string;
}

export type StageCoverage =
  | {
      readonly kind: "covered";
      readonly tests: readonly [LifecycleRegression, ...LifecycleRegression[]];
    }
  | { readonly kind: "not_applicable"; readonly reason: string }
  | { readonly kind: "gap"; readonly reason: string };

export type ProviderOwnership = "process" | "connection" | "in_process";

export interface ProviderLifecycleCoverage {
  readonly ownership: ProviderOwnership;
  readonly stages: Readonly<Record<LifecycleStage, StageCoverage>>;
}

const test = (path: string, title: string): LifecycleRegression => ({
  path,
  title,
});
const covered = (
  first: LifecycleRegression,
  ...rest: LifecycleRegression[]
): StageCoverage => ({ kind: "covered", tests: [first, ...rest] });
const notApplicable = (reason: string): StageCoverage => ({
  kind: "not_applicable",
  reason,
});

const ONE_SHOT = notApplicable(
  "One-shot command per request: there is no handshake after launch.",
);
const ATTACH_ONLY = notApplicable(
  "Attaches to a caller-started engine endpoint; REA launches no process.",
);
const IN_PROCESS = notApplicable(
  "In-process provider: no owned process or connection to launch, hand shake with, clean up or retry.",
);

const inProcess = (
  operation: StageCoverage,
  cancel: StageCoverage,
): ProviderLifecycleCoverage => ({
  ownership: "in_process",
  stages: {
    launch: IN_PROCESS,
    handshake: IN_PROCESS,
    operation,
    cancel,
    cleanup: IN_PROCESS,
    retry: IN_PROCESS,
  },
});

const typedFailures = (path: string) =>
  covered(test(path, "returns typed resource and cancellation failures"));

const HISTORICAL_DECODER =
  "tests/boundary/browser/historicalCaptureDecoder.test.ts";
/** HAR, qlog, SAZ and mitmproxy captures share one owned decoder child. */
const historicalCapture = (
  operation: StageCoverage,
): ProviderLifecycleCoverage => ({
  ownership: "process",
  stages: {
    launch: covered(
      test(
        "tests/boundary/browser/historicalCapturePreparationCleanup.test.ts",
        "cancels after snapshot acquisition without launching or adopting the opaque caller reason",
      ),
    ),
    handshake: notApplicable(
      "The decoder child writes one reply per request; there is no handshake.",
    ),
    operation,
    cancel: covered(
      test(
        HISTORICAL_DECODER,
        "preserves the exact cancellation reason observed during final runtime close",
      ),
    ),
    cleanup: covered(
      test(
        HISTORICAL_DECODER,
        "retains completed capture facts and binds final root cleanup to its retry lease",
      ),
    ),
    retry: covered(
      test(
        HISTORICAL_DECODER,
        "keeps late cancellation primary when runtime close also fails, then clears on retry",
      ),
    ),
  },
});

const UEFI_PROVIDER = "src/uefi/UefiAnalysisProvider.test.ts";
const FIRMWARE_INTEGRATION =
  "tests/boundary/firmware/firmwareIntegration.test.ts";
const REVERSE_LAUNCH_ERRORS =
  "tests/composition/reverseProviderLaunchErrors.test.ts";
const REVERSE_EDGE_CASES =
  "tests/composition/reverseEngineeringEdgeCases.test.ts";
const SOURCE_MAP_DECODER_BOUNDARY =
  "tests/boundary/javascript/sourceMapDecoder.test.ts";
const CDP_BROWSER_SOCKET =
  "tests/boundary/browser/cdpBrowserProvider.browserSocket.test.ts";
const CDP_CLEANUP_CANCELLATION =
  "tests/boundary/browser/cdpCleanupCancellation.test.ts";

export const PROVIDER_LIFECYCLE_COVERAGE: Readonly<
  Record<string, ProviderLifecycleCoverage>
> = {
  adb: {
    ownership: "process",
    stages: {
      launch: covered(
        test(
          "src/adb/AdbCommand.test.ts",
          "reports an adb that never started without claiming an exit code",
        ),
      ),
      handshake: ONE_SHOT,
      operation: covered(
        test(
          "src/adb/AdbProvider.test.ts",
          "pulls one device file with a digest",
        ),
      ),
      cancel: covered(
        test(
          "src/adb/AdbProvider.test.ts",
          "reports cancellation arriving during the version probe",
        ),
        test(
          "tests/boundary/providers/adb/adbServerLifetime.test.ts",
          "asks a cancelled device command to stop with SIGTERM before its group is killed",
        ),
      ),
      cleanup: covered(
        test(
          "src/adb/AdbProvider.test.ts",
          "retains failed snapshot cleanup with completed push Evidence until close retries",
        ),
        test(
          "tests/boundary/providers/adb/adbServerLifetime.test.ts",
          "stops a descendant a device command leaves behind with the command's cleanup",
        ),
        test(
          "tests/boundary/providers/adb/adbServerLifetime.test.ts",
          "starts the adb server explicitly before device commands and never stops it",
        ),
      ),
      retry: covered(
        test(
          "src/adb/AdbProvider.test.ts",
          "retains failed snapshot cleanup with completed push Evidence until close retries",
        ),
      ),
    },
  },
  "aioquic-qlog-json": historicalCapture(
    covered(
      test(
        "tests/acceptance/tools/qlogCapture.test.ts",
        "runs built CLI and real stdio SDK with exact evidence parity, selection, retained references and strict schemas",
      ),
    ),
  ),
  "apk-signature": inProcess(
    covered(
      test(
        "tests/boundary/filesystem/apkSignatureViewIdentity.test.ts",
        "checks parent subject identity again when signing facts are already cached",
      ),
    ),
    covered(
      test(
        "tests/process-global/apkSignatureLifecycle.test.ts",
        "keeps the abort reason itself as the cancellation cause",
      ),
    ),
  ),
  apktool: {
    ownership: "process",
    stages: {
      launch: covered(
        test(
          "src/apktool/ApktoolProvider.test.ts",
          "reports launcher disappearance after version admission as apktool unavailable",
        ),
      ),
      handshake: ONE_SHOT,
      operation: covered(
        test(
          "src/apktool/ApktoolProvider.test.ts",
          "decodes resources with target identity, metadata, and strings",
        ),
      ),
      cancel: covered(
        test(
          "src/apktool/ApktoolVersionProbe.lifecycle.test.ts",
          "stops an interpreter launcher and its pipe-holding child when the probe is cancelled",
        ),
      ),
      cleanup: covered(
        test(
          "src/apktool/ApktoolProvider.test.ts",
          "retains completed Evidence and live cleanup until a denied workspace removal recovers",
        ),
      ),
      retry: covered(
        test(
          "src/apktool/ApktoolProvider.test.ts",
          "retains failed workspace cleanup and retries it on close",
        ),
      ),
    },
  },
  binwalk: {
    ownership: "process",
    stages: {
      launch: covered(
        test(
          "src/firmware/FirmwareCommand.test.ts",
          "does not relabel an unrelated launch failure when a deadline also fires",
        ),
      ),
      handshake: ONE_SHOT,
      operation: covered(
        test(
          FIRMWARE_INTEGRATION,
          "binds region observations to exact bytes and preserves provider-reported uncertainty",
        ),
      ),
      cancel: covered(
        test(
          FIRMWARE_INTEGRATION,
          "cancels an owned active process and permits the next queued operation",
        ),
      ),
      cleanup: covered(
        test(
          FIRMWARE_INTEGRATION,
          "retains an uncertain worker's workspace and blocks later launches",
        ),
      ),
      retry: covered(
        test(
          "tests/boundary/firmware/firmwareReportFiles.test.ts",
          "retains the analysis timeout and command output while report cleanup is pending and after retry",
        ),
      ),
    },
  },
  "byte-entropy": inProcess(
    covered(
      test(
        "src/application/binaryDiagnostics/ByteEntropyService.test.ts",
        "keeps %i-byte blocks relative to an unaligned window across short physical reads",
      ),
    ),
    covered(
      test(
        "src/application/binaryDiagnostics/ByteEntropyService.test.ts",
        "honors cancellation %s and closes any admitted descriptor",
      ),
    ),
  ),
  "cutter.python-plugin": {
    ownership: "connection",
    stages: {
      launch: ATTACH_ONLY,
      handshake: covered(
        test(
          "tests/boundary/providers/cutterBridgeProducer.test.ts",
          "authenticates bridge peers before payloads and permits status recovery after a poisoned UI timeout",
        ),
      ),
      operation: covered(
        test(
          "tests/boundary/mcp/cutterMcp.test.ts",
          "preserves live Cutter command Evidence and parity through the MCP boundary",
        ),
      ),
      cancel: covered(
        test(
          "tests/boundary/mcp/cutterCancellationMcp.test.ts",
          "propagates MCP cancellation into an active Cutter command",
        ),
      ),
      cleanup: covered(
        test(
          "tests/boundary/providers/CutterBridgeService.test.ts",
          "clears a poisoned command only after its exact UI-dispatcher receipt",
        ),
      ),
      retry: covered(
        test(
          "tests/boundary/providers/cutterBridgeProducer.test.ts",
          "retains failed receipt acknowledgements and retries before another command",
        ),
      ),
    },
  },
  "electron-fuses": inProcess(
    covered(
      test(
        "tests/acceptance/electronFusesCli.test.ts",
        "retains Windows drive, root, and mixed-separator path resolution",
      ),
    ),
    covered(
      test(
        "src/electron/ElectronFuseCleanup.test.ts",
        "retains the exact caller reason and completed Evidence when final close succeeds after cancellation",
      ),
    ),
  ),
  "evmole-interface": {
    ownership: "process",
    stages: {
      launch: covered(
        test(
          "src/evm/EvmoleFailures.test.ts",
          "maps real selected-path failures before the EVM worker starts",
        ),
      ),
      handshake: ONE_SHOT,
      operation: covered(
        test(
          "tests/boundary/evm/evmoleInterfaceProvider.test.ts",
          "retains raw metadata and ordered duplicate selector inferences after worker admission",
        ),
      ),
      cancel: covered(
        test(
          "tests/boundary/evm/evmCleanupRetry.test.ts",
          "preserves an active cancellation through denied owned-group cleanup and later retry",
        ),
      ),
      cleanup: covered(
        test(
          "tests/boundary/evm/evmoleInterfaceProvider.test.ts",
          "retains original format failure when owned-root cleanup fails",
        ),
      ),
      retry: covered(
        test(
          "src/evm/EvmoleInterfaceProvider.test.ts",
          "retains a real cleanup owner through failed EVM close and releases it on retry",
        ),
      ),
    },
  },
  "fiddler-saz": historicalCapture(
    covered(
      test(
        "tests/boundary/browser/sazWebCapture.test.ts",
        "uses HTTP optional whitespace for SAZ identity codings without changing raw headers",
      ),
    ),
  ),
  flutter: inProcess(
    covered(
      test(
        "tests/boundary/filesystem/flutterBuildProvider.test.ts",
        "projects each payload shape through the owned snapshot",
      ),
    ),
    covered(
      test(
        "tests/boundary/filesystem/flutterBuildProvider.test.ts",
        "cancels before creating any snapshot root",
      ),
    ),
  ),
  frida: {
    ownership: "process",
    stages: {
      launch: covered(
        test(
          "src/frida/FridaInstrumentationManager.test.ts",
          "retains a failed startup's spawn and remote lease until cleanup succeeds",
        ),
      ),
      handshake: notApplicable(
        "Frida runs in-process through its Node bindings; device and session attach is the launch stage.",
      ),
      operation: covered(
        test(
          "src/frida/FridaInstrumentationManager.test.ts",
          "loads instrumentation before resuming a spawned target",
        ),
      ),
      cancel: covered(
        test(
          "src/application/frida/FridaInstrumentationService.test.ts",
          "cleans up a session and returns typed cancellation after a pending start",
        ),
      ),
      cleanup: covered(
        test(
          "src/frida/FridaInstrumentationManager.test.ts",
          "refuses new session work after incomplete close while retaining cleanup for retry",
        ),
      ),
      retry: covered(
        test(
          "src/frida/FridaInstrumentationManager.test.ts",
          "retains a failed script handle until a later cleanup retry releases it",
        ),
      ),
    },
  },
  ghidra: {
    ownership: "process",
    stages: {
      launch: covered(
        test(
          "src/ghidra/GhidraLaunchFailure.test.ts",
          "retains the failed launcher command outcome on the launch error",
        ),
        test(
          "tests/boundary/providers/ghidra/ghidraClient.test.ts",
          "cancels startup promptly and leaves no project or process",
        ),
      ),
      handshake: covered(
        test(
          "tests/boundary/providers/ghidra/ghidraClient.test.ts",
          "completes an exact, fragmented post-analysis handshake",
        ),
        test(
          "tests/boundary/mcp/ghidraReopen.test.ts",
          "refuses an uncommitted handshake report before the first query and replaces that session on reopen",
        ),
      ),
      operation: covered(
        test(
          "tests/boundary/providers/ghidra/ghidraClient.test.ts",
          "correlates an admitted inventory request after startup",
        ),
      ),
      cancel: covered(
        test(
          "tests/boundary/providers/ghidra/ghidraClient.test.ts",
          "retains cancellation reasons before admission, in the queue, and on the wire (%j)",
        ),
        test(
          "tests/boundary/providers/ghidra/ghidraClient.test.ts",
          "retains the identity refusal when cancellation arrives during final startup cleanup",
        ),
      ),
      cleanup: covered(
        test(
          "tests/boundary/mcp/ghidraReopen.test.ts",
          "retains failed cleanup and refuses replacement until cleanup can be retried",
        ),
      ),
      retry: covered(
        test(
          "src/ghidra/GhidraProvider.behavior.test.ts",
          "reports rejection cleanup that failed and retries it on close",
        ),
        test(
          "tests/boundary/providers/ghidra/ghidraClient.test.ts",
          "redacts authentication after failed startup cleanup and retry",
        ),
      ),
    },
  },
  "gnu.gdb": {
    ownership: "process",
    stages: {
      launch: covered(
        test(
          "tests/boundary/providers/GdbSessionManagerCoverage.test.ts",
          "retains ownership when GDB startup fails before its prompt and stop is incomplete",
        ),
      ),
      handshake: covered(
        test(
          "tests/boundary/providers/GdbSessionManagerCoverage.test.ts",
          "returns startup timeout when the MI prompt never arrives",
        ),
        test(
          "tests/boundary/providers/GdbSessionManagerCoverage.test.ts",
          "retries MI2 after an MI3 process exits before its startup prompt",
        ),
      ),
      operation: covered(
        test(
          "tests/boundary/providers/GdbSessionManagerCoverage.test.ts",
          "correlates command output records and reports invalid or cancelled requests",
        ),
      ),
      cancel: covered(
        test(
          "tests/boundary/mcp/gdbCancellationMcp.test.ts",
          "propagates MCP cancellation into a running GDB command",
        ),
      ),
      cleanup: covered(
        test(
          "tests/boundary/cli/gdbStartupCleanupCli.test.ts",
          "marks the CLI failed when retained GDB cleanup remains incomplete",
        ),
      ),
      retry: covered(
        test(
          "tests/boundary/cli/gdbStartupCleanupCli.test.ts",
          "retries retained GDB cleanup when CLI session startup fails",
        ),
        test(
          "tests/boundary/providers/GdbSessionManagerCoverage.test.ts",
          "retains failed startup ownership when stop rejects and resolves it on retry",
        ),
      ),
    },
  },
  "go-build-info": inProcess(
    covered(
      test(
        "tests/acceptance/goBinaryCli.test.ts",
        "delivers a Go CLI summary with its unchanged complete source bundle",
      ),
    ),
    covered(
      test(
        "src/application/go/GoBinaryService.test.ts",
        "honors cancellation before reading and after a completed observation",
      ),
    ),
  ),
  "gpu-code-objects": inProcess(
    covered(
      test(
        "tests/boundary/gpu/codeObjects.test.ts",
        "does not decode unselected payloads and keeps stable positional identities",
      ),
    ),
    covered(
      test(
        "tests/process-global/gpuFileLifetime.test.ts",
        "preserves completed observations when caller cancellation arrives during final close",
      ),
    ),
  ),
  "har-schema/lossless-json": historicalCapture(
    covered(
      test(
        "tests/boundary/browser/historicalWebCapture.test.ts",
        "preserves opaque HAR container fields through CLI and MCP",
      ),
    ),
  ),
  hopper: {
    ownership: "process",
    stages: {
      launch: covered(
        test(
          "tests/acceptance/providers/hopperStartupRecovery.test.ts",
          "recovers a denied Hopper launch through the same stdio MCP session and CLI",
        ),
        test(
          "tests/boundary/providers/hopper/hopperClient.protocol.test.ts",
          "records process exit code, stage, and restart guidance on unexpected exit",
        ),
      ),
      handshake: covered(
        test(
          "tests/boundary/providers/hopper/hopperClient.health.test.ts",
          "reports launch work until the first authenticated handshake completes",
        ),
        test(
          "tests/boundary/providers/hopper/hopperClient.handshakeRecovery.test.ts",
          "recovers an application exit after the first valid handshake occurs during cleanup",
        ),
      ),
      operation: covered(
        test(
          "tests/boundary/providers/hopper/hopperClient.protocol.test.ts",
          "does not start cold and preserves normal dispatch once ready",
        ),
      ),
      cancel: covered(
        test(
          "tests/boundary/providers/hopper/hopperClient.progress.test.ts",
          "cancels and ignores late responses without corrupting the session",
        ),
      ),
      cleanup: covered(
        test(
          "tests/boundary/providers/hopper/hopperClient.cleanupRetry.test.ts",
          "retains failed startup cleanup until an owned process and its backing image are closed",
        ),
      ),
      retry: covered(
        test(
          "tests/boundary/providers/hopper/hopperClient.cleanupRetry.test.ts",
          "retries a failed lease release after document, process, and runtime cleanup are confirmed",
        ),
      ),
    },
  },
  ida: {
    ownership: "process",
    stages: {
      launch: covered(
        test(
          "src/ida/IdaMcpEnvironment.test.ts",
          "launches the owned stdio server with only the selected snapshot, never ambient variables",
        ),
        test(
          "src/ida/IdaMcpWindowsLaunch.test.ts",
          "refuses a network-share executable before launch with a drive-letter remedy",
        ),
      ),
      handshake: covered(
        test(
          "src/ida/IdaMcpOwnedCleanup.test.ts",
          "keeps a failed handshake's incomplete cleanup observable with the redacted server tail",
        ),
      ),
      operation: covered(
        test(
          "src/ida/IdaNativeProtocol.test.ts",
          "retains native tool provenance, reads recorded metadata, and closes only its connection",
        ),
      ),
      cancel: covered(
        test(
          "src/ida/IdaSessionClient.test.ts",
          "drains in-flight read-only work on cancellation before closing its proxy",
        ),
      ),
      cleanup: covered(
        test(
          "src/ida/IdaSessionClient.test.ts",
          "retries failed worker release through the retained connection",
        ),
      ),
      retry: covered(
        test(
          "tests/boundary/providers/ida/retainedConnectionRetry.test.ts",
          "retries cleanup through the detached stdio connection",
        ),
      ),
    },
  },
  "il2cpp-metadata": inProcess(
    covered(
      test(
        "tests/acceptance/il2cppMetadataCli.test.ts",
        "queries compact retained metadata through the real SDK with exact row identities and fields",
      ),
    ),
    covered(
      test(
        "tests/boundary/il2cpp/il2cppMetadataProvider.test.ts",
        "accepts cancellation between binary linking batches and keeps the metadata source",
      ),
    ),
  ),
  jadx: {
    ownership: "process",
    stages: {
      launch: covered(
        test(
          "tests/boundary/process/jadxStartup.test.ts",
          "returns terminal startup diagnostics and partial identity through the MCP contract",
        ),
      ),
      handshake: covered(
        test(
          "tests/boundary/process/jadxIntegration.test.ts",
          "classifies a heap shortage that stops the bridge before the handshake",
        ),
      ),
      operation: covered(
        test(
          "tests/boundary/process/jadxIntegration.test.ts",
          "retires an idle engine and starts a fresh one for a later request",
        ),
      ),
      cancel: covered(
        test(
          "tests/boundary/process/jadxIntegration.test.ts",
          "cancels active and queued requests, cleans ownership and never launches a queued cancelled request",
        ),
      ),
      cleanup: covered(
        test(
          "tests/boundary/process/jadxIntegration.test.ts",
          "retains an uncertain workspace and blocks later launches after cleanup cannot be verified",
        ),
      ),
      retry: covered(
        test(
          "tests/boundary/process/jadxStartup.test.ts",
          "retains the startup primary across cleanup failure and retry",
        ),
        test(
          "tests/boundary/android/jadxMcpTransport.test.ts",
          "retries an incomplete owned stop while joining concurrent close callers",
        ),
      ),
    },
  },
  jeb: {
    ownership: "connection",
    stages: {
      launch: ATTACH_ONLY,
      handshake: covered(
        test(
          "tests/boundary/providers/jebMcpCatalog.test.ts",
          "uses the selected discovery budget across handshake and catalog pages",
        ),
        test(
          "tests/boundary/providers/jebMcpConnection.test.ts",
          "reconnects after a catalog refresh loses its session without replaying the refresh",
        ),
      ),
      operation: covered(
        test(
          "tests/boundary/providers/jebMcpReplies.test.ts",
          "retains own structured fields through the JEB SDK transport",
        ),
      ),
      cancel: covered(
        test(
          "src/jeb/JebProvider.test.ts",
          "forwards in-flight cancellation to the MCP call",
        ),
      ),
      cleanup: covered(
        test(
          "tests/boundary/providers/jebMcpConnection.test.ts",
          "retains failed cleanup ownership and does not reuse the invalid session before cleanup succeeds",
        ),
      ),
      retry: covered(
        test(
          "tests/boundary/providers/jebMcpConnection.test.ts",
          "retains the typed timeout when disposal fails and retries owned cleanup before reconnecting",
        ),
      ),
    },
  },
  kuna: {
    ownership: "process",
    stages: {
      launch: covered(
        test(
          "tests/boundary/providers/kuna/kunaSelectedCommand.test.ts",
          "uses the selected Kuna launcher and its sibling producer for readiness and commands",
        ),
        test(
          "tests/boundary/providers/kuna/kunaProvider.test.ts",
          "refuses to launch an executable replaced after the target was opened",
        ),
      ),
      handshake: ONE_SHOT,
      operation: covered(
        test(
          "tests/boundary/providers/kuna/kunaIndependentDecompileMcp.test.ts",
          "runs a cold independent request without starting a project export",
        ),
      ),
      cancel: covered(
        test(
          "tests/boundary/providers/kuna/kunaCommandCancellation.test.ts",
          "keeps cancellation output and primary reason while exact command cleanup is retried",
        ),
        test(
          "tests/boundary/providers/kuna/kunaProvider.test.ts",
          "stops waiting for the export when the caller cancels, without abandoning it",
        ),
      ),
      cleanup: covered(
        test(
          "tests/boundary/providers/kuna/kunaPublicationCleanup.test.ts",
          "preserves the original failed export when staging cleanup also fails",
        ),
        test(
          "tests/boundary/providers/kuna/kunaProjectCache.test.ts",
          "keeps staging owned when a cancelled Kuna process cannot be proven stopped",
        ),
      ),
      retry: covered(
        test(
          "tests/boundary/providers/kuna/kunaProvider.test.ts",
          "keeps reporting a failed close and succeeds once a retry proves the stop",
        ),
      ),
    },
  },
  "mitmproxy-native-tnetstring": historicalCapture(
    covered(
      test(
        "tests/boundary/browser/historicalCaptureWideNumbers.test.ts",
        "retains every exclusion in a wide native-number reply through the owned decoder",
      ),
    ),
  ),
  "model-artifact": inProcess(
    covered(
      test(
        "tests/acceptance/modelArtifactCli.test.ts",
        "bounds compact model warnings and omits unselected long labels while retaining complete Evidence",
      ),
    ),
    covered(
      test(
        "tests/boundary/model/modelArtifactPartialCancellation.test.ts",
        "retains GGUF tensor declarations and layout limitations before later tensor bytes cancel",
      ),
    ),
  ),
  "native-macos": {
    ownership: "process",
    stages: {
      launch: covered(
        test(
          "tests/boundary/providers/native/lldbCallTracerFailures.test.ts",
          "releases a launch failure after the bridge proves the process exited",
        ),
      ),
      handshake: covered(
        test(
          "tests/boundary/providers/native/lldbLauncherBoundary.test.ts",
          "reports why the host could not establish the launched target's identity",
        ),
      ),
      operation: covered(
        test(
          "tests/boundary/providers/native/nativeCallObservation.test.ts",
          "launches the active Mach-O through the tracer and projects its run",
        ),
      ),
      cancel: covered(
        test(
          "tests/boundary/providers/native/lldbCallTracerFailures.test.ts",
          "preserves cancellation and journal/output evidence after runtime cleanup",
        ),
        test(
          "tests/boundary/providers/native/LldbCallTracer.cleanup.test.ts",
          "does not retain a target when cancellation proves LLDB never launched",
        ),
      ),
      cleanup: covered(
        test(
          "tests/boundary/providers/native/LldbCallTracer.cleanup.test.ts",
          "retains an unidentified debuggee and runtime until exit can be confirmed",
        ),
      ),
      retry: covered(
        test(
          "tests/boundary/providers/native/LldbCallTracer.cleanup.test.ts",
          "retains a real LLDB process owner and runtime until a later cleanup retry succeeds",
        ),
        test(
          "tests/boundary/providers/native/nativeCommandTermination.test.ts",
          "retains and retries every failed native command cleanup owner before launching another command",
        ),
      ),
    },
  },
  "objdump.command": {
    ownership: "process",
    stages: {
      launch: covered(
        test(
          REVERSE_LAUNCH_ERRORS,
          "preserves Darwin process ownership inspection preparation error without blaming objdump command",
        ),
      ),
      handshake: ONE_SHOT,
      operation: covered(
        test(
          "tests/composition/objdumpSelectedDisassembly.test.ts",
          "keeps omitted and undefined selection out of default command Evidence",
        ),
      ),
      cancel: covered(
        test(
          "tests/composition/reverseEngineeringAdmission.test.ts",
          "preserves the caller reason when cancellation arrives after provider output",
        ),
      ),
      cleanup: covered(
        test(
          REVERSE_EDGE_CASES,
          "retains an objdump command's unverified process owner until a later inspection stops it",
        ),
      ),
      retry: covered(
        test(
          REVERSE_EDGE_CASES,
          "retains an objdump command's unverified process owner until a later inspection stops it",
        ),
      ),
    },
  },
  pcap: {
    ownership: "process",
    stages: {
      launch: covered(
        test(
          "tests/boundary/pcap/pcapCommand.test.ts",
          "attributes a refused limiter spawn to the limiter, not Wireshark",
        ),
      ),
      handshake: ONE_SHOT,
      operation: covered(
        test(
          "tests/boundary/pcap/pcapProvider.test.ts",
          "inspects a capture with endpoints, DNS, TLS SNI, and HTTP",
        ),
      ),
      cancel: covered(
        test(
          "tests/boundary/pcap/pcapCommand.test.ts",
          "preserves a failed producer when cancellation arrives during its final cleanup",
        ),
      ),
      cleanup: covered(
        test(
          "tests/boundary/pcap/pcapCommand.test.ts",
          "returns complete stdout while retaining unresolved process cleanup",
        ),
      ),
      retry: covered(
        test(
          "tests/boundary/pcap/pcapCredentialErrors.test.ts",
          "retains safe cleanup observations and retries their original owner",
        ),
      ),
    },
  },
  "pwntools-elf": {
    ownership: "process",
    stages: {
      launch: covered(
        test(
          "src/native/pwntools/PwntoolsFailures.test.ts",
          "does not read an errno from another syscall as a launch refusal",
        ),
      ),
      handshake: covered(
        test(
          "tests/process-global/pwntoolsCliFinalization.test.ts",
          "preserves cancellation across a late owned process handshake",
        ),
      ),
      operation: covered(
        test(
          "tests/process-global/pwntoolsCliFinalization.test.ts",
          "recovers a completed worker reply after terminal process cleanup succeeds",
        ),
      ),
      cancel: covered(
        test(
          "tests/process-global/pwntoolsCleanup.test.ts",
          "cancels queued inspections promptly and drains the running inspection when closing",
        ),
      ),
      cleanup: covered(
        test(
          "tests/process-global/pwntoolsCliFinalization.test.ts",
          "preserves the validated report when runtime removal remains denied",
        ),
      ),
      retry: covered(
        test(
          "tests/process-global/pwntoolsCleanup.test.ts",
          "retains a failed root removal and retries it before acquiring another decoder",
        ),
      ),
    },
  },
  "rea-analysis-view": inProcess(
    covered(
      test(
        "tests/acceptance/applications/progressiveAnalysisViews.test.ts",
        "loads retained analysis views only when needed, preserving complete schemas, source facts and Evidence",
      ),
    ),
    covered(
      test(
        "src/application/analysisView/AnalysisViewService.test.ts",
        "returns typed cancellation when a running file request is aborted",
      ),
    ),
  ),
  "rea-android-application": inProcess(
    covered(
      test(
        "tests/boundary/mcp/androidPackageSummaryMcp.test.ts",
        "retains complete APK Evidence and reads exact manifest without its source or another engine launch",
      ),
    ),
    covered(
      test(
        "tests/boundary/mcp/androidPackageSummaryMcp.test.ts",
        "rejects unavailable retention, invalid selectors and cancellation before provider execution",
      ),
    ),
  ),
  "rea-apple-application": {
    ownership: "process",
    stages: {
      launch: covered(
        test(
          "src/artifacts/apple/AppleAssetCatalogAnalysis.test.ts",
          "reports an assetutil that cannot be launched as unavailable",
        ),
      ),
      handshake: ONE_SHOT,
      operation: covered(
        test(
          "src/artifacts/apple/AppleAssetCatalogAnalysis.test.ts",
          "joins only explicit resource-key fields with archive provenance",
        ),
      ),
      cancel: covered(
        test(
          "src/artifacts/apple/AppleAssetCatalogAnalysis.test.ts",
          "settles a cancelled assetutil run only after its process exits",
        ),
      ),
      cleanup: covered(
        test(
          "src/artifacts/apple/AppleAssetCatalogAnalysis.test.ts",
          "retains an unproven assetutil process cleanup for a later retry",
        ),
      ),
      retry: covered(
        test(
          "src/artifacts/apple/AppleAssetCatalogAnalysis.test.ts",
          "releases a retained assetutil cleanup before the next inspection launches",
        ),
      ),
    },
  },
  "rea-apple-ips": inProcess(
    covered(
      test(
        "tests/boundary/filesystem/appleIpsJoin.test.ts",
        "joins matching UUID and architecture and derives static addresses",
      ),
    ),
    covered(
      test(
        "src/native/apple/AppleIpsProvider.test.ts",
        "retains completed join facts when cancellation arrives during join parsing",
      ),
    ),
  ),
  "rea-artifact-graph": {
    ownership: "process",
    stages: {
      launch: covered(
        test(
          "tests/boundary/providers/native/nativeDmgArtifactReader.test.ts",
          "distinguishes child launch and host permission failures",
        ),
      ),
      handshake: notApplicable(
        "DMG attach and detach are one-shot hdiutil commands; other formats are read in-process.",
      ),
      operation: covered(
        test(
          "tests/boundary/providers/native/nativeDmgArtifactReader.test.ts",
          "uses plist attachment metadata and detaches returned devices",
        ),
      ),
      cancel: covered(
        test(
          "tests/boundary/providers/native/artifactProvider.zipCancellation.test.ts",
          "preserves a real ZIP stream's caller cancellation through extraction rollback",
        ),
      ),
      cleanup: covered(
        test(
          "tests/boundary/providers/native/nativeDmgArtifactReader.test.ts",
          "retains the root and reports unknown ownership when recovery discovery fails",
        ),
      ),
      retry: covered(
        test(
          "tests/boundary/providers/native/nativeDmgArtifactReader.test.ts",
          "retains a mounted directory after its close fails and retries before detach",
        ),
        test(
          "tests/boundary/providers/native/artifactProvider.cleanupRetry.test.ts",
          "retains a failed reader close, blocks new work, and retries the same reader",
        ),
      ),
    },
  },
  "rea-binary-hardening": inProcess(
    covered(
      test(
        "tests/acceptance/binaryHardeningCli.test.ts",
        "reads ELF and PE hardening through the CLI and MCP",
      ),
    ),
    covered(
      test(
        "tests/boundary/filesystem/binaryHardening.test.ts",
        "returns typed resource and cancellation failures and leaves bytes unchanged",
      ),
    ),
  ),
  "rea-cdp-browser": {
    ownership: "connection",
    stages: {
      launch: ATTACH_ONLY,
      handshake: covered(
        test(
          CDP_BROWSER_SOCKET,
          "times out a WebSocket handshake that never completes",
        ),
        test(
          CDP_BROWSER_SOCKET,
          "coalesces concurrent cold-start calls onto one browser WebSocket handshake",
        ),
      ),
      operation: covered(
        test(
          CDP_BROWSER_SOCKET,
          "reuses one admitted browser socket across sequential operations and closes on provider shutdown",
        ),
      ),
      cancel: covered(
        test(
          "tests/boundary/browser/cdpBrowserProvider.lifecycle_failures.test.ts",
          "cancels observation and still detaches without closing the page",
        ),
        test(
          CDP_CLEANUP_CANCELLATION,
          "releases cleanup when cancellation arrives after capture completes",
        ),
      ),
      cleanup: covered(
        test(
          CDP_BROWSER_SOCKET,
          "surfaces cleanupIncomplete when forced shared-socket close fails after detach rejection",
        ),
      ),
      retry: covered(
        test(
          CDP_BROWSER_SOCKET,
          "records cleanup lease ownership when finish() callback rejects and resolves on retryPending",
        ),
        test(
          CDP_BROWSER_SOCKET,
          "blocks new admissions while forced shared-socket cleanup fails with an active peer, then recovers cleanly",
        ),
      ),
    },
  },
  "rea-cdp-electron": {
    ownership: "connection",
    stages: {
      launch: ATTACH_ONLY,
      handshake: covered(
        test(
          "tests/boundary/browser/cdpElectronProvider.test.ts",
          "cancels a held Electron CDP handshake and admits the next inspection",
        ),
      ),
      operation: covered(
        test(
          "tests/boundary/browser/cdpElectronProvider.test.ts",
          "returns every Electron page target exposed by the endpoint inline",
        ),
      ),
      cancel: covered(
        test(
          "tests/boundary/browser/cdpElectronProvider.test.ts",
          "retains a completed page observation when cancellation arrives during final detach",
        ),
        test(
          CDP_CLEANUP_CANCELLATION,
          "classifies cancellation that arrives during final Electron detach",
        ),
      ),
      cleanup: covered(
        test(
          "tests/boundary/browser/cdpElectronProvider.test.ts",
          "retains a failed Electron transport close and retries it before the next inspection",
        ),
      ),
      retry: covered(
        test(
          "tests/boundary/browser/cdpElectronProvider.test.ts",
          "retains a failed Electron transport close and retries it before the next inspection",
        ),
      ),
    },
  },
  "rea-devicetree": inProcess(
    covered(
      test(
        "tests/acceptance/devicetreeCli.test.ts",
        "inspects a relative DTB and preserves the source",
      ),
    ),
    covered(
      test(
        "src/application/binaryDiagnostics/DevicetreeService.test.ts",
        "retains a completed observation when the caller cancels as the provider completes",
      ),
    ),
  ),
  "rea-dotnet-static": inProcess(
    covered(
      test(
        "tests/acceptance/dotnetBundleJourney.test.ts",
        "inspects and extracts ${format} through public CLI and stdio MCP",
      ),
    ),
    covered(
      test(
        "tests/boundary/providers/managed/managedStaticProvider.test.ts",
        "preserves cancellation when snapshot cleanup also fails",
      ),
    ),
  ),
  "rea-dotnet-workflows": inProcess(
    covered(
      test(
        "tests/boundary/mcp/managedWorkflowUnknownIdentityMcp.test.ts",
        "retains partial native export coverage after an observed match",
      ),
    ),
    covered(
      test(
        "tests/composition/analysis-sessions/managedApplicationGraph.test.ts",
        "stops resolving retained managed sources when the caller cancels mid-request",
      ),
    ),
  ),
  "rea-dwarf-units": inProcess(
    covered(
      test(
        "tests/acceptance/dwarfUnitsCli.test.ts",
        "reports a compile unit through the public CLI",
      ),
      test(
        "tests/boundary/mcp/dwarfUnitsMcp.test.ts",
        "advertises inspect_dwarf_units and reads a compile unit",
      ),
    ),
    typedFailures("tests/boundary/filesystem/dwarfUnits.test.ts"),
  ),
  "rea-elf-debug-link": inProcess(
    covered(
      test(
        "tests/acceptance/elfDebugLinkCli.test.ts",
        "verifies a debug file while preserving both relative caller paths",
      ),
    ),
    covered(
      test(
        "tests/boundary/filesystem/elfDebugLink.test.ts",
        "returns typed resource and cancellation failures",
      ),
      test(
        "tests/boundary/filesystem/elfDebugLink.test.ts",
        "retains streamed candidate Evidence when cancelled during %s",
      ),
    ),
  ),
  "rea-elf-dependencies": inProcess(
    covered(
      test(
        "tests/acceptance/elfDependenciesCli.test.ts",
        "reports needed libraries, RUNPATH tokens, and versioned imports through the public CLI",
      ),
    ),
    typedFailures("tests/boundary/filesystem/elfDependencies.test.ts"),
  ),
  "rea-elf-notes": inProcess(
    covered(
      test(
        "tests/acceptance/elfNotesCli.test.ts",
        "resolves section note names from a compressed string table through the CLI",
      ),
    ),
    typedFailures("tests/boundary/filesystem/elfNotes.test.ts"),
  ),
  "rea-elf-unwind-ranges": inProcess(
    covered(
      test(
        "tests/boundary/filesystem/elfUnwindRanges.test.ts",
        "accepts a header whose search table is omitted, as GNU ld writes it",
      ),
    ),
    typedFailures("tests/boundary/filesystem/elfUnwindRanges.test.ts"),
  ),
  "rea-erlang-beam": inProcess(
    covered(
      test(
        "tests/acceptance/erlangBeamCli.test.ts",
        "reports BEAM tables and code for a path relative to the CLI working directory",
      ),
    ),
    typedFailures("tests/boundary/filesystem/erlangBeam.test.ts"),
  ),
  "rea-harmony-application": inProcess(
    covered(
      test(
        "tests/acceptance/harmonyArtifactJourney.test.ts",
        "preserves Harmony archive formats through the public CLI/MCP lifecycle",
      ),
    ),
    covered(
      test(
        "tests/boundary/filesystem/harmony/application.test.ts",
        "stops resolving retained inventory pages when the caller cancels mid-request",
      ),
    ),
  ),
  "rea-javascript-application": {
    ownership: "process",
    stages: {
      launch: covered(
        test(
          "tests/boundary/javascript/javascriptAnalysisWorkerLaunch.test.ts",
          "reports a JavaScript worker that fails to launch and launches a fresh worker on the next analysis",
        ),
      ),
      handshake: covered(
        test(
          "src/javascript/analysis/JavaScriptAnalysisWorker.startup.test.ts",
          "refuses a worker that emits facts before its ready frame and stops it",
        ),
        test(
          "src/javascript/analysis/JavaScriptAnalysisWorker.startup.test.ts",
          "times out a worker whose ready frame never arrives and stops it",
        ),
      ),
      operation: covered(
        test(
          "tests/acceptance/javascriptRoutesCli.test.ts",
          "keeps a large source's partial route facts queryable through SDK delivery",
        ),
      ),
      cancel: covered(
        test(
          "tests/boundary/filesystem/javascript-applications/javascriptApplicationService.test.ts",
          "keeps unselected files outside scope when the real worker cancels after the last selected file",
        ),
      ),
      cleanup: covered(
        test(
          "src/javascript/analysis/JavaScriptAnalysisWorker.inspection.test.ts",
          "retains a mixed identity batch's actual descriptor until the same owner retries",
        ),
      ),
      retry: covered(
        test(
          "src/javascript/analysis/JavaScriptAnalysisWorker.inspection.test.ts",
          "retries the exact failed inspection owner before releasing its error",
        ),
      ),
    },
  },
  "rea-javascript-application-workflows": inProcess(
    covered(
      test(
        "tests/boundary/filesystem/javascriptApplicationWorkflows.test.ts",
        "traces a contextBridge API through IPC into linked native evidence",
      ),
    ),
    covered(
      test(
        "tests/boundary/filesystem/javascriptApplicationWorkflows.test.ts",
        "stops resolving retained version-comparison sources when the caller cancels mid-request",
      ),
    ),
  ),
  "rea-javascript-runtime-reconciliation": inProcess(
    covered(
      test(
        "tests/boundary/filesystem/javascript-applications/javascriptRuntimeReconciliation.test.ts",
        "matches renderer, frame, script bytes, and worker without claiming execution",
      ),
    ),
    covered(
      test(
        "src/application/javascript/JavaScriptRuntimeReconciliationService.test.ts",
        "stops resolving retained reconciliation sources when the caller cancels mid-request",
      ),
    ),
  ),
  "rea-kernel-build-config": inProcess(
    covered(
      test(
        "tests/boundary/filesystem/kernelBuildConfig.test.ts",
        "reports an ordinary IKCFG_ST string as no config with file Evidence",
      ),
    ),
    covered(
      test(
        "src/native/elf/KernelBuildConfig.test.ts",
        "honors an abort raised while the parse is running",
      ),
    ),
  ),
  "rea-kernel-module": inProcess(
    covered(
      test(
        "tests/acceptance/kernelModuleCli.test.ts",
        "reports license, duplicate aliases, and version CRCs through the public CLI",
      ),
    ),
    typedFailures("tests/boundary/filesystem/kernelModule.test.ts"),
  ),
  "rea-maven-gradle-metadata": inProcess(
    covered(
      test(
        "tests/boundary/mcp/mavenGradleMetadataMcp.test.ts",
        "advertises inspect_maven_gradle_metadata and reports a real POM",
      ),
    ),
    covered(
      test(
        "src/application/java/MavenGradleMetadataService.test.ts",
        "retains completed Evidence and selected parameters on late cancellation",
      ),
    ),
  ),
  "rea-native-exports": inProcess(
    covered(
      test(
        "tests/boundary/filesystem/nativeExports.test.ts",
        "binds PE and ELF export inventories to the selected file",
      ),
    ),
    covered(
      test(
        "tests/boundary/filesystem/nativeExports.test.ts",
        "returns typed input, unsupported, budget and cancellation failures",
      ),
    ),
  ),
  "rea-native-initializers": inProcess(
    covered(
      test(
        "tests/acceptance/nativeInitializersCli.test.ts",
        "lists Mach-O initializers and finalizers through the public CLI",
      ),
    ),
    covered(
      test(
        "src/native/initializers/NativeInitializersParsers.test.ts",
        "observes cancellation during the section relocation walk",
      ),
    ),
  ),
  "rea-pe-certificates": inProcess(
    covered(
      test(
        "tests/acceptance/peCertificatesCli.test.ts",
        "reports PKCS#7 signer identity and BER lengths through both adapters",
      ),
    ),
    typedFailures("tests/boundary/filesystem/peCertificates.test.ts"),
  ),
  "rea-pe-imports": inProcess(
    covered(
      test(
        "tests/boundary/filesystem/peImports.test.ts",
        "retains partial Evidence for an import name beyond the read allowance",
      ),
    ),
    typedFailures("tests/boundary/filesystem/peImports.test.ts"),
  ),
  "rea-pe-load-config": inProcess(
    covered(
      test(
        "tests/boundary/filesystem/peLoadConfig.test.ts",
        "retains completed PE acquisition through %s",
      ),
    ),
    typedFailures("tests/boundary/filesystem/peLoadConfig.test.ts"),
  ),
  "rea-pe-resources": inProcess(
    covered(
      test(
        "tests/boundary/filesystem/peResources.test.ts",
        "admits the largest measured stock Windows resource table by default",
      ),
    ),
    typedFailures("tests/boundary/filesystem/peResources.test.ts"),
  ),
  "rea-pe-unwind-ranges": inProcess(
    covered(
      test(
        "tests/acceptance/peUnwindRangesCli.test.ts",
        "reads x64 exception-directory ranges identically over CLI and MCP",
      ),
    ),
    typedFailures("src/native/pe/PeUnwindRangesProvider.test.ts"),
  ),
  "rea-playwright-browser-scenario": {
    ownership: "process",
    stages: {
      launch: covered(
        test(
          "src/browser/PlaywrightScenarioBrowser.test.ts",
          "normalizes a genuine Playwright launch timeout and releases its profile",
        ),
        test(
          "src/browser/PlaywrightScenarioBrowser.test.ts",
          "passes the selected environment to the $platform browser launch boundary",
        ),
      ),
      handshake: covered(
        test(
          "src/browser/PlaywrightScenarioBrowser.test.ts",
          "closes a browser that connects after its deadline without waiting to report the timeout",
        ),
      ),
      operation: covered(
        test(
          "src/browser/PlaywrightBrowserScenarioProvider.test.ts",
          "retains all long-scenario steps and monotonic elapsed time",
        ),
      ),
      cancel: covered(
        test(
          "src/browser/PlaywrightScenarioSession.test.ts",
          "preserves $outcome action rejection through provider cancellation (cleanup refused: $cleanupFails)",
        ),
      ),
      cleanup: covered(
        test(
          "src/browser/PlaywrightBrowserScenarioProvider.test.ts",
          "returns a cleanup failure with completed observations when close fails",
        ),
      ),
      retry: covered(
        test(
          "src/browser/PlaywrightBrowserScenarioProvider.test.ts",
          "retries all opening leases after a refusal and reports only those still owned",
        ),
      ),
    },
  },
  "rea-playwright-electron-active": {
    ownership: "process",
    stages: {
      launch: covered(
        test(
          "src/browser/PlaywrightElectronActiveProvider.test.ts",
          "passes the selected environment and ownership token to Electron launch",
        ),
      ),
      handshake: covered(
        test(
          "src/browser/PlaywrightElectronActiveProvider.test.ts",
          "joins a late launch acknowledgement and its cleanup after shutdown",
        ),
      ),
      operation: covered(
        test(
          "src/browser/PlaywrightElectronActiveActions.test.ts",
          "runs an untargeted deep-link without requiring a BrowserWindow",
        ),
      ),
      cancel: covered(
        test(
          "src/browser/PlaywrightElectronActiveProvider.test.ts",
          "cancels a windowless wait action and cleans up the owned application (%s)",
        ),
      ),
      cleanup: covered(
        test(
          "src/browser/PlaywrightElectronActiveProvider.test.ts",
          "retains cancellation first observed during failed %s cleanup through retry",
        ),
      ),
      retry: covered(
        test(
          "src/browser/PlaywrightElectronActiveProvider.test.ts",
          "retains failed ownership-helper cleanup until provider close retries it",
        ),
      ),
    },
  },
  "rea-nuget-nupkg": inProcess(
    covered(
      test(
        "tests/boundary/mcp/nugetNupkgMcp.test.ts",
        "advertises inspect_nuget_nupkg and reads package identity",
      ),
    ),
    covered(
      test(
        "src/application/nuget/NugetNupkgService.test.ts",
        "retains completed Evidence and caller selections on late cancellation",
      ),
    ),
  ),
  "rea-python-pyc": inProcess(
    covered(
      test(
        "tests/boundary/mcp/pythonPycMcp.test.ts",
        "reads signed TYPE_INT64 constants and rejects a truncated payload",
      ),
    ),
    covered(
      test(
        "src/application/python/PythonPycService.test.ts",
        "retains completed pyc Evidence and the opaque caller reason on late cancellation",
      ),
    ),
  ),
  "rea-release-exposure": inProcess(
    covered(
      test(
        "tests/boundary/filesystem/releaseExposure.test.ts",
        "audits an ASAR whose unpacked module was signed after packaging",
      ),
    ),
    typedFailures("tests/boundary/filesystem/releaseExposure.test.ts"),
  ),
  "rea-v8-code-cache": inProcess(
    covered(
      test(
        "tests/acceptance/v8CodeCacheCli.test.ts",
        "reports wide, synthetic narrow and synthetic six-word header extents through the public CLI",
      ),
    ),
    covered(
      test(
        "tests/boundary/filesystem/v8CodeCacheArtifact.test.ts",
        "retains verified V8 Evidence during $stage",
      ),
    ),
  ),
  "rea-v8-inspector": {
    ownership: "connection",
    stages: {
      launch: ATTACH_ONLY,
      handshake: covered(
        test(
          "src/inspector/V8InspectorProvider.handshake.test.ts",
          "cancels a held inspector WebSocket handshake and admits the next observation",
        ),
      ),
      operation: covered(
        test(
          "tests/acceptance/tools/inspectorLifecycle.test.ts",
          "observes a real Node Inspector and releases attachments after cancellation and failures",
        ),
      ),
      cancel: covered(
        test(
          "src/inspector/V8InspectorCaptureProjection.test.ts",
          "stops finalization when cancellation arrives during location authorization",
        ),
      ),
      cleanup: covered(
        test(
          "src/inspector/V8InspectorProvider.closeOwnership.test.ts",
          "retains cancelled final-close ownership and retries the exact transport before replacement observation",
        ),
      ),
      retry: covered(
        test(
          "src/inspector/V8InspectorProvider.closeOwnership.test.ts",
          "retains cancelled final-close ownership and retries the exact transport before replacement observation",
        ),
      ),
    },
  },
  "rea-web-module-trace": {
    ownership: "process",
    stages: {
      launch: covered(
        test(
          "src/browser/modules/NativeModuleResolver.test.ts",
          "retains the selected executable and actual startup diagnostic",
        ),
      ),
      handshake: covered(
        test(
          "src/browser/modules/NativeModuleResolver.test.ts",
          "awaits and closes the late browser connection after cancellation",
        ),
      ),
      operation: covered(
        test(
          "tests/boundary/filesystem/webModuleArtifacts.test.ts",
          "verifies relocated source identity before accepting the captured bytes",
        ),
      ),
      cancel: covered(
        test(
          "src/browser/modules/NativeModuleResolver.test.ts",
          "does not acquire a browser after caller cancellation",
        ),
        test(
          "src/application/WebModuleTraceService.test.ts",
          "does not start the native resolver after cancellation during artifact admission",
        ),
      ),
      cleanup: covered(
        test(
          "src/browser/modules/NativeModuleResolver.test.ts",
          "retries retained browser cleanup before launching the next resolution",
        ),
      ),
      retry: covered(
        test(
          "src/browser/modules/NativeModuleResolver.test.ts",
          "retries retained browser cleanup before launching the next resolution",
        ),
      ),
    },
  },
  "rea-web-script-export": inProcess(
    covered(
      test(
        "tests/boundary/filesystem/javascriptExportShapeComparison.test.ts",
        "preserves accessor-effect uncertainty through analyzed Evidence and export comparison",
      ),
    ),
    covered(
      test(
        "tests/boundary/filesystem/webScriptExport.test.ts",
        "cancels before work and rolls back cancellation after output creation",
      ),
    ),
  ),
  "rea-web-source-location": {
    ownership: "process",
    stages: {
      launch: covered(
        test(
          SOURCE_MAP_DECODER_BOUNDARY,
          "removes the private request when launching the codec fails",
        ),
      ),
      handshake: notApplicable(
        "The source-map codec child writes one reply per request; there is no handshake.",
      ),
      operation: covered(
        test(
          "tests/boundary/filesystem/webSourceLocationArtifacts.test.ts",
          "retains exact selected map bytes and completed reads across failures",
        ),
      ),
      cancel: covered(
        test(
          SOURCE_MAP_DECODER_BOUNDARY,
          "cancels a real owned process and removes the runtime request",
        ),
        test(
          "src/application/WebSourceLocationService.test.ts",
          "honors cancellation both before acquisition and across decoder completion",
        ),
      ),
      cleanup: covered(
        test(
          "src/javascript/sourceMaps/SourceMapDecoder.test.ts",
          "settles every source-map cleanup failure when final close releases the exact runtime",
        ),
      ),
      retry: covered(
        test(
          "src/javascript/sourceMaps/SourceMapDecoder.test.ts",
          "retains physical failure and late cancellation through cleanup failure and retry",
        ),
      ),
    },
  },
  "rea-windows-shortcut": inProcess(
    covered(
      test(
        "tests/acceptance/windowsShortcutCli.test.ts",
        "reports Shell Link facts through CLI and stdio MCP",
      ),
    ),
    typedFailures("tests/boundary/filesystem/windowsShortcut.test.ts"),
  ),
  rizin: {
    ownership: "process",
    stages: {
      launch: covered(
        test(
          REVERSE_LAUNCH_ERRORS,
          "preserves provider-launch ENOENT for a real execute_rizin_command target and records launch failure",
        ),
      ),
      handshake: ONE_SHOT,
      operation: covered(
        test(
          "tests/composition/reverseEngineering.test.ts",
          "passes decoder and map inputs to Rizin before the path and records them",
        ),
      ),
      cancel: covered(
        test(
          "tests/composition/reverseEngineeringCancellation.test.ts",
          "waits for a Rizin process cancelled during its %s to exit before returning",
        ),
      ),
      cleanup: covered(
        test(
          REVERSE_EDGE_CASES,
          "retains a capability failure when its injected owned runner also reports incomplete cleanup",
        ),
      ),
      retry: covered(
        test(
          REVERSE_EDGE_CASES,
          "releases a retained provider owner after cleanup succeeds",
        ),
      ),
    },
  },
  "rizin.debugger": {
    ownership: "process",
    stages: {
      launch: covered(
        test(
          "tests/boundary/providers/RizinDebugSessionCoverage.part2.test.ts",
          "maps injected spawn errors and startup protocol failure",
        ),
      ),
      handshake: covered(
        test(
          "tests/boundary/providers/RizinDebugSessionCoverage.part1.test.ts",
          "times out startup through the frame wait when Rizin never emits a frame",
        ),
        test(
          "tests/boundary/providers/RizinDebugSessionReviewRegressions.test.ts",
          "rejects startup when Rizin exits immediately after its initial frame",
        ),
      ),
      operation: covered(
        test(
          "tests/boundary/providers/RizinDebugSessionCoverage.part3.test.ts",
          "correlates an injected command frame with its generated marker",
        ),
      ),
      cancel: covered(
        test(
          "tests/boundary/mcp/rizinDebuggerCancellationMcp.test.ts",
          "propagates MCP cancellation into a running Rizin debugger command",
        ),
      ),
      cleanup: covered(
        test(
          "tests/boundary/providers/RizinDebugSessionCoverage.part1.test.ts",
          "retains owned fixture processes and files until a failed cleanup can complete",
        ),
      ),
      retry: covered(
        test(
          "tests/boundary/providers/RizinDebugSessionCoverage.part1.test.ts",
          "retains close failures and resolves their owner after cleanup retry",
        ),
      ),
    },
  },
  "rust-auditable": inProcess(
    covered(
      test(
        "tests/boundary/rust/rustBinaryBudget.test.ts",
        "recovers the same complete Rust image after input and report budget changes",
      ),
    ),
    covered(
      test(
        "src/application/rust/RustBinaryService.test.ts",
        "retains completed Rust Evidence on late cancellation and keeps output failure precedence",
      ),
    ),
  ),
  "sigrok-recording": {
    ownership: "process",
    stages: {
      launch: covered(
        test(
          "tests/boundary/signals/resourceLimits.test.ts",
          "preserves lower inherited file/CPU limits in the real launch",
        ),
      ),
      handshake: ONE_SHOT,
      operation: covered(
        test(
          "tests/boundary/signals/recordingProvider.test.ts",
          "decodes an immutable copy, preserves options and warnings, and releases its directory",
        ),
      ),
      cancel: covered(
        test(
          "tests/boundary/signals/recordingProvider.test.ts",
          "retains a completed observation when cancellation arrives at the service boundary",
        ),
      ),
      cleanup: covered(
        test(
          "tests/boundary/signals/recordingProvider.test.ts",
          "retains a completed observation and cleanup ownership for retry",
        ),
      ),
      retry: covered(
        test(
          "tests/boundary/signals/recordingProvider.test.ts",
          "releases a retained decoder process cleanup before the next decode completes",
        ),
      ),
    },
  },
  sqlite: {
    ownership: "process",
    stages: {
      launch: covered(
        test(
          "tests/boundary/sqlite/sqliteDatabaseProvider.test.ts",
          "reports a SQLite worker that fails to launch and removes its snapshot before the next inspection",
        ),
      ),
      handshake: notApplicable(
        "The SQLite worker writes one reply per request; there is no handshake.",
      ),
      operation: covered(
        test(
          "tests/boundary/sqlite/sqliteDatabaseProvider.test.ts",
          "enforces a selected worker budget and completes the corrected same-database retry",
        ),
      ),
      cancel: covered(
        test(
          "tests/boundary/sqlite/sqliteDatabaseDescriptorCleanup.test.ts",
          "retains cancellation diagnostics and the interrupt exit code through CLI shutdown",
        ),
      ),
      cleanup: covered(
        test(
          "tests/boundary/sqlite/sqliteDatabaseCleanup.test.ts",
          "retains the snapshot until a failed worker cleanup owner can be stopped",
        ),
      ),
      retry: covered(
        test(
          "tests/boundary/sqlite/sqliteDatabaseCleanup.test.ts",
          "retains failed snapshot owners and blocks new acquisition until retry succeeds",
        ),
      ),
    },
  },
  "tshark-capture": {
    ownership: "process",
    stages: {
      launch: covered(
        test(
          "tests/boundary/captures/resourceLimits.test.ts",
          "preserves lower inherited file/CPU limits in the real launch",
        ),
      ),
      handshake: ONE_SHOT,
      operation: covered(
        test(
          "tests/boundary/captures/captureProvider.test.ts",
          "returns canonical alias output through the public packet-capture CLI",
        ),
      ),
      cancel: covered(
        test(
          "tests/boundary/captures/captureProvider.test.ts",
          "retains a completed observation when cancellation arrives at the service boundary",
        ),
      ),
      cleanup: covered(
        test(
          "tests/boundary/captures/captureProvider.test.ts",
          "retains a completed observation and cleanup ownership for retry",
        ),
      ),
      retry: covered(
        test(
          "tests/boundary/captures/captureProvider.test.ts",
          "releases a retained decoder process cleanup before the next inspection completes",
        ),
      ),
    },
  },
  "rea-uefi": {
    ownership: "process",
    stages: {
      launch: covered(
        test(
          UEFI_PROVIDER,
          "decodes an LZMA-custom section through the owned worker and derives it",
        ),
      ),
      handshake: notApplicable(
        "The decoder child writes one framed reply per request; there is no handshake.",
      ),
      operation: covered(
        test(
          "tests/acceptance/uefiFirmware.test.ts",
          "maps a flash image end to end through CLI inspection and MCP session inventory",
        ),
      ),
      cancel: covered(
        test(
          UEFI_PROVIDER,
          "waits for committed output finalization during late cancellation and retries retained cleanup",
        ),
      ),
      cleanup: covered(
        test(
          UEFI_PROVIDER,
          "retains the worker root across a failed child stop retry and stops its child before root removal",
        ),
      ),
      retry: covered(
        test(
          UEFI_PROVIDER,
          "retains the worker root across a failed child stop retry and stops its child before root removal",
        ),
      ),
    },
  },
  unblob: {
    ownership: "process",
    stages: {
      launch: covered(
        test(
          FIRMWARE_INTEGRATION,
          "retains startup stderr when Unblob exits 1 without a report",
        ),
      ),
      handshake: ONE_SHOT,
      operation: covered(
        test(
          FIRMWARE_INTEGRATION,
          "extracts a selected interval with verified file identity and parent-byte lineage",
        ),
      ),
      cancel: covered(
        test(
          "tests/process-global/firmwareFileLifetime.test.ts",
          "preserves primitive cancellation before publication commit and rolls back the output",
        ),
      ),
      cleanup: covered(
        test(
          FIRMWARE_INTEGRATION,
          "retains the complete firmware result when published output cleanup stays uncertain",
        ),
      ),
      retry: covered(
        test(
          FIRMWARE_INTEGRATION,
          "retains a setup-failed publication tree for provider cleanup retry",
        ),
      ),
    },
  },
  "wabt-artifact": {
    ownership: "process",
    stages: {
      launch: covered(
        test(
          "src/wasm/WabtFailures.test.ts",
          "reports a WABT tool the host refused to start as unavailable",
        ),
      ),
      handshake: ONE_SHOT,
      operation: covered(
        test(
          "src/wasm/WabtArtifactProvider.test.ts",
          "admits a compatible caller WABT release and records the observed banner",
        ),
      ),
      cancel: covered(
        test(
          "src/wasm/WabtArtifactProvider.test.ts",
          "reports a snapshot write the caller cancelled as that caller's cancellation",
        ),
      ),
      cleanup: covered(
        test(
          "src/wasm/WabtArtifactProvider.test.ts",
          "bounds the excerpt when cleanup also fails after the output budget",
        ),
      ),
      retry: covered(
        test(
          "src/wasm/WabtArtifactProvider.test.ts",
          "retries a retained input descriptor before admitting the next WABT operation",
        ),
      ),
    },
  },
  wakaru: {
    ownership: "process",
    stages: {
      launch: covered(
        test(
          "src/javascript/recovery/WakaruCommand.test.ts",
          "preserves a real launch failure when the caller cancels after it",
        ),
      ),
      handshake: ONE_SHOT,
      operation: covered(
        test(
          "tests/boundary/javascript-recovery/wakaruIntegration.test.ts",
          "preserves selected source identities and layout through a symlink followed by ..",
        ),
      ),
      cancel: covered(
        test(
          "tests/boundary/javascript-recovery/wakaruIntegration.test.ts",
          "cancels an active recovery and verifies owned cleanup",
        ),
      ),
      cleanup: covered(
        test(
          "tests/boundary/javascript-recovery/wakaruIntegration.test.ts",
          "reports cleanup failure and retains the workspace named by the error",
        ),
      ),
      retry: covered(
        test(
          "tests/boundary/javascript-recovery/wakaruIntegration.test.ts",
          "retains a setup-failed publication tree for provider cleanup retry",
        ),
      ),
    },
  },
};
