import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { isDeepStrictEqual } from "node:util";
import {
  applyEdits,
  modify,
  parse as parseJsonc,
  printParseErrorCode,
  type ParseError,
} from "jsonc-parser";
import { z } from "zod";

import type { SetupClient } from "./SupportedClients.js";

export type ClientConfigurationFormat = NonNullable<SetupClient["format"]>;
export type ClientServersKey = "mcp_servers" | "mcpServers" | "mcp" | "servers";

/** Validated client document and its server table, preserving unrelated settings. */
export interface ClientConfigurationDocument {
  readonly document: Record<string, unknown>;
  readonly servers: Record<string, unknown>;
  readonly serversKey: ClientServersKey;
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

/** Return the top-level object used for MCP server registrations by a client. */
export const clientConfigurationServersKey = (
  format: ClientConfigurationFormat,
): ClientServersKey => {
  switch (format) {
    case "toml":
      return "mcp_servers";
    case "opencode":
      return "mcp";
    case "vscode":
      return "servers";
    default:
      return "mcpServers";
  }
};

const parseDocument = (
  text: string,
  format: ClientConfigurationFormat,
): Record<string, unknown> => {
  if (format === "toml") return objectSchema.parse(parseToml(text));
  const errors: ParseError[] = [];
  // Accept a UTF-8 BOM without shifting diagnostics or editing the original text.
  const jsonText = text.startsWith("\uFEFF") ? ` ${text.slice(1)}` : text;
  const document = parseJsonc(jsonText, errors, { allowTrailingComma: true });
  const firstError = errors[0];
  if (firstError !== undefined)
    throw new SyntaxError(
      `Invalid JSON/JSONC at offset ${firstError.offset}: ${printParseErrorCode(firstError.error)}`,
    );
  return objectSchema.parse(document);
};

/** Parse a client document and reject malformed roots or MCP server tables. */
export const parseClientConfiguration = (
  text: string,
  format: ClientConfigurationFormat | undefined,
): ClientConfigurationDocument => {
  if (format === undefined || format === "unsupported")
    throw new TypeError("client does not have a supported MCP config format");
  const document = parseDocument(text, format);
  const serversKey = clientConfigurationServersKey(format);
  const value = document[serversKey];
  const servers = value === undefined ? {} : objectSchema.parse(value);
  return { document, servers, serversKey };
};

/** Serialize a validated client document, retaining JSONC comments. */
export const serializeClientConfiguration = (
  document: Record<string, unknown>,
  format: ClientConfigurationFormat | undefined,
  originalText?: string,
  editedServerName?: string,
): string => {
  if (format === undefined || format === "unsupported")
    throw new TypeError("client does not have a supported MCP config format");
  if (format === "toml") return stringifyToml(document);
  if (originalText !== undefined && editedServerName !== undefined) {
    const serversKey = clientConfigurationServersKey(format);
    const servers = objectSchema.parse(document[serversKey] ?? {});
    const editedValue = Object.hasOwn(servers, editedServerName)
      ? servers[editedServerName]
      : undefined;
    const edits = modify(
      originalText,
      [serversKey, editedServerName],
      editedValue,
      {
        formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
      },
    );
    return applyEdits(originalText, edits);
  }
  return `${JSON.stringify(document, null, 2)}\n`;
};

/** Build the stdio entry shape expected by one client's configuration dialect. */
export const clientRegistrationEntry = (
  format: ClientConfigurationFormat,
  command: readonly string[],
  environment: Readonly<Record<string, string>>,
): Record<string, unknown> => {
  const [executable = "rea", ...args] = command;
  switch (format) {
    case "opencode":
      return {
        type: "local",
        command: [...command],
        enabled: true,
        ...(Object.keys(environment).length === 0
          ? {}
          : { environment: { ...environment } }),
      };
    case "vscode":
      return {
        type: "stdio",
        command: executable,
        args,
        ...(Object.keys(environment).length === 0 ? {} : { env: environment }),
      };
    case "copilot_cli":
      return {
        type: "stdio",
        command: executable,
        args,
        tools: ["*"],
        ...(Object.keys(environment).length === 0 ? {} : { env: environment }),
      };
    case "commandcode":
      return {
        transport: "stdio",
        enabled: true,
        command: executable,
        args,
        ...(Object.keys(environment).length === 0 ? {} : { env: environment }),
      };
    default:
      return {
        command: executable,
        args,
        ...(Object.keys(environment).length === 0 ? {} : { env: environment }),
      };
  }
};
