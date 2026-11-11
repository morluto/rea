import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import { processArgumentSchema } from "../domain/process/processArgument.js";
import { clientConfigurationRecordSchema } from "./ClientConfigurationDocument.js";
import {
  clientRegistrationSourceFacts,
  parseClientRegistrationLauncher,
} from "./ClientRegistration.js";
import type {
  ClientRegistrationTarget,
  NativeStdioIncompatibility,
} from "./ClientRegistrationProfile.js";

export interface NativeStdioAdmissionIssue {
  readonly kind: "invalid" | "unknown";
  readonly cause: ConfigurationError;
}

/** Evaluate only the native conditions recorded by the selected client owner. */
const incompatible = (
  condition: NativeStdioIncompatibility,
  source: Record<string, unknown>,
): boolean => {
  if (condition.kind === "all")
    return condition.conditions.every((item) => incompatible(item, source));
  const value = Object.hasOwn(source, condition.field)
    ? source[condition.field]
    : undefined;
  switch (condition.kind) {
    case "truthy":
      return Boolean(value);
    case "non-nullish":
      return value !== undefined && value !== null;
    case "present":
      return Object.hasOwn(source, condition.field);
    case "missing":
      return value === undefined;
    case "nullish":
      return value === undefined || value === null;
    case "string":
      return typeof value === "string";
    case "invalid-string":
      return value !== undefined && typeof value !== "string";
    case "equals":
      return value === condition.value;
    case "required-enum":
      return typeof value !== "string" || !condition.values.includes(value);
    case "optional-enum":
      return (
        value !== undefined &&
        (typeof value !== "string" || !condition.values.includes(value))
      );
  }
};

/** Admit selected stdio separately from ownership of a retained launcher field. */
export const admitClientStdioConnection = (
  value: unknown,
  target: ClientRegistrationTarget,
): Result<{ command: string; args: string[] }, NativeStdioAdmissionIssue> => {
  const parsed = clientConfigurationRecordSchema.safeParse(value);
  if (!parsed.success)
    return err({
      kind: "invalid",
      cause: new ConfigurationError(
        "The native client connection is not an admitted server mapping.",
      ),
    });
  const source = parsed.data;
  const connection = target.profile.connection;
  if (connection.kind === "unavailable")
    return err({
      kind: "unknown",
      cause: new ConfigurationError(connection.reason),
    });
  if (connection.kind === "commandcode") {
    // Published file-loader semantics; its add-json management parser differs.
    const selector = source.transport ?? source.type ?? "";
    if (typeof selector !== "string")
      return err({
        kind: "invalid",
        cause: new ConfigurationError(
          "The selected native CommandCode transport tag must be text.",
        ),
      });
    const transport = selector.toLowerCase();
    if (
      transport === "http" ||
      transport === "sse" ||
      (transport !== "stdio" && source.url && !source.command)
    )
      return err({
        kind: "unknown",
        cause: new ConfigurationError(
          "The native CommandCode configuration selects a remote connection rather than the retained stdio launcher.",
        ),
      });
  }
  if (connection.kind === "flat") {
    const conflict = connection.stdio.find((item) =>
      incompatible(item, source),
    );
    if (conflict !== undefined)
      return err({
        kind:
          conflict.kind === "required-enum" || conflict.kind === "optional-enum"
            ? "invalid"
            : "unknown",
        cause: new ConfigurationError(
          `The native ${target.profile.nativeClient} connection does not establish the retained stdio launcher as selected. Repair its native transport selectors before treating the registration as aligned.`,
          {
            settings: [
              {
                setting:
                  conflict.kind === "all" ? "native transport" : conflict.field,
                constraint:
                  "Native connection selection does not establish stdio",
              },
            ],
          },
        ),
      });
  }
  if (connection.kind === "cline") {
    const nested = clientConfigurationRecordSchema.safeParse(source.transport);
    const type = nested.success
      ? nested.data.type
      : (source.type ?? source.transportType);
    if (type !== undefined && type !== "stdio")
      return err({
        kind: "unknown",
        cause: new ConfigurationError(
          "The native Cline transport does not select stdio.",
        ),
      });
  }
  const launcher = parseClientRegistrationLauncher(value, target);
  if (!launcher.ok) return err({ kind: "invalid", cause: launcher.error });
  if (
    [launcher.value.command, ...launcher.value.args].some(
      (word) => !processArgumentSchema.safeParse(word).success,
    )
  )
    return err({
      kind: "invalid",
      cause: new ConfigurationError(
        "The stored stdio executable or arguments contain NUL and cannot be launched. The existing registration was retained; correct its process arguments in the client settings.",
      ),
    });
  if (connection.kind === "stdio-only") {
    const applicability = clientRegistrationSourceFacts(
      target,
      [launcher.value.command, ...launcher.value.args],
      value,
    );
    if (!applicability.ok)
      return err({ kind: "unknown", cause: applicability.error });
  }
  return ok(launcher.value);
};
