import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { SolanaProgramPort } from "../../ports/solana/SolanaProgramPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { join } from "node:path";

import {
  analyzeSolanaProgramInputSchema,
  solanaProgramAnalysisSchema,
  solanaRpcEndpointProvenance,
} from "../../domain/solana/solanaProgram.js";
import { err, type Result } from "../../domain/result.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";
import { parseAnalysisInput } from "../AnalysisInput.js";

const OPERATION = "analyze_solana_program";

/** Shared exact input validation and artifact-bound Evidence for CLI and MCP. */
export class SolanaProgramService {
  constructor(readonly provider: SolanaProgramPort) {}

  close(): Promise<void> {
    return this.provider.close?.() ?? Promise.resolve();
  }

  /**
   * Analyze one selected Solana program. ELF/RPC facts are observed;
   * the record is labeled inferred because its handler candidates are
   * dispatch-scan inferences, not a verified instruction inventory.
   */
  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const input = parseAnalysisInput(
      OPERATION,
      rawInput,
      analyzeSolanaProgramInputSchema,
      options?.signal,
    );
    if (!input.ok) return input;
    const analyzed = await this.provider.analyze(input.value, options);
    if (!analyzed.ok) return analyzed;
    const report = solanaProgramAnalysisSchema.safeParse(analyzed.value);
    if (!report.success) return err(outputError());
    const value = report.data;
    const identityAgrees =
      input.value.path !== undefined
        ? value.artifact.source === "local-file" &&
          value.artifact.path === input.value.path
        : value.artifact.source === "solana-rpc" &&
          value.artifact.program_id === input.value.program_id &&
          input.value.out_dir !== undefined &&
          // Same platform path owner as the provider, so trailing
          // separators and Windows backslashes compare equal.
          value.artifact.path ===
            join(input.value.out_dir, `${input.value.program_id}.so`);
    if (!identityAgrees) return err(outputError());
    return completeProviderEvidence(
      createEvidence(
        {
          path: value.artifact.path,
          sha256: value.artifact.sha256,
          format: "file",
        },
        this.provider.identity,
        {
          operation: OPERATION,
          parameters: {
            ...(input.value.path === undefined
              ? {}
              : { path: input.value.path }),
            ...(input.value.program_id === undefined
              ? {}
              : { program_id: input.value.program_id }),
            // The full URL is transport-only: endpoints often embed API
            // keys in userinfo, path or query, so Evidence keeps the origin.
            ...(input.value.rpc_url === undefined
              ? {}
              : {
                  rpc_endpoint: solanaRpcEndpointProvenance(
                    input.value.rpc_url,
                  ),
                }),
            ...(input.value.out_dir === undefined
              ? {}
              : { out_dir: input.value.out_dir }),
            ...(input.value.handoff === undefined
              ? {}
              : { handoff: input.value.handoff }),
            ...(input.value.instruction_names === undefined
              ? {}
              : { instruction_names: input.value.instruction_names }),
          },
          result: value,
          confidence: "inferred",
          limitations: value.limitations,
          locations: [
            { kind: "artifact-path", path: value.artifact.path },
            ...value.handlers.flatMap((handler) =>
              handler.constant_file_offset === null
                ? []
                : [
                    {
                      kind: "file-offset",
                      offset: handler.constant_file_offset,
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

const outputError = (): AnalysisOutputError =>
  new AnalysisOutputError(
    OPERATION,
    "Solana program analyzer returned malformed data or changed the selected program identity.",
  );
