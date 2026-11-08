import {
  MAX_NATIVE_INITIALIZER_NAME_BYTES,
  MAX_NATIVE_INITIALIZER_NOTES,
} from "../../domain/native/nativeInitializers.js";

/** Observations a crafted table can repeat per row, so they are reported once with a count. */
const TALLY_TEXT = {
  "long-symbol-name": (count: number) =>
    `${String(count)} symbol name(s) exceeded the ${String(MAX_NATIVE_INITIALIZER_NAME_BYTES)}-byte name budget and were not used.`,
  "relocation-entry-size": (count: number) =>
    `${String(count)} relocation section(s) had an unexpected entry size and were not applied.`,
} as const;
export type InitializerTally = keyof typeof TALLY_TEXT;
const TALLIES = Object.keys(TALLY_TEXT) as InitializerTally[];

/**
 * Image observations for one inspection. Distinct messages are kept once in
 * arrival order up to the note budget; later ones are counted, and repeated
 * per-row reasons are tallied, so a crafted table cannot grow the report.
 */
export class InitializerNotes {
  private readonly messages: string[] = [];
  private readonly tallies = new Map<InitializerTally, number>();
  private omitted = 0;
  /** Every observation recorded, including duplicates, tallies and omitted ones. */
  recorded = 0;

  add(message: string): void {
    this.recorded += 1;
    if (this.messages.includes(message)) return;
    if (this.messages.length >= MAX_NATIVE_INITIALIZER_NOTES) {
      this.omitted += 1;
      return;
    }
    this.messages.push(message);
  }

  tally(reason: InitializerTally): void {
    this.recorded += 1;
    this.tallies.set(reason, (this.tallies.get(reason) ?? 0) + 1);
  }

  /** At most the note budget, one line per tally reason and one omission line. */
  list(): string[] {
    return [
      ...this.messages,
      ...TALLIES.flatMap((reason) => {
        const count = this.tallies.get(reason);
        return count === undefined ? [] : [TALLY_TEXT[reason](count)];
      }),
      ...(this.omitted === 0
        ? []
        : [
            `${String(this.omitted)} further observation(s), repeats included, were not listed after the ${String(MAX_NATIVE_INITIALIZER_NOTES)}-note budget.`,
          ]),
    ];
  }
}
