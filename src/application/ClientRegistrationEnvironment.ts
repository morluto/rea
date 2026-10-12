import { z } from "zod";

import { parseEnvironment } from "../config/environment.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  effectiveClientServer,
  type ClientConfigurationDocument,
} from "./ClientConfigurationDocument.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";
import { dshDocument } from "./DshCordisPatch.js";

/** Read explicit REA overrides without dropping peers when one value is invalid. */
export const clientRegistrationEnvironment = (
  parsed: ClientConfigurationDocument | undefined,
  overrides: Readonly<Record<string, string>> = {},
): Result<Readonly<Record<string, string>>, ConfigurationError> => {
  if (parsed?.dialect === "dsh")
    return dshDocument(parsed.document).environment(overrides);
  const key =
    parsed?.dialect === "opencode" || parsed?.dialect === "opencode_v2"
      ? "environment"
      : "env";
  const registration =
    parsed === undefined
      ? undefined
      : effectiveClientServer(parsed, PRODUCT_IDENTITY.mcpServerKey);
  const raw =
    typeof registration === "object" && registration !== null
      ? Reflect.get(registration, key)
      : undefined;
  const existing = z
    .record(z.string(), z.string())
    .safeParse(raw === undefined ? {} : raw);
  if (!existing.success)
    return err(
      new ConfigurationError("Invalid REA server environment", {
        settings: existing.error.issues.map((issue) => ({
          setting: [key, ...issue.path].join("."),
          constraint:
            "Server environment must be an object containing only string values",
        })),
      }),
    );
  // Validate known settings with the runtime's parser, but retain the original
  // string overrides, including unknown client-specific keys and no defaults.
  const environment = { ...existing.data, ...overrides };
  const validated = parseEnvironment(environment);
  if (!validated.ok) return validated;
  return ok(
    Object.fromEntries(
      Object.entries(environment).sort(([left], [right]) =>
        compareUnicodeCodePoints(left, right),
      ),
    ),
  );
};
