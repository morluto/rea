import { z } from "incur";
import { cliDecimalField } from "./cli/options.js";
import {
  browserDiscoveryTimeoutSchema,
  webRuntimeCommandTimeoutSchema,
} from "./domain/browserDeadline.js";

/** Accept an agent-selected browser observation duration without an artificial ceiling. */
export const observationDuration = (fallback: number, minimum = 0) =>
  cliDecimalField(
    z
      .number()
      .int()
      .min(minimum)
      .default(fallback)
      .describe("Observation duration in milliseconds"),
  );

/** Shared passive browser origin options. */
export const browserScopeOptions = {
  allowedOrigins: z
    .array(z.string().min(1))
    .optional()
    .describe("Optional exact-origin filter"),
  commandTimeoutMs: cliDecimalField(webRuntimeCommandTimeoutSchema),
};

/** Shared options for passive browser commands that also accept discovery_timeout_ms. */
export const passiveBrowserScopeOptions = {
  ...browserScopeOptions,
  discoveryTimeoutMs: cliDecimalField(browserDiscoveryTimeoutSchema),
};

/** Keep an omitted discovery deadline absent so Evidence records the caller selection only. */
export const selectedDiscoveryTimeout = (
  discoveryTimeoutMs: number | undefined,
): { readonly discovery_timeout_ms?: number } =>
  discoveryTimeoutMs === undefined
    ? {}
    : { discovery_timeout_ms: discoveryTimeoutMs };

/** Keep an omitted command deadline absent so Evidence records the caller selection only. */
export const selectedCommandTimeout = (
  commandTimeoutMs: number | undefined,
): { readonly command_timeout_ms?: number } =>
  commandTimeoutMs === undefined
    ? {}
    : { command_timeout_ms: commandTimeoutMs };
