import { Worker } from "node:worker_threads";
import { z } from "zod";

import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import { analysisStringSchema } from "../domain/hopperValues.js";
import { HopperRemoteError } from "../domain/hopperErrors.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import { analysisSearchInput } from "../contracts/analysisSearchContract.js";
import type { HopperClient } from "./HopperClient.js";

const MATCHING_DEADLINE_MS = 5_000;
const inputSchema = z.strictObject({
  ...analysisSearchInput,
  mode: z.literal("regex"),
  document: z.string().nullish(),
  case_sensitive: z
    .boolean()
    .nullish()
    .transform((value) => value ?? false),
});
const replySchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("matched"),
    indices: z.array(z.number().int().nonnegative()),
  }),
  z.strictObject({ status: z.literal("invalid_pattern"), reason: z.string() }),
]);

/** Match collected native facts off Hopper's API thread, with cancellable lifetime. */
export class HopperRegexSearch {
  readonly #active = new Map<
    AbortController,
    Promise<Result<JsonValue, AnalysisError>>
  >();

  constructor(private readonly client: HopperClient) {}

  execute(
    operation: "search_strings" | "search_procedures",
    parameters: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
  ): Promise<Result<JsonValue, AnalysisError>> {
    const controller = new AbortController();
    const signal =
      options?.signal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, options.signal]);
    const pending = this.#execute(operation, parameters, {
      ...options,
      signal,
    });
    this.#active.set(controller, pending);
    void pending.then(
      () => this.#active.delete(controller),
      () => this.#active.delete(controller),
    );
    return pending;
  }

  /** Abort matching workers before their provider session closes. */
  async close(): Promise<void> {
    for (const controller of this.#active.keys()) controller.abort();
    await Promise.all(this.#active.values());
  }

  async #execute(
    operation: "search_strings" | "search_procedures",
    parameters: Readonly<Record<string, JsonValue>>,
    options: ExecutionOptions,
  ): Promise<Result<JsonValue, AnalysisError>> {
    const input = inputSchema.safeParse(parameters);
    if (!input.success)
      return err(
        new HopperRemoteError(
          -32000,
          `Invalid search arguments: ${input.error.message}`,
          { diagnosticType: "invalid_request", operation },
        ),
      );
    const inventoryOptions: ExecutionOptions = {
      ...options,
      ...(options.progress === undefined
        ? {}
        : {
            progress: {
              report: (update) =>
                options.progress?.report({
                  ...update,
                  completed:
                    update.total === null || update.total === 0
                      ? 0
                      : Math.min(0.5, update.completed / update.total / 2),
                  total: 1,
                }) ?? Promise.resolve(),
            },
          }),
    };
    const inventory = await this.client.callTool(
      operation === "search_strings" ? "list_strings" : "list_procedures",
      input.data.document == null ? {} : { document: input.data.document },
      inventoryOptions,
    );
    if (!inventory.ok) return inventory;
    const parsed = z.array(analysisStringSchema).safeParse(inventory.value);
    if (!parsed.success)
      return err(
        new AnalysisOutputError(
          operation,
          "Hopper search inventory is malformed",
        ),
      );
    if (options.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    await options.progress
      ?.report({
        phase: "hopper_regex",
        completed: 0.5,
        total: 1,
        message: "Matching inventory in cancellable regex worker",
      })
      .catch(() => undefined);
    if (options.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    let worker: Worker;
    try {
      worker = new Worker(new URL("./HopperRegexWorker.js", import.meta.url), {
        workerData: {
          pattern: input.data.pattern,
          caseSensitive: input.data.case_sensitive,
          values: parsed.data.map((item) => item.value),
        },
      });
    } catch (cause: unknown) {
      return err(
        new AnalysisOutputError(
          operation,
          `Cannot start regex worker: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        ),
      );
    }
    try {
      return await new Promise<Result<JsonValue, AnalysisError>>((resolve) => {
        const finish = (result: Result<JsonValue, AnalysisError>): void => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          resolve(result);
        };
        const onAbort = (): void =>
          finish(err(new AnalysisCancelledError(operation)));
        const timer = setTimeout(
          () =>
            finish(
              err(
                new AnalysisResourceConstraintError(
                  operation,
                  "cpu",
                  "Regex matching exceeded its supervised deadline; the Hopper API thread remains available.",
                  { matching_deadline_ms: MATCHING_DEADLINE_MS },
                  {
                    remediationAction:
                      "Simplify the ECMAScript Unicode regex or use literal mode, then retry in the same session.",
                  },
                ),
              ),
            ),
          MATCHING_DEADLINE_MS,
        );
        options.signal?.addEventListener("abort", onAbort, { once: true });
        if (options.signal?.aborted) onAbort();
        worker.once("message", (message: unknown) => {
          const reply = replySchema.safeParse(message);
          if (!reply.success)
            return finish(
              err(
                new AnalysisOutputError(
                  operation,
                  "Regex worker reply is malformed",
                ),
              ),
            );
          if (reply.data.status === "invalid_pattern")
            return finish(
              err(
                new HopperRemoteError(
                  -32000,
                  `Invalid regex pattern: ${reply.data.reason}`,
                  { diagnosticType: "invalid_request", operation },
                ),
              ),
            );
          const indices = reply.data.indices;
          if (
            indices.some(
              (index, position) =>
                index >= parsed.data.length ||
                (position > 0 && index <= (indices[position - 1] ?? -1)),
            )
          )
            return finish(
              err(
                new AnalysisOutputError(
                  operation,
                  "Regex worker returned invalid inventory indices",
                ),
              ),
            );
          const selected = new Set(indices);
          finish(ok(parsed.data.filter((_, index) => selected.has(index))));
        });
        worker.once("error", (cause: Error) =>
          finish(
            err(
              new AnalysisOutputError(
                operation,
                `Regex worker failed: ${cause.message}`,
                { cause },
              ),
            ),
          ),
        );
        worker.once("exit", (code) =>
          finish(
            err(
              new AnalysisOutputError(
                operation,
                `Regex worker exited without a result (${code})`,
              ),
            ),
          ),
        );
      });
    } finally {
      await worker.terminate();
    }
  }
}
