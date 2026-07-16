import { z } from "zod";

import {
  AnalysisInputError,
  AnalysisProtocolError,
  type AnalysisError,
} from "../domain/errors.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import {
  managedApplicationGraphResultSchema,
  projectManagedApplicationGraph,
  projectManagedApplicationGraphInputSchema,
  type ManagedApplicationGraphResult,
  type ProjectManagedApplicationGraphInput,
} from "../domain/managedApplicationGraph.js";
import { err, ok, type Result } from "../domain/result.js";
import { MANAGED_WORKFLOW_PROVIDER } from "./InvestigationProviders.js";

const OPERATION = "project_managed_application_graph" as const;

/** Project authenticated managed Evidence into a provider-neutral graph. */
export const projectManagedApplicationGraphEvidence = (
  rawInput: unknown,
): Result<Evidence, AnalysisError> => {
  const parsed = projectManagedApplicationGraphInputSchema.safeParse(rawInput);
  if (!parsed.success)
    return err(new AnalysisInputError(OPERATION, { cause: parsed.error }));
  try {
    const result = projectManagedApplicationGraph(parsed.data);
    return ok(createManagedApplicationGraphEvidence(parsed.data, result));
  } catch (cause: unknown) {
    return err(
      cause instanceof TypeError || cause instanceof z.ZodError
        ? new AnalysisInputError(OPERATION, { cause })
        : new AnalysisProtocolError(
            "Managed application graph projection produced an invalid result",
            { cause },
          ),
    );
  }
};

const createManagedApplicationGraphEvidence = (
  input: ProjectManagedApplicationGraphInput,
  result: ManagedApplicationGraphResult,
): Evidence =>
  createEvidence(subjectTarget(input), MANAGED_WORKFLOW_PROVIDER, {
    predicateType: "rea.managed-application-graph/v1",
    operation: OPERATION,
    parameters: {
      managed_artifact_evidence_id: input.managed_artifact?.evidence_id ?? null,
      managed_members_evidence_id: input.managed_members?.evidence_id ?? null,
      managed_native_boundaries_evidence_id:
        input.managed_native_boundaries?.evidence_id ?? null,
      limits: jsonValueSchema.parse(input.limits),
    },
    result: jsonValueSchema.parse(
      managedApplicationGraphResultSchema.parse(result),
    ),
    rawResult: null,
    confidence: "inferred",
    authority: "analyst-inference",
    environment: null,
    limitations: result.limitations,
    evidenceLinks: result.evidence_links,
  });

const subjectTarget = (
  input: ProjectManagedApplicationGraphInput,
):
  | {
      readonly path: string;
      readonly sha256: string;
      readonly format: "pe";
      readonly architecture?: "x86" | "x86_64" | "arm" | "arm64";
    }
  | undefined => {
  const subject =
    input.managed_artifact?.subject ??
    input.managed_members?.subject ??
    input.managed_native_boundaries?.subject;
  if (subject === undefined || subject === null || subject.format !== "pe")
    return undefined;
  return {
    path: subject.local_path,
    sha256: subject.digest.sha256,
    format: "pe",
    ...(subject.architecture === null
      ? {}
      : { architecture: subject.architecture }),
  };
};
