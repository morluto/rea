import { z } from "zod";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisProtocolError,
} from "../domain/analysisErrorCore.js";
import { nativeFunctionAnnotationsInputSchema } from "../domain/native/nativeFunctionAnnotations.js";
import {
  nativeDecompilationEditsSchema,
  nativeDecompilationFlavorSchema,
  renameNativeVariablesInputSchema,
  setNativeDecompilationFlavorInputSchema,
  setNativeFunctionPrototypesInputSchema,
  setNativeVariableTypesInputSchema,
  type NativeDecompilationEdits,
} from "../domain/native/nativeDecompilationEdits.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import type { AngrOperationRunner } from "./AngrOperationRunner.js";
import {
  angrAddressSchema,
  editBatchSchema,
  flavorSchema,
  type AngrEditBatch,
  type AngrFunction,
} from "./AngrProtocolValues.js";

const SESSION_EFFECTS = {
  scope: "session-analysis-database",
  source_bytes_modified: false,
  persists_after_close: false,
} as const;

const setAddressNameInput = z.object({
  address: angrAddressSchema,
  name: z.string(),
});
const setAddressesNamesInput = z.object({
  names: z.record(z.string(), z.string()),
});
const setCommentInput = z.object({
  address: angrAddressSchema,
  comment: z.string(),
});

const applied = (status: string) => status === "ok" || status === "unchanged";

/** Project angr's batch result onto REA's per-item readback contract. */
const projectBatch = (batch: AngrEditBatch): NativeDecompilationEdits =>
  nativeDecompilationEditsSchema.parse({
    dry_run: batch.dry_run,
    total: batch.total,
    succeeded: batch.succeeded,
    unchanged: batch.unchanged,
    failed: batch.failed,
    skipped: batch.skipped,
    results: batch.results.map((entry) => ({
      index: entry.index,
      status: entry.status,
      procedure:
        entry.function_address === null || entry.function_name === null
          ? null
          : { address: entry.function_address, name: entry.function_name },
      target: entry.target,
      old: entry.old,
      new: entry.new,
      error: entry.error ?? null,
      detail: jsonValueSchema.parse(entry.detail ?? {}),
    })),
    functions_affected: batch.functions_affected,
    effects: SESSION_EFFECTS,
  });

/** Session-scoped knowledge-base edits through angr's batch edit tools. */
export class AngrEditRunner {
  constructor(
    private readonly runner: AngrOperationRunner,
    private readonly options: {
      readonly flavorToolsAvailable: boolean;
      readonly onMutation: () => void;
      readonly onFlavor: (flavor: string) => void;
    },
  ) {}

  private async batch(
    tool: "rename" | "set_type" | "set_comments",
    args: Readonly<Record<string, JsonValue>>,
  ): Promise<AngrEditBatch> {
    // Caches derived from names are dropped before dispatch: the server may
    // apply the edit even when the caller cancels before the reply.
    if (args.dry_run !== true) this.options.onMutation();
    const batch = editBatchSchema.parse(
      await this.runner.callSettled(tool, args),
    );
    if (this.runner.cancelled) throw new AnalysisCancelledError(tool);
    if (batch.results.length !== batch.total)
      throw new AnalysisProtocolError(
        "angr edit batch reported a different item count than it returned.",
      );
    return batch;
  }

  /** Exactly one applied item whose readback equals the requested value. */
  private static readback(batch: AngrEditBatch, expected: string): boolean {
    const entry = batch.results[0];
    return (
      batch.total === 1 &&
      entry !== undefined &&
      applied(entry.status) &&
      entry.new === expected
    );
  }

  async setAddressName(address: string, name: string): Promise<boolean> {
    return AngrEditRunner.readback(
      await this.batch("rename", {
        items: [await this.nameItem(address, name)],
        allow_overwrite: false,
      }),
      name,
    );
  }

  /** A function entry renames the function; any other address names a global. */
  private async nameItem(
    address: string,
    newName: string,
  ): Promise<Record<string, JsonValue>> {
    const fn = await this.runner.functionEntryAt(address);
    return fn !== undefined
      ? { kind: "function", address, new_name: newName }
      : { kind: "global", address, new_name: newName };
  }

  async setAddressesNames(
    names: Readonly<Record<string, string>>,
  ): Promise<Record<string, boolean>> {
    const addresses = Object.keys(names).map((key) => {
      const parsed = angrAddressSchema.safeParse(key);
      if (!parsed.success)
        throw new AnalysisInputError("set_addresses_names", undefined, [
          {
            path: ["names", key],
            reason: "invalid_format",
            message: "angr requires hexadecimal addresses.",
          },
        ]);
      return { key, address: parsed.data };
    });
    const items: Record<string, JsonValue>[] = [];
    for (const { key, address } of addresses)
      items.push(await this.nameItem(address, names[key] ?? ""));
    const batch = await this.batch("rename", { items, allow_overwrite: false });
    const result: Record<string, boolean> = {};
    addresses.forEach(({ key }, index) => {
      const entry = batch.results[index];
      result[key] =
        entry !== undefined &&
        applied(entry.status) &&
        entry.new === names[key];
    });
    return result;
  }

  async setComment(address: string, comment: string): Promise<boolean> {
    const batch = await this.batch("set_comments", {
      items: [{ kind: "address", address, comment }],
    });
    const entry = batch.results[0];
    return (
      batch.total === 1 &&
      entry !== undefined &&
      applied(entry.status) &&
      (entry.new ?? "") === comment
    );
  }

  async annotateFunction(
    parameters: Readonly<Record<string, JsonValue>>,
  ): Promise<JsonValue> {
    const input = nativeFunctionAnnotationsInputSchema.parse(parameters);
    if (input.inline_comment !== undefined)
      throw new AnalysisInputError("annotate_native_function", undefined, [
        {
          path: ["inline_comment"],
          reason: "invalid_value",
          message:
            "angr keeps a single comment store; use comment, or set_comment at an instruction address.",
        },
      ]);
    const fn = await this.runner.resolve(
      input.procedure,
      "annotate_native_function",
    );
    const rollback: {
      name?: string;
      comment?: string;
      /** The comment call did not return, so its previous value is unknown. */
      commentUnknown?: true;
    } = {};
    let comment: string | null = null;
    let refreshed: AngrFunction;
    try {
      if (input.comment !== undefined) {
        rollback.commentUnknown = true;
        const entry = await this.applyOne("set_comments", {
          kind: "function",
          address: fn.address,
          comment: input.comment,
        });
        delete rollback.commentUnknown;
        if (entry === undefined || !applied(entry.status))
          throw new AnalysisProtocolError(
            `angr rejected the entry comment: ${entry?.error ?? "no result"}`,
          );
        if (entry.status === "ok") rollback.comment = entry.old ?? "";
        comment = entry.new ?? "";
      } else
        this.runner.limitations.push(
          "The existing entry comment was not read back because it was not changed; angr's MCP server has no comment read.",
        );
      if (input.name !== undefined) {
        // Recorded before dispatch: the server may apply the rename even when
        // the reply is lost to cancellation or fails to decode.
        rollback.name = fn.name;
        const entry = await this.applyOne("rename", {
          kind: "function",
          address: fn.address,
          new_name: input.name,
        });
        if (entry === undefined || !applied(entry.status))
          throw new AnalysisInputError("annotate_native_function", undefined, [
            {
              path: ["name"],
              reason: "invalid_value",
              message: entry?.error ?? "angr rejected the function name.",
            },
          ]);
        if (entry.status !== "ok") delete rollback.name;
      }
      refreshed = await this.runner.resolve(fn.address);
      if (input.name !== undefined && refreshed.name !== input.name)
        throw new AnalysisProtocolError(
          "angr function name readback disagrees with the requested name.",
        );
    } catch (cause: unknown) {
      await this.rollbackAnnotations(fn.address, rollback, cause);
      throw cause;
    }
    return {
      annotations: {
        address: refreshed.address,
        name: refreshed.name,
        comment,
        inline_comment: null,
      },
      dossier: await this.runner.dossier(refreshed),
      effects: SESSION_EFFECTS,
    };
  }

  /** Apply one edit item and return its entry; dry runs never reach here. */
  private async applyOne(
    tool: "rename" | "set_comments",
    item: Readonly<Record<string, JsonValue>>,
  ) {
    const batch = await this.batch(tool, {
      items: [item],
      ...(tool === "rename" ? { allow_overwrite: false } : {}),
    });
    return batch.results[0];
  }

  /** Restore the values an annotation changed before it failed; an unrestorable edit is reported. */
  private async rollbackAnnotations(
    address: string,
    rollback: { name?: string; comment?: string; commentUnknown?: true },
    cause: unknown,
  ): Promise<void> {
    const remaining: string[] = [];
    // Restores ignore the caller's cancellation: an abort must not leave the
    // knowledge base holding half of the requested annotation.
    const restore = async (
      tool: "rename" | "set_comments",
      item: Readonly<Record<string, JsonValue>>,
    ): Promise<boolean> => {
      try {
        const batch = editBatchSchema.parse(
          await this.runner.callIgnoringCancellation(tool, {
            items: [item],
            ...(tool === "rename" ? { allow_overwrite: false } : {}),
          }),
        );
        const entry = batch.results[0];
        return entry !== undefined && applied(entry.status);
      } catch {
        return false;
      }
    };
    if (
      rollback.name !== undefined &&
      !(await restore("rename", {
        kind: "function",
        address,
        new_name: rollback.name,
      }))
    )
      remaining.push(
        `function name (previously ${JSON.stringify(rollback.name)})`,
      );
    if (rollback.commentUnknown === true)
      remaining.push(
        "entry comment (the comment call did not return, so its previous value and whether it was applied are unknown)",
      );
    else if (
      rollback.comment !== undefined &&
      !(await restore("set_comments", {
        kind: "function",
        address,
        comment: rollback.comment,
      }))
    )
      remaining.push("entry comment");
    if (remaining.length > 0) {
      const summary = `The annotation failed and its applied edits could not be restored: ${remaining.join(", ")}.`;
      // Recorded on the partial Evidence as well, since a cancelled request
      // reports only the cancellation.
      this.runner.limitations.push(summary);
      throw new AnalysisProtocolError(
        `${summary} ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
  }

  async renameVariables(
    parameters: Readonly<Record<string, JsonValue>>,
  ): Promise<JsonValue> {
    const input = renameNativeVariablesInputSchema.parse(parameters);
    return projectBatch(
      await this.batch("rename", {
        items: input.items.map((item) => ({
          kind: "variable",
          function: item.procedure,
          name: item.variable,
          new_name: item.new_name,
        })),
        dry_run: input.dry_run,
        allow_overwrite: input.allow_overwrite,
        auto_decompile: true,
      }),
    );
  }

  async setVariableTypes(
    parameters: Readonly<Record<string, JsonValue>>,
  ): Promise<JsonValue> {
    const input = setNativeVariableTypesInputSchema.parse(parameters);
    return projectBatch(
      await this.batch("set_type", {
        items: input.items.map((item) =>
          "address" in item
            ? {
                kind: "global",
                address: angrAddressSchema.parse(item.address),
                type: item.type,
              }
            : {
                kind: "variable",
                function: item.procedure,
                name: item.variable,
                type: item.type,
              },
        ),
        dry_run: input.dry_run,
        redecompile: input.redecompile,
        auto_decompile: true,
      }),
    );
  }

  async setFunctionPrototypes(
    parameters: Readonly<Record<string, JsonValue>>,
  ): Promise<JsonValue> {
    const input = setNativeFunctionPrototypesInputSchema.parse(parameters);
    return projectBatch(
      await this.batch("set_type", {
        items: input.items.map((item) =>
          "signature" in item
            ? {
                kind: "function",
                function: item.procedure,
                type: item.signature,
              }
            : {
                kind: "return",
                function: item.procedure,
                type: item.return_type,
              },
        ),
        dry_run: input.dry_run,
        auto_decompile: true,
      }),
    );
  }

  private requireFlavorTools(operation: string): void {
    if (!this.options.flavorToolsAvailable)
      throw new AnalysisCapabilityUnavailableError(
        "angr",
        operation,
        "The connected angr MCP server has no decompilation-flavor tools; upgrade angr to a release with get_decompilation_flavor and set_decompilation_flavor.",
      );
  }

  async inspectFlavor(): Promise<JsonValue> {
    this.requireFlavorTools("inspect_native_decompilation_flavor");
    const result = flavorSchema.parse(
      await this.runner.call("get_decompilation_flavor", {}),
    );
    this.options.onFlavor(result.flavor);
    return nativeDecompilationFlavorSchema.parse({
      flavor: result.flavor,
      previous_flavor: null,
      available_flavors: result.available_flavors ?? [result.flavor],
      detected_language: result.detected_language ?? null,
      detection_confidence: result.detection_confidence ?? null,
    });
  }

  async setFlavor(
    parameters: Readonly<Record<string, JsonValue>>,
  ): Promise<JsonValue> {
    this.requireFlavorTools("set_native_decompilation_flavor");
    const input = setNativeDecompilationFlavorInputSchema.parse(parameters);
    let changed: z.infer<typeof flavorSchema>;
    try {
      changed = flavorSchema.parse(
        await this.runner.callSettled("set_decompilation_flavor", {
          flavor: input.flavor,
        }),
      );
    } catch (cause: unknown) {
      if (
        cause instanceof AnalysisProtocolError &&
        /Unknown decompilation flavor/u.test(cause.message)
      )
        throw new AnalysisInputError(
          "set_native_decompilation_flavor",
          { cause },
          [
            {
              path: ["flavor"],
              reason: "invalid_value",
              message: cause.message,
            },
          ],
        );
      throw cause;
    }
    this.options.onFlavor(changed.flavor);
    this.options.onMutation();
    if (this.runner.cancelled)
      throw new AnalysisCancelledError("set_native_decompilation_flavor");
    const current = flavorSchema.parse(
      await this.runner.call("get_decompilation_flavor", {}),
    );
    if (current.flavor !== changed.flavor)
      throw new AnalysisProtocolError(
        "angr decompilation flavor readback disagrees with the requested flavor.",
      );
    return nativeDecompilationFlavorSchema.parse({
      flavor: current.flavor,
      previous_flavor: changed.previous_flavor ?? null,
      available_flavors: current.available_flavors ?? [current.flavor],
      detected_language: current.detected_language ?? null,
      detection_confidence: current.detection_confidence ?? null,
    });
  }

  /** Dispatch one mutating or flavor operation after contract validation. */
  async run(
    operation: string,
    parameters: Readonly<Record<string, JsonValue>>,
  ): Promise<JsonValue> {
    switch (operation) {
      case "set_address_name": {
        const input = setAddressNameInput.parse(parameters);
        this.runner.locations.push({ kind: "address", address: input.address });
        return this.setAddressName(input.address, input.name);
      }
      case "set_addresses_names":
        return this.setAddressesNames(
          setAddressesNamesInput.parse(parameters).names,
        );
      case "set_comment": {
        const input = setCommentInput.parse(parameters);
        this.runner.locations.push({ kind: "address", address: input.address });
        return this.setComment(input.address, input.comment);
      }
      case "annotate_native_function":
        return this.annotateFunction(parameters);
      case "rename_native_variables":
        return this.renameVariables(parameters);
      case "set_native_variable_types":
        return this.setVariableTypes(parameters);
      case "set_native_function_prototypes":
        return this.setFunctionPrototypes(parameters);
      case "inspect_native_decompilation_flavor":
        return this.inspectFlavor();
      case "set_native_decompilation_flavor":
        return this.setFlavor(parameters);
      default:
        throw new AnalysisProtocolError(
          `angr edit runner received unknown operation ${operation}.`,
        );
    }
  }
}
