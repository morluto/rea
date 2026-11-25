import { lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { ExecutionOptions } from "../ports/AnalysisProvider.js";
import type { SolanaReceiptsPort } from "../ports/solana/SolanaReceiptsPort.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisInputError,
  cancelledBy,
  isAborted,
} from "../domain/analysisErrorCore.js";
import { fixedAllowanceOptions } from "../domain/fixedAllowanceRemediation.js";
import { decodeLimit } from "../domain/parseFailure.js";
import { parseLimitConstraint } from "../domain/parseFailureAnalysisError.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { sha256Hex } from "../kernel/sha256Hex.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  solanaProgramAnalysisSchema,
  solanaProgramBatchSchema,
} from "../domain/solana/solanaProgram.js";
import {
  solanaReceiptEvidenceFileSchema,
  type SolanaProgramReceipts,
  type SolanaReceiptEvidence,
  type SolanaReceiptsInput,
  type SolanaReceiptsResult,
} from "../domain/solana/solanaReceipts.js";
import { SOLANA_PROGRAM_PROVIDER_IDENTITY } from "./SolanaProviderIdentity.js";
import {
  buildProgramReceipts,
  SolanaReceiptsFailure,
} from "./SolanaReceipts.js";

const OPERATION = "solana_receipts";
/** The single-program analysis file name inside an analysis out_dir. */
const SOLANA_ANALYSIS_FILE = "solana-analysis.json";
/** Receipt inputs are REA-written JSON or a hand-built evidence file; both are small. */
const MAX_JSON_BYTES = 64 * 1024 * 1024;

const adapterError = (cause: unknown): ProviderAdapterError =>
  new ProviderAdapterError(SOLANA_PROGRAM_PROVIDER_IDENTITY.id, OPERATION, {
    cause,
  });

/** Classify a recognized abort at the I/O owner, keeping the caller's reason. */
const abortedOr = (
  signal: AbortSignal | undefined,
  failure: () => AnalysisError,
): AnalysisError =>
  isAborted(signal) ? cancelledBy(OPERATION, signal) : failure();

/** One batch item directory name: a single path segment, never `.` or `..`. */
const isSafeItemName = (name: string): boolean =>
  name.length > 0 &&
  name !== "." &&
  name !== ".." &&
  !name.includes("/") &&
  !name.includes("\\") &&
  !name.includes("\0");

const inputIssue = (path: string, message: string): AnalysisInputError =>
  new AnalysisInputError(OPERATION, undefined, [
    { path: [path], reason: "invalid_value", message },
  ]);

/** Device and inode of an existing file (following links), or undefined. */
const fileIdentity = async (path: string): Promise<string | undefined> => {
  try {
    const info = await stat(path);
    return `${String(info.dev)}:${String(info.ino)}`;
  } catch {
    return undefined;
  }
};

/**
 * Admit every receipt destination before anything is written. A destination
 * must not be a symbolic link (or sit in a linked item directory), and must
 * not be, through any alias, one of the selected inputs: the evidence file
 * or an analysis. Returns the refusal message, or undefined when admitted.
 */
const outputConflict = async (
  outputs: readonly { readonly path: string; readonly directory?: string }[],
  inputs: readonly string[],
): Promise<string | undefined> => {
  const inputIds = new Set<string>();
  for (const input of inputs) {
    const id = await fileIdentity(input);
    if (id !== undefined) inputIds.add(id);
  }
  for (const output of outputs) {
    if (output.directory !== undefined) {
      try {
        const directory = await lstat(output.directory);
        if (!directory.isDirectory())
          return `Batch item directory is not a plain directory: ${output.directory}.`;
      } catch {
        /* a missing item directory is reported when its analysis is read */
      }
    }
    let info: Awaited<ReturnType<typeof lstat>> | undefined;
    try {
      info = await lstat(output.path);
    } catch {
      info = undefined;
    }
    if (info === undefined) continue;
    if (info.isSymbolicLink())
      return `Receipt destination is a symbolic link: ${output.path}.`;
    if (inputIds.has(`${String(info.dev)}:${String(info.ino)}`))
      return `Receipt destination ${output.path} is one of the selected inputs; choose evidence and analysis files outside the receipt destinations.`;
  }
  return undefined;
};

/** Read and JSON-parse one caller-selected file with the intake error taxonomy. */
const readJsonFile = async (
  path: string,
  field: string,
  signal: AbortSignal | undefined,
): Promise<Result<unknown, AnalysisError>> => {
  let info: Awaited<ReturnType<typeof stat>>;
  if (isAborted(signal)) return err(cancelledBy(OPERATION, signal));
  try {
    info = await stat(path);
  } catch (cause) {
    if (isAborted(signal)) return err(cancelledBy(OPERATION, signal));
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM")
      return err(
        new AnalysisAccessDeniedError(OPERATION, path, code, { cause }),
      );
    if (
      code === "ENOENT" ||
      code === "ENOTDIR" ||
      code === "ELOOP" ||
      code === "ENAMETOOLONG"
    )
      return err(
        inputIssue(
          field,
          `Selected file cannot be resolved: ${path} (${code}).`,
        ),
      );
    return err(adapterError(cause));
  }
  if (!info.isFile())
    return err(
      inputIssue(field, `Selected path is not a regular file: ${path}.`),
    );
  if (info.size > MAX_JSON_BYTES)
    return err(
      parseLimitConstraint(
        OPERATION,
        "memory",
        decodeLimit(
          "json",
          `Selected file ${path} is ${String(info.size)} bytes, above the ${String(MAX_JSON_BYTES)}-byte intake allowance.`,
          { name: "solana-receipts-json-bytes", maximum: MAX_JSON_BYTES },
        ),
        {
          legacyMaximumKey: "maximum_bytes",
          ...fixedAllowanceOptions(
            "The Solana receipts JSON intake allowance",
            "input",
            { limit: MAX_JSON_BYTES, unit: "bytes" },
          ),
        },
      ),
    );
  let text: string;
  try {
    text = await readFile(path, { encoding: "utf8", signal });
  } catch (cause) {
    return err(abortedOr(signal, () => adapterError(cause)));
  }
  try {
    return ok(JSON.parse(text) as unknown);
  } catch {
    return err(inputIssue(field, `Selected file is not valid JSON: ${path}.`));
  }
};

const fileExists = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

interface ReceiptTarget {
  readonly name: string;
  readonly analysisPath: string;
  readonly receiptsPath: string;
}

/**
 * Filesystem receipts builder. Reads the selected analysis (a file, a
 * single-run out_dir, or a batch out_dir with its index) plus the caller's
 * evidence file, joins them by artifact SHA-256, and writes one
 * receipts.json per program (plus the aggregate at a batch root). It never
 * runs a differential itself; verdicts derive solely from the evidence the
 * caller supplies.
 */
export class SolanaReceiptsProvider implements SolanaReceiptsPort {
  readonly identity = SOLANA_PROGRAM_PROVIDER_IDENTITY;

  async build(
    input: SolanaReceiptsInput,
    options?: ExecutionOptions,
  ): Promise<Result<SolanaReceiptsResult, AnalysisError>> {
    const signal = options?.signal;
    const evidenceRead = await readJsonFile(
      input.evidence_path,
      "evidence_path",
      signal,
    );
    if (!evidenceRead.ok) return evidenceRead;
    const evidenceParsed = solanaReceiptEvidenceFileSchema.safeParse(
      evidenceRead.value,
    );
    if (!evidenceParsed.success)
      return err(
        inputIssue(
          "evidence_path",
          `Evidence file does not match the receipts evidence schema: ${evidenceParsed.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")}`,
        ),
      );
    const documents: readonly SolanaReceiptEvidence[] = Array.isArray(
      evidenceParsed.data,
    )
      ? evidenceParsed.data
      : [evidenceParsed.data];
    // One document per artifact: a second document for the same SHA-256
    // could contradict the first, and silently using only one would hide it.
    const documentShas = new Set<string>();
    for (const document of documents) {
      if (documentShas.has(document.program.elf_sha256))
        return err(
          inputIssue(
            "evidence_path",
            `Evidence holds more than one document for artifact ${document.program.elf_sha256}; merge them into one document so every claim is checked together.`,
          ),
        );
      documentShas.add(document.program.elf_sha256);
    }

    let mode: "single" | "batch";
    let targets: ReceiptTarget[];
    let batchRoot: string | undefined;
    const skipped: SolanaReceiptsResult["skipped_items"] = [];
    if (input.analysis_path !== undefined) {
      mode = "single";
      targets = [
        {
          name: basename(dirname(input.analysis_path)),
          analysisPath: input.analysis_path,
          receiptsPath: join(dirname(input.analysis_path), "receipts.json"),
        },
      ];
    } else {
      const outDir = input.out_dir as string;
      const singleAnalysis = join(outDir, SOLANA_ANALYSIS_FILE);
      if (await fileExists(singleAnalysis)) {
        mode = "single";
        targets = [
          {
            name: basename(outDir),
            analysisPath: singleAnalysis,
            receiptsPath: join(outDir, "receipts.json"),
          },
        ];
      } else {
        const indexPath = join(outDir, "index.json");
        if (!(await fileExists(indexPath)))
          return err(
            inputIssue(
              "out_dir",
              `Directory holds neither a solana-analysis.json nor a batch index.json: ${outDir}.`,
            ),
          );
        mode = "batch";
        batchRoot = outDir;
        const indexRead = await readJsonFile(indexPath, "out_dir", signal);
        if (!indexRead.ok) return indexRead;
        // Parse the index with its owning schema. Item locations derive from
        // the selected root and the validated item name, never from stored
        // absolute paths, so writes stay inside out_dir and a moved batch
        // still resolves.
        const indexParsed = solanaProgramBatchSchema.shape.entries.safeParse(
          indexRead.value,
        );
        if (!indexParsed.success)
          return err(
            inputIssue(
              "out_dir",
              `Batch index does not match the batch index schema: ${indexPath}.`,
            ),
          );
        targets = [];
        const names = new Set<string>();
        for (const entry of indexParsed.data) {
          if (!isSafeItemName(entry.name) || names.has(entry.name))
            return err(
              inputIssue(
                "out_dir",
                `Batch index names an unsafe or repeated item directory "${entry.name}": ${indexPath}.`,
              ),
            );
          names.add(entry.name);
          if (entry.status === "error") {
            skipped.push({
              name: entry.name,
              reason: `Batch analysis failed: ${entry.error ?? "no recorded reason"}.`,
            });
            continue;
          }
          const itemDir = join(outDir, entry.name);
          targets.push({
            name: entry.name,
            analysisPath: join(itemDir, SOLANA_ANALYSIS_FILE),
            receiptsPath: join(itemDir, "receipts.json"),
          });
        }
        if (targets.length === 0)
          return err(
            inputIssue(
              "out_dir",
              `Batch index names no analyzed items${skipped.length === 0 ? "" : ` (${skipped.map((item) => `${item.name}: ${item.reason}`).join("; ")})`}: ${indexPath}.`,
            ),
          );
      }
    }

    const conflict = await outputConflict(
      [
        ...targets.map((target) => ({
          path: target.receiptsPath,
          ...(mode === "batch"
            ? { directory: dirname(target.receiptsPath) }
            : {}),
        })),
        ...(batchRoot === undefined
          ? []
          : [{ path: join(batchRoot, "receipts.json") }]),
      ],
      [input.evidence_path, ...targets.map((target) => target.analysisPath)],
    );
    if (isAborted(signal)) return err(cancelledBy(OPERATION, signal));
    if (conflict !== undefined)
      return err(
        inputIssue(
          input.analysis_path === undefined ? "out_dir" : "analysis_path",
          conflict,
        ),
      );

    const programs: SolanaProgramReceipts[] = [];
    const usedShas = new Set<string>();
    let singleReceiptBytes: string | undefined;
    for (const target of targets) {
      const fail = (
        message: string,
      ): Result<SolanaReceiptsResult, AnalysisError> | undefined => {
        if (mode === "batch") {
          skipped.push({ name: target.name, reason: message });
          return undefined;
        }
        return err(inputIssue("analysis_path", message));
      };
      const analysisRead = await readJsonFile(
        target.analysisPath,
        "analysis_path",
        signal,
      );
      if (!analysisRead.ok) {
        const failed = fail(
          `Analysis cannot be read: ${target.analysisPath} (${analysisRead.error.message}).`,
        );
        if (failed !== undefined) return failed;
        continue;
      }
      const analysisParsed = solanaProgramAnalysisSchema.safeParse(
        analysisRead.value,
      );
      if (!analysisParsed.success) {
        const failed = fail(
          `File is not a solana program analysis: ${target.analysisPath}.`,
        );
        if (failed !== undefined) return failed;
        continue;
      }
      const analysis = analysisParsed.data;
      usedShas.add(analysis.artifact.sha256);
      const document = documents.find(
        (candidate) =>
          candidate.program.elf_sha256 === analysis.artifact.sha256,
      );
      if (document === undefined && mode === "single")
        return err(
          inputIssue(
            "evidence_path",
            `Evidence covers ${documents
              .map((candidate) => candidate.program.elf_sha256)
              .join(
                ", ",
              )}, but the analysis covers artifact ${analysis.artifact.sha256}; refusing to emit receipts across artifacts.`,
          ),
        );
      let program: SolanaProgramReceipts;
      try {
        program = buildProgramReceipts(
          analysis,
          document,
          target.analysisPath,
          target.receiptsPath,
        );
      } catch (cause) {
        if (cause instanceof SolanaReceiptsFailure) {
          const failed = fail(cause.message);
          if (failed !== undefined) return failed;
          continue;
        }
        throw cause;
      }
      const bytes = `${JSON.stringify(program, null, 2)}\n`;
      try {
        await mkdir(dirname(target.receiptsPath), { recursive: true });
        await writeFile(target.receiptsPath, bytes, { signal });
      } catch (cause) {
        return err(abortedOr(signal, () => adapterError(cause)));
      }
      if (mode === "single") singleReceiptBytes = bytes;
      programs.push(program);
    }
    if (programs.length === 0)
      return err(
        inputIssue(
          "analysis_path",
          `No program could be receipted: ${skipped
            .map((item) => `${item.name}: ${item.reason}`)
            .join("; ")}`,
        ),
      );

    const totals = {
      total_candidates: programs.reduce(
        (sum, program) => sum + program.summary.total_candidates,
        0,
      ),
      recovered: programs.reduce(
        (sum, program) => sum + program.summary.recovered,
        0,
      ),
      failed: programs.reduce(
        (sum, program) => sum + program.summary.failed,
        0,
      ),
      not_a_handler: programs.reduce(
        (sum, program) => sum + program.summary.not_a_handler,
        0,
      ),
      leads: programs.reduce((sum, program) => sum + program.summary.leads, 0),
      orphans: programs.reduce(
        (sum, program) => sum + program.summary.orphans.length,
        0,
      ),
    };
    const orphanPrograms = documents
      .filter((document) => !usedShas.has(document.program.elf_sha256))
      .map((document) => document.program.elf_sha256);

    if (mode === "single") {
      const only = programs[0] as SolanaProgramReceipts;
      return ok({
        mode,
        receipts_path: only.program.receipts_path,
        receipts_sha256: sha256Hex(singleReceiptBytes as string),
        programs,
        totals,
        orphan_programs: orphanPrograms,
        skipped_items: skipped,
      });
    }
    const rootPath = join(batchRoot as string, "receipts.json");
    const rootBytes = `${JSON.stringify(
      {
        mode,
        programs,
        totals,
        orphan_programs: orphanPrograms,
        skipped_items: skipped,
      },
      null,
      2,
    )}\n`;
    try {
      await writeFile(rootPath, rootBytes, { signal });
    } catch (cause) {
      return err(abortedOr(signal, () => adapterError(cause)));
    }
    return ok({
      mode,
      receipts_path: rootPath,
      receipts_sha256: sha256Hex(rootBytes),
      programs,
      totals,
      orphan_programs: orphanPrograms,
      skipped_items: skipped,
    });
  }
}
