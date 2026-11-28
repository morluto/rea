import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestId } from "@modelcontextprotocol/server";
import type { z } from "zod";

import type { AnalysisOperationPort } from "../ports/AnalysisProvider.js";
import type { BinarySessionPort } from "../application/binary/BinarySessionPort.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  cancelledBy,
  type CallerAbort,
  type OwnerCancellation,
} from "../domain/analysisErrorCore.js";
import { err, ok, type Result } from "../domain/result.js";

import { callerAnalysisParameters } from "../application/AnalysisInput.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { ProjectedErrorEncoding } from "./ToolResultDelivery.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";

const currentRequest = new AsyncLocalStorage<McpToolRequest>();

/** One SDK request owns validation, cancellation and its publication boundary. */
export class McpToolRequest {
  readonly cancellation = new AbortController();
  projectedErrorEncoding?: ProjectedErrorEncoding | undefined;
  readonly #parameterSelections = new WeakMap<
    object,
    {
      readonly tool: string;
      readonly select: ReturnType<typeof callerAnalysisParameters>;
    }
  >();
  validation?: {
    readonly issues: readonly z.core.$ZodIssue[];
    readonly input: unknown;
  };
  /**
   * The `detail` this request's tool call spelled before schema defaults,
   * captured at canonical validation. An omitted `detail` leaves delivery to
   * the agent result budget; without a capture nothing is known about it.
   * `pageable` records whether the session advertises the view tool that
   * pages a summary, without which the budget never replaces Evidence.
   * `record` is the session's Evidence writer, which retains a failure's
   * over-budget partial observation before its summary replaces it.
   */
  deliverySelection?: {
    readonly detail: unknown;
    readonly pageable: boolean;
    readonly record?: EvidenceWriter["recordEvidence"] | undefined;
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

  /** Capture only selected names at canonical validation, not the raw input tree. */
  captureCallerParameters(tool: string, input: unknown, parsed: unknown): void {
    if (parsed !== null && typeof parsed === "object")
      this.#parameterSelections.set(parsed, {
        tool,
        select: callerAnalysisParameters(input),
      });
  }

  /** The exact parsed object identifies its validation, including nested tool calls. */
  callerParameters(
    tool: string,
    parsed: unknown,
    parameters: Readonly<Record<string, JsonValue>>,
  ): Readonly<Record<string, JsonValue>> {
    const selection =
      parsed !== null && typeof parsed === "object"
        ? this.#parameterSelections.get(parsed)
        : undefined;
    // Dropping properties from a validated JSON object preserves its value type.
    return (
      selection?.tool === tool ? selection.select(parameters) : parameters
    ) as Readonly<Record<string, JsonValue>>;
  }

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
  cancel(reason: CallerAbort | OwnerCancellation): void {
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
          return err(cancelledBy(operationName, cancellation));
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
