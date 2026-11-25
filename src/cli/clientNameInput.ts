import { z } from "zod";

import {
  SUPPORTED_CLIENT_DEFINITIONS,
  supportedClientDefinition,
  type SupportedClientName,
} from "../application/SupportedClients.js";
import { suggestCommand } from "./commandSuggestion.js";

const supportedClientIds = SUPPORTED_CLIENT_DEFINITIONS.map(({ name }) => name);

/** Case, surrounding space and runs of `-`, `_` or whitespace are not significant. */
const normalizedClientName = (input: string): string =>
  input
    .trim()
    .toLowerCase()
    .replace(/[-_\s]+/gu, "_");

/**
 * The supported client a typed name selects: its canonical id, or one of the
 * `rea mcp add` aliases its row declares, compared after normalization.
 */
export const resolveSupportedClientName = (
  input: string,
): SupportedClientName | undefined => {
  const key = normalizedClientName(input);
  return (
    supportedClientIds.find((id) => id === key) ??
    supportedClientIds.find((id) =>
      (supportedClientDefinition(id).mcpAdd?.aliases ?? []).some(
        (alias) => normalizedClientName(alias) === key,
      ),
    )
  );
};

const unknownClientMessage = (
  input: unknown,
  candidates: readonly string[],
): string | undefined => {
  if (typeof input !== "string") return undefined;
  const key = normalizedClientName(input);
  // An empty key is a prefix of every id, so ranking would name an arbitrary one.
  const suggestion = key === "" ? undefined : suggestCommand(key, candidates);
  return suggestion === undefined
    ? `Unknown client '${input}'. Supported clients: ${candidates.join(", ")}.`
    : `Unknown client '${input}'. Did you mean '${suggestion}'?`;
};

const resolvedClientInput = (value: unknown): unknown =>
  typeof value === "string"
    ? (resolveSupportedClientName(value) ?? value)
    : value;

/** One `--client` value, resolved to its canonical id before validation. */
export const supportedClientSchema = z.preprocess(
  resolvedClientInput,
  z.enum(supportedClientIds, {
    error: (issue) => unknownClientMessage(issue.input, supportedClientIds),
  }),
);

const skillClientIds = ["shared", ...supportedClientIds];

/** One `--skill-client` value: `shared` or a supported client. */
export const skillClientSchema = z.preprocess(
  (value) =>
    typeof value === "string" && normalizedClientName(value) === "shared"
      ? "shared"
      : resolvedClientInput(value),
  z.union([z.literal("shared"), z.enum(supportedClientIds)], {
    error: (issue) => unknownClientMessage(issue.input, skillClientIds),
  }),
);
