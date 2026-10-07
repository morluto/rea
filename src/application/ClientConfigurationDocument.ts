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

/**
 * Registration entry dialect. OpenCode V2 reads V1 `mcp.<name>` entries, but a
 * document already using the native `mcp.servers` table takes native entries.
 */
export type ClientRegistrationDialect =
  | ClientConfigurationFormat
  | "opencode_v2";

/** Validated client document and its server table, preserving unrelated settings. */
export interface ClientConfigurationDocument {
  readonly document: Record<string, unknown>;
  /** Server table that registrations are written to. */
  readonly servers: Record<string, unknown>;
  /** Key path of `servers` in `document`. */
  readonly serversPath: readonly string[];
  readonly dialect: ClientRegistrationDialect;
  /**
   * OpenCode V1 server members beside a native V2 `mcp.servers` table. OpenCode
   * still loads them, and a native entry with the same name takes precedence.
   */
  readonly legacyServers: Record<string, unknown>;
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

/** Members of OpenCode V2's `mcp` object that are not server names. */
const OPENCODE_V2_MCP_SETTINGS = new Set(["servers", "timeout"]);

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
  const native = servers.servers;
  // A V1 server named `servers` has a string `type` discriminator; the V2
  // table may instead hold a server object named `type`.
  if (
    format !== "opencode" ||
    native === undefined ||
    (typeof native === "object" &&
      native !== null &&
      "type" in native &&
      typeof native.type === "string")
  )
    return {
      document,
      servers,
      serversPath: [serversKey],
      dialect: format,
      legacyServers: {},
    };
  return {
    document,
    servers: objectSchema.parse(native),
    serversPath: [serversKey, "servers"],
    dialect: "opencode_v2",
    legacyServers: Object.fromEntries(
      Object.entries(servers).filter(
        ([name]) => !OPENCODE_V2_MCP_SETTINGS.has(name),
      ),
    ),
  };
};

/** The registration a client loads for `name`, including OpenCode V1 entries. */
export const effectiveClientServer = (
  parsed: ClientConfigurationDocument,
  name: string,
): unknown =>
  Object.hasOwn(parsed.servers, name)
    ? parsed.servers[name]
    : parsed.legacyServers[name];

/**
 * Return `parsed.document` with `servers` at its server table. A legacy OpenCode
 * V1 member named in `removeLegacy` is removed beside a native V2 table.
 */
export const withClientServers = (
  parsed: ClientConfigurationDocument,
  servers: Record<string, unknown>,
  removeLegacy?: string,
): Record<string, unknown> => {
  const [key = "", nested] = parsed.serversPath;
  if (nested === undefined) return { ...parsed.document, [key]: servers };
  const outer = { ...objectSchema.parse(parsed.document[key]) };
  if (removeLegacy !== undefined && !OPENCODE_V2_MCP_SETTINGS.has(removeLegacy))
    delete outer[removeLegacy];
  return { ...parsed.document, [key]: { ...outer, [nested]: servers } };
};

/** Read the value at a key path, or `undefined` when any member is absent. */
const valueAt = (
  document: Record<string, unknown>,
  path: readonly string[],
): unknown => {
  let current: unknown = document;
  for (const key of path) {
    const object = objectSchema.safeParse(current);
    if (!object.success || !Object.hasOwn(object.data, key)) return undefined;
    current = object.data[key];
  }
  return current;
};

/** Serialize a validated client document, retaining JSONC comments. */
export const serializeClientConfiguration = (
  document: Record<string, unknown>,
  format: ClientConfigurationFormat | undefined,
  originalText?: string,
  editedPaths?: readonly (readonly string[])[],
): string => {
  if (format === undefined || format === "unsupported")
    throw new TypeError("client does not have a supported MCP config format");
  if (format === "toml") return stringifyToml(document);
  if (originalText !== undefined && editedPaths !== undefined)
    return editedPaths.reduce(
      (text, path) =>
        applyEdits(
          text,
          modify(text, [...path], valueAt(document, path), {
            formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
          }),
        ),
      originalText,
    );
  return `${JSON.stringify(document, null, 2)}\n`;
};

/** Key path of a named registration in the server table. */
export const clientServerPath = (
  parsed: ClientConfigurationDocument,
  name: string,
): string[] => [...parsed.serversPath, name];

/** Key path of a present OpenCode V1 entry beside a native V2 table. */
export const legacyClientServerPath = (
  parsed: ClientConfigurationDocument,
  name: string,
): string[] | undefined =>
  Object.hasOwn(parsed.legacyServers, name)
    ? [parsed.serversPath[0] ?? "mcp", name]
    : undefined;

/** Build the stdio entry shape expected by one client's configuration dialect. */
export const clientRegistrationEntry = (
  format: ClientRegistrationDialect,
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
    case "opencode_v2":
      // V2 connects servers unless `disabled` is true.
      return {
        type: "local",
        command: [...command],
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
