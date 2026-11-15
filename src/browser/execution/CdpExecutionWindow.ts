import { cancelledBy, carriedReason } from "../../domain/analysisErrorCore.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { WebExecution } from "../../domain/webExecution.js";
import type { CdpReceivedEvent } from "../CdpConnection.js";
import type { CdpRuntimeSession } from "./CdpRuntimeSession.js";
import { BrowserObservationError } from "../../domain/browserObservationError.js";
import type {
  CdpRootNavigation,
  CdpTargetDocument,
} from "../CdpTargetDocument.js";
import { cdpFrameEvent } from "../protocol/CdpEvents.js";

type EndReason = WebExecution["window"]["end_reason"];
/** One finite document-scoped window, with an actual armed point and event-driven termination. */
export class CdpExecutionWindow {
  armedAt: string | undefined;
  endedAt: string | undefined;
  reason: EndReason | undefined;
  #timer: NodeJS.Timeout | undefined;
  #resolve: ((reason: EndReason) => void) | undefined;
  #reject: ((error: AnalysisError) => void) | undefined;
  #failure: AnalysisError | undefined;
  #removeAbort: (() => void) | undefined;
  readonly #removeNavigation: () => void;
  constructor(
    readonly session: Pick<CdpRuntimeSession, "operation" | "options"> & {
      readonly target: { readonly frame_id: string };
      readonly document: Pick<CdpTargetDocument, "onNavigation">;
    },
  ) {
    this.#removeNavigation = session.document.onNavigation((navigation) =>
      this.#rootNavigation(navigation),
    );
  }

  /**
   * Collection ends when the target session's document owner reports another
   * document, never follows source URLs into another context. A same-document
   * navigation keeps the window; unreadable frame identity fails it.
   */
  #rootNavigation(navigation: CdpRootNavigation): void {
    if (!this.active) return;
    if (
      navigation.kind === "unidentified" ||
      navigation.kind === "unreadable_child"
    ) {
      this.fail(
        new BrowserObservationError(this.session.operation, "protocol_error"),
      );
      return;
    }
    if (navigation.kind === "navigated" && navigation.comparison !== "same")
      this.end("document_changed");
  }

  /** Lifecycle facts other than navigation that end the document's window. */
  ingest(event: CdpReceivedEvent): void {
    const method = event.registered?.method;
    if (method === "Target.detachedFromTarget") {
      this.end("session_detached");
      return;
    }
    if (method === "Inspector.targetCrashed") {
      this.end("target_terminated");
      return;
    }
    if (!this.active) return;
    if (method === "Runtime.executionContextsCleared")
      this.end("document_changed");
    const frame = cdpFrameEvent(event)?.facts;
    if (
      frame?.kind === "detached" &&
      frame.frameId === this.session.target.frame_id
    )
      this.end("document_changed");
  }
  /** Metadata before arming is inventory; request events outside the window are excluded. */
  get active(): boolean {
    return (
      this.armedAt !== undefined &&
      this.reason === undefined &&
      this.endedAt === undefined
    );
  }

  /** The timer starts at arming, before progress delivery can delay the external action. */
  start(duration: number): Promise<EndReason> {
    if (this.#failure !== undefined) return Promise.reject(this.#failure);
    if (this.reason !== undefined) return Promise.resolve(this.reason);
    this.armedAt = new Date().toISOString();
    return new Promise((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
      this.#timer = setTimeout(() => this.end("window_elapsed"), duration);
      const signal = this.session.options.signal;
      const abort = (): void => {
        this.fail(
          cancelledBy(this.session.operation, carriedReason(signal?.reason)),
        );
      };
      this.#removeAbort = () => signal?.removeEventListener("abort", abort);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  /** A producer lifecycle fact ends the window; instrumentation cleanup still requires confirmation. */
  end(reason: EndReason): void {
    if (this.reason !== undefined || this.#failure !== undefined) return;
    this.reason = reason;
    this.endedAt = new Date().toISOString();
    this.dispose();
    this.#resolve?.(reason);
  }
  /** Invalid producer data ends instrumentation immediately with its original failure. */
  fail(error: AnalysisError): void {
    if (this.reason !== undefined || this.#failure !== undefined) return;
    this.#failure = error;
    this.endedAt = new Date().toISOString();
    this.dispose();
    this.#reject?.(error);
  }
  /** Surface a failure recorded before local arming without emitting misleading progress. */
  check(): void {
    if (this.#failure !== undefined) throw this.#failure;
  }
  /** Release local timer and abort listener on every setup/failure path. */
  dispose(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#removeAbort?.();
    this.#removeNavigation();
  }
}
