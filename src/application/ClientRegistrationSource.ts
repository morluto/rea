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
