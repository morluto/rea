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

  constructor(options: EventCaptureOptions) {
    this.enabled = options.enabled;
    this.secrets = options.secrets;
    this.ownsContext = options.ownsContext === true;
    this.pages.add(options.page);
    if (this.ownsContext && this.enabled.size > 0)
      (options.context ?? options.page.context()).on("page", (page) =>
        this.popup(page),
      );
    if (this.enabled.has("network")) {
      const context = options.context ?? options.page.context();
      const inScope = (request: Request): boolean => {
        if (this.ownsContext) return true;
        try {
          return this.pages.has(request.frame().page());
        } catch {
          // Initial popup navigations can lack a frame. Never guess ownership
          // from a URL in a shared context; connect captures are attach-limited.
          return false;
        }
      };
      context.on("request", (request) => {
        if (inScope(request)) this.request("request", request);
      });
      context.on("response", (response) => {
        if (inScope(response.request())) this.response(response);
      });
      context.on("requestfailed", (request) => {
        if (inScope(request)) this.request("request-failed", request);
      });
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

  /** Report selected popup event families with unrecoverable pre-discovery gaps. */
  limitations(): readonly string[] {
    const popupGaps = [...this.incompleteFamilies].map(
      (family) =>
        `Popup ${family} events before Page discovery are unavailable; later events are retained.`,
    );
    return this.enabled.has("network") && !this.ownsContext
      ? [
          "Shared-context network capture excludes requests without a known root or descendant Page frame.",
          ...popupGaps,
        ]
      : popupGaps;
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

  private push(event: UnindexedEvent): void {
    this.sequence += 1;
    const parsed = browserScenarioEventSchema.parse({
      ...event,
      sequence: this.sequence,
      step_index: this.stepIndex,
    });
    this.items.push(parsed);
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

  private request(kind: "request" | "request-failed", request: Request): void {
    const observation = {
      method: this.secrets.redact(request.method()),
      url: this.safeUrl(request.url()),
      resource_type: this.secrets.redact(request.resourceType()),
      header_names: Object.keys(request.headers())
        .map((name) => this.secrets.redact(name))
        .sort(),
    };
    if (kind === "request-failed") {
      this.push({
        ...observation,
        kind,
        status: null,
        failure: this.secrets.redact(request.failure()?.errorText ?? "unknown"),
      });
      return;
    }
    this.push({
      ...observation,
      kind,
      status: null,
      failure: null,
    });
  }

  private response(response: Response): void {
    const request = response.request();
    this.push({
      kind: "response",
      method: this.secrets.redact(request.method()),
      url: this.safeUrl(response.url()),
      resource_type: this.secrets.redact(request.resourceType()),
      status: response.status(),
      header_names: Object.keys(response.headers())
        .map((name) => this.secrets.redact(name))
        .sort(),
      failure: null,
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
    void download.cancel().catch(() => undefined);
  }
}
