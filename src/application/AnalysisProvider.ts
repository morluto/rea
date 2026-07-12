import type { BinaryTarget } from "../domain/binaryTarget.js";
import type { AnalysisError } from "../domain/errors.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { Result } from "../domain/result.js";

export interface ExecutionOptions {
  readonly signal?: AbortSignal;
}

/** Provider-neutral application capability for one analysis operation. */
export interface AnalysisOperationPort {
  execute(
    operation: string,
    parameters: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
  ): Promise<Result<JsonValue, AnalysisError>>;
}

/** Provider session bound to exactly one parsed artifact. */
export interface AnalysisClient extends AnalysisOperationPort {
  close(): Promise<void>;
}

export type AnalysisClientFactory = (target: BinaryTarget) => AnalysisClient;

export interface ProviderIdentity {
  readonly id: string;
  readonly name: string;
  readonly version: string | null;
}

/** Factory and capability declaration for an analysis implementation. */
export interface AnalysisProvider {
  identity(): ProviderIdentity;
  capabilities(): readonly string[];
  createClient(target: BinaryTarget): AnalysisClient;
}
