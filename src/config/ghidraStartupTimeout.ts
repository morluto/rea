import { z } from "zod";

/** Default absolute deadline for Ghidra import, analysis, bridge, and readiness. */
export const DEFAULT_GHIDRA_STARTUP_TIMEOUT_MS = 330_000;

// Node schedules delays above this signed 32-bit boundary as a 1 ms timer.
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Parse the optional setting without reading the ambient process environment. */
export const ghidraStartupTimeoutSchema = z
  .string()
  .optional()
  .transform((raw) => {
    const value = Number(raw);
    return Number.isSafeInteger(value) &&
      value > 0 &&
      value <= MAX_TIMER_DELAY_MS
      ? value
      : DEFAULT_GHIDRA_STARTUP_TIMEOUT_MS;
  });
