import type { AnalysisParameterLimit } from "../analysisSettings.js";

/** A caller-selected ELF reader budget: its schema bounds and omitted value. */
export interface ElfReadBudgetBounds {
  readonly minimum: number;
  readonly maximum: number;
  readonly default_value: number;
}

/** The per-call read budgets an ELF note reader accepts. */
export interface ElfReadBudgets {
  readonly max_file_bytes: ElfReadBudgetBounds;
  readonly max_entries: ElfReadBudgetBounds;
}

/** Smallest `max_file_bytes`: an ELF64 file header. */
export const MINIMUM_ELF_READ_FILE_BYTES = 64;

/** `max_file_bytes` when omitted. */
export const DEFAULT_ELF_READ_FILE_BYTES = 64 * 1024 * 1024;

/**
 * The per-call control that stopped an ELF or kernel reader, named by its
 * contract field; each adapter names the option that sets it. The schema owns
 * the same bounds, so the reported range is the one the next call accepts.
 */
export const elfReadBudgetLimit = <
  T extends { readonly [K in keyof T]: ElfReadBudgetBounds },
  K extends keyof T & string,
>(
  budgets: T,
  parameter: K,
  effectiveValue: number,
  unit: AnalysisParameterLimit["unit"] = parameter.endsWith("_bytes")
    ? "bytes"
    : "count",
): AnalysisParameterLimit => ({
  control_kind: "parameter",
  parameter,
  effective_value: effectiveValue,
  unit,
  ...budgets[parameter],
  applies_at: "next_call",
});
