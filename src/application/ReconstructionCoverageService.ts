import { z } from "zod";

import {
  AnalysisCancelledError,
  AnalysisInputError,
  type AnalysisError,
} from "../domain/errors.js";
import type { EvidenceFilePolicy } from "../domain/evidenceBundle.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import {
  evaluateReconstructionClosure,
  reconstructionCoverageWorkspaceSchema,
} from "../domain/reconstructionCoverage.js";
import { err, ok, type Result } from "../domain/result.js";
import type { ExecutionOptions } from "./AnalysisProvider.js";
import {
  readReconstructionCoverageWorkspace,
  writeReconstructionCoverageWorkspace,
} from "./ReconstructionCoverageWorkspaceStore.js";

const COMMIT_OPERATION = "commit_reconstruction_coverage" as const;
const QUERY_OPERATION = "query_reconstruction_coverage" as const;
const isAborted = (signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true;

export const reconstructionCoverageCommitInputSchema = z.strictObject({
  approved: z.literal(true),
  workspace_path: z.string().min(1).max(4_096),
  expected_revision: z.number().int().min(1).nullable(),
  workspace: reconstructionCoverageWorkspaceSchema,
});

export const reconstructionCoverageQueryInputSchema = z.strictObject({
  workspace_path: z.string().min(1).max(4_096),
  boundary_id: z.string().min(1).max(200),
});

export const reconstructionCoverageCommitOutputSchema = z.strictObject({
  workspace_path: z.string(),
  bytes: z.number().int().min(0),
  workspace_id: z.string().regex(/^rcw_[a-f0-9]{64}$/u),
  revision: z.number().int().min(1),
  revision_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  evidence_records: z.number().int().min(0),
});

/** Commit one caller-approved canonical reconstruction coverage CAS revision. */
export const commitReconstructionCoverage = async (
  rawInput: unknown,
  policy: EvidenceFilePolicy,
  options: ExecutionOptions = {},
): Promise<Result<JsonValue, AnalysisError>> => {
  const parsed = reconstructionCoverageCommitInputSchema.safeParse(rawInput);
  if (!parsed.success)
    return err(
      new AnalysisInputError(COMMIT_OPERATION, { cause: parsed.error }),
    );
  if (isAborted(options.signal))
    return err(new AnalysisCancelledError(COMMIT_OPERATION));
  const written = await writeReconstructionCoverageWorkspace(
    parsed.data.workspace,
    parsed.data.workspace_path,
    parsed.data.expected_revision,
    policy,
  );
  if (!written.ok) return written;
  return ok(
    jsonValueSchema.parse({
      workspace_path: written.value.path,
      bytes: written.value.bytes,
      workspace_id: parsed.data.workspace.workspace_id,
      revision: parsed.data.workspace.revision,
      revision_sha256: parsed.data.workspace.revision_sha256,
      evidence_records: parsed.data.workspace.evidence_bundle.records.length,
    }),
  );
};

/** Read one coverage revision and evaluate a named fail-closed boundary. */
export const queryReconstructionCoverage = async (
  rawInput: unknown,
  policy: EvidenceFilePolicy,
  nowEpochMs: number,
  options: ExecutionOptions = {},
): Promise<Result<JsonValue, AnalysisError>> => {
  const parsed = reconstructionCoverageQueryInputSchema.safeParse(rawInput);
  if (!parsed.success)
    return err(
      new AnalysisInputError(QUERY_OPERATION, { cause: parsed.error }),
    );
  if (isAborted(options.signal))
    return err(new AnalysisCancelledError(QUERY_OPERATION));
  const loaded = await readReconstructionCoverageWorkspace(
    parsed.data.workspace_path,
    policy,
  );
  if (!loaded.ok) return loaded;
  if (loaded.value === null)
    return err(
      new AnalysisInputError(QUERY_OPERATION, {
        cause: new TypeError(
          "Reconstruction coverage workspace does not exist",
        ),
      }),
    );
  if (isAborted(options.signal))
    return err(new AnalysisCancelledError(QUERY_OPERATION));
  try {
    return ok(
      jsonValueSchema.parse(
        evaluateReconstructionClosure(
          loaded.value,
          parsed.data.boundary_id,
          nowEpochMs,
        ),
      ),
    );
  } catch (cause: unknown) {
    return err(new AnalysisInputError(QUERY_OPERATION, { cause }));
  }
};
