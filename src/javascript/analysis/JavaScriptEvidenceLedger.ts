import type { JavaScriptEvidenceAdmission } from "../../domain/javascript/javascriptSourceAnalysis.js";
import { javaScriptEvidenceBudgetBytes } from "../../process/JavaScriptEvidenceBudget.js";

/** Capacity owned by one analysis, independent of a reusable worker process. */
export class JavaScriptEvidenceLedger implements JavaScriptEvidenceAdmission {
  readonly limitBytes = javaScriptEvidenceBudgetBytes();
  #chargedBytes = 0;
  #forecastBytes = 0;

  remainingBytes(): number {
    return Math.max(0, this.limitBytes - this.#chargedBytes);
  }

  reserveBytes(bytes: number): boolean {
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw new RangeError(
        "Evidence reservation requires nonnegative safe bytes",
      );
    if (bytes > this.remainingBytes()) return false;
    this.#chargedBytes += bytes;
    return true;
  }

  releaseBytes(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.#chargedBytes)
      throw new RangeError("Evidence release exceeds its retained reservation");
    this.#chargedBytes -= bytes;
  }

  reserveForecast(bytes: number): boolean {
    if (!this.reserveBytes(bytes)) return false;
    this.#forecastBytes += bytes;
    return true;
  }

  releaseForecastBytes(bytes: number): void {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > this.#forecastBytes
    )
      throw new RangeError("Evidence release exceeds its forecast reservation");
    this.releaseBytes(bytes);
    this.#forecastBytes -= bytes;
  }

  releaseForecast(): void {
    this.releaseForecastBytes(this.#forecastBytes);
  }
}
