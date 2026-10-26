import { completedOperationEvidence } from "../binary/SessionEvidenceReuse.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import type { Evidence } from "../../domain/evidence.js";
import { jsonObjectSchema, type JsonValue } from "../../domain/jsonValue.js";
import { err, type Result } from "../../domain/result.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import { UnicornClient } from "../../unicorn/UnicornClient.js";
import { UNICORN_OPERATION } from "../../unicorn/UnicornBridge.js";

/**
 * Runs one Unicorn emulation outside session admission and returns its
 * Evidence. The harness carries raw function bytes, so no binary needs to
 * be open; the Evidence names no file subject (the run's source is the
 * caller-supplied bytes, recorded by the client as a controlled replay).
 */
export class UnicornEmulationService {
  readonly #client: UnicornClient;

  constructor(environment: Readonly<NodeJS.ProcessEnv>) {
    this.#client = new UnicornClient(environment);
  }

  async emulate(
    input: unknown,
    options: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const parsed = jsonObjectSchema.safeParse(input);
    if (!parsed.success)
      return err(
        new AnalysisInputError(UNICORN_OPERATION, {}, [
          {
            path: [],
            reason: "invalid_type",
            message: "emulate_function input must be an object.",
          },
        ]),
      );
    const parameters: Readonly<Record<string, JsonValue>> = parsed.data;
    const executed = await this.#client.execute(
      UNICORN_OPERATION,
      parameters,
      options,
    );
    if (!executed.ok) return err(executed.error);
    return completedOperationEvidence(
      UNICORN_OPERATION,
      parameters,
      executed.value,
      {
        target: null,
      },
    );
  }
}
