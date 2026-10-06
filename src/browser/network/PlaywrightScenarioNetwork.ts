import type {
  BrowserNetworkBody,
  BrowserNetworkContentSelection,
} from "../../domain/browserNetworkEvidence.js";
import type { BrowserScenarioEvent } from "../../domain/browserScenarioCapture.js";
import type { BrowserScenarioSecrets } from "../BrowserScenarioSecrets.js";
import {
  captureNetworkBody,
  captureNetworkHeaders,
  type NetworkHeadersSource,
  type NetworkReadOptions,
} from "./PlaywrightNetworkContent.js";

/** Request object identity is the association key, never URL or receipt adjacency. */
export interface ScenarioNetworkRequest extends NetworkHeadersSource {
  method(): string;
  url(): string;
  resourceType(): string;
  postDataBuffer(): Buffer | null;
  redirectedFrom(): ScenarioNetworkRequest | null;
  failure(): { errorText: string } | null;
}

/** A response's body becomes eligible for reading only after requestfinished. */
export interface ScenarioNetworkResponse extends NetworkHeadersSource {
  request(): ScenarioNetworkRequest;
  url(): string;
  status(): number;
  body(): Promise<Buffer>;
}

type UnindexedNetworkEvent = BrowserScenarioEvent extends infer Event
  ? Event extends BrowserScenarioEvent
    ? Event["kind"] extends
        | "request"
        | "response"
        | "request-finished"
        | "request-failed"
        | "request-unfinished"
        | "network-content"
      ? Omit<Event, "sequence" | "step_index">
      : never
    : never
  : never;

interface Transaction {
  readonly id: string;
  readonly redirectedFrom: string | null;
  response?: {
    readonly source: ScenarioNetworkResponse;
    readonly sequence: number;
  };
  terminal?: "finished" | "failed";
  responseScheduled: boolean;
}

interface NetworkCaptureOptions {
  readonly selection: BrowserNetworkContentSelection;
  readonly secrets: BrowserScenarioSecrets;
  readonly emit: (event: UnindexedNetworkEvent) => number;
  readonly signal?: AbortSignal;
  /** Production uses 5s; a fixture can supply its own bounded-read clock. */
  readonly readTimeoutMs?: number;
}

/** Captures correlated network phases and drains selected content before browser cleanup. */
export class PlaywrightScenarioNetwork {
  private readonly transactions = new Map<
    ScenarioNetworkRequest,
    Transaction
  >();
  private readonly pending: Promise<void>[] = [];
  private readonly gaps = new Set<string>();
  private accepting = true;
  private readonly readOptions: NetworkReadOptions;

  constructor(private readonly options: NetworkCaptureOptions) {
    this.readOptions = {
      timeoutMs: options.readTimeoutMs ?? 5_000,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
  }

  /** Observe a request start, retaining the producer's redirect relationship when known. */
  request(request: ScenarioNetworkRequest): void {
    if (!this.accepting) return;
    const transaction = this.transaction(request);
    const sequence = this.options.emit({
      ...this.metadata(request, transaction),
      kind: "request",
      status: null,
      failure: null,
    });
    if (
      this.options.selection.request_body ||
      this.options.selection.header_values
    )
      this.collect(
        transaction,
        sequence,
        "request",
        request,
        this.options.selection.request_body
          ? captureNetworkBody(
              async () => request.postDataBuffer(),
              "request",
              request,
              this.options.secrets,
              this.readOptions,
            )
          : Promise.resolve({ state: "not_requested" }),
      );
  }

  /** Observe response metadata without starting a potentially unfinished body read. */
  response(response: ScenarioNetworkResponse): void {
    if (!this.accepting) return;
    const request = response.request();
    const transaction = this.transaction(request);
    const sequence = this.options.emit({
      ...this.metadata(request, transaction),
      kind: "response",
      url: this.options.secrets.sanitizeUrl(response.url()),
      status: response.status(),
      header_names: this.headerNames(response),
      failure: null,
    });
    transaction.response = { source: response, sequence };
  }

  /** Record completion and read the original completed response, never a later refetch. */
  finished(request: ScenarioNetworkRequest): void {
    if (!this.accepting) return;
    const transaction = this.transaction(request);
    transaction.terminal = "finished";
    this.options.emit({
      ...this.metadata(request, transaction),
      kind: "request-finished",
      status: null,
      failure: null,
    });
    this.responseContent(transaction);
  }

  /** Preserve request failure separately from missing or unreadable response content. */
  failed(request: ScenarioNetworkRequest): void {
    if (!this.accepting) return;
    const transaction = this.transaction(request);
    transaction.terminal = "failed";
    const message = this.options.secrets.redact(
      request.failure()?.errorText || "Unknown request failure",
    );
    this.options.emit({
      ...this.metadata(request, transaction),
      kind: "request-failed",
      status: null,
      failure: message,
    });
    this.responseContent(transaction, {
      state: "unavailable",
      reason: "request-failed",
      message,
    });
  }

  /** Stop observing, mark unfinished transactions, and settle bounded content reads. */
  async finish(): Promise<void> {
    if (!this.accepting) {
      await Promise.all(this.pending);
      return;
    }
    this.accepting = false;
    for (const [request, transaction] of this.transactions) {
      if (transaction.terminal === undefined) {
        this.gaps.add(
          "Some network requests had not completed when capture ended; later activity is unknown.",
        );
        this.options.emit({
          ...this.metadata(request, transaction),
          kind: "request-unfinished",
          status: null,
          failure: null,
          reason:
            this.options.signal?.aborted === true
              ? "cancelled"
              : "capture-ended",
        });
        this.responseContent(transaction, {
          state: "unavailable",
          reason:
            this.options.signal?.aborted === true
              ? "cancelled"
              : "response-unfinished",
          message:
            "The response had not finished at the capture cutoff; no body read or refetch was attempted.",
        });
      }
    }
    await Promise.all(this.pending);
  }

  /** Missing selected content contributes to aggregate completeness. */
  limitations(): readonly string[] {
    return [...this.gaps];
  }

  private transaction(request: ScenarioNetworkRequest): Transaction {
    const known = this.transactions.get(request);
    if (known !== undefined) return known;
    const predecessor = request.redirectedFrom();
    const transaction: Transaction = {
      id: `request-${this.transactions.size + 1}`,
      redirectedFrom:
        predecessor === null
          ? null
          : (this.transactions.get(predecessor)?.id ?? null),
      responseScheduled: false,
    };
    this.transactions.set(request, transaction);
    return transaction;
  }

  private headerNames(source: NetworkHeadersSource): string[] {
    return Object.keys(source.headers())
      .map((name) => this.options.secrets.redact(name))
      .sort();
  }

  private metadata(request: ScenarioNetworkRequest, transaction: Transaction) {
    return {
      transaction_id: transaction.id,
      redirected_from_transaction_id: transaction.redirectedFrom,
      method: this.options.secrets.redact(request.method()),
      url: this.options.secrets.sanitizeUrl(request.url()),
      resource_type: this.options.secrets.redact(request.resourceType()),
      header_names: this.headerNames(request),
    };
  }

  private responseContent(
    transaction: Transaction,
    unavailable?: BrowserNetworkBody,
  ): void {
    const response = transaction.response;
    if (
      response === undefined ||
      transaction.responseScheduled ||
      (!this.options.selection.response_body &&
        !this.options.selection.header_values)
    )
      return;
    transaction.responseScheduled = true;
    this.collect(
      transaction,
      response.sequence,
      "response",
      response.source,
      this.options.selection.response_body
        ? unavailable === undefined
          ? captureNetworkBody(
              () => response.source.body(),
              "response",
              response.source,
              this.options.secrets,
              this.readOptions,
            )
          : Promise.resolve(unavailable)
        : Promise.resolve({ state: "not_requested" }),
    );
  }

  private collect(
    transaction: Transaction,
    sequence: number,
    phase: "request" | "response",
    source: NetworkHeadersSource,
    body: Promise<BrowserNetworkBody>,
  ): void {
    const headers = this.options.selection.header_values
      ? captureNetworkHeaders(source, this.options.secrets, this.readOptions)
      : Promise.resolve({ state: "not_requested" } as const);
    this.pending.push(
      Promise.all([headers, body]).then(([retainedHeaders, retainedBody]) => {
        if (
          retainedHeaders.state === "unavailable" ||
          retainedBody.state === "unavailable" ||
          retainedBody.state === "not_exposed"
        )
          this.gaps.add(
            "Some selected network content was unavailable; per-transaction content states retain the reason.",
          );
        this.options.emit({
          kind: "network-content",
          transaction_id: transaction.id,
          source_event_sequence: sequence,
          phase,
          headers: retainedHeaders,
          body: retainedBody,
        });
      }),
    );
  }
}
