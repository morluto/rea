import {
  MAX_NODE_TIMER_DELAY_MS,
  deadlineParameterLimit,
  timerDurationMsSchema,
} from "../analysisResourceLimits.js";

import type { AnalysisControlLimit } from "../analysisSettings.js";
import {
  fixedAllowanceRemediation,
  type FixedAllowanceKind,
} from "../fixedAllowanceRemediation.js";

/**
 * Omitted `native_command_timeout_ms`. This is the macOS Xcode-tool wall
 * clock, not objdump/rizin `command_timeout_ms` (default 120000).
 */
export const DEFAULT_NATIVE_COMMAND_TIMEOUT_MS = 60_000;

/** Omitted `native_ui_deadline_ms` for one UI observation or scenario. */
export const DEFAULT_NATIVE_UI_DEADLINE_MS = 180_000;

/** Omitted `pwntools_timeout_ms` for one owned pwntools command. */
export const DEFAULT_PWNTOOLS_TIMEOUT_MS = 30_000;

/**
 * One scenario wait step. The operation deadline is separate and adjustable;
 * this step cap stays fixed.
 */
export const NATIVE_UI_WAIT_STEP_MAX_MS = 180_000;

const deadlineField = (description: string) =>
  timerDurationMsSchema.optional().describe(description);

/** Per-call macOS native command deadline. Omitted means 60000 ms. */
export const nativeCommandTimeoutField = deadlineField(
  `Wall-clock budget in milliseconds for each macOS native command in this call (lipo, codesign, plutil, swift-demangle, and the other allowlisted Xcode tools). Omitted means 60000. Integer from 1 to ${String(MAX_NODE_TIMER_DELAY_MS)}. Applies on the next call. Does not raise the fixed 67108864-byte output allowance or the 65536-byte failure-diagnostic excerpt. Named native_command_timeout_ms rather than command_timeout_ms because command_timeout_ms is the separate one-shot objdump and rizin deadline (default 120000).`,
);

/** Per-call native UI observation deadline. Omitted means 180000 ms. */
export const nativeUiDeadlineField = deadlineField(
  `Deadline in milliseconds for this UI observation or scenario, including helper preparation and captures. Omitted means 180000. Integer from 1 to ${String(MAX_NODE_TIMER_DELAY_MS)}. Applies on the next call. Does not raise the fixed 67108864-byte scenario output allowance or the 180000 ms cap on one wait step. A partial observation may already be retained when this deadline expires.`,
);

/** Per-call pwntools command deadline. Omitted means 30000 ms. */
export const pwntoolsTimeoutField = deadlineField(
  `Deadline in milliseconds for each owned pwntools command in this call. Omitted means 30000, range 1..${String(MAX_NODE_TIMER_DELAY_MS)}; applies on the next call. Independent CPU, output, diagnostic, file and address-space allowances are selected in producer_limits. input_bytes overrides REA_PWNTOOLS_MAX_INPUT_BYTES; otherwise that launch default applies.`,
);

type NativeDeadlineRead =
  | { readonly ok: true; readonly timeoutMs: number }
  | {
      readonly ok: false;
      readonly reason: "invalid_type" | "out_of_range";
      readonly message: string;
    };

/** Accept an omitted deadline as the shipped default. */
export const readNativeDeadline = (
  value: unknown,
  defaultMs: number,
): NativeDeadlineRead => {
  if (value === undefined) return { ok: true, timeoutMs: defaultMs };
  const parsed = timerDurationMsSchema.safeParse(value);
  if (parsed.success) return { ok: true, timeoutMs: parsed.data };
  const invalidType = parsed.error.issues.some(
    (issue) => issue.code === "invalid_type",
  );
  return {
    ok: false,
    reason: invalidType ? "invalid_type" : "out_of_range",
    message: `Expected an integer from 1 to ${String(MAX_NODE_TIMER_DELAY_MS)} milliseconds; received ${JSON.stringify(value)}. Omitted means ${String(defaultMs)}.`,
  };
};

/** Agent recovery and limit facts for a caller-selected native deadline. */
export const nativeDeadlineRecovery = (input: {
  readonly timeoutMs: number;
  readonly parameter: string;
  readonly defaultMs: number;
  readonly phase: string;
  readonly unchanged: string;
  readonly detail?: string;
}): {
  readonly userMessage: string;
  readonly remediationAction: string;
  readonly limit: AnalysisControlLimit;
} => {
  const atMaximum = input.timeoutMs >= MAX_NODE_TIMER_DELAY_MS;
  const adjustment = atMaximum
    ? `${input.parameter} is already at the maximum ${String(MAX_NODE_TIMER_DELAY_MS)} ms; do not increase it.`
    : `Increase ${input.parameter} above ${String(input.timeoutMs)} (integer milliseconds from 1 to ${String(MAX_NODE_TIMER_DELAY_MS)}; omitted means ${String(input.defaultMs)}). A change applies on the next call.`;
  return {
    userMessage: `This request reached REA's ${input.phase} of ${String(input.timeoutMs)} ms (${input.parameter}). This is a server/provider deadline, not the MCP client deadline.${input.detail ?? ""}`,
    remediationAction: `${adjustment} ${input.unchanged} Allow execution, cleanup, and delivery headroom in the outer MCP client deadline. Confirm outstanding work and cleanup before retrying.`,
    limit: deadlineParameterLimit(
      input.parameter,
      input.timeoutMs,
      input.defaultMs,
    ),
  };
};

/** Fixed native allowance the agent can see, with the value and no override. */
export const fixedNativeAllowance = (
  allowance: string,
  kind: FixedAllowanceKind,
  valueWithUnits: string,
): { readonly retryable: false; readonly remediationAction: string } => ({
  retryable: false,
  remediationAction: `${fixedAllowanceRemediation(allowance, kind)} This release has no runtime override. The allowance is ${valueWithUnits}.`,
});
