import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestId } from "@modelcontextprotocol/server";
import type { z } from "zod";

import type { AnalysisOperationPort } from "../application/AnalysisProvider.js";
import type { BinarySessionPort } from "../application/binary/BinarySessionPort.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { err, ok, type Result } from "../domain/result.js";

const currentRequest = new AsyncLocalStorage<McpToolRequest>();

/** One SDK request owns validation, cancellation and its publication boundary. */
export class McpToolRequest {
  readonly cancellation = new AbortController();
  validation?: {
    readonly issues: readonly z.core.$ZodIssue[];
    readonly input: unknown;
  };
  #handlerStarted = false;
  #finishHandler: () => void = () => undefined;
  readonly #handlerDone = new Promise<void>((resolve) => {
    this.#finishHandler = resolve;
  });
  #publicationStarted = false;
  #finishPublication: () => void = () => undefined;
  readonly #publicationDone = new Promise<void>((resolve) => {
    this.#finishPublication = resolve;
  });
  readonly #admissions = new Map<
    BinarySessionPort,
    Promise<Result<AnalysisOperationPort, AnalysisError>>
  >();

  constructor(
    readonly id: RequestId,
    readonly tool: string,
  ) {}

  beginHandler(): void {
    this.#handlerStarted = true;
  }

  finishHandler(): void {
    this.#finishHandler();
  }

  beginPublication(): void {
    this.#publicationStarted = true;
  }

  finishPublication(): void {
    this.#finishPublication();
  }

  /** A suppressed SDK reply releases admission after the handler's cleanup. */
  cancel(reason?: unknown): void {
    this.cancellation.abort(reason);
    if (!this.#publicationStarted) this.#finishPublication();
  }

  get holdsAdmission(): boolean {
    return this.#admissions.size > 0;
  }

  /**
   * Return the application's result to the SDK while retaining its original
   * session admission through publication. Later work on this same request
   * reuses that binding, including when reset has already queued behind it.
   */
  admit<Value>(
    session: BinarySessionPort,
    operationName: string,
    signal: AbortSignal | undefined,
    operation: (analysis: AnalysisOperationPort) => Promise<Value>,
  ): Promise<Result<Value, AnalysisError>> {
    const existing = this.#admissions.get(session);
    if (existing !== undefined)
      return existing.then(async (binding) => {
        if (!binding.ok) return binding;
        const cancellation =
          signal?.aborted === true ? signal : this.cancellation.signal;
        if (cancellation.aborted)
          return err(
            new AnalysisCancelledError(operationName, {
              cause: cancellation.reason,
            }),
          );
        return ok(await operation(binding.value));
      });

    let resolveBinding!: (
      value: Result<AnalysisOperationPort, AnalysisError>,
    ) => void;
    let rejectBinding!: (cause: unknown) => void;
    const binding = new Promise<Result<AnalysisOperationPort, AnalysisError>>(
      (resolve, reject) => {
        resolveBinding = resolve;
        rejectBinding = reject;
      },
    );
    // The first operation does not consume binding; a thrown pre-admission
    // failure still has an owner even when there is no second operation.
    void binding.catch(() => undefined);
    this.#admissions.set(session, binding);
    let resolveResult!: (value: Result<Value, AnalysisError>) => void;
    let rejectResult!: (cause: unknown) => void;
    const result = new Promise<Result<Value, AnalysisError>>(
      (resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
      },
    );
    const failed = (cause: unknown): void => {
      this.#admissions.delete(session);
      rejectBinding(cause);
      rejectResult(cause);
    };
    let held: Promise<Result<Value, AnalysisError>>;
    try {
      held = session.withAdmittedAnalysis(
        operationName,
        signal === undefined
          ? this.cancellation.signal
          : AbortSignal.any([signal, this.cancellation.signal]),
        async (analysis) => {
          resolveBinding(ok(analysis));
          try {
            const value = await operation(analysis);
            resolveResult(ok(value));
            await this.#settlePublication();
            return value;
          } catch (cause: unknown) {
            rejectResult(cause);
            await this.#settlePublication();
            throw cause;
          }
        },
      );
    } catch (cause: unknown) {
      failed(cause);
      return result;
    }
    void held.then((completed) => {
      this.#admissions.delete(session);
      if (!completed.ok) {
        resolveBinding(completed);
        resolveResult(completed);
      }
    }, failed);
    return result;
  }

  async #settlePublication(): Promise<void> {
    if (this.#handlerStarted) await this.#handlerDone;
    await this.#publicationDone;
  }
}

export const currentMcpToolRequest = (): McpToolRequest | undefined =>
  currentRequest.getStore();

export const runMcpToolRequest = <Value>(
  request: McpToolRequest,
  operation: () => Value,
): Value => currentRequest.run(request, operation);
