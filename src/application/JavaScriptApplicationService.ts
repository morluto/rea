import { z } from "zod";

import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import {
  analyzeJavaScriptApplicationInputSchema,
  javascriptApplicationAnalysisResultSchema,
} from "../domain/javascriptApplicationAnalysis.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisProtocolError,
  ArtifactOperationError,
  PermissionRequiredError,
  type AnalysisError,
} from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";
import type { Evidence } from "../domain/evidence.js";
import type { ExecutionOptions } from "./AnalysisProvider.js";
import { createJavaScriptApplicationEvidence } from "./JavaScriptApplicationEvidence.js";
import { reconstructJavaScriptArtifact } from "./JavaScriptArtifactReconstruction.js";
import type { PermissionAuthority } from "./PermissionAuthority.js";

const OPERATION = "analyze_javascript_application" as const;

/** Authorize and statically analyze one local JavaScript/Electron application. */
export const analyzeJavaScriptApplication = async (
  authority: PermissionAuthority | undefined,
  rawInput: unknown,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const parsed = analyzeJavaScriptApplicationInputSchema.safeParse(rawInput);
  if (!parsed.success) return err(new AnalysisInputError(OPERATION));
  return analyzeJavaScriptApplicationValidated(authority, parsed.data, options);
};

/** Analyze input already parsed by a trusted adapter boundary. */
export const analyzeJavaScriptApplicationValidated = async (
  authority: PermissionAuthority | undefined,
  input: z.output<typeof analyzeJavaScriptApplicationInputSchema>,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  if (authority === undefined)
    return err(
      new AnalysisCapabilityUnavailableError(
        "rea-javascript-application",
        OPERATION,
        "JavaScript application permission policy is not configured",
      ),
    );
  const authorized = await authority.authorize(
    {
      capability: "investigation_input",
      roots: [input.input_path],
      executables: [],
      environment_names: [],
      network: "none",
      mount: false,
      operation_identity: `${OPERATION}:${input.input_path}`,
    },
    "read",
  );
  if (!authorized.ok)
    return err(
      authorized.error instanceof PermissionRequiredError
        ? authorized.error
        : new ArtifactOperationError(OPERATION, "path", {
            logicalPath: input.input_path,
            declaredSha256: null,
            calculatedSha256: null,
            unpacked: false,
          }),
    );
  await options.progress?.report({
    phase: "analyze_javascript_application",
    completed: 0,
    total: 1,
    message: "Inventorying and parsing approved application artifacts",
  });
  try {
    const reconstructed = await reconstructJavaScriptArtifact(
      {
        input_path: input.input_path,
        format: input.format,
        source_map_read_approved: input.source_map_read_approved,
        limits: input.limits,
      },
      options.signal,
    );
    const { electron_summary: summary, ...application } = reconstructed;
    const result = javascriptApplicationAnalysisResultSchema.parse({
      schema_version: 1,
      ...application,
      summary,
      limitations: reconstructed.graph.limitations,
    });
    await options.progress?.report({
      phase: "analyze_javascript_application",
      completed: 1,
      total: 1,
      message: "Application graph and Electron boundaries reconstructed",
      terminal: true,
    });
    return ok(createJavaScriptApplicationEvidence(input, result));
  } catch (cause: unknown) {
    if (cause instanceof ArtifactReaderFailure)
      return err(
        new ArtifactOperationError(OPERATION, cause.reason, cause.details),
      );
    if (cause instanceof z.ZodError)
      return err(
        new AnalysisProtocolError(
          "JavaScript application analysis produced an invalid result",
          { cause },
        ),
      );
    return err(new ArtifactOperationError(OPERATION, "io"));
  }
};
