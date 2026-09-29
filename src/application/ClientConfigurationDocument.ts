import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import type { SetupClient } from "./SupportedClients.js";

/** Validated client document and its server table, preserving unrelated settings. */
export interface ClientConfigurationDocument {
  readonly document: Record<string, unknown>;
  readonly servers: Record<string, unknown>;
  readonly serversKey: "mcp_servers" | "mcpServers";
}

const objectSchema = z.record(z.string(), z.unknown());

/** Compare parsed configuration values without depending on parser prototypes. */
export const clientConfigurationValuesEqual = (
  left: unknown,
  right: unknown,
): boolean =>
  isDeepStrictEqual(
    normalizeConfigurationValue(left),
    normalizeConfigurationValue(right),
  );

const normalizeConfigurationValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalizeConfigurationValue);
  if (typeof value !== "object" || value === null || value instanceof Date)
    return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, normalizeConfigurationValue(nested)]),
  );
};

/** Parse the client format and reject malformed root or server-table values. */
export const parseClientConfiguration = (
  text: string,
  format: SetupClient["format"],
): ClientConfigurationDocument => {
  const document = objectSchema.parse(
    format === "toml" ? parseToml(text) : JSON.parse(text),
  );
  const serversKey = format === "toml" ? "mcp_servers" : "mcpServers";
  const value = document[serversKey];
  const servers = value === undefined ? {} : objectSchema.parse(value);
  return { document, servers, serversKey };
};

/** Serialize a validated client document using the selected format. */
export const serializeClientConfiguration = (
  document: Record<string, unknown>,
  format: SetupClient["format"],
): string =>
  format === "toml"
    ? stringifyToml(document)
    : `${JSON.stringify(document, null, 2)}\n`;
