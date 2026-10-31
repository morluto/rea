import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  createAnalysisExecution,
  type AnalysisExecution,
  type ProviderIdentity,
} from "../application/AnalysisProvider.js";
import { createAnalysisExecutionEvidence } from "../domain/analysisObservation.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import type { Evidence } from "../domain/evidence.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisProtocolError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  adbClientIdentitySchema,
  adbPackageNameSchema,
} from "../domain/adb/adbIdentity.js";
import {
  adbUiObservationSchemas,
  adbUiRunnerIdentitySchema,
  type AdbUiRequest,
} from "../domain/adb/adbUiAnalysis.js";
import { jsonObjectSchema } from "../domain/jsonValue.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  OwnedCommandFailure,
  runOwnedCommand,
} from "../process/OwnedCommand.js";
import {
  spawnOwnedProviderProcess,
  type ProviderProcessSnapshot,
  type ProviderProcessSupervisor,
} from "../process/ProviderProcess.js";
import { resolveWindowsProviderExecutable } from "../process/WindowsProviderExecutable.js";
import { adbEvidenceParameters } from "../domain/adb/adbEvidenceParameters.js";
import { adbArguments } from "./AdbCommand.js";

const PACKAGE_ENV = "REA_ADB_UI_PACKAGE";
const DEFAULT_PACKAGE = "dev.rea.uiautomator";
const REQUEST_BYTES = 16 * 1024;
const RESPONSE_BYTES = 256 * 1024;
const CAPTURE_BYTES = 1024 * 1024;
const CLEANUP_MS = 5000;
const PROTOCOL = 2;
/** Stated for every UI execution, whether it completed or was recovered. */
const UI_LIMITATIONS = [
  "UI Automator observes accessibility-exposed nodes; off-screen, custom-drawn and inaccessible content can be missing.",
  "Snapshots and input dispatch are sequential observations, not an atomic UI transaction. A returned action is not proof of the intended application outcome.",
  "Runner version and instance identity are reported by the operator-owned instrumentation process; REA does not install, start or stop that process implicitly.",
] as const;
const envelope = z
  .strictObject({
    protocol: z.literal(PROTOCOL),
    request_id: z.string().uuid().nullable(),
    instance_id: z.string().uuid(),
    // The JSON decoder owns JSON validity; named payload schemas own its facts.
    ok: z.boolean(),
    result: z.record(z.string(), z.unknown()).nullable(),
    error: z.strictObject({ kind: z.string(), reason: z.string() }).nullable(),
  })
  .refine(
    (value) =>
      value.ok === (value.error === null) &&
      value.ok === (value.result !== null),
    "Inconsistent outcome fields",
  );
type Reply = z.infer<typeof envelope>;
type UiObservation = z.infer<
  (typeof adbUiObservationSchemas)[AdbUiRequest["operation"]]
>;
type ReplyFailure = {
  readonly kind: "unavailable" | "protocol" | "capacity";
  readonly reason: string;
};
/** A settled request can still lack a transportable result of its action. */
interface RemoteCompletion {
  readonly reply: Reply;
  readonly kind: "report" | "refusal" | "unavailable";
}
interface RemoteRequest {
  readonly binary: string;
  readonly serial: string;
  readonly targetPackage: string;
  readonly displayId: number;
  readonly windowId: number | undefined;
  /** Complete identity admitted by ping, shared by transport and result validation. */
  readonly runner: Readonly<z.infer<typeof adbUiRunnerIdentitySchema>>;
  readonly requestId: string;
  readonly operation: string;
  readonly socketPath: string;
  settled?: boolean;
  completion?: RemoteCompletion;
  /** Host handoff is uncertain until the matching runner answers admission. */
  actionAdmission?: "unconfirmed" | "accepted" | "refused";
  lateEvidenceRecorded?: boolean;
  /**
   * Attach a terminal reply recovered by a later cleanup retry to the outcome
   * this request already produced. The request owns the recovery until it is
   * forgotten, because a completed action must never disappear behind a
   * transport failure that happened while reporting it.
   */
  recover?: (completion: RemoteCompletion) => Evidence | undefined;
}

interface RecoveredActionOutcome {
  readonly requestId: string;
  readonly operation: string;
  readonly serial: string;
  readonly targetPackage: string;
  readonly displayId: number;
  readonly windowId: number | undefined;
  readonly evidence?: Evidence;
}

const actionMayHaveDispatched = (request: RemoteRequest): boolean =>
  request.actionAdmission === "unconfirmed" ||
  request.actionAdmission === "accepted";

const actionOutcomeUnknown = (request: RemoteRequest): boolean =>
  actionMayHaveDispatched(request) &&
  (request.completion === undefined ||
    request.completion.kind === "unavailable");

/** Parse the producer's terminal record, never a substring inside Android diagnostics. */
export const parseAdbUiReply = (
  stdout: string,
  channel: "control" | "input" = "control",
): Result<Reply, ReplyFailure> => {
  const fail = (reason: string, kind: ReplyFailure["kind"] = "protocol") =>
    err({ kind, reason });
  const records =
    channel === "input"
      ? [stdout.trim()]
      : stdout
          .split(/\r?\n/u)
          .filter((line) => line.startsWith("Broadcast completed:"));
  if (records.length !== 1)
    return fail("Expected one completed UI runner broadcast");
  const match = (
    channel === "input"
      ? /^REA_UI_V2:([A-Za-z0-9+/]+={0,2})$/u
      : /^Broadcast completed: result=-?\d+, data="REA_UI_V2:([A-Za-z0-9+/]+={0,2})"$/u
  ).exec(records[0]!);
  if (match === null)
    return fail(
      "The selected UI runner did not answer the REA protocol",
      records[0]!.includes("REA_UI_V2:") ? "protocol" : "unavailable",
    );
  const encoded = match[1]!;
  if (encoded.length > Math.ceil(RESPONSE_BYTES / 3) * 4)
    return fail("UI response exceeds the Binder protocol budget", "capacity");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > RESPONSE_BYTES || bytes.toString("base64") !== encoded)
    return fail("UI response is not bounded canonical base64");
  try {
    const parsed = envelope.safeParse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    if (!parsed.success) return fail("UI response violated protocol v2");
    return ok(parsed.data);
  } catch {
    return fail("UI response is not valid UTF-8 JSON");
  }
};

/**
 * Own host commands and remote requests, borrowing AdbProvider's serialized
 * admission. The instrumentation process belongs to the operator.
 */
export class AdbUiRunner {
  readonly #pending = new Map<string, RemoteRequest>();
  readonly #commands = new Map<ProviderProcessSupervisor, string>();
  readonly #cleanupErrors = new Set<WeakRef<AnalysisError>>();
  #cleanup: Promise<readonly RecoveredActionOutcome[]> | undefined;
  /** Outcomes survive remote forget/acknowledgement failures until reported to a caller. */
  #recoveredActionOutcomes = new Map<string, RecoveredActionOutcome>();
  #unknownActionOutcome: RecoveredActionOutcome | undefined;

  constructor(
    readonly environment: Readonly<Record<string, string | undefined>>,
    /** Launch adapters must preserve the launch-state observations owned by this boundary. */
    private readonly launcher = spawnOwnedProviderProcess,
    /** Host facts deciding how the selected adb executable reaches the launcher. */
    private readonly platform: NodeJS.Platform = process.platform,
    /** Test seam for Windows PATH lookup while running on another host. */
    private readonly windowsIsFile?: (path: string) => boolean,
    /** Record a terminal outcome recovered after its original response was sent. */
    private readonly onLateEvidence?: (evidence: Evidence) => void,
  ) {}

  /**
   * The UI transport owns its adb processes, and the native Windows launcher
   * starts a drive-path executable without a PATH search. Resolve the caller's
   * selection against the same captured environment that the child receives,
   * so an unset `REA_ADB_PATH` works there exactly as the `adb version` probe
   * already does.
   */
  #launchExecutable(binary: string): string {
    if (this.platform !== "win32") return binary;
    return resolveWindowsProviderExecutable(
      binary,
      this.environment,
      this.windowsIsFile === undefined ? {} : { isFile: this.windowsIsFile },
    );
  }

  /** One validated UI execution, shared by the success and recovery paths. */
  #execution(
    request: AdbUiRequest,
    client: z.infer<typeof adbClientIdentitySchema>,
    serial: string,
    observed: UiObservation,
    provider: ProviderIdentity,
  ): AnalysisExecution {
    return createAnalysisExecution({ client, serial, ...observed }, provider, {
      limitations: UI_LIMITATIONS,
    });
  }

  get pendingResources(): readonly string[] {
    return [
      ...this.#commands.values(),
      ...[...this.#pending.values()].map(
        (request) =>
          `adb-ui:${request.serial}:${request.runner.package_name}:${request.runner.instance_id}:${request.requestId}`,
      ),
    ];
  }

  #trackCleanupError(error: AnalysisError): void {
    for (const reference of this.#cleanupErrors)
      if (reference.deref() === undefined)
        this.#cleanupErrors.delete(reference);
    this.#cleanupErrors.add(new WeakRef(error));
  }

  async #settleCommands(): Promise<void> {
    const failures = [];
    for (const [owner, resource] of this.#commands) {
      try {
        const stopped = await owner.stop();
        if (stopped.status === "incomplete" || stopped.status === "not-owned")
          failures.push({ resource, ...stopped });
        else this.#commands.delete(owner);
      } catch (cause) {
        failures.push({
          resource,
          reason: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
    if (failures.length) {
      const error = new ProviderCleanupError(
        "adb",
        [...this.#commands.values()],
        jsonObjectSchema.parse({ failures }),
      );
      this.#trackCleanupError(error);
      throw error;
    }
  }

  async #send(
    binary: string,
    serial: string,
    packageName: string,
    operation: string,
    payload: Readonly<Record<string, unknown>>,
    timeoutMs: number,
    signal?: AbortSignal,
    submission?: RemoteRequest,
    socketPath?: string,
    observeReply?: (reply: Reply) => void,
  ): Promise<Reply> {
    const json = JSON.stringify(payload);
    if (Buffer.byteLength(json) > REQUEST_BYTES)
      throw new AnalysisResourceConstraintError(
        operation,
        "transport",
        "UI request exceeds the 16 KiB retained-request protocol budget",
        { max_request_bytes: REQUEST_BYTES },
      );
    if (socketPath === undefined && "input" in payload)
      throw new AnalysisProtocolError(
        "UI request bodies require the private stdin channel",
      );
    const encoded = Buffer.from(json).toString("base64");
    const runId = randomUUID();
    let received: Result<Reply, AnalysisError> | undefined;
    try {
      await runOwnedCommand(
        {
          command: binary,
          arguments: adbArguments(
            serial,
            socketPath === undefined
              ? [
                  "shell",
                  "am",
                  "broadcast",
                  "--receiver-foreground",
                  "--user",
                  "0",
                  "-a",
                  `${packageName}.REQUEST`,
                  "-p",
                  packageName,
                  "--es",
                  "request",
                  encoded,
                ]
              : [
                  "shell",
                  "-T",
                  "run-as",
                  packageName,
                  // AOSP's run-as reads the package from argv[1] and the
                  // optional --user from argv[2], so the user option follows
                  // the package; its header comment shows the older order.
                  "--user",
                  "0",
                  "/system/bin/toybox",
                  "nc",
                  "-U",
                  "-w",
                  "5",
                  "-W",
                  "10",
                  socketPath,
                ],
          ),
          ...(socketPath === undefined ? {} : { stdin: "pipe" as const }),
          runId,
          expectedCommand: null,
          hostEnvironment: this.environment,
          onLaunchState: (state) => {
            if (submission === undefined || socketPath !== undefined) return;
            if (state === "attempting")
              this.#pending.set(submission.requestId, submission);
            else this.#pending.delete(submission.requestId);
          },
        },
        {
          timeoutMs,
          diagnosticBytes: CAPTURE_BYTES,
          observeCompleted: (result) => {
            // Complete output is authoritative before host cleanup can fail or
            // be cancelled. Decode once and keep admission separate from cleanup.
            received = this.#readReply(
              result,
              operation,
              serial,
              payload,
              socketPath,
            );
            if (received.ok) observeReply?.(received.value);
          },
        },
        {
          ...(signal === undefined ? {} : { signal }),
          ...(submission === undefined || socketPath === undefined
            ? {}
            : {
                onInputSubmission: () => {
                  if (operation === "perform_adb_ui_action")
                    submission.actionAdmission = "unconfirmed";
                },
              }),
          retainCleanup: (owner) => {
            this.#commands.set(owner, runId);
          },
          launcher: this.launcher,
          ...(socketPath === undefined ? {} : { input: `${encoded}\n` }),
        },
      );
      await this.#settleCommands();
      if (received === undefined)
        throw new AnalysisProtocolError(
          "ADB command has no completed UI reply",
        );
      if (!received.ok) throw received.error;
      return received.value;
    } catch (cause) {
      if (cause instanceof AnalysisError) throw cause;
      const capturedOutput =
        cause instanceof OwnedCommandFailure && cause.snapshot !== null
          ? {
              stdout: cause.snapshot.stdout.text,
              stderr: cause.snapshot.stderr.text,
              truncated:
                cause.snapshot.stdout.bytes <
                  cause.snapshot.stdout.observedBytes ||
                cause.snapshot.stderr.bytes <
                  cause.snapshot.stderr.observedBytes,
            }
          : undefined;
      const options = {
        cause,
        ...(capturedOutput === undefined ? {} : { capturedOutput }),
      };
      if (
        (signal?.aborted && cause === signal.reason) ||
        (cause instanceof OwnedCommandFailure && cause.reason === "cancelled")
      )
        throw new AnalysisCancelledError(operation, {
          ...options,
          cause: signal?.aborted ? signal.reason : cause,
        });
      if (cause instanceof OwnedCommandFailure && cause.reason === "timeout")
        throw new AnalysisTimeoutError(operation, timeoutMs, options);
      if (
        cause instanceof OwnedCommandFailure &&
        cause.reason === "output-limit"
      )
        throw new AnalysisResourceConstraintError(
          operation,
          "transport",
          "ADB UI output exceeded its complete-capture budget",
          { max_output_bytes: CAPTURE_BYTES },
          options,
        );
      throw new AnalysisProtocolError("ADB UI transport failed", options);
    }
  }

  #readReply(
    result: ProviderProcessSnapshot,
    operation: string,
    serial: string,
    payload: Readonly<Record<string, unknown>>,
    socketPath: string | undefined,
  ): Result<Reply, AnalysisError> {
    const parsed = parseAdbUiReply(
      result.stdout.text,
      socketPath === undefined ? "control" : "input",
    );
    if (!parsed.ok) {
      const options = {
        capturedOutput: {
          stdout: result.stdout.text,
          stderr: result.stderr.text,
          truncated: false,
        },
      };
      if (parsed.error.kind === "unavailable")
        return err(
          new AnalysisCapabilityUnavailableError(
            "adb",
            operation,
            `${parsed.error.reason}. Install and start the UI Automator runner on ${serial}; see docs/adb-ui-automation.md.`,
            options,
          ),
        );
      if (parsed.error.kind === "capacity")
        return err(
          new AnalysisResourceConstraintError(
            operation,
            "transport",
            parsed.error.reason,
            { max_response_bytes: RESPONSE_BYTES },
            options,
          ),
        );
      return err(new AnalysisProtocolError(parsed.error.reason, options));
    }
    if (parsed.value.request_id !== payload.request_id)
      return err(
        new AnalysisProtocolError("UI reply belongs to a different request"),
      );
    return parsed;
  }

  /** The provider drains accepted work before closing this transport. */
  async close(): Promise<void> {
    await this.#retryCleanup();
  }

  /** Reconcile retained owners once, inside the provider's admitted turn. */
  async reconcile(
    operation: string,
    signal?: AbortSignal,
  ): Promise<AnalysisOutputError | undefined> {
    const recovered = await this.#retryCleanup();
    if (signal?.aborted)
      throw new AnalysisCancelledError(operation, { cause: signal.reason });
    const action =
      operation === "perform_adb_ui_action"
        ? (this.#unknownActionOutcome ??
          recovered.find(
            ({ operation: prior }) => prior === "perform_adb_ui_action",
          ))
        : undefined;
    if (action === undefined) return undefined;
    const error = this.#recoveredActionError(operation, action);
    this.#recoveredActionOutcomes.delete(action.requestId);
    return error;
  }

  #rememberRecoveredAction(outcome: RecoveredActionOutcome): void {
    this.#recoveredActionOutcomes.set(outcome.requestId, outcome);
    if (outcome.evidence === undefined) this.#unknownActionOutcome = outcome;
  }

  #recoveredActionError(
    operation: string,
    recovered: RecoveredActionOutcome,
  ): AnalysisOutputError {
    return new AnalysisOutputError(
      operation,
      recovered.evidence === undefined
        ? "A previous UI action has no confirmed outcome"
        : "A previous UI action was recovered before this request was sent",
      {
        userMessage:
          "A previous UI action may have completed. This request was not sent.",
        remediationAction:
          recovered.evidence === undefined
            ? "Run inspect_adb_ui to check the current device state before deciding whether to send the intended action again."
            : "Review the recovered action Evidence and current UI state before deciding whether to send the intended action again.",
        diagnostics: {
          prior_request_id: recovered.requestId,
          prior_target: {
            serial: recovered.serial,
            package: recovered.targetPackage,
            display_id: recovered.displayId,
            ...(recovered.windowId === undefined
              ? {}
              : { window_id: recovered.windowId }),
          },
          prior_action_outcome:
            recovered.evidence === undefined ? "unknown" : "observed",
          current_request_dispatched: false,
        },
        ...(recovered.evidence === undefined
          ? {}
          : { partialObservation: recovered.evidence }),
      },
    );
  }

  #retryCleanup(): Promise<readonly RecoveredActionOutcome[]> {
    this.#cleanup ??= this.#close().finally(() => {
      this.#cleanup = undefined;
    });
    return this.#cleanup;
  }

  async #close(): Promise<readonly RecoveredActionOutcome[]> {
    await this.#settleCommands();
    const failures = [];
    for (const request of this.#pending.values()) {
      try {
        const signal = AbortSignal.timeout(CLEANUP_MS);
        for (;;) {
          signal.throwIfAborted();
          const reply = await this.#send(
            request.binary,
            request.serial,
            request.runner.package_name,
            request.operation,
            {
              protocol: PROTOCOL,
              operation: "cancel",
              request_id: randomUUID(),
              instance_id: request.runner.instance_id,
              cancel_request_id: request.requestId,
            },
            CLEANUP_MS,
            signal,
          );
          if (reply.instance_id !== request.runner.instance_id)
            throw new Error("Runner identity changed during cancellation");
          if (!reply.ok) {
            if (reply.error?.kind !== "capacity")
              throw new Error(
                reply.error?.reason ??
                  "Runner identity changed during cancellation",
              );
            // The runner settled the request but could not transport its
            // completion. Releasing it keeps the runner's slot available; the
            // completion itself never reached the caller.
            request.settled = true;
            if (actionMayHaveDispatched(request)) {
              const outcome: RecoveredActionOutcome = {
                requestId: request.requestId,
                operation: request.operation,
                serial: request.serial,
                targetPackage: request.targetPackage,
                displayId: request.displayId,
                windowId: request.windowId,
              };
              this.#rememberRecoveredAction(outcome);
            }
            await this.#forget(request, signal);
            break;
          }
          const result = z
            .strictObject({
              state: z.enum(["cancelling", "settled", "missing"]),
              response: envelope.nullable(),
            })
            .parse(reply.result);
          if (result.state === "missing" && !request.settled)
            throw new AnalysisProtocolError(
              "Runner has not observed the request; a delayed submission may still arrive",
            );
          if (result.state === "settled" || result.state === "missing") {
            request.settled = true;
            if (result.response !== null) {
              const completion = this.#rememberCompletion(
                request,
                result.response,
              );
              // The originating outcome may already have been returned; it still
              // owns this request's recovery until the request is forgotten.
              const evidence = request.recover?.(completion);
              if (
                actionMayHaveDispatched(request) &&
                completion.kind !== "refusal"
              ) {
                const outcome: RecoveredActionOutcome = {
                  requestId: request.requestId,
                  operation: request.operation,
                  serial: request.serial,
                  targetPackage: request.targetPackage,
                  displayId: request.displayId,
                  windowId: request.windowId,
                  ...(evidence === undefined ? {} : { evidence }),
                };
                this.#rememberRecoveredAction(outcome);
              }
            }
            await this.#forget(request, signal);
            break;
          }
          await delay(50, undefined, { signal });
        }
      } catch (cause) {
        failures.push({
          request_id: request.requestId,
          serial: request.serial,
          runner_package: request.runner.package_name,
          runner_instance: request.runner.instance_id,
          runner_user: 0,
          socket_path: request.socketPath,
          reason: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
    if (failures.length) {
      const error = new ProviderCleanupError("adb", this.pendingResources, {
        failures,
      });
      this.#trackCleanupError(error);
      throw error;
    }
    for (const reference of this.#cleanupErrors)
      reference.deref()?.resolveCleanup();
    this.#cleanupErrors.clear();
    return [...this.#recoveredActionOutcomes.values()];
  }

  #rememberCompletion(request: RemoteRequest, reply: Reply): RemoteCompletion {
    if (
      reply.request_id !== request.requestId ||
      reply.instance_id !== request.runner.instance_id
    )
      throw new AnalysisProtocolError(
        "Completed UI result belongs to a different request or runner",
      );
    // Sensitive-store refusals use their own kind. Keep the existing capacity
    // tag for lost output so older hosts also retain replay guards; older
    // runners' ambiguous capacity replies cannot establish a refusal either.
    const completion: RemoteCompletion = {
      reply,
      kind: reply.ok
        ? "report"
        : reply.error?.kind === "capacity"
          ? "unavailable"
          : "refusal",
    };
    request.completion = completion;
    request.settled = true;
    return completion;
  }

  async #forget(request: RemoteRequest, signal?: AbortSignal): Promise<void> {
    const reply = await this.#send(
      request.binary,
      request.serial,
      request.runner.package_name,
      request.operation,
      {
        protocol: PROTOCOL,
        operation: "forget",
        request_id: randomUUID(),
        instance_id: request.runner.instance_id,
        target_request_id: request.requestId,
      },
      CLEANUP_MS,
      signal,
    );
    if (reply.instance_id !== request.runner.instance_id || !reply.ok)
      throw new AnalysisProtocolError(
        "Could not release the completed UI request",
      );
    z.strictObject({ state: z.literal("forgotten") }).parse(reply.result);
    this.#pending.delete(request.requestId);
  }

  /** Execute only after the provider owns the turn and reconciles prior work. */
  async execute(
    request: AdbUiRequest,
    selectedBinary: string,
    client: z.infer<typeof adbClientIdentitySchema>,
    provider: ProviderIdentity,
    signal?: AbortSignal,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    let primary: AnalysisError;
    let owned: RemoteRequest | undefined;
    let observed: UiObservation | undefined;
    let admissionFailure: AnalysisError | undefined;
    let failureBeforeUnknownOutcome: AnalysisError | undefined;
    // A returned outcome is final; a later recovery can only add provenance.
    // The caller holds the composed cleanup failure, not the primary, so a late
    // recovery attaches to whichever error this request actually produced.
    let delivered = false;
    let returned: AnalysisError | undefined;
    let interruptedBeforeActionSubmission: AnalysisCancelledError | undefined;
    try {
      if (signal?.aborted)
        throw new AnalysisCancelledError(request.operation, {
          cause: signal.reason,
        });
      const selected = this.environment[PACKAGE_ENV];
      const parsedPackage = adbPackageNameSchema.safeParse(
        selected === undefined || selected === "" ? DEFAULT_PACKAGE : selected,
      );
      if (!parsedPackage.success)
        throw new AnalysisInputError(request.operation, {
          userMessage: `${PACKAGE_ENV} must name the installed runner package`,
        });
      const packageName = parsedPackage.data;
      const { serial } = request.input;
      const launch = this.#launchExecutable(selectedBinary);
      const ping = await this.#send(
        launch,
        serial,
        packageName,
        request.operation,
        { protocol: PROTOCOL, request_id: randomUUID(), operation: "ping" },
        10000,
        signal,
      );
      if (!ping.ok)
        throw new AnalysisCapabilityUnavailableError(
          "adb",
          request.operation,
          ping.error!.reason,
        );
      const hello = z
        .strictObject({
          runner: adbUiRunnerIdentitySchema,
          socket_path: z.string(),
        })
        .safeParse(ping.result);
      if (!hello.success)
        throw new AnalysisCapabilityUnavailableError(
          "adb",
          request.operation,
          "Rebuild and start the matching debug UI runner with protocol v2 private stdin transport.",
        );
      const identity = hello.data.runner;
      if (
        hello.data.socket_path !== `files/rea-ui-${identity.instance_id}.sock`
      )
        throw new AnalysisProtocolError(
          "UI runner socket does not belong to its reported instance",
        );
      if (
        identity.package_name !== packageName ||
        identity.instance_id !== ping.instance_id
      )
        throw new AnalysisProtocolError(
          "UI runner identity does not match the selected endpoint",
        );
      owned = {
        binary: launch,
        serial,
        targetPackage: request.input.package,
        displayId: request.input.display_id,
        windowId: request.input.window_id,
        runner: identity,
        requestId: randomUUID(),
        operation: request.operation,
        socketPath: hello.data.socket_path,
      };
      const payload = {
        protocol: PROTOCOL,
        request_id: owned.requestId,
        instance_id: owned.runner.instance_id,
        operation: request.operation,
        input: request.input,
      };
      // No remote authority is retained for requests refused before transport.
      if (Buffer.byteLength(JSON.stringify(payload)) > REQUEST_BYTES)
        throw new AnalysisResourceConstraintError(
          request.operation,
          "transport",
          "UI request exceeds the 16 KiB protocol budget",
          { max_request_bytes: REQUEST_BYTES },
        );
      let reply = await this.#send(
        launch,
        serial,
        packageName,
        request.operation,
        {
          protocol: PROTOCOL,
          request_id: owned.requestId,
          instance_id: owned.runner.instance_id,
          operation: "prepare",
          target_operation: request.operation,
        },
        10000,
        signal,
        owned,
      );
      if (reply.instance_id !== owned.runner.instance_id)
        throw new AnalysisProtocolError(
          "UI runner changed during request preparation",
        );
      if (!reply.ok) this.#pending.delete(owned.requestId);
      else {
        z.strictObject({ state: z.literal("prepared") }).parse(reply.result);
        const submitted = owned;
        reply = await this.#send(
          launch,
          serial,
          packageName,
          request.operation,
          payload,
          10000,
          signal,
          owned,
          owned.socketPath,
          (reply) => {
            // Only the selected request and runner can decide admission. The
            // transport already checked the request id while decoding output.
            if (reply.instance_id !== submitted.runner.instance_id) return;
            if (!reply.ok) {
              if (submitted.actionAdmission !== undefined)
                submitted.actionAdmission = "refused";
              admissionFailure = this.#runnerFailure(
                request,
                submitted,
                reply.error!,
                signal,
              );
              return;
            }
            const accepted = z
              .strictObject({ state: z.literal("accepted") })
              .safeParse(reply.result);
            if (!accepted.success)
              admissionFailure = new AnalysisOutputError(
                request.operation,
                "Invalid UI runner admission response",
                { cause: accepted.error },
              );
            else if (submitted.actionAdmission !== undefined)
              submitted.actionAdmission = "accepted";
          },
        );
      }
      if (reply.instance_id !== owned.runner.instance_id)
        throw new AnalysisProtocolError(
          "UI runner restarted while a request was outstanding",
        );
      if (admissionFailure !== undefined) throw admissionFailure;
      if (reply.ok) {
        const deadline = AbortSignal.timeout(request.input.timeout_ms + 10000);
        const pollSignal =
          signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
        try {
          for (;;) {
            const status = await this.#send(
              launch,
              serial,
              packageName,
              request.operation,
              {
                protocol: PROTOCOL,
                operation: "status",
                request_id: randomUUID(),
                instance_id: owned.runner.instance_id,
                target_request_id: owned.requestId,
              },
              10000,
              pollSignal,
            );
            if (
              status.instance_id === owned.runner.instance_id &&
              status.error?.kind === "capacity"
            )
              throw new AnalysisResourceConstraintError(
                request.operation,
                "transport",
                status.error.reason,
                { max_response_bytes: RESPONSE_BYTES },
              );
            if (status.instance_id !== owned.runner.instance_id || !status.ok)
              throw new AnalysisProtocolError(
                status.error?.reason ??
                  "UI runner changed while awaiting completion",
              );
            const progress = z
              .strictObject({
                state: z.enum(["running", "settled", "missing"]),
                response: envelope.nullable(),
              })
              .parse(status.result);
            if (progress.state === "missing")
              throw new AnalysisProtocolError(
                "UI runner lost an unacknowledged request",
              );
            if (progress.state === "settled") {
              if (progress.response === null)
                throw new AnalysisProtocolError(
                  "Completed UI request has no result",
                );
              this.#rememberCompletion(owned, progress.response);
              reply = progress.response;
              // Validate the report before acknowledgement/finalization can be
              // interrupted, and retain the parsed facts through that phase.
              observed = this.#validateObservation(
                request,
                owned,
                reply,
                signal,
              );
              await this.#forget(owned, pollSignal);
              break;
            }
            await delay(50, undefined, { signal: pollSignal });
          }
        } catch (cause) {
          if (deadline.aborted && !signal?.aborted)
            throw new AnalysisTimeoutError(
              request.operation,
              request.input.timeout_ms,
              { cause },
            );
          throw cause;
        }
      }
      observed ??= this.#validateObservation(request, owned, reply, signal);
      if (signal?.aborted)
        throw new AnalysisCancelledError(request.operation, {
          cause: signal.reason,
        });
      const execution = this.#execution(
        request,
        client,
        serial,
        observed,
        provider,
      );
      const unknownAction = this.#unknownActionOutcome;
      if (
        request.operation === "inspect_adb_ui" &&
        unknownAction !== undefined &&
        request.input.serial === unknownAction.serial &&
        request.input.package === unknownAction.targetPackage &&
        request.input.display_id === unknownAction.displayId &&
        request.input.window_id === unknownAction.windowId
      ) {
        this.#unknownActionOutcome = undefined;
        this.#recoveredActionOutcomes.delete(unknownAction.requestId);
      }
      return ok(execution);
    } catch (cause) {
      primary =
        signal?.aborted &&
        (cause === signal.reason ||
          (cause instanceof Error && cause.name === "AbortError"))
          ? new AnalysisCancelledError(request.operation, {
              cause: signal.reason,
            })
          : cause instanceof AnalysisError
            ? cause
            : new AnalysisOutputError(
                request.operation,
                "Invalid UI runner response",
                { cause },
              );
    }
    if (admissionFailure !== undefined && admissionFailure !== primary) {
      admissionFailure.retainSecondaryFailure(primary, {
        admission_transport_failure: projectAnalysisError(primary),
      });
      primary = admissionFailure;
    }
    if (
      owned !== undefined &&
      actionOutcomeUnknown(owned) &&
      observed === undefined
    ) {
      failureBeforeUnknownOutcome = primary;
      primary = new AnalysisOutputError(
        request.operation,
        "The submitted UI action has no confirmed terminal outcome",
        {
          cause: primary,
          userMessage:
            "The UI action may have completed, but its outcome is unknown. Do not replay it until you inspect the current UI state.",
          remediationAction:
            "Inspect the current UI state and any recovered action Evidence before deciding whether to send the action again.",
          diagnostics: {
            action_outcome: "unknown",
            request_id: owned.requestId,
            replay_safe: false,
          },
        },
      );
    }
    if (primary instanceof AnalysisCancelledError)
      interruptedBeforeActionSubmission = primary;
    // One recovery owner: a terminal reply discovered in this frame or by a later
    // cleanup retry is attached to the same outcome, whichever arrives first.
    // A recovered refusal is the runner's definitive answer, so it replaces a
    // cancellation that is still undecided and otherwise stays visible as a
    // secondary failure instead of being dropped with the request.
    const retainCompletion = ({
      reply,
      kind,
    }: RemoteCompletion): Evidence | undefined => {
      if (owned === undefined) return undefined;
      // Cancelling the prepared slot releases ownership; it cannot supersede
      // the authoritative body refusal or create an uncertain action outcome.
      if (owned.actionAdmission === "refused") return undefined;
      if (
        !delivered &&
        interruptedBeforeActionSubmission !== undefined &&
        reply.error?.kind === "cancelled"
      ) {
        // The runner confirms it cancelled before admitting the action body.
        // Preserve the caller's interruption instead of relabeling it unknown.
        primary = interruptedBeforeActionSubmission;
        return undefined;
      }
      try {
        observed ??= this.#validateObservation(request, owned, reply, signal);
      } catch (cause) {
        if (!(cause instanceof AnalysisError)) return;
        if (kind === "unavailable")
          (returned ?? primary).retainSecondaryFailure(cause, {
            unavailable_completion: projectAnalysisError(cause),
          });
        else if (
          !delivered &&
          (primary instanceof AnalysisCancelledError ||
            (kind === "refusal" && failureBeforeUnknownOutcome !== undefined))
        ) {
          // A recovered refusal settles the temporary uncertainty before
          // delivery. Preserve the physical failure, not a superseded inference.
          const previous = failureBeforeUnknownOutcome ?? primary;
          failureBeforeUnknownOutcome = undefined;
          primary = cause;
          primary.retainSecondaryFailure(previous, {});
        } else
          // Callers read the projected error, not the cause chain, so the
          // runner's definitive refusal is retained where it stays visible.
          (returned ?? primary).retainSecondaryFailure(cause, {
            recovered_refusal: projectAnalysisError(cause),
          });
        return undefined;
      }
      // Recovered UI facts become the same Evidence a successful call returns, so an
      // exported session records the action and its after-state even when
      // acknowledgement, cleanup or the caller interrupted the request.
      const recovered = this.#execution(
        request,
        client,
        request.input.serial,
        observed,
        provider,
      );
      const evidence = createAnalysisExecutionEvidence(
        request.operation,
        adbEvidenceParameters(request, recovered.result),
        recovered,
        "observed",
        { authority: "controlled-replay" },
      );
      (returned ?? primary).retainPartialObservation(evidence);
      if (delivered && !owned.lateEvidenceRecorded) {
        // If persistence throws, let cleanup retain this remote request. A
        // later retry can deliver the same Evidence before releasing ownership.
        this.onLateEvidence?.(evidence);
        owned.lateEvidenceRecorded = true;
      }
      return evidence;
    };
    if (owned !== undefined) owned.recover = retainCompletion;
    const retainCompleted = (): void => {
      if (owned?.completion === undefined) return;
      retainCompletion(owned.completion);
    };
    try {
      await this.#retryCleanup();
    } catch (cause) {
      retainCompleted();
      const cleanup =
        cause instanceof ProviderCleanupError
          ? cause
          : new ProviderCleanupError(
              "adb",
              this.pendingResources,
              {},
              { cause },
            );
      const combined = analysisErrorWithCleanupFailure(
        primary,
        cleanup,
        request.operation,
      ).bindCleanupDependencies([primary, cleanup]);
      this.#trackCleanupError(combined);
      delivered = true;
      returned = combined;
      return err(combined);
    }
    retainCompleted();
    delivered = true;
    returned = primary;
    return err(primary);
  }

  #validateObservation(
    request: AdbUiRequest,
    owned: RemoteRequest,
    reply: Reply,
    signal?: AbortSignal,
  ): UiObservation {
    if (!reply.ok)
      throw this.#runnerFailure(request, owned, reply.error!, signal);
    const parsed = adbUiObservationSchemas[request.operation].safeParse(
      reply.result,
    );
    if (!parsed.success)
      throw new AnalysisOutputError(
        request.operation,
        "Invalid UI runner response",
        { cause: parsed.error },
      );
    const observation = parsed.data;
    const expected = owned.runner;
    if (
      observation.runner.package_name !== expected.package_name ||
      observation.runner.instance_id !== expected.instance_id ||
      observation.runner.version !== expected.version ||
      observation.runner.ui_automator_version !==
        expected.ui_automator_version ||
      observation.runner.sdk_int !== expected.sdk_int
    )
      throw new AnalysisProtocolError(
        "UI observation runner identity does not match the selected endpoint",
      );
    const snapshots =
      "before" in observation
        ? [
            observation.before,
            ...(observation.after === null ? [] : [observation.after]),
          ]
        : [observation.snapshot];
    if (
      snapshots.some(
        (snapshot) =>
          snapshot.package_name !== request.input.package ||
          snapshot.display_id !== request.input.display_id ||
          snapshot.window_id_filter !== (request.input.window_id ?? null),
      )
    )
      throw new AnalysisProtocolError(
        "UI observation does not match the requested scope",
      );
    const selectedSnapshotId =
      "snapshot_id" in request.input ? request.input.snapshot_id : undefined;
    const selectedSnapshot =
      "before" in observation ? observation.before : observation.snapshot;
    if (
      selectedSnapshotId !== undefined &&
      selectedSnapshot.id !== selectedSnapshotId
    )
      throw new AnalysisProtocolError(
        "UI observation does not belong to the selected snapshot",
      );
    if ("freshness" in observation) {
      const expectedFreshness =
        selectedSnapshotId === undefined ? "captured" : "retained_snapshot";
      const expectedOffset =
        request.operation === "find_adb_ui_elements" ? request.input.offset : 0;
      if (
        observation.freshness !== expectedFreshness ||
        observation.offset !== expectedOffset
      )
        throw new AnalysisProtocolError(
          "UI query does not match the requested freshness and page",
        );
    }
    if (
      request.operation === "perform_adb_ui_action" &&
      "selected_element" in observation &&
      observation.selected_element?.id !== request.input.element_id
    )
      throw new AnalysisProtocolError(
        "UI action does not belong to the selected element",
      );
    return observation;
  }

  #runnerFailure(
    request: AdbUiRequest,
    owned: RemoteRequest,
    failure: NonNullable<Reply["error"]>,
    signal?: AbortSignal,
  ): AnalysisError {
    if (failure.kind === "sensitive_capacity")
      return new AnalysisResourceConstraintError(
        request.operation,
        "capacity",
        failure.reason,
        null,
        {
          remediationAction:
            "After outstanding work settles, restart the operator-owned UI runner before adding more sensitive values. Actions that do not add sensitive values remain available.",
          diagnostics: {
            runner_failure: failure.kind,
            runner_instance: owned.runner.instance_id,
          },
        },
      );
    if (failure.kind === "timeout")
      return new AnalysisTimeoutError(
        request.operation,
        request.input.timeout_ms,
      );
    if (failure.kind === "cancelled")
      return new AnalysisCancelledError(request.operation, {
        cause: signal?.aborted ? signal.reason : failure.reason,
      });
    if (failure.kind === "busy" || failure.kind === "capacity")
      return new AnalysisResourceConstraintError(
        request.operation,
        "capacity",
        failure.reason,
        null,
      );
    if (
      failure.kind === "unsupported" ||
      failure.kind === "unsupported_key_code"
    )
      return new AnalysisCapabilityUnavailableError(
        "adb",
        request.operation,
        failure.reason,
        {
          diagnostics: {
            runner_failure: failure.kind,
            runner_instance: owned.runner.instance_id,
            ...(failure.kind === "unsupported_key_code" &&
            request.operation === "perform_adb_ui_action" &&
            request.input.action.kind === "key_event"
              ? { requested_key_code: request.input.action.key_code }
              : {}),
            selected_scope: {
              serial: request.input.serial,
              package: request.input.package,
              display_id: request.input.display_id,
              ...(request.input.window_id === undefined
                ? {}
                : { window_id: request.input.window_id }),
            },
          },
          remediationAction:
            failure.kind === "unsupported_key_code"
              ? "Choose a key_code supported by the connected device's Android version, using the range reported by the runner."
              : "Select a device and display supported by this operation: secondary-display inspection requires Android 11 or later, and key events require display 0.",
        },
      );
    return new AnalysisOutputError(request.operation, failure.kind, {
      userMessage: failure.reason,
      diagnostics: {
        runner_failure: failure.kind,
        runner_instance: owned.runner.instance_id,
      },
      remediationAction:
        "Inspect or find the current UI again, then select an enabled, visible element from that snapshot.",
    });
  }
}
