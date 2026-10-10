import { isAbsolute } from "node:path";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { GoBinaryPort } from "./GoBinaryPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  goBinarySchema,
  inspectGoBinaryInputSchema,
} from "../../domain/go/goBinary.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { err, ok, type Result } from "../../domain/result.js";

const OPERATION = "inspect_go_binary";
const architectureForSubject = (architecture: string) => {
  switch (architecture) {
    case "386":
    case "x86":
      return "x86";
    case "amd64":
    case "x86_64":
      return "x86_64";
    case "arm":
      return "arm";
    case "arm64":
      return "arm64";
    default:
      return undefined;
  }
};

/** Shared exact input validation and artifact-bound Evidence for CLI and MCP. */
export class GoBinaryService {
  constructor(readonly provider: GoBinaryPort) {}

  /** Inspect one explicitly selected file without acquiring a binary session. */
  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(OPERATION));
    const input = inspectGoBinaryInputSchema.safeParse(rawInput);
    if (!input.success)
      return err(
        analysisInputErrorFromIssues(OPERATION, input.error.issues, rawInput, {
          cause: input.error,
        }),
      );
    if (!isAbsolute(input.data.path))
      return err(
        new AnalysisInputError(OPERATION, undefined, [
          {
            path: ["path"],
            reason: "invalid_format",
            message: "Expected an absolute filesystem path on this host.",
          },
        ]),
      );
    const inspected = await this.provider.inspect(input.data, options);
    if (!inspected.ok) return inspected;
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(OPERATION));
    const report = goBinarySchema.safeParse(inspected.value);
    if (!report.success || report.data.artifact.path !== input.data.path)
      return err(
        new AnalysisOutputError(
          OPERATION,
          "Go build-information reader returned malformed metadata or changed the selected artifact identity.",
        ),
      );
    const value = report.data;
    const architecture = architectureForSubject(value.architecture);
    return ok(
      createEvidence(
        {
          path: value.artifact.path,
          sha256: value.artifact.sha256,
          format: value.format === "macho" ? "mach-o" : value.format,
          ...(architecture === undefined ? {} : { architecture }),
        },
        this.provider.identity,
        {
          operation: OPERATION,
          parameters: input.data,
          result: value,
          confidence: "observed",
          limitations: value.limitations,
          locations: [
            { kind: "artifact-path", path: value.artifact.path },
            ...(value.build_info === null
              ? []
              : [
                  {
                    kind: "file-offset-range" as const,
                    start: value.build_info.header_offset,
                    end: value.build_info.header_offset + 32,
                  },
                ]),
          ],
        },
      ),
    );
  }
}
