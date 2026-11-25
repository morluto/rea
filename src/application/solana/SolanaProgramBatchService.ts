import { mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import { parseAnalysisInput } from "../AnalysisInput.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";
import { SolanaProgramService } from "./SolanaProgramService.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisInputError,
  AnalysisOutputError,
  cancelledBy,
  isAborted,
} from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  analyzeSolanaProgramsInputSchema,
  solanaProgramBatchSchema,
  type AnalyzeSolanaProgramsInput,
  type SolanaProgramAnalysis,
  type SolanaProgramBatch,
  type SolanaProgramBatchItem,
} from "../../domain/solana/solanaProgram.js";
import { err, ok, type Result } from "../../domain/result.js";
import { sha256Hex } from "../../kernel/sha256Hex.js";

const OPERATION = "analyze_solana_programs";
const DEFAULT_CONCURRENCY = 4;
const MAX_ITEMS = 64;
const SOLANA_ANALYSIS_FILE = "solana-analysis.json";

const BATCH_LIMITATIONS: readonly string[] = [
  "Each entry is the single-program analysis of one item with that workflow's own limitations; handler candidates remain reconstruction leads, not a verified instruction inventory.",
  "Items are isolated: a failed item records its error in the index and never blocks the rest of the batch.",
];

/** Names reserved at the batch root, never used for an item directory. */
const RESERVED_ROOT_NAMES: readonly string[] = ["index.json", "receipts.json"];

/**
 * Derive the item's directory name from its source, deduplicated in order.
 * The name is always one safe path segment: leading and trailing dots and
 * dashes are stripped, so `...so` or `..so` can never become `..` or `.`
 * and select a directory outside (or the root of) the batch output.
 */
const itemName = (item: SolanaProgramBatchItem, used: Set<string>): string => {
  const raw =
    item.path !== undefined
      ? basename(item.path).replace(/\.(so|elf)$/i, "")
      : (item.program_id as string);
  const cleaned = raw
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  const base = cleaned.length > 0 ? cleaned : "program";
  let name = base;
  for (let suffix = 2; used.has(name); suffix += 1)
    name = `${base}-${String(suffix)}`;
  used.add(name);
  return name;
};

/** Confirm a derived item directory is a direct child of the batch root. */
const isDirectChild = (root: string, name: string): boolean =>
  name !== "." &&
  name !== ".." &&
  !name.includes("/") &&
  !name.includes("\\") &&
  join(root, name) !== root &&
  basename(join(root, name)) === name;

const errnoCode = (cause: unknown): string | undefined =>
  (cause as NodeJS.ErrnoException | undefined)?.code;

/**
 * List a caller-selected capture directory's `.so` files through the
 * shared workflow, so missing, unreadable, or non-directory selections
 * become typed input or access errors instead of generic failures.
 */
const listCaptureDirectory = async (
  dir: string,
  signal: AbortSignal | undefined,
): Promise<Result<SolanaProgramBatchItem[], AnalysisError>> => {
  if (isAborted(signal)) return err(cancelledBy(OPERATION, signal));
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (cause) {
    if (isAborted(signal)) return err(cancelledBy(OPERATION, signal));
    const code = errnoCode(cause);
    if (code === "EACCES" || code === "EPERM")
      return err(
        new AnalysisAccessDeniedError(OPERATION, dir, code, { cause }),
      );
    return err(
      new AnalysisInputError(OPERATION, { cause }, [
        {
          path: ["dir"],
          reason: "invalid_value",
          message: `Selected capture directory cannot be listed: ${dir} (${code ?? "unknown error"}).`,
        },
      ]),
    );
  }
  return ok(
    names
      .filter((name) => name.toLowerCase().endsWith(".so"))
      .sort()
      .map((name) => ({ path: join(dir, name) })),
  );
};

/**
 * Admit the batch root: absent (created here) or an existing empty
 * directory. Item directories are then created exclusively by the
 * single-program workflow, and index.json is created exclusively, so a
 * batch never overwrites earlier output or caller files.
 */
const admitBatchRoot = async (
  outDir: string,
  signal: AbortSignal | undefined,
): Promise<AnalysisError | undefined> => {
  const refusal = (message: string, cause?: unknown): AnalysisInputError =>
    new AnalysisInputError(
      OPERATION,
      { ...(cause === undefined ? {} : { cause }), userMessage: message },
      [{ path: ["out_dir"], reason: "invalid_value", message }],
    );
  try {
    const existing = await readdir(outDir);
    if (existing.length > 0)
      return refusal(`Batch output directory is not empty: ${outDir}.`);
    return undefined;
  } catch (cause) {
    const code = errnoCode(cause);
    if (code === "ENOTDIR")
      return refusal(`Batch output path is not a directory: ${outDir}.`, cause);
    if (code === "EACCES" || code === "EPERM")
      return new AnalysisAccessDeniedError(OPERATION, outDir, code, { cause });
    if (code !== "ENOENT") return outputError(cause);
  }
  try {
    await mkdir(outDir, { recursive: true });
    return undefined;
  } catch (cause) {
    if (isAborted(signal)) return cancelledBy(OPERATION, signal);
    return outputError(cause);
  }
};

interface PlannedItem {
  readonly item: SolanaProgramBatchItem;
  readonly name: string;
  readonly source: string;
  readonly itemDir: string;
}

/** Run `task` over every index with at most `limit` in flight. */
const runPool = async <T>(
  count: number,
  limit: number,
  task: (index: number) => Promise<T>,
): Promise<readonly T[]> => {
  const results = new Array<T>(count);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, count) },
    async (): Promise<void> => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= count) return;
        results[index] = await task(index);
      }
    },
  );
  await Promise.all(workers);
  return results;
};

/**
 * Batch workflow over the single-program service: the same validation,
 * analysis, and artifact writing per item, plus one `index.json` binding
 * the batch together. This service adds orchestration only — it never
 * re-implements program analysis.
 */
export class SolanaProgramBatchService {
  constructor(readonly programs: SolanaProgramService) {}

  close(): Promise<void> {
    return this.programs.close();
  }

  async inspectBatch(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const input = parseAnalysisInput(
      OPERATION,
      rawInput,
      analyzeSolanaProgramsInputSchema,
      options?.signal,
    );
    if (!input.ok) return input;
    const value: AnalyzeSolanaProgramsInput = input.value;
    const items: SolanaProgramBatchItem[] = [...(value.items ?? [])];
    if (value.dir !== undefined) {
      const listed = await listCaptureDirectory(value.dir, options?.signal);
      if (!listed.ok) return listed;
      items.push(...listed.value);
    }
    if (items.length === 0 || items.length > MAX_ITEMS)
      return err(
        new AnalysisInputError(OPERATION, undefined, [
          {
            path: [value.dir === undefined ? "items" : "dir"],
            reason: "invalid_value",
            message:
              items.length === 0
                ? "The batch selects no programs: dir holds no .so files and no items were given."
                : `The batch selects ${String(items.length)} programs, above the ${String(MAX_ITEMS)}-item limit.`,
          },
        ]),
      );
    const used = new Set<string>(RESERVED_ROOT_NAMES);
    const planned: PlannedItem[] = items.map((item) => {
      const name = itemName(item, used);
      return {
        item,
        name,
        source: item.path ?? (item.program_id as string),
        itemDir: join(value.out_dir, name),
      };
    });
    if (planned.some((plan) => !isDirectChild(value.out_dir, plan.name)))
      return err(outputError());
    const rootFailure = await admitBatchRoot(value.out_dir, options?.signal);
    if (rootFailure !== undefined) return err(rootFailure);

    const entries = await runPool(
      planned.length,
      value.concurrency ?? DEFAULT_CONCURRENCY,
      async (index): Promise<SolanaProgramBatch["entries"][number]> => {
        const plan = planned[index] as PlannedItem;
        const result = await this.programs.inspect(
          {
            ...(plan.item.path === undefined ? {} : { path: plan.item.path }),
            ...(plan.item.program_id === undefined
              ? {}
              : { program_id: plan.item.program_id }),
            ...(plan.item.rpc_url === undefined
              ? {}
              : { rpc_url: plan.item.rpc_url }),
            out_dir: plan.itemDir,
            ...(value.handoff === undefined ? {} : { handoff: value.handoff }),
            ...(value.instruction_names === undefined
              ? {}
              : { instruction_names: value.instruction_names }),
          },
          options,
        );
        if (!result.ok)
          return {
            name: plan.name,
            source: plan.source,
            status: "error",
            sha256: null,
            slot: null,
            handler_candidates: null,
            dispatch: null,
            analysis_path: null,
            error: result.error.message,
          };
        const analysis = result.value
          .normalized_result as SolanaProgramAnalysis;
        return {
          name: plan.name,
          source: plan.source,
          status: "ok",
          sha256: analysis.artifact.sha256,
          slot: analysis.artifact.slot,
          handler_candidates: analysis.handlers.length,
          dispatch: analysis.dispatch,
          analysis_path: join(plan.itemDir, SOLANA_ANALYSIS_FILE),
          error: null,
        };
      },
    );

    const batch: SolanaProgramBatch = {
      out_dir: value.out_dir,
      index_path: join(value.out_dir, "index.json"),
      total: entries.length,
      succeeded: entries.filter((entry) => entry.status === "ok").length,
      failed: entries.filter((entry) => entry.status === "error").length,
      entries: [...entries],
    };
    const parsed = solanaProgramBatchSchema.safeParse(batch);
    if (!parsed.success) return err(outputError());
    const indexBytes = `${JSON.stringify(parsed.data.entries, null, 2)}\n`;
    try {
      await writeFile(batch.index_path, indexBytes, { flag: "wx" });
    } catch (cause) {
      if (isAborted(options?.signal))
        return err(cancelledBy(OPERATION, options.signal));
      return err(outputError(cause));
    }
    return completeProviderEvidence(
      createEvidence(
        {
          path: batch.index_path,
          sha256: sha256Hex(indexBytes),
          format: "file",
        },
        this.programs.provider.identity,
        {
          operation: OPERATION,
          parameters: {
            out_dir: value.out_dir,
            items: planned.map((plan) => plan.source),
            ...(value.dir === undefined ? {} : { dir: value.dir }),
            ...(value.concurrency === undefined
              ? {}
              : { concurrency: value.concurrency }),
          },
          result: parsed.data,
          confidence: "inferred",
          limitations: [...BATCH_LIMITATIONS],
          locations: [
            { kind: "artifact-path", path: batch.index_path },
            ...parsed.data.entries.flatMap((entry) =>
              entry.analysis_path === null
                ? []
                : [
                    {
                      kind: "artifact-path",
                      path: entry.analysis_path,
                    } as const,
                  ],
            ),
          ],
        },
      ),
      options?.signal,
    );
  }
}

function outputError(cause?: unknown): AnalysisOutputError {
  return new AnalysisOutputError(
    OPERATION,
    "Solana batch analysis could not assemble or write its index.",
    cause === undefined ? undefined : { cause },
  );
}
