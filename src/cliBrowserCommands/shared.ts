import { z } from "incur";

import { loadConfiguredPermissionAuthority } from "../application/PermissionConfiguration.js";
import { CdpBrowserProvider } from "../browser/CdpBrowserProvider.js";
import { parseConfig } from "../config.js";
import { projectAnalysisError } from "../domain/errors.js";
import type { JsonValue } from "../domain/jsonValue.js";

export const browserScopeOptions = {
  allowedOrigins: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Exact origins to observe; defaults to REA_BROWSER_ALLOWED_ORIGINS_JSON",
    ),
  approved: z.boolean().default(false).describe("Approve passive observation"),
};

export const boundedCount = (
  subject: string,
  maximum: number,
  fallback: number,
  minimum = 1,
) =>
  z
    .number()
    .int()
    .min(minimum)
    .max(maximum)
    .default(fallback)
    .describe(`Maximum ${subject}`);

export const boundedBytes = (
  subject: string,
  maximum: number,
  fallback: number,
) => boundedCount(`${subject} in bytes`, maximum, fallback);

export const browserContext = async () => {
  const config = parseConfig(process.env);
  if (!config.ok) return { ok: false as const, error: cliError(config.error) };
  const authority = await loadConfiguredPermissionAuthority(config.value);
  if (!authority.ok)
    return { ok: false as const, error: cliError(authority.error) };
  return {
    ok: true as const,
    authority: authority.value,
    provider: new CdpBrowserProvider(),
    allowedBrowserOrigins: config.value.browserAllowedOrigins,
  };
};

export const cliError = (
  error: Parameters<typeof projectAnalysisError>[0],
): JsonValue => ({
  error: "Browser observation failed",
  ...projectAnalysisError(error),
});
