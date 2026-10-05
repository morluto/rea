import type {
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
  readonly enabled: ReadonlySet<EventName>;
  readonly secrets: BrowserScenarioSecrets;
  readonly allowedOrigins: readonly string[];
}

/** Arrival-ordered Playwright event capture with current-step attribution. */
export class PlaywrightScenarioEvents {
  private readonly items: BrowserScenarioEvent[] = [];
  private stepIndex = 0;
  private sequence = 0;
  private readonly enabled: ReadonlySet<EventName>;
  private readonly secrets: BrowserScenarioSecrets;
  private readonly allowedOrigins: ReadonlySet<string>;

  constructor(options: EventCaptureOptions) {
    this.enabled = options.enabled;
    this.secrets = options.secrets;
    this.allowedOrigins = new Set(options.allowedOrigins);
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
      page.on("console", (message) => {
        if (this.pageInScope(page)) this.console(message);
      });
    if (this.enabled.has("page-errors"))
      page.on("pageerror", (error) => {
        if (this.pageInScope(page))
          this.push({
            kind: "page-error",
            message: this.secrets.redact(error.message),
            stack:
              error.stack === undefined
                ? null
                : this.secrets.redact(error.stack),
          });
      });
    if (this.enabled.has("network")) {
      page.on("request", (request) => {
        if (this.pageInScope(page)) this.request("request", request);
      });
      page.on("response", (response) => {
        if (this.pageInScope(page)) this.response(response);
      });
      page.on("requestfailed", (request) => {
        if (this.pageInScope(page)) this.request("request-failed", request);
      });
    }
    if (this.enabled.has("websockets"))
      page.on("websocket", (socket) => {
        if (this.pageInScope(page)) this.webSocket(page, socket);
      });
    if (this.enabled.has("frames")) {
      page.on("frameattached", (frame) => {
        if (this.pageInScope(page)) this.frame("frame-attached", frame);
      });
      page.on("framedetached", (frame) => {
        if (this.pageInScope(page)) this.frame("frame-detached", frame);
      });
      page.on("framenavigated", (frame) => {
        if (this.pageInScope(page)) this.frame("frame-navigated", frame);
      });
    }
    if (this.enabled.has("workers"))
      page.on("worker", (worker) => {
        if (this.pageInScope(page)) this.worker(page, worker);
      });
    if (this.enabled.has("popups"))
      page.on("popup", (popup) => {
        if (this.pageInScope(page)) this.popup(popup);
      });
    if (this.enabled.has("downloads"))
      page.on("download", (download) => {
        if (this.pageInScope(page)) this.download(download);
      });
  }

  private pageInScope(page: Page): boolean {
    try {
      return this.allowedOrigins.has(new URL(page.url()).origin);
    } catch {
      return false;
    }
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

  private webSocket(page: Page, socket: WebSocket): void {
    const url = this.safeUrl(socket.url());
    this.push({ kind: "websocket-opened", url });
    socket.on("framesent", ({ payload }) => {
      if (this.pageInScope(page))
        this.webSocketFrame("websocket-frame-sent", url, payload);
    });
    socket.on("framereceived", ({ payload }) => {
      if (this.pageInScope(page))
        this.webSocketFrame("websocket-frame-received", url, payload);
    });
    socket.on("close", () => {
      if (this.pageInScope(page)) this.push({ kind: "websocket-closed", url });
    });
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

  private worker(page: Page, worker: Worker): void {
    const details = {
      url: this.safeUrl(worker.url()),
      name: null,
    };
    this.push({ kind: "worker-created", ...details });
    worker.on("close", () => {
      if (this.pageInScope(page))
        this.push({ kind: "worker-closed", ...details });
    });
  }

  private popup(page: Page): void {
    if (!this.pageInScope(page)) {
      void page.close().catch(() => undefined);
      return;
    }
    const opened = {
      url: page.url() === "" ? null : this.safeUrl(page.url()),
      name: null,
    };
    this.push({ kind: "popup-opened", ...opened });
    page.on("close", () =>
      this.pageInScope(page)
        ? this.push({
            kind: "popup-closed",
            url: page.url() === "" ? null : this.safeUrl(page.url()),
            name: null,
          })
        : undefined,
    );
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
