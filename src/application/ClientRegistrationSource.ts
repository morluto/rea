import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import { clientConfigurationRecordSchema } from "./ClientConfigurationDocument.js";
import type { ClientRegistrationProfile } from "./ClientRegistrationProfile.js";

/** Native source placement is selected by the registration's connection profile. */
export const clientRegistrationSource = (
  value: unknown,
  profile: ClientRegistrationProfile | undefined,
): {
  readonly source: Record<string, unknown> | undefined;
  readonly connection: Record<string, unknown> | undefined;
  readonly nested: boolean;
} => {
  const parsed = clientConfigurationRecordSchema.safeParse(value);
  if (!parsed.success)
    return { source: undefined, connection: undefined, nested: false };
  if (profile?.connection.kind === "cline") {
    const transport = clientConfigurationRecordSchema.safeParse(
      parsed.data.transport,
    );
    if (transport.success)
      return { source: parsed.data, connection: transport.data, nested: true };
  }
  return { source: parsed.data, connection: parsed.data, nested: false };
};

/**
 * Goose reads `env` as an alias of `envs`. The field is chosen by presence, so
 * a null alias stays a malformed environment rather than an absent one;
 * declaring both fields is ambiguous.
 */
export const gooseEnvironmentField = (
  connection: Record<string, unknown> | undefined,
): Result<"env" | "envs", ConfigurationError> => {
  if (connection === undefined || !Object.hasOwn(connection, "env"))
    return ok("envs");
  if (Object.hasOwn(connection, "envs"))
    return err(
      new ConfigurationError(
        "Goose environment is ambiguous: keep only envs or its env alias, not both.",
        {
          settings: [
            {
              setting: "envs",
              constraint: "env and envs declare the same native field",
            },
          ],
        },
      ),
    );
  return ok("env");
};
