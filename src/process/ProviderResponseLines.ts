import { constants } from "node:buffer";

import type { AnalysisErrorOptions } from "../domain/analysisErrorBase.js";
import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";

/** Callbacks for one newline-delimited provider response stream. */
export interface ProviderResponseLinesOptions {
  /** Receives each trimmed, non-empty line; return false to drop the rest of the chunk. */
  readonly onLine: (line: string) => boolean;
  /**
   * Reports a line too long to assemble. The line is skipped through its
   * newline and reading resumes after it; return false to drop the rest of
   * the chunk instead.
   */
  readonly onOverflow: () => boolean;
}

/**
 * Splits decoded provider socket text into response lines.
 *
 * Provider replies are complete by contract, so the only line limit is the
 * runtime's maximum string length. Assembling a longer line would throw from
 * the socket listener and terminate the process instead of one request.
 */
export class ProviderResponseLines {
  readonly #options: ProviderResponseLinesOptions;
  readonly #maxLineLength = constants.MAX_STRING_LENGTH;
  #fragments: string[] = [];
  #pendingLength = 0;
  #skipping = false;

  constructor(options: ProviderResponseLinesOptions) {
    this.#options = options;
  }

  /** Consume one decoded socket chunk. */
  push(chunk: string): void {
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf("\n", start);
      const end = newline === -1 ? chunk.length : newline;
      if (!this.#skipping && !this.#append(chunk, start, end)) {
        this.#skipping = true;
        if (!this.#options.onOverflow()) return;
      }
      if (newline === -1) return;
      start = newline + 1;
      if (this.#skipping) {
        this.#skipping = false;
        continue;
      }
      const line = this.#fragments.join("").trim();
      this.#clear();
      if (line.length > 0 && !this.#options.onLine(line)) return;
    }
  }

  /** Drop any incomplete or skipped line when a session closes. */
  reset(): void {
    this.#clear();
    this.#skipping = false;
  }

  #append(chunk: string, start: number, end: number): boolean {
    if (end === start) return true;
    const length = this.#pendingLength + end - start;
    if (length > this.#maxLineLength) {
      this.#clear();
      return false;
    }
    this.#fragments.push(
      start === 0 && end === chunk.length ? chunk : chunk.slice(start, end),
    );
    this.#pendingLength = length;
    return true;
  }

  #clear(): void {
    this.#fragments = [];
    this.#pendingLength = 0;
  }
}

/** Fail the one request whose reply could not be assembled. */
export const oversizedProviderResponse = (
  operation: string,
  options?: AnalysisErrorOptions,
): AnalysisResourceConstraintError =>
  new AnalysisResourceConstraintError(
    operation,
    "transport",
    "The provider reply is longer than the JavaScript runtime can hold as one string.",
    { maximum_line_length: constants.MAX_STRING_LENGTH },
    {
      ...options,
      remediationAction:
        "Request a narrower result, such as a search instead of a complete listing. The analysis session remains available.",
    },
  );
