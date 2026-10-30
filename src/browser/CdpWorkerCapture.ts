import type { WebPageInspection } from "../domain/browserObservationSchemas.js";
import { supportsJavaScriptSource } from "../domain/browserScriptLanguage.js";
import type { CaptureContext } from "./CdpPageCapture.js";
import type { CdpEvent } from "./CdpConnection.js";
import { CdpCaptureEvents } from "./CdpCaptureEvents.js";
import { optionalCdpCommand } from "./CdpOptionalCommand.js";
import { CdpCommandRejection } from "./CdpCommandRejection.js";
import { parseCdpWorkerTarget } from "./CdpWorkerTarget.js";
import { exclusionReasonForUrl } from "./CdpCaptureEventHelpers.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import { WEB_RUNTIME_LIMITS } from "../domain/webRuntime.js";
import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";
import {
  admitRecords,
  allowedSanitizedUrl,
  cdpStringValue,
  numberValue,
  recordValue,
  requiredScriptSource,
  sourceExcluded,
  sourceResult,
} from "./CdpCaptureValues.js";

const workerAutoAttachParameters = {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
  filter: [
    { type: "iframe" },
    { type: "worker" },
    { type: "service_worker" },
    { exclude: true },
  ],
};

const isMissingWorkerSession = (cause: unknown): boolean =>
  cause instanceof CdpCommandRejection &&
  cause.code === -32_001 &&
  cause.reportedMessage === "Session with given id not found.";

const isUnavailableWorkerCommand = (cause: unknown): boolean =>
  (cause instanceof CdpCommandRejection && cause.code === -32_000) ||
  isMissingWorkerSession(cause);

type Worker = WebPageInspection["workers"][number];
type Observation = NonNullable<Worker["observation"]>;
interface WorkerState {
  item: Worker & { observation: Observation };
  sessionId: string | undefined;
  detached: boolean;
  enabled: boolean;
  domains: Set<string>;
  autoAttach: boolean;
  events: CdpCaptureEvents;
  sources: Map<string, Observation["scripts"][number]>;
}

/** Owns only REA's worker debugger sessions; never pauses, starts or stops workers. */
export class CdpWorkerCapture {
  readonly #workers = new Map<string, WorkerState>();
  readonly #sessions = new Map<string, WorkerState>();
  readonly #frames = new Map<
    string,
    { targetId: string; detached: boolean; autoAttach: boolean }
  >();
  readonly #controlled = new Set<string>();
  readonly #versionsByTarget = new Map<
    string,
    {
      clients: readonly string[] | null;
      lifecycle: Observation["lifecycle"][number];
    }[]
  >();
  readonly #pending = new Set<Promise<void>>();
  readonly #lifecycleWork: (() => Promise<void>)[] = [];
  #runningLifecycle = false;
  readonly #invalidTargets = new Set<string>();
  readonly #sourceReads: {
    worker: WorkerState;
    item: Observation["scripts"][number];
  }[] = [];
  #readingSources = false;
  #failure: unknown;
  #removeListener: (() => void) | undefined;
  #stopped = false;
  #eventBytes = 0;
  #sourceBytes = 0;
  readonly #unavailableSourceSessions = new Set<string | undefined>();
  readonly #abort = new AbortController();
  readonly signal: AbortSignal;

  constructor(
    private readonly context: CaptureContext,
    private readonly allowedOrigins: ReadonlySet<string>,
    readonly limitations: string[],
    private readonly pageEvents: CdpCaptureEvents,
  ) {
    this.signal =
      context.signal === undefined
        ? this.#abort.signal
        : AbortSignal.any([context.signal, this.#abort.signal]);
  }

  check(): void {
    if (this.#failure !== undefined) throw this.#failure;
  }

  async start(): Promise<void> {
    this.pageEvents.completeness.attachLimited("workers");
    this.#removeListener = this.context.connection.onEvent((event) => {
      try {
        this.#ingest(event);
      } catch (cause) {
        this.#fail(cause);
      }
    });
    const serviceWorkers = await this.#command(
      "ServiceWorker.enable",
      {},
      this.context.sessionId,
    );
    if (serviceWorkers === undefined)
      this.pageEvents.completeness.unavailable("workers");
    if (this.context.sessionId !== undefined) {
      const attached = await this.#command(
        "Target.setAutoAttach",
        workerAutoAttachParameters,
        this.context.sessionId,
      );
      if (attached === undefined)
        this.pageEvents.completeness.unavailable("workers");
    }
    await this.#inventory();
    for (const id of this.context.input.worker_target_ids ?? []) {
      const worker = this.#workers.get(id);
      if (worker === undefined)
        throw new BrowserObservationError(
          this.context.operation,
          "target_not_allowed",
        );
      if (
        worker.sessionId !== undefined ||
        this.context.sessionId === undefined
      )
        continue;
      const result = recordValue(
        await this.#command(
          "Target.attachToTarget",
          { targetId: id, flatten: true },
          undefined,
        ),
      );
      const sessionId = cdpStringValue(result?.sessionId);
      if (sessionId === undefined)
        throw new BrowserObservationError(
          this.context.operation,
          "protocol_error",
        );
      this.#attach(worker, sessionId);
    }
    await this.#settle();
  }

  async finish(): Promise<Worker[]> {
    await this.#inventory();
    await this.#settle();
    this.#stopped = true;
    for (const [id, versions] of this.#versionsByTarget)
      if (
        !this.#workers.has(id) &&
        versions.some(({ lifecycle }) => lifecycle.controls_page === true)
      )
        this.pageEvents.completeness.unavailable("workers");
    return [...this.#workers.values()]
      .map((worker) => {
        worker.events.recordScriptMetadataBudgetExclusions();
        worker.events.settleUnexaminedResponseBodies();
        if (!this.context.input.include_script_sources)
          worker.events.completeness.exclude(
            "script_sources",
            "not_approved",
            worker.sources.size,
          );
        if (!worker.domains.has("Debugger"))
          worker.events.completeness.unavailable("scripts");
        if (!worker.domains.has("Network"))
          for (const section of [
            "network_requests",
            "websocket_connections",
            "websocket_frames",
            "metadata",
          ] as const)
            worker.events.completeness.unavailable(section);
        if (!worker.domains.has("Runtime"))
          for (const section of ["metadata", "console_events"] as const)
            worker.events.completeness.unavailable(section);
        worker.item.observation.network_requests = [
          ...worker.events.network.values(),
        ];
        worker.item.observation.scripts = [...worker.sources.values()];
        worker.item.observation.console_events = worker.events.console;
        worker.item.observation.metadata = {
          responses: worker.events.responseMetadata,
          agent_hints: worker.events.agentHints,
          headers_allowlisted: true,
        };
        worker.item.observation.websocket_connections = [
          ...worker.events.webSocketConnectionsById.values(),
        ];
        worker.item.observation.completeness =
          worker.events.completeness.snapshot();
        if (!worker.enabled)
          worker.item.observation.limitations.push(
            this.context.sessionId === undefined
              ? "Worker runtime observation requires a browser-level CDP WebSocket; this endpoint exposes a direct page transport."
              : "Worker source and runtime observation unavailable without proven page ownership or explicit target selection.",
          );
        return worker.item;
      })
      .sort((a, b) => compareUnicodeCodePoints(a.target_id, b.target_id));
  }

  async close(): Promise<void> {
    this.#stopped = true;
    this.#removeListener?.();
    this.#abort.abort();
    await Promise.all(this.#pending);
    if (this.#removeListener === undefined) return;
    // The outer page-session owner closes the entire connection even if these
    // optional domain/detach commands fail or the caller has cancelled.
    const signal = AbortSignal.timeout(1000);
    const send = async (
      method: string,
      params: Record<string, unknown>,
      sessionId?: string,
    ): Promise<void> => {
      try {
        await this.context.connection.send(method, params, sessionId, signal);
      } catch {
        /* Socket close is the definitive release boundary. */
      }
    };
    if (this.context.sessionId !== undefined)
      await send(
        "Target.setAutoAttach",
        { autoAttach: false, waitForDebuggerOnStart: false, flatten: true },
        this.context.sessionId,
      );
    await send("ServiceWorker.disable", {}, this.context.sessionId);
    for (const [sessionId, worker] of this.#sessions) {
      if (worker.detached) continue;
      if (worker.autoAttach)
        await send(
          "Target.setAutoAttach",
          { autoAttach: false, waitForDebuggerOnStart: false, flatten: true },
          sessionId,
        );
      await send("Target.detachFromTarget", { sessionId });
    }
    for (const [sessionId, frame] of this.#frames) {
      if (frame.detached) continue;
      if (frame.autoAttach)
        await send(
          "Target.setAutoAttach",
          { autoAttach: false, waitForDebuggerOnStart: false, flatten: true },
          sessionId,
        );
      await send("Target.detachFromTarget", { sessionId });
    }
  }

  async #inventory(): Promise<void> {
    const result = await this.#command("Target.getTargets", {}, undefined);
    if (result === undefined)
      this.pageEvents.completeness.unavailable("workers");
    const targets = admitRecords(recordValue(result)?.targetInfos);
    if (result !== undefined && targets === undefined)
      this.pageEvents.completeness.exclude(
        "workers",
        "invalid_protocol_value",
        null,
      );
    for (const target of targets ?? []) this.#admit(target);
  }

  #invalidTarget(target: unknown): void {
    const key = JSON.stringify(target);
    if (this.#invalidTargets.has(key)) return;
    this.#invalidTargets.add(key);
    this.pageEvents.completeness.exclude("workers", "invalid_protocol_value");
  }

  #invalidServiceTarget(id: string): void {
    this.#invalidTarget({
      targetId: id,
      event: "ServiceWorker.workerVersionUpdated",
    });
    this.pageEvents.completeness.unavailable("workers");
    this.#controlled.delete(id);
    this.#versionsByTarget.delete(id);
  }

  #excludeUrl(value: string | undefined, count: number | null = 1): void {
    const reason = exclusionReasonForUrl(value);
    // Only a known foreign HTTP origin proves exclusion from this scope.
    // An unattributed worker or frame may still contain page-related workers.
    if (reason !== "disallowed_origin")
      this.pageEvents.completeness.unavailable("workers");
    this.pageEvents.completeness.exclude("workers", reason, count);
  }

  #admit(value: unknown): WorkerState | undefined {
    const parsed = parseCdpWorkerTarget(value);
    if (!parsed.ok) {
      this.#invalidTarget(value);
      return;
    }
    const target = parsed.value;
    if (target.kind === "non_worker") return;
    const {
      type,
      targetId: id,
      openerTargetId: openerId,
      parentFrameId,
    } = target;
    if (
      type !== "worker" &&
      type !== "shared_worker" &&
      type !== "service_worker"
    )
      return;
    const existing = this.#workers.get(id);
    const url = allowedSanitizedUrl(target.url, this.allowedOrigins);
    if (
      existing !== undefined &&
      (existing.item.type !== type || existing.item.url !== url?.url)
    )
      throw new BrowserObservationError(
        this.context.operation,
        "target_changed",
      );
    if (url === undefined) {
      if (!this.#invalidTargets.has(id)) {
        this.#invalidTargets.add(id);
        this.#excludeUrl(target.url);
      }
      return;
    }
    if (existing !== undefined) {
      existing.item.attached = target.attached;
      return existing;
    }
    if (type !== "service_worker" && this.#versionsByTarget.has(id))
      this.#invalidServiceTarget(id);
    const worker: WorkerState = {
      item: {
        target_id: id,
        type,
        url: url.url,
        origin: url.origin,
        attached: target.attached === true,
        opener_target_id: openerId ?? null,
        parent_frame_id: parentFrameId ?? null,
        observation: {
          ownership: this.#versionsByTarget
            .get(id)
            ?.some(({ lifecycle }) => lifecycle.controls_page === true)
            ? "service_worker_client"
            : "unknown",
          selected_explicitly:
            this.context.input.worker_target_ids?.includes(id) ?? false,
          page_target_id: this.#versionsByTarget
            .get(id)
            ?.some(({ lifecycle }) => lifecycle.controls_page === true)
            ? this.context.target.id
            : null,
          lifecycle:
            this.#versionsByTarget.get(id)?.map(({ lifecycle }) => lifecycle) ??
            [],
          execution_contexts: [],
          scripts: [],
          network_requests: [],
          completeness: new CdpCaptureEvents(
            this.context.input,
            this.allowedOrigins,
          ).completeness.snapshot(),
          limitations: [
            "Only events after attachment are observed. Loaded scripts do not prove execution. Worker registration does not prove cached response delivery.",
          ],
        },
      },
      sessionId: undefined,
      detached: false,
      enabled: false,
      domains: new Set(),
      autoAttach: false,
      events: new CdpCaptureEvents(this.context.input, this.allowedOrigins),
      sources: new Map(),
    };
    this.#workers.set(id, worker);
    return worker;
  }

  #ingest(event: CdpEvent): void {
    if (this.#stopped) return;
    if (
      event.sessionId !== this.context.sessionId &&
      !this.#sessions.has(event.sessionId ?? "") &&
      !this.#frames.has(event.sessionId ?? "") &&
      !(
        event.method === "Target.detachedFromTarget" &&
        (this.#sessions.has(
          cdpStringValue(recordValue(event.params)?.sessionId) ?? "",
        ) ||
          this.#frames.has(
            cdpStringValue(recordValue(event.params)?.sessionId) ?? "",
          ))
      )
    )
      return;
    const worker = this.#sessions.get(event.sessionId ?? "");
    if (
      !event.method.startsWith("Target.") &&
      !event.method.startsWith("ServiceWorker.")
    ) {
      if (worker === undefined || !worker.enabled || worker.detached) return;
      if (
        worker.item.type === "service_worker" &&
        !this.#controlled.has(worker.item.target_id) &&
        !worker.item.observation.selected_explicitly
      )
        return;
    }
    this.#eventBytes += Buffer.byteLength(JSON.stringify(event));
    if (this.#eventBytes > WEB_RUNTIME_LIMITS.retainedEventBytes)
      throw new BrowserObservationError(
        this.context.operation,
        "payload_limit",
      );
    const params = recordValue(event.params);
    if (params === undefined) return;
    if (
      event.method === "ServiceWorker.workerVersionUpdated" &&
      event.sessionId === this.context.sessionId
    ) {
      this.#versions(params);
      return;
    }
    if (event.method === "Target.attachedToTarget") {
      if (this.context.sessionId === undefined) return;
      const parent =
        event.sessionId === this.context.sessionId
          ? undefined
          : this.#sessions.get(event.sessionId ?? "");
      const frameParent = this.#frames.get(event.sessionId ?? "");
      if (
        event.sessionId !== this.context.sessionId &&
        parent === undefined &&
        frameParent === undefined
      )
        return;
      if (parent?.detached || frameParent?.detached) return;
      const info = recordValue(params.targetInfo);
      const sessionId = cdpStringValue(params.sessionId);
      if (sessionId === undefined || sessionId.length === 0)
        throw new BrowserObservationError(
          this.context.operation,
          "protocol_error",
        );
      if (info === undefined) {
        this.pageEvents.completeness.unavailable("workers");
        this.#invalidTarget(params.targetInfo);
        return;
      }
      if (info?.type === "iframe") {
        if (parent !== undefined) return;
        const targetId = cdpStringValue(info.targetId);
        if (targetId === undefined || targetId.length === 0)
          throw new BrowserObservationError(
            this.context.operation,
            "protocol_error",
          );
        if (allowedSanitizedUrl(info.url, this.allowedOrigins) === undefined) {
          this.#excludeUrl(cdpStringValue(info.url), null);
          return;
        }
        const existing = this.#frames.get(sessionId);
        if (
          sessionId === this.context.sessionId ||
          this.#sessions.has(sessionId) ||
          (existing !== undefined && existing.targetId !== targetId)
        )
          throw new BrowserObservationError(
            this.context.operation,
            "protocol_error",
          );
        if (existing !== undefined) return;
        const frame = { targetId, detached: false, autoAttach: false };
        this.#frames.set(sessionId, frame);
        this.#refreshServiceClients();
        this.#queue(async () => {
          if (frame.detached) return;
          try {
            const result = await this.#command(
              "Target.setAutoAttach",
              workerAutoAttachParameters,
              sessionId,
            );
            frame.autoAttach = result !== undefined;
          } catch (cause) {
            if (this.signal.aborted || !isUnavailableWorkerCommand(cause))
              throw cause;
          }
          if (!frame.autoAttach)
            this.pageEvents.completeness.unavailable("workers");
        });
        return;
      }
      const worker = this.#admit(info);
      if (worker === undefined) return;
      if (
        worker.item.type === "worker" &&
        worker.item.observation.ownership !== "page_related" &&
        (parent === undefined ||
          parent.item.observation.ownership !== "unknown")
      ) {
        worker.item.observation.ownership = "page_related";
        worker.item.observation.page_target_id = this.context.target.id;
        this.#refreshServiceClients();
      }
      this.#attach(worker, sessionId);
      return;
    }
    if (event.method === "Target.detachedFromTarget") {
      const sessionId = cdpStringValue(params.sessionId);
      if (sessionId === undefined || sessionId.length === 0)
        throw new BrowserObservationError(
          this.context.operation,
          "protocol_error",
        );
      const frame = this.#frames.get(sessionId);
      if (frame !== undefined) {
        frame.detached = true;
        this.pageEvents.completeness.unavailable("workers");
        this.#refreshServiceClients();
      }
      const worker = this.#sessions.get(sessionId);
      if (worker !== undefined) {
        worker.detached = true;
        this.#refreshServiceClients();
        worker.item.observation.lifecycle.push({
          event: "detached",
          observed_at: new Date().toISOString(),
          running_status: null,
          version_status: null,
          controls_page: null,
        });
      }
      return;
    }
    if (worker === undefined || !worker.enabled || worker.detached) return;
    worker.events.ingest(event);
    if (event.method === "Runtime.executionContextCreated") {
      const context = recordValue(params.context);
      const id = numberValue(context?.id);
      if (id !== undefined && Number.isSafeInteger(id))
        worker.item.observation.execution_contexts.push({
          id,
          unique_id: cdpStringValue(context?.uniqueId) ?? null,
          origin:
            allowedSanitizedUrl(context?.origin, this.allowedOrigins)?.origin ??
            null,
        });
    }
    if (event.method === "Debugger.scriptParsed") this.#script(worker, params);
  }

  #script(
    worker: WorkerState,
    params: Readonly<Record<string, unknown>>,
  ): void {
    const scriptId = cdpStringValue(params.scriptId);
    const script = worker.events.scripts.get(scriptId ?? "");
    if (script === undefined) {
      if (worker.sources.has(scriptId ?? ""))
        throw new BrowserObservationError(
          this.context.operation,
          "target_changed",
        );
      return;
    }
    const contextId = numberValue(params.executionContextId);
    const item: Observation["scripts"][number] = {
      script_id: script.scriptId,
      is_module: script.isModule,
      language: script.language,
      length: script.length,
      source_map_url: script.sourceMapUrl,
      execution_context_id:
        contextId !== undefined && Number.isSafeInteger(contextId)
          ? contextId
          : null,
      url: script.url,
      cdp_hash: script.hash,
      source: sourceExcluded("source capture was not selected"),
    };
    const previous = worker.sources.get(script.scriptId);
    if (previous !== undefined) {
      if (
        previous.url !== item.url ||
        previous.cdp_hash !== item.cdp_hash ||
        previous.execution_context_id !== item.execution_context_id ||
        previous.is_module !== item.is_module ||
        previous.language !== item.language ||
        previous.length !== item.length ||
        previous.source_map_url !== item.source_map_url
      )
        throw new BrowserObservationError(
          this.context.operation,
          "target_changed",
        );
      return;
    }
    worker.sources.set(script.scriptId, item);
    if (!supportsJavaScriptSource(item.language)) {
      item.source = sourceExcluded(
        `Debugger reported language ${item.language}; JavaScript source capture was not inferred.`,
      );
      return;
    }
    if (this.context.input.include_script_sources) {
      this.#sourceReads.push({ worker, item });
      if (this.#readingSources) return;
      this.#readingSources = true;
      this.#track(() => this.#readSources());
    }
  }

  async #readSources(): Promise<void> {
    try {
      for (
        let index = 0;
        index < this.#sourceReads.length && !this.signal.aborted;
        index++
      ) {
        const { worker, item } = this.#sourceReads[index]!;
        try {
          const source =
            worker.detached ||
            this.#unavailableSourceSessions.has(worker.sessionId)
              ? undefined
              : await this.#command(
                  "Debugger.getScriptSource",
                  { scriptId: item.script_id },
                  worker.sessionId,
                  worker.item.observation.limitations,
                );
          if (source === undefined) {
            // Undefined from the optional command means method-not-found.
            // Cache that capability per session, preserving per-script failures.
            if (!worker.detached)
              this.#unavailableSourceSessions.add(worker.sessionId);
            item.source = sourceExcluded(
              "Worker source retrieval is unavailable",
            );
            worker.events.completeness.unavailable("script_sources");
            continue;
          }
          const text = requiredScriptSource(source, this.context.operation);
          this.#sourceBytes += Buffer.byteLength(text);
          if (this.#sourceBytes > WEB_RUNTIME_LIMITS.sourceBytes)
            throw new BrowserObservationError(
              this.context.operation,
              "payload_limit",
            );
          item.source = sourceResult(text);
        } catch (cause) {
          if (!this.signal.aborted && isUnavailableWorkerCommand(cause)) {
            if (isMissingWorkerSession(cause))
              this.#unavailableSourceSessions.add(worker.sessionId);
            item.source = sourceExcluded(
              "Worker source became unavailable during capture",
            );
            worker.events.completeness.unavailable("script_sources");
          } else throw cause;
        }
      }
    } finally {
      this.#sourceReads.length = 0;
      this.#readingSources = false;
    }
  }

  #versions(params: Readonly<Record<string, unknown>>): void {
    const versions = admitRecords(params.versions);
    if (versions === undefined) {
      this.pageEvents.completeness.unavailable("workers");
      this.pageEvents.completeness.exclude("workers", "invalid_protocol_value");
      return;
    }
    for (const value of versions) {
      const version = recordValue(value);
      if (version === undefined) {
        this.pageEvents.completeness.unavailable("workers");
        this.pageEvents.completeness.exclude(
          "workers",
          "invalid_protocol_value",
        );
        continue;
      }
      // Installed/stopped versions need not have a running Target.
      if (version.targetId === undefined) continue;
      const id = cdpStringValue(version.targetId);
      if (id === undefined || id.length === 0) {
        this.pageEvents.completeness.exclude(
          "workers",
          "invalid_protocol_value",
        );
        continue;
      }
      const target = this.#workers.get(id);
      if (target !== undefined && target.item.type !== "service_worker") {
        this.#invalidServiceTarget(id);
        continue;
      }
      const clients =
        Array.isArray(version.controlledClients) &&
        version.controlledClients.every(
          (client) => typeof client === "string" && client.length > 0,
        )
          ? version.controlledClients
          : null;
      if (version.controlledClients !== undefined && clients === null) {
        this.pageEvents.completeness.unavailable("workers");
        this.pageEvents.completeness.exclude(
          "workers",
          "invalid_protocol_value",
        );
      }
      // A missing first snapshot records a permanent discovery gap. Later
      // incomplete updates need neither revoke prior clients nor rescan history.
      if (clients === null && !this.#versionsByTarget.has(id))
        this.pageEvents.completeness.unavailable("workers");
      const lifecycle: Observation["lifecycle"][number] = {
        event: "version",
        observed_at: new Date().toISOString(),
        running_status: cdpStringValue(version.runningStatus) ?? null,
        version_status: cdpStringValue(version.status) ?? null,
        controls_page: this.#controlsPage(clients),
      };
      // Retain every client snapshot with its transition. A later frame
      // attachment can resolve historical control even after another version.
      const versions = this.#versionsByTarget.get(id) ?? [];
      versions.push({ clients, lifecycle });
      this.#versionsByTarget.set(id, versions);
      this.#updateControl(id, lifecycle.controls_page);
      const worker = this.#workers.get(id);
      worker?.item.observation.lifecycle.push(lifecycle);
    }
  }

  #controlsPage(clients: readonly string[] | null): boolean | null {
    if (clients === null) return null;
    return (
      clients.includes(this.context.target.id) ||
      [...this.#frames.values()].some(
        (frame) => !frame.detached && clients.includes(frame.targetId),
      ) ||
      clients.some((id) => {
        const worker = this.#workers.get(id);
        return (
          worker !== undefined &&
          !worker.detached &&
          worker.item.observation.ownership === "page_related"
        );
      })
    );
  }

  #refreshServiceClients(): void {
    for (const [id, versions] of this.#versionsByTarget) {
      let current: boolean | null = null;
      let observedControl = false;
      // Client IDs can arrive before their iframe attachment. Resolve that
      // recorded relationship when the owned frame becomes known, without
      // inventing another protocol version event. Detachment preserves the
      // historical observation while stopping later out-of-scope ingestion.
      for (const version of versions) {
        const controls = this.#controlsPage(version.clients);
        if (controls === true) version.lifecycle.controls_page = true;
        if (version.lifecycle.controls_page === true) observedControl = true;
        if (controls !== null) current = controls;
      }
      this.#updateControl(id, current, observedControl);
    }
  }

  #updateControl(
    id: string,
    controls: boolean | null,
    observedControl = false,
  ): void {
    const previouslyControlled = this.#controlled.has(id);
    if (controls === true) this.#controlled.add(id);
    else if (controls === false) this.#controlled.delete(id);
    const worker = this.#workers.get(id);
    if (worker === undefined) return;
    if (
      previouslyControlled &&
      controls === false &&
      worker.enabled &&
      !worker.item.observation.selected_explicitly
    ) {
      for (const section of [
        "scripts",
        "network_requests",
        "console_events",
        "websocket_connections",
        "websocket_frames",
        "metadata",
      ] as const)
        worker.events.completeness.exclude(
          section,
          "out_of_target_scope",
          null,
        );
      for (const section of [
        "scripts",
        "network_requests",
        "console_events",
        "websocket_connections",
        "websocket_frames",
      ] as const)
        worker.events.completeness.unavailable(section);
      worker.item.observation.limitations.push(
        "Service-worker control was revoked during capture; later runtime events outside the selected page scope were excluded.",
      );
    }
    if (controls === true || observedControl) {
      worker.item.observation.ownership = "service_worker_client";
      worker.item.observation.page_target_id = this.context.target.id;
    }
    if (worker.sessionId !== undefined) this.#queue(() => this.#enable(worker));
  }

  #attach(worker: WorkerState, sessionId: string): void {
    if (sessionId.length === 0 || sessionId === this.context.sessionId)
      throw new BrowserObservationError(
        this.context.operation,
        "protocol_error",
      );
    const owner = this.#sessions.get(sessionId);
    if (
      this.#frames.has(sessionId) ||
      (owner !== undefined && owner !== worker)
    )
      throw new BrowserObservationError(
        this.context.operation,
        "protocol_error",
      );
    if (worker.sessionId === sessionId) return;
    if (worker.sessionId !== undefined)
      throw new BrowserObservationError(
        this.context.operation,
        "target_changed",
      );
    worker.sessionId = sessionId;
    this.#sessions.set(sessionId, worker);
    worker.item.observation.lifecycle.push({
      event: "attached",
      observed_at: new Date().toISOString(),
      running_status: null,
      version_status: null,
      controls_page: null,
    });
    this.#queue(() => this.#enable(worker));
  }

  async #enable(worker: WorkerState): Promise<void> {
    if (
      worker.enabled ||
      worker.detached ||
      (!worker.item.observation.selected_explicitly &&
        (worker.item.type === "service_worker"
          ? !this.#controlled.has(worker.item.target_id)
          : worker.item.observation.ownership === "unknown"))
    )
      return;
    worker.enabled = true;
    let stage = "Target.setAutoAttach";
    try {
      if (worker.item.observation.ownership !== "unknown") {
        const attached = await this.#command(
          stage,
          workerAutoAttachParameters,
          worker.sessionId,
          worker.item.observation.limitations,
        );
        worker.autoAttach = attached !== undefined;
        if (!worker.autoAttach)
          worker.events.completeness.unavailable("workers");
      }
      for (const domain of ["Runtime", "Debugger", "Network"]) {
        if (worker.detached) return;
        stage = `${domain}.enable`;
        const result = await this.#command(
          stage,
          {},
          worker.sessionId,
          worker.item.observation.limitations,
        );
        if (result !== undefined) worker.domains.add(domain);
        if (result === undefined && domain !== "Runtime")
          worker.events.completeness.unavailable(
            domain === "Debugger" ? "scripts" : "network_requests",
          );
      }
    } catch (cause) {
      if (!this.signal.aborted && isUnavailableWorkerCommand(cause)) {
        worker.item.observation.limitations.push(
          `${stage} became unavailable during worker attachment.`,
        );
        worker.events.completeness.unavailable("workers");
        worker.events.completeness.unavailable("scripts");
        worker.events.completeness.unavailable("network_requests");
        return;
      }
      throw cause;
    }
  }

  async #command(
    method: string,
    params: Record<string, unknown>,
    sessionId: string | undefined,
    limitations = this.limitations,
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(WEB_RUNTIME_LIMITS.commandTimeoutMs);
    try {
      return await optionalCdpCommand(
        {
          connection: this.context.connection,
          sessionId,
          signal: AbortSignal.any([this.signal, timeout]),
        },
        method,
        params,
        limitations,
      );
    } catch (cause) {
      if (timeout.aborted && !this.signal.aborted)
        throw new BrowserObservationError(this.context.operation, "timeout", {
          cause,
        });
      throw cause;
    }
  }

  #queue(work: () => Promise<void>): void {
    if (this.#stopped || this.signal.aborted) return;
    this.#lifecycleWork.push(work);
    if (this.#runningLifecycle) return;
    this.#runningLifecycle = true;
    // Allocate one runner, not one command/timer/promise per attachment. Source
    // reads have their own serialized runner so neither lane blocks the other.
    this.#track(async () => {
      try {
        for (
          let index = 0;
          index < this.#lifecycleWork.length && !this.signal.aborted;
          index++
        )
          await this.#lifecycleWork[index]!();
      } finally {
        this.#lifecycleWork.length = 0;
        this.#runningLifecycle = false;
      }
    });
  }
  #track(work: () => Promise<void>): void {
    const pending = work()
      .catch((cause) => {
        this.#fail(cause);
      })
      .finally(() => this.#pending.delete(pending));
    this.#pending.add(pending);
  }
  async #settle(): Promise<void> {
    while (this.#pending.size > 0) await Promise.all(this.#pending);
    if (this.#failure !== undefined) throw this.#failure;
  }
  #fail(cause: unknown): void {
    if (this.#failure === undefined) this.#failure = cause;
    this.#abort.abort();
  }
}
