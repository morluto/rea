import type { V8CodeCacheInputBudget } from "../domain/v8/v8CodeCacheBudget.js";

/** A caller-selected budget was exceeded while scanning the payload. */
export class V8CodeCacheBudgetFailure extends Error {
  constructor(
    readonly boundary: keyof V8CodeCacheInputBudget,
    readonly limit: number,
    message: string,
  ) {
    super(message);
    this.name = "V8CodeCacheBudgetFailure";
  }
}
