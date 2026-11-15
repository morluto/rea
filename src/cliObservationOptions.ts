import { z } from "incur";
import { cliDecimalField } from "./cli/options.js";
import { webRuntimeCommandTimeoutSchema } from "./domain/browserDeadline.js";

/** Shared passive browser origin options. */
export const browserScopeOptions = {
  allowedOrigins: z
    .array(z.string().min(1))
    .optional()
    .describe("Optional exact-origin filter"),
  commandTimeoutMs: cliDecimalField(webRuntimeCommandTimeoutSchema),
};

/** Keep an omitted command deadline absent so Evidence records the caller selection only. */
export const selectedCommandTimeout = (
  commandTimeoutMs: number | undefined,
): { readonly command_timeout_ms?: number } =>
  commandTimeoutMs === undefined
    ? {}
    : { command_timeout_ms: commandTimeoutMs };
