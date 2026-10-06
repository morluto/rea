import type {
  BrowserContext,
  ConsoleMessage,
  Download,
  Frame,
  Page,
  Request,
  Response,
  WebSocket,
  Worker,
} from "playwright-core";

import type { SanitizedBrowserUrl } from "../domain/browserObservation.js";
import {
  browserScenarioEventSchema,
  type BrowserScenarioEvent,
} from "../domain/browserScenarioCapture.js";
import type { BrowserScenarioSecrets } from "./BrowserScenarioSecrets.js";
import type { BrowserNetworkContentSelection } from "../domain/browserNetworkEvidence.js";
import { PlaywrightScenarioNetwork } from "./network/PlaywrightScenarioNetwork.js";

type EventName =
  | "console"
  | "page-errors"
  | "network"
  | "websockets"
  | "frames"
  | "workers"
  | "popups"
  | "downloads";

type UnindexedEvent = BrowserScenarioEvent extends infer Event
  ? Event extends BrowserScenarioEvent
    ? Omit<Event, "sequence" | "step_index">
    : never
  : never;

interface EventCaptureOptions {
  readonly page: Page;
  readonly context?: BrowserContext;
  /** A fresh launch context is wholly owned; connected contexts can contain other tabs. */
  readonly ownsContext?: boolean;
  readonly enabled: ReadonlySet<EventName>;
  readonly secrets: BrowserScenarioSecrets;
  readonly network?: BrowserNetworkContentSelection;
  readonly signal?: AbortSignal;
}

/** Arrival-ordered Playwright event capture with current-step attribution. */
export class PlaywrightScenarioEvents {
  private readonly items: BrowserScenarioEvent[] = [];
  private stepIndex = 0;
  private sequence = 0;
  private readonly enabled: ReadonlySet<EventName>;
  private readonly secrets: BrowserScenarioSecrets;
  private readonly ownsContext: boolean;
  private readonly pages = new Set<Page>();
  private readonly incompleteFamilies = new Set<EventName>();
  private readonly network: PlaywrightScenarioNetwork | undefined;
  private stopNetwork: (() => void) | undefined;
  private sealed = false;

  constructor(options: EventCaptureOptions) {
    const network = options.network ?? {
      request_body: false,
      response_body: false,
      header_values: false,
    };
    this.enabled = new Set(options.enabled);
    if (network.request_body || network.response_body || network.header_values)
      this.enabled = new Set([...this.enabled, "network"]);
    this.secrets = options.secrets;
    this.ownsContext = options.ownsContext === true;
    this.pages.add(options.page);
    if (this.ownsContext && this.enabled.size > 0)
      (options.context ?? options.page.context()).on("page", (page) =>
        this.popup(page),
      );
    if (this.enabled.has("network")) {
      const context = options.context ?? options.page.context();
      const collector = new PlaywrightScenarioNetwork({
        selection: network,
        secrets: options.secrets,
        emit: (event) => this.push(event),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      this.network = collector;
      const inScope = (request: Request): boolean => {
        if (this.ownsContext) return true;
        try {
          return this.pages.has(request.frame().page());
        } catch (cause: unknown) {
          // Initial popup navigations can lack a frame. Never guess ownership
          // from a URL in a shared context; connect captures are attach-limited.
          void cause;
          return false;
        }
      };
      const onRequest = (request: Request) => {
        if (inScope(request)) collector.request(request);
      };
      const onResponse = (response: Response) => {
        if (inScope(response.request())) collector.response(response);
      };
      const onFailed = (request: Request) => {
        if (inScope(request)) collector.failed(request);
      };
      const onFinished = (request: Request) => {
        if (inScope(request)) collector.finished(request);
      };
      context.on("request", onRequest);
      context.on("response", onResponse);
      context.on("requestfailed", onFailed);
      context.on("requestfinished", onFinished);
      this.stopNetwork = () => {
        context.off("request", onRequest);
        context.off("response", onResponse);
        context.off("requestfailed", onFailed);
        context.off("requestfinished", onFinished);
      };
    }
    this.observePage(options.page);
  }

  setStep(index: number): void {
    this.stepIndex = index;
  }

  nextSequence(): number {
    return this.sequence + 1;
  }

  lastSequence(): number {
    return this.sequence;
  }

  /** Drain selected network content and freeze the result before browser teardown. */
  async finish(): Promise<void> {
    this.stopNetwork?.();
    this.stopNetwork = undefined;
    try {
      await this.network?.finish();
    } finally {
      this.sealed = true;
    }
  }

  /** Report selected popup event families with unrecoverable pre-discovery gaps. */
  limitations(): readonly string[] {
    const popupGaps = [...this.incompleteFamilies].map(
      (family) =>
        `Popup ${family} events before Page discovery are unavailable; later events are retained.`,
    );
    const gaps = [...popupGaps, ...(this.network?.limitations() ?? [])];
    return this.enabled.has("network") && !this.ownsContext
      ? [
          "Shared-context network capture excludes requests without a known root or descendant Page frame.",
          ...gaps,
        ]
      : gaps;
  }

  result(): {
    readonly retained: number;
    readonly dropped: number;
    readonly items: readonly BrowserScenarioEvent[];
  } {
    return {
      retained: this.items.length,
      dropped: 0,
      items: this.items,
    };
  }

  private push(event: UnindexedEvent): number {
    if (this.sealed) return this.sequence;
    this.sequence += 1;
    const parsed = browserScenarioEventSchema.parse({
      ...event,
      sequence: this.sequence,
      step_index: this.stepIndex,
    });
    this.items.push(parsed);
    return this.sequence;
  }

  private observePage(page: Page): void {
    if (this.enabled.has("console"))
      page.on("console", (message) => this.console(message));
    if (this.enabled.has("page-errors"))
      page.on("pageerror", (error) => {
        this.push({
          kind: "page-error",
          message: this.secrets.redact(error.message),
          stack:
            error.stack === undefined ? null : this.secrets.redact(error.stack),
        });
      });
    if (this.enabled.has("websockets"))
      page.on("websocket", (socket) => this.webSocket(socket));
    if (this.enabled.has("frames")) {
      page.on("frameattached", (frame) => this.frame("frame-attached", frame));
      page.on("framedetached", (frame) => this.frame("frame-detached", frame));
      page.on("framenavigated", (frame) =>
        this.frame("frame-navigated", frame),
      );
    }
    if (this.enabled.has("workers"))
      page.on("worker", (worker) => this.worker(worker));
    // Any selected family needs descendant discovery in shared contexts.
    // Popup lifecycle records remain gated on their own selector below.
    if (this.enabled.size > 0) page.on("popup", (popup) => this.popup(popup));
    if (this.enabled.has("downloads"))
      page.on("download", (download) => this.download(download));
  }

  private safeUrl(value: string) {
    return this.secrets.sanitizeUrl(value);
  }

  private console(message: ConsoleMessage): void {
    const location = message.location();
    this.push({
      kind: "console",
      level: this.secrets.redact(message.type()),
      text: this.secrets.redact(message.text()),
      url: location.url === "" ? null : this.safeUrl(location.url),
    });
  }

  private webSocket(socket: WebSocket): void {
    const url = this.safeUrl(socket.url());
    this.push({ kind: "websocket-opened", url });
    socket.on("framesent", ({ payload }) =>
      this.webSocketFrame("websocket-frame-sent", url, payload),
    );
    socket.on("framereceived", ({ payload }) =>
      this.webSocketFrame("websocket-frame-received", url, payload),
    );
    socket.on("close", () => this.push({ kind: "websocket-closed", url }));
  }

  private webSocketFrame(
    kind: "websocket-frame-sent" | "websocket-frame-received",
    url: SanitizedBrowserUrl,
    payload: string | Buffer,
  ): void {
    const bytes = Buffer.byteLength(payload);
    const isText = typeof payload === "string";
    if (!isText) {
      this.push({
        kind,
        url,
        payload_type: "binary",
        payload_bytes: bytes,
        payload_text: null,
        truncated: false,
      });
      return;
    }
    const text = this.secrets.redact(payload);
    this.push({
      kind,
      url,
      payload_type: "text",
      payload_bytes: bytes,
      payload_text: text,
      truncated: false,
    });
  }

  private frame(
    kind: "frame-attached" | "frame-detached" | "frame-navigated",
    frame: Frame,
  ): void {
    this.push({
      kind,
      url: frame.url() === "" ? null : this.safeUrl(frame.url()),
      name: frame.name() === "" ? null : this.secrets.redact(frame.name()),
    });
  }

  private worker(worker: Worker): void {
    const details = {
      url: this.safeUrl(worker.url()),
      name: null,
    };
    this.push({ kind: "worker-created", ...details });
    worker.on("close", () => this.push({ kind: "worker-closed", ...details }));
  }

  private popup(page: Page): void {
    if (this.pages.has(page)) return;
    this.pages.add(page);
    for (const family of [
      "frames",
      "workers",
      "websockets",
      "downloads",
    ] as const)
      if (this.enabled.has(family)) this.incompleteFamilies.add(family);
    const opened = {
      url: page.url() === "" ? null : this.safeUrl(page.url()),
      name: null,
    };
    if (this.enabled.has("popups")) {
      this.push({ kind: "popup-opened", ...opened });
      page.on("close", () =>
        this.push({
          kind: "popup-closed",
          url: page.url() === "" ? null : this.safeUrl(page.url()),
          name: null,
        }),
      );
    }
    this.observePage(page);
  }

  private download(download: Download): void {
    this.push({
      kind: "download-cancelled",
      suggested_filename: this.secrets.redact(download.suggestedFilename()),
      url: this.safeUrl(download.url()),
    });
    void download.cancel().catch((cause: unknown) => {
      // best-effort cleanup: download cancellation must not reject unhandled.
      void cause;
    });
  }
}
