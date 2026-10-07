import { z } from "zod";
import {
  normalizeArtifactPath,
  ArtifactPathRegistry,
} from "../../artifacts/ArtifactPaths.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import type { JavaScriptRecoveryResult } from "../../domain/javascriptRecovery.js";
import { readRecoveryFile, recoveryFailureMessage } from "./RecoveryFiles.js";
import { RECOVERY_LIMITS } from "./WakaruRelease.js";
import type { runWakaruCommand } from "./WakaruCommand.js";

const warningSchema = z.strictObject({
  filename: z.string(),
  kind: z.string(),
  is_error: z.boolean(),
  message: z.string(),
});
const reportSchema = z.strictObject({
  detected_formats: z.array(z.string()),
  safety: z.string(),
  modules: z.array(
    z.strictObject({
      filename: z.string().min(1),
      kind: z.literal("javascript"),
      status: z.literal("decompiled"),
    }),
  ),
  warnings: z.array(warningSchema),
  total: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  elapsed_ms: z.number().int().nonnegative(),
});
const rangeSchema = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
]);
const provenanceSchema = z.strictObject({
  format: z.string(),
  strategy: z.string(),
  modules: z.record(
    z.string(),
    z.strictObject({
      input: z.string(),
      ranges: z.array(rangeSchema),
      extraction: z.string(),
      context_ranges: z.array(rangeSchema).optional(),
    }),
  ),
});

const OPERATION = "recover_javascript_sources";

type ReportContext = {
  execution: Awaited<ReturnType<typeof runWakaruCommand>>;
  provenancePath: string;
  snapshotPath: string;
  sourceBytes: Buffer;
  files: readonly { relativePath: string }[];
};

/** Parse exact pinned producer JSON before projecting provider-neutral artifacts. */
export const parseWakaruReports = async (context: ReportContext) => {
  const { execution, provenancePath } = context;

  try {
    if (execution.exit_code !== 0 && execution.exit_code !== 1)
      throw new TypeError(
        "Wakaru did not complete recovery (expected exit 0 or a reported partial exit 1)",
      );
    const report = reportSchema.parse(JSON.parse(execution.stdout));
    const provenance = provenanceSchema.parse(
      JSON.parse(
        (
          await readRecoveryFile(provenancePath, RECOVERY_LIMITS.reportBytes)
        ).toString("utf8"),
      ),
    );
    if (report.total !== report.modules.length || report.failed > report.total)
      throw new TypeError("Reported module totals disagree");
    if (
      execution.exit_code === 1 &&
      report.failed === 0 &&
      !report.warnings.some((warning) => warning.is_error)
    )
      throw new TypeError(
        "Wakaru exited 1 without a reported partial recovery reason",
      );
    validateModuleSet(report, provenance, context);
    return {
      report,
      provenance,
      status:
        report.failed > 0 ||
        report.warnings.some((warning) => warning.is_error) ||
        execution.exit_code === 1
          ? ("partial" as const)
          : ("complete" as const),
    };
  } catch (cause: unknown) {
    throw new ProviderAdapterError("wakaru", OPERATION, {
      cause,
      diagnostics: {
        reason: `Unusable Wakaru recovery report: ${recoveryFailureMessage(cause)}`,
        exit_code: execution.exit_code,
        signal: execution.signal,
        stdout: execution.stdout,
        stderr: execution.stderr,
      },
    });
  }
};

const validateModuleSet = (
  report: z.output<typeof reportSchema>,
  provenance: z.output<typeof provenanceSchema>,
  context: ReportContext,
): void => {
  const { files, snapshotPath, sourceBytes } = context;
  const registry = new ArtifactPathRegistry();
  const expected = new Set(["provenance.json"]);
  const observed = new Set(files.map((file) => file.relativePath));
  for (const module of report.modules) {
    const path = normalizeArtifactPath(module.filename);
    if (path !== module.filename || !/\.(?:js|mjs|cjs)$/u.test(path))
      throw new TypeError(`Unsupported module path: ${module.filename}`);
    registry.add(path, "file");
    if (!observed.has(path))
      throw new TypeError(`Missing reported module file: ${path}`);
    expected.add(path);
    if (observed.has(`${path}.map`)) expected.add(`${path}.map`);
    const entry = provenance.modules[path];
    if (entry === undefined || entry.input !== snapshotPath)
      throw new TypeError(
        `Module provenance does not bind the selected input snapshot: ${path}`,
      );
    validateRanges(
      [...entry.ranges, ...(entry.context_ranges ?? [])],
      sourceBytes,
      path,
    );
  }
  if (Object.keys(provenance.modules).length !== report.modules.length)
    throw new TypeError("Provenance and reported module sets disagree");
  for (const path of observed)
    if (!expected.has(path))
      throw new TypeError(`Unreported recovery artifact: ${path}`);
};

const validateRanges = (
  ranges: readonly [number, number][],
  bytes: Buffer,
  filename: string,
): void => {
  for (const [start, end] of ranges) {
    if (
      start > end ||
      end > bytes.length ||
      !utf8Boundary(bytes, start) ||
      !utf8Boundary(bytes, end)
    )
      throw new TypeError(
        `Invalid half-open UTF-8 byte range [${String(start)},${String(end)}) for ${filename}`,
      );
  }
};

const utf8Boundary = (bytes: Buffer, offset: number): boolean => {
  const value = bytes[offset];
  return value === undefined || (value & 0xc0) !== 0x80;
};

/** Translate extraction byte ranges without claiming rewritten line positions. */
export const recoveryRanges = (
  ranges: readonly [number, number][],
): JavaScriptRecoveryResult["modules"][number]["provenance"]["byte_ranges"] =>
  ranges.map(([start, end]) => ({ start, end }));

/** Validate a source map's representation; preserve its unverified mapping bytes. */
export const validateRecoverySourceMap = (
  bytes: Buffer,
  filename: string,
): void => {
  const schema = z.object({
    version: z.literal(3),
    sources: z.array(z.string()),
    names: z.array(z.string()),
    mappings: z.string(),
  });
  try {
    schema.parse(JSON.parse(bytes.toString("utf8")));
  } catch (cause: unknown) {
    throw new AnalysisOutputError(
      OPERATION,
      `Invalid emitted source map for ${filename}: ${recoveryFailureMessage(cause)}`,
      { cause },
    );
  }
};
