import { Budget } from "../domain/budget.js";
import { decodeLimit } from "../domain/parseFailure.js";

/** Fixed per-package allowances for retained header values and decoded text. */
const MATERIALIZATION_ALLOWANCES = {
  values: 1048576,
  textBytes: 64 * 1024 * 1024,
} as const;

/** Admission shared by both headers and every consumer of their known values. */
export class RpmPackageMaterialization {
  readonly #values: Budget;
  readonly #textBytes: Budget;
  readonly #text = new Map<Buffer, string>();

  constructor(
    allowances: {
      readonly values: number;
      readonly textBytes: number;
    } = MATERIALIZATION_ALLOWANCES,
  ) {
    this.#values = new Budget(allowances.values);
    this.#textBytes = new Budget(allowances.textBytes);
  }

  /** Reserve vector elements before readStrings/readInts allocates any of them. */
  values(count: number): void {
    this.#values.charge(count, () =>
      decodeLimit(
        "rpm",
        `RPM known header values require at least ${String(this.#values.used + count)} elements, above the ${String(this.#values.maximum)}-element materialization allowance.`,
        {
          name: "materialized_values",
          maximum: this.#values.maximum,
          required: this.#values.used + count,
        },
      ),
    );
  }

  /** Decode each stored value once; distinct overlapping values still share the byte allowance. */
  text(raw: Buffer, decode: () => string): string {
    const existing = this.#text.get(raw);
    if (existing !== undefined) return existing;
    this.#textBytes.charge(raw.length, () =>
      decodeLimit(
        "rpm",
        `RPM decoded header text requires at least ${String(this.#textBytes.used + raw.length)} source bytes, above the ${String(this.#textBytes.maximum)}-byte text allowance.`,
        {
          name: "decoded_text_bytes",
          maximum: this.#textBytes.maximum,
          required: this.#textBytes.used + raw.length,
        },
      ),
    );
    const value = decode();
    this.#text.set(raw, value);
    return value;
  }
}
