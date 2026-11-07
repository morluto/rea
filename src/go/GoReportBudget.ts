import type { JsonValue } from "../domain/jsonValue.js";
import { jsonValueByteLength } from "../domain/jsonValueByteLength.js";

/** Complete normalized Go report allowance, independent of string admission. */
export const GO_COMPLETE_REPORT_BYTES = 8 * 1024 * 1024;

/** The reader and parser share one report failure, projected by the provider. */
export class GoReportLimitFailure extends Error {
  constructor() {
    super("Go metadata exceeds the 8 MiB complete-report allowance");
    this.name = "GoReportLimitFailure";
  }
}

/** Account for encoded representation before retaining a parsed record. */
export class GoReportBudget {
  constructor(public remaining = GO_COMPLETE_REPORT_BYTES) {
    this.reserve(0);
  }
  reserve(bytes: number): void {
    if (bytes > this.remaining) throw new GoReportLimitFailure();
    this.remaining -= bytes;
  }
  replace(value: JsonValue, oldBytes = 0): void {
    this.reserve(
      jsonValueByteLength(value, this.remaining + oldBytes) - oldBytes,
    );
  }
  append(value: JsonValue, previousLength: number): void {
    this.replace(value);
    if (previousLength > 0) this.reserve(1);
  }
}
