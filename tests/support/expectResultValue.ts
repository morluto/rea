import type { Result } from "../../src/domain/result.js";

/** Unwrap successful fixture operations while preserving the cause of a failed test. */
export const expectResultValue = <Value, Failure>(
  result: Result<Value, Failure>,
): Value => {
  if (!result.ok)
    throw new Error("Expected a successful result", { cause: result.error });
  return result.value;
};
