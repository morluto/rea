import { selectCdpDiscoveryTarget } from "./CdpDiscoveryTargets.js";
import {
  DEFAULT_ASAR_HEADER_ADMISSION,
  type AsarHeaderAdmission,
} from "../config/asarHeaderAdmission.js";
import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../ports/AnalysisProvider.js";
import type { ElectronObservationPort } from "../ports/javascript/ElectronObservationPort.js";
import {
  electronPageInspectionSchema,
  electronTargetListSchema,
  type ElectronPageInspection,
  type ElectronTargetList,
  type InspectElectronPageInput,
  type ListElectronTargetsInput,
} from "../domain/javascript/electronObservation.js";
import { selectedCdpCommandTimeoutMs } from "../domain/browserDeadline.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { cancelledBy } from "../domain/analysisErrorCore.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  discoverCdpEndpoint,
  hasCdpTargetWebSocket,
  type CdpEndpointDiscovery,
  type CdpEndpointTarget,
} from "./CdpEndpoint.js";
import {
  closeCdpTargetSession,
  openCdpTargetSession,
  type CdpTargetSession,
} from "./CdpTargetSession.js";
import { inspectCdpElectronPage } from "./CdpElectronInspection.js";
import {
  authorizedElectronFile,
  mapElectronFileAuthorizationFailure,
  retryElectronFileCleanup,
} from "./ElectronFileScope.js";

import { CDP_ELECTRON_PROVIDER_IDENTITY } from "./providerIdentities.js";
import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";
import { providerCleanupErrorFromFailures } from "../domain/analysisErrorCleanup.js";
import { finalizedResult, runOwned } from "../providers/runOwned.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import {
  CdpTargetSessionOwner,
  bindCdpTransportCleanup,
} from "./CdpTargetSessionOwner.js";
import { errorMessage } from "../kernel/errorMessage.js";
/** Passive Electron provider for local file pages exposed by loopback CDP. */
export class CdpElectronProvider implements ElectronObservationPort {
  readonly #owner = new CdpTargetSessionOwner();
  readonly #asarHeaderAdmission: AsarHeaderAdmission;

  /** The admission comes from the composition root's environment; default otherwise. */
  constructor(
    asarHeaderAdmission: AsarHeaderAdmission = DEFAULT_ASAR_HEADER_ADMISSION,
  ) {
    this.#asarHeaderAdmission = asarHeaderAdmission;
  }
  #activeOperations = 0;
  #closing = false;
  #closePromise: Promise<void> | undefined;
  readonly #idleWaiters = new Set<() => void>();

  async close(): Promise<void> {
    if (this.#closePromise === undefined) {
      this.#closing = true;
      const attempt = this.#closeAfterOperations();
      let tracked: Promise<void>;
      tracked = attempt.catch((cause: unknown) => {
        if (this.#closePromise === tracked) this.#closePromise = undefined;
        throw cause;
      });
      this.#closePromise = tracked;
    }
    await this.#closePromise;
  }

  async #closeAfterOperations(): Promise<void> {
    while (this.#activeOperations > 0)
      await new Promise<void>((resolve) => this.#idleWaiters.add(resolve));
    const outcomes = await Promise.allSettled([
      this.#owner.close(),
      retryElectronFileCleanup(),
    ]);
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason as unknown] : [],
    );
    const mapped = failures.map(
      (failure) =>
        mapElectronFileAuthorizationFailure(
          failure,
          CDP_ELECTRON_PROVIDER_IDENTITY.id,
          "inspect_electron_page",
        ) ?? failure,
    );
    if (mapped.length === 1) throw mapped[0];
    if (mapped.length > 1) {
      const typed = mapped.filter(
        (failure): failure is AnalysisError => failure instanceof AnalysisError,
      );
      throw providerCleanupErrorFromFailures(
        CDP_ELECTRON_PROVIDER_IDENTITY.id,
        typed,
        "Electron transport and file cleanup remain incomplete",
        { operation: "inspect_electron_page", causes: mapped },
      );
    }
  }

  identity(): ProviderIdentity {
    return CDP_ELECTRON_PROVIDER_IDENTITY;
  }

  async listTargets(
    input: ListElectronTargetsInput,
    options: ExecutionOptions = {},
  ): Promise<Result<ElectronTargetList, AnalysisError>> {
    return await this.#withAdmission(
      "list_electron_targets",
      async () => await this.#listTargets(input, options),
    );
  }

  async #listTargets(
    input: ListElectronTargetsInput,
    options: ExecutionOptions,
  ): Promise<Result<ElectronTargetList, AnalysisError>> {
    const allowed: ElectronTargetList["targets"] = [];
    let discovery: CdpEndpointDiscovery | undefined;
    let unsupportedUrl = 0;
    let nonPage = 0;
    let unconnectable = 0;
    let examined = 0;
    try {
      discovery = await discoverCdpEndpoint(
        input.cdp_endpoint,
        "list_electron_targets",
        options.signal,
      );
      throwIfElectronOperationCancelled(
        options.signal,
        "list_electron_targets",
      );
      for (const target of discovery.targets) {
        throwIfElectronOperationCancelled(
          options.signal,
          "list_electron_targets",
        );
        if (target.type !== "page") {
          examined += 1;
          nonPage += 1;
          continue;
        }
        const path = await authorizedElectronFile(
          target.url,
          options.signal,
          "list_electron_targets",
          this.#asarHeaderAdmission,
        );
        if (path === undefined) {
          examined += 1;
          unsupportedUrl += 1;
          continue;
        }
        if (!hasCdpTargetWebSocket(discovery, target)) {
          examined += 1;
          unconnectable += 1;
          continue;
        }
        examined += 1;
        allowed.push({
          target_id: target.id,
          type: target.type,
          title: target.title,
          file_path: path,
          attached: target.attached,
        });
      }
      allowed.sort((left, right) =>
        compareUnicodeCodePoints(left.target_id, right.target_id),
      );
      throwIfElectronOperationCancelled(
        options.signal,
        "list_electron_targets",
      );
      return ok(
        electronTargetListSchema.parse({
          browser: discovery.version,
          targets: allowed,
          excluded: {
            unsupported_url: unsupportedUrl,
            non_page: nonPage,
          },
          limitations: [
            ...(discovery.limitations ?? []),
            "Every local file page exposed by the selected loopback CDP endpoint is eligible for listing.",
            ...(unconnectable === 0
              ? []
              : [
                  `${String(unconnectable)} otherwise allowed page target(s) lacked a validated direct CDP WebSocket and were excluded.`,
                ]),
            ...(allowed.some((target) => target.attached === null)
              ? [
                  "CDP discovery could not establish debugger attachment state for one or more targets.",
                ]
              : []),
          ],
        }),
      );
    } catch (cause: unknown) {
      const completedPrefix = {
        browser_version: discovery?.version ?? null,
        examined_targets: examined,
        discovered_targets: discovery?.targets.length ?? null,
        allowed_targets: allowed,
        excluded: {
          unsupported_url: unsupportedUrl,
          non_page: nonPage,
        },
        unconnectable_targets: unconnectable,
        coverage:
          "partial: target authorization stopped; remaining targets are unknown",
      };
      const fileFailure = mapElectronFileAuthorizationFailure(
        cause,
        CDP_ELECTRON_PROVIDER_IDENTITY.id,
        "list_electron_targets",
        {
          completed_prefix: completedPrefix,
        },
      );
      if (fileFailure !== undefined) return err(fileFailure);
      return err(
        options.signal?.aborted === true
          ? cancelledBy("list_electron_targets", options.signal, {
              diagnostics: {
                completed_prefix: completedPrefix,
              },
            })
          : providerError(cause, "list_electron_targets"),
      );
    }
  }

  async inspectPage(
    input: InspectElectronPageInput,
    options: ExecutionOptions = {},
  ): Promise<Result<ElectronPageInspection, AnalysisError>> {
    return await this.#withAdmission(
      "inspect_electron_page",
      async () => await this.#inspectPage(input, options),
    );
  }

  async #inspectPage(
    input: InspectElectronPageInput,
    options: ExecutionOptions,
  ): Promise<Result<ElectronPageInspection, AnalysisError>> {
    let targetSession: CdpTargetSession | undefined;
    const operation = "inspect_electron_page";
    let cleanupIncomplete = false;
    const result = await runOwned<ElectronPageInspection>(
      async () => {
        try {
          const discovery = await discoverCdpEndpoint(
            input.cdp_endpoint,
            operation,
            options.signal,
          );
          const target = await authorizeTarget(
            discovery,
            input.target_id,
            this.#asarHeaderAdmission,
            options.signal,
          );
          targetSession = await openCdpTargetSession(
            discovery,
            target,
            operation,
            options.signal,
            {
              commandTimeoutMs: selectedCdpCommandTimeoutMs(
                input.command_timeout_ms,
              ),
            },
            this.#owner,
          );
          return ok(
            electronPageInspectionSchema.parse(
              await inspectCdpElectronPage({
                connection: targetSession.connection,
                sessionId: targetSession.sessionId,
                discovery,
                target,
                input,
                asarHeaderAdmission: this.#asarHeaderAdmission,
                ...(options.signal === undefined
                  ? {}
                  : { signal: options.signal }),
                ...(options.progress === undefined
                  ? {}
                  : { progress: options.progress }),
              }),
            ),
          );
        } catch (cause: unknown) {
          return err(providerError(cause, operation));
        }
      },
      {
        operation,
        providerId: CDP_ELECTRON_PROVIDER_IDENTITY.id,
        signal: options.signal,
        partial: (inspection) => ({
          kind: "electron-page-observation",
          inspection,
          cleanup: cleanupIncomplete ? "incomplete" : "transport-closed",
        }),
        close: async () => {
          if (targetSession === undefined) return;
          try {
            await closeCdpTargetSession(
              targetSession,
              ["Debugger", "Runtime", "Page"],
              options.signal,
              this.#owner,
            );
          } catch (cause: unknown) {
            cleanupIncomplete = true;
            const cleanupFailure =
              cause instanceof AnalysisError ? cause : undefined;
            const failure = new ProviderCleanupError(
              CDP_ELECTRON_PROVIDER_IDENTITY.id,
              cleanupFailure?.cleanupResources ?? [input.target_id],
              {
                cleanup_error: cleanupFailure?.message ?? errorMessage(cause),
              },
              { operation, cause },
            );
            throw bindCdpTransportCleanup(cause, failure);
          }
        },
      },
    );
    return finalizedResult(result);
  }

  async #withAdmission<Value>(
    operation: "list_electron_targets" | "inspect_electron_page",
    work: () => Promise<Result<Value, AnalysisError>>,
  ): Promise<Result<Value, AnalysisError>> {
    if (this.#closing)
      return err(
        new ProviderAdapterError(CDP_ELECTRON_PROVIDER_IDENTITY.id, operation, {
          diagnostics: { reason: "provider_closed" },
          userMessage: "Electron provider is closed to new observations.",
        }),
      );
    this.#activeOperations += 1;
    try {
      return await work();
    } catch (cause: unknown) {
      return err(providerError(cause, operation));
    } finally {
      this.#activeOperations -= 1;
      if (this.#activeOperations === 0) {
        for (const resolve of this.#idleWaiters) resolve();
        this.#idleWaiters.clear();
      }
    }
  }
}

const authorizeTarget = async (
  discovery: CdpEndpointDiscovery,
  targetId: string,
  asarHeaderAdmission: AsarHeaderAdmission,
  signal?: AbortSignal,
): Promise<CdpEndpointTarget> => {
  const operation = "inspect_electron_page";
  throwIfElectronOperationCancelled(signal, operation);
  const target = selectCdpDiscoveryTarget(
    discovery.targets,
    targetId,
    operation,
    discovery.ambiguousTargetIds,
  );
  if (target === undefined)
    throw new BrowserObservationError(operation, "target_not_found");
  if (target.type !== "page")
    throw new BrowserObservationError(operation, "target_not_allowed");
  const path = await authorizedElectronFile(
    target.url,
    signal,
    operation,
    asarHeaderAdmission,
  );
  throwIfElectronOperationCancelled(signal, operation);
  if (path === undefined)
    throw new BrowserObservationError(operation, "target_not_allowed");
  return target;
};

const throwIfElectronOperationCancelled = (
  signal: AbortSignal | undefined,
  operation: "list_electron_targets" | "inspect_electron_page",
): void => {
  if (signal?.aborted === true) throw cancelledBy(operation, signal);
};

const providerError = (
  cause: unknown,
  operation: "list_electron_targets" | "inspect_electron_page",
): AnalysisError => {
  const fileFailure = mapElectronFileAuthorizationFailure(
    cause,
    CDP_ELECTRON_PROVIDER_IDENTITY.id,
    operation,
  );
  if (fileFailure !== undefined) return fileFailure;
  return cause instanceof BrowserObservationError
    ? cause.forOperation(operation)
    : cause instanceof AnalysisError
      ? cause
      : new ProviderAdapterError(CDP_ELECTRON_PROVIDER_IDENTITY.id, operation, {
          cause,
        });
};
