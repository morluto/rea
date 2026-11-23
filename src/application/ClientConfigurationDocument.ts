import { CordisDocumentError } from "./DshCordisYaml.js";
import {
  parseClientToml,
  serializeCodexConfiguration,
  serializeGrokConfiguration,
} from "./ClientConfigurationToml.js";
import {
  GooseConfigurationYamlError,
  parseGooseConfigurationYaml,
  stringifyGooseConfigurationYaml,
  editGooseConfigurationYaml,
} from "./GooseConfigurationYaml.js";

import {
  parseDshCordisDocument,
  serializeDshDocument,
  editDshDocument,
  dshClientRegistrationEntry,
} from "./DshCordisPatch.js";
import {
  editHermesConfigurationYaml,
  HermesConfigurationEditError,
  parseHermesConfigurationYaml,
  stringifyHermesConfigurationYaml,
} from "./HermesConfigurationYaml.js";
import {
  applyEdits,
  createScanner,
  format as formatJson,
  getNodeValue,
  parseTree,
  printParseErrorCode,
  type Edit,
  type Node,
  type ParseError,
  type SyntaxKind,
} from "jsonc-parser";
import { z } from "zod";

import { err, ok, type Result } from "../domain/result.js";
import { errorMessage } from "../kernel/errorMessage.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import type { SetupClient } from "./SupportedClients.js";
import {
  clientConfigurationRecordSchema,
  clientConfigurationValuesEqual,
  isEmptyClientConfigurationText,
} from "./ClientConfigurationValues.js";

export type ClientConfigurationFormat =
  | NonNullable<SetupClient["format"]>
  | "copilot_cli_project";
type ClientServersKey =
  | "mcp_servers"
  | "mcpServers"
  | "mcp"
  | "servers"
  | "amp.mcpServers"
  | "context_servers"
  | "extensions";

/**
 * Registration entry dialect. OpenCode V2 reads V1 `mcp.<name>` entries, but a
 * document already using the native `mcp.servers` table takes native entries.
 */
export type ClientRegistrationDialect =
  | ClientConfigurationFormat
  | "opencode_v2";

/** In this dialect, a higher server row supplies all of its own fields. */
export const clientServerRowsReplace = (
  dialect: ClientRegistrationDialect | undefined,
) => dialect === "opencode_v2";

/** Validated client document and its server table, preserving unrelated settings. */
export interface ClientConfigurationDocument {
  readonly document: Record<string, unknown>;
  /** A repairable source syntax is admitted for preservation but must be rewritten
   * before this client's strict reader can load the published registration. */
  readonly requiresRewrite?: true;
  /** Server table that registrations are written to. */
  readonly servers: Record<string, unknown>;
  /** Key path of `servers` in `document`. */
  readonly serversPath: readonly string[];
  readonly dialect: ClientRegistrationDialect;
  /** Member holding explicit environment overrides in a server registration. */
  readonly environmentKey: "env" | "environment" | "envs";
  /**
   * OpenCode V1 server members beside a native V2 `mcp.servers` table. OpenCode
   * still loads them, and a native entry with the same name takes precedence.
   */
  readonly legacyServers: Record<string, unknown>;
}

/**
 * Configuration a client reads from an environment variable instead of a file.
 * It is the client's highest-precedence layer, and REA never writes it.
 */
export interface ClientInlineConfiguration {
  readonly origin: "KILO_CONFIG_CONTENT";
  readonly parsed: ClientConfigurationDocument;
}

/** Return the top-level object used for MCP server registrations by a client. */
export const clientConfigurationServersKey = (
  format: ClientConfigurationFormat,
): ClientServersKey => {
  switch (format) {
    case "toml":
    case "grok":
    case "hermes":
      return "mcp_servers";
    case "opencode":
    case "zcode":
    case "kilo":
    case "mimo":
      return "mcp";
    case "amp":
      return "amp.mcpServers";
    case "zed":
      return "context_servers";
    case "goose":
      return "extensions";
    case "vscode":
      return "servers";
    default:
      return "mcpServers";
  }
};

/**
 * How a client's own loader reads its configuration file: the syntax and the
 * strictness, byte-order-mark and empty-file rules REA must match so it never
 * accepts or writes a document the client rejects. This is the only owner of
 * those facts; the registration dialect (server table, entry shape) is separate.
 */
type ClientConfigurationReader =
  | { readonly syntax: "toml" }
  | {
      readonly syntax: "yaml";
      readonly parse?: (text: string) => unknown;
    }
  | {
      readonly syntax: "json";
      /** What the client's loader accepts: strict `JSON.parse` or JSONC. */
      readonly native: "json" | "jsonc";
      /**
       * REA admits JSONC for a strict client only when it rewrites the whole
       * file as strict JSON before the client reads it again.
       */
      readonly repairsJsonc?: true;
      /** Whether a leading UTF-8 byte-order mark is accepted. */
      readonly bom: "accept" | "reject";
      /** An empty (blank or BOM-only) file holds no settings, or is invalid. */
      readonly emptyFile: "no-settings" | "reject";
    };

const JSONC_READER = {
  syntax: "json",
  native: "jsonc",
  bom: "accept",
  emptyFile: "no-settings",
} as const satisfies ClientConfigurationReader;
const STRICT_JSON_REPAIRED_READER = {
  syntax: "json",
  native: "json",
  repairsJsonc: true,
  bom: "accept",
  emptyFile: "no-settings",
} as const satisfies ClientConfigurationReader;
/** Strict `JSON.parse` without BOM tolerance; an empty file holds no settings. */
const STRICT_JSON_READER = {
  syntax: "json",
  native: "json",
  bom: "reject",
  emptyFile: "no-settings",
} as const satisfies ClientConfigurationReader;

const CLIENT_CONFIGURATION_READERS = {
  json: JSONC_READER,
  vscode: JSONC_READER,
  opencode: JSONC_READER,
  commandcode: JSONC_READER,
  omp: JSONC_READER,
  amp: JSONC_READER,
  zed: JSONC_READER,
  kilo: JSONC_READER,
  // Copilot CLI and fx load strict JSON; admitted JSONC is rewritten.
  copilot_cli: STRICT_JSON_REPAIRED_READER,
  copilot_cli_project: STRICT_JSON_REPAIRED_READER,
  fx: STRICT_JSON_REPAIRED_READER,
  // Claude Code loads `.claude.json` with strict JSON.parse after a UTF-8 BOM,
  // so comments and trailing commas it rejects must not be admitted as JSONC.
  claude_code: { ...STRICT_JSON_READER, bom: "accept" },
  // Kimi, LM Studio and ZCode read their files with JSON.parse; an empty
  // file holds nothing to preserve.
  // MiMo Code reads `mimocode.jsonc`, and its own writer preserves comments.
  mimo: JSONC_READER,
  kimi: STRICT_JSON_READER,
  lm_studio: STRICT_JSON_READER,
  zcode: STRICT_JSON_READER,
  // Pi loads `mcp.json` with a strict `JSON.parse` and no BOM tolerance, so
  // comments, trailing commas, a BOM, or an empty existing file must be
  // rejected instead of registering into a document the client cannot load.
  pi: { ...STRICT_JSON_READER, emptyFile: "reject" },
  zcode_fallback: { ...STRICT_JSON_READER, emptyFile: "reject" },
  toml: { syntax: "toml" },
  grok: { syntax: "toml" },
  goose: { syntax: "yaml", parse: parseGooseConfigurationYaml },
  // Hermes stores MCP servers in `mcp_servers` inside a YAML document.
  hermes: { syntax: "yaml", parse: parseHermesConfigurationYaml },
  // DeepSeek Harness reads a Cordis patch list; its own parser owns the shape.
  dsh: { syntax: "yaml" },
} as const satisfies Record<
  Exclude<ClientConfigurationFormat, "unsupported">,
  ClientConfigurationReader
>;

/** The client loader's reader for one configuration format. */
const clientConfigurationReader = (
  format: Exclude<ClientConfigurationFormat, "unsupported">,
): ClientConfigurationReader => CLIENT_CONFIGURATION_READERS[format];

/** The syntax name REA's reader admits for a format, for diagnostics. */
export const clientConfigurationSyntaxName = (
  format: Exclude<ClientConfigurationFormat, "unsupported">,
): "JSON" | "JSONC" | "TOML" | "YAML" => {
  const reader = clientConfigurationReader(format);
  if (reader.syntax === "toml") return "TOML";
  if (reader.syntax === "yaml") return "YAML";
  return reader.native === "json" && reader.repairsJsonc !== true
    ? "JSON"
    : "JSONC";
};

/** Read the document and identify a repairable syntax at the same boundary. */
const parseDocument = (
  text: string,
  format: Exclude<ClientConfigurationFormat, "unsupported">,
  root = "The configuration root",
): Pick<ClientConfigurationDocument, "document" | "requiresRewrite"> => {
  const reader = clientConfigurationReader(format);
  if (reader.syntax === "toml")
    return { document: requireObject(parseClientToml(text), root) };
  const repair = reader.syntax === "json" && reader.repairsJsonc === true;
  // An empty file, which some clients create before any server is added,
  // holds no settings to preserve.
  if (
    (reader.syntax === "yaml" || reader.emptyFile === "no-settings") &&
    isEmptyClientConfigurationText(text)
  )
    return repair ? { document: {}, requiresRewrite: true } : { document: {} };
  if (reader.syntax === "yaml") {
    if (reader.parse === undefined)
      throw new TypeError(`${format} configuration has a dedicated parser`);
    return { document: requireObject(reader.parse(text), root) };
  }
  if (reader.native === "json") {
    const input =
      !repair && reader.bom === "accept" ? text.replace(/^\uFEFF/, "") : text;
    try {
      return { document: requireObject(JSON.parse(input), root) };
    } catch (cause: unknown) {
      if (!repair || !(cause instanceof SyntaxError)) throw cause;
    }
  }
  const errors: ParseError[] = [];
  // Accept a UTF-8 BOM without shifting diagnostics or editing the original text.
  const jsonText = text.startsWith("\uFEFF") ? ` ${text.slice(1)}` : text;
  const tree = parseTree(jsonText, errors, { allowTrailingComma: true });
  const firstError = errors[0];
  if (firstError !== undefined)
    throw new SyntaxError(
      `Invalid JSON/JSONC at offset ${firstError.offset}: ${printParseErrorCode(firstError.error)}`,
    );
  return {
    document: requireObject(
      tree === undefined ? undefined : getNodeValue(tree),
      root,
    ),
    ...(repair ? { requiresRewrite: true } : {}),
  };
};

/** A parsed configuration whose structure, not its syntax, cannot hold MCP servers. */
class ClientConfigurationShapeError extends TypeError {}

/** Validate source mappings and copy their own properties without rewriting values. */
const requireObject = (
  value: unknown,
  description: string,
): Record<string, unknown> => {
  const parsed = clientConfigurationRecordSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new ClientConfigurationShapeError(`${description} must be an object`, {
    cause: parsed.error,
  });
};

/** ZCode reads the same-scope fallback as strict JSON with a mcpServers table. */
const parseZcodeFallbackConfiguration = (
  text: string,
): ClientConfigurationDocument => {
  const { document } = parseDocument(
    text,
    "zcode_fallback",
    "ZCode fallback root",
  );
  return {
    document,
    servers:
      document.mcpServers === undefined
        ? {}
        : requireObject(document.mcpServers, "ZCode fallback mcpServers"),
    serversPath: ["mcpServers"],
    dialect: "zcode_fallback",
    environmentKey: "env",
    legacyServers: {},
  };
};

/** Members of OpenCode V2's `mcp` object that are not server names. */
const OPENCODE_V2_MCP_SETTINGS = new Set(["servers", "timeout"]);

/** Fx's native writer preserves a sole profile table and rejects hidden peers. */
const fxConfigurationServersKey = (
  document: Record<string, unknown>,
): "mcp" | "mcpServers" => {
  const legacy = Object.hasOwn(document, "mcp");
  if (legacy && Object.hasOwn(document, "mcpServers"))
    throw new ClientConfigurationShapeError(
      'Fx profile contains both "mcp" and "mcpServers". Consolidate these into one server table before registering so existing servers remain visible.',
    );
  return legacy ? "mcp" : "mcpServers";
};

const readClientDocument = (
  text: string,
  format: Exclude<ClientConfigurationFormat, "unsupported">,
): ClientConfigurationDocument => {
  // DeepSeek Harness stores a Cordis patch list, not a server table.
  if (format === "zcode_fallback") return parseZcodeFallbackConfiguration(text);
  if (format === "dsh") return parseDshCordisDocument(text);
  const { document, requiresRewrite } = parseDocument(text, format);
  if (
    format === "copilot_cli_project" &&
    !Object.hasOwn(document, "mcpServers")
  ) {
    const serverLike = (value: unknown): boolean => {
      const entry = clientConfigurationRecordSchema.safeParse(value);
      return (
        entry.success &&
        ["command", "url", "type"].some(
          (key) => typeof entry.data[key] === "string",
        )
      );
    };
    const wrapper = clientConfigurationRecordSchema.safeParse(document.servers);
    if (
      wrapper.success &&
      !serverLike(wrapper.data) &&
      Object.values(wrapper.data).some(serverLike)
    )
      throw new ClientConfigurationShapeError(
        'Copilot CLI reads mcpServers or a bare server map, not the VS Code "servers" wrapper. Select --agent vscode for that document.',
      );
    const entries = Object.values(document);
    if (entries.length > 0 && entries.every(serverLike))
      return {
        document,
        ...(requiresRewrite === undefined ? {} : { requiresRewrite }),
        servers: document,
        serversPath: [],
        dialect: format,
        environmentKey: "env",
        legacyServers: {},
      };
  }
  const environmentKey =
    format === "opencode" ||
    format === "fx" ||
    format === "kilo" ||
    format === "mimo"
      ? "environment"
      : format === "goose"
        ? "envs"
        : "env";
  const serversKey =
    format === "fx"
      ? fxConfigurationServersKey(document)
      : clientConfigurationServersKey(format);
  const value = document[serversKey];
  const servers =
    value === undefined ? {} : requireObject(value, `"${serversKey}"`);
  // ZCode reads stdio servers from the nested `mcp.servers` table of
  // `~/.zcode/cli/config.json`; entries carry `command`, `args`, and `env`.
  if (format === "zcode") {
    const nested = servers.servers;
    return {
      document,
      servers:
        nested === undefined
          ? {}
          : requireObject(nested, `"${serversKey}.servers"`),
      serversPath: [serversKey, "servers"],
      dialect: format,
      environmentKey,
      legacyServers: {},
    };
  }
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
      ...(requiresRewrite === undefined ? {} : { requiresRewrite }),
      servers,
      serversPath: [serversKey],
      dialect: format,
      environmentKey,
      legacyServers: {},
    };
  return {
    document,
    servers: requireObject(native, `"${serversKey}.servers"`),
    serversPath: [serversKey, "servers"],
    dialect: "opencode_v2",
    environmentKey,
    legacyServers: Object.fromEntries(
      Object.entries(servers).filter(
        ([name]) => !OPENCODE_V2_MCP_SETTINGS.has(name),
      ),
    ),
  };
};

type NativeDocumentError =
  | CordisDocumentError
  | GooseConfigurationYamlError
  | HermesConfigurationEditError;

interface NativeDocumentFailure {
  readonly kind: "document";
  readonly detail: string;
  readonly cause: NativeDocumentError;
}

const isNativeDocumentError = (cause: unknown): cause is NativeDocumentError =>
  cause instanceof CordisDocumentError ||
  cause instanceof GooseConfigurationYamlError ||
  cause instanceof HermesConfigurationEditError;

export type ClientConfigurationParseFailure =
  | NativeDocumentFailure
  | {
      readonly kind: "unsupported" | "syntax" | "shape";
      readonly detail: string;
      readonly cause?: unknown;
    };

/** Parse one native client document and retain its failure at the format boundary. */
export const parseClientConfiguration = (
  text: string,
  format: ClientConfigurationFormat | undefined,
): Result<ClientConfigurationDocument, ClientConfigurationParseFailure> => {
  if (format === undefined || format === "unsupported")
    return err({
      kind: "unsupported",
      detail: "client does not have a supported MCP config format",
    });
  try {
    return ok(readClientDocument(text, format));
  } catch (cause: unknown) {
    if (isNativeDocumentError(cause))
      return err({ kind: "document", detail: cause.message, cause });
    return err({
      kind: cause instanceof ClientConfigurationShapeError ? "shape" : "syntax",
      detail: errorMessage(cause),
      cause,
    });
  }
};

/** Interpret activation in the authored dialect and preserve malformed values. */
export const openCodeDisabled = (
  { enabled, disabled }: Record<string, unknown>,
  dialect: "opencode" | "opencode_v2",
): unknown =>
  dialect === "opencode" && enabled !== undefined
    ? typeof enabled === "boolean"
      ? !enabled
      : enabled
    : disabled;

/** Read a server row in the shared effective representation. */
export const effectiveClientServer = (
  parsed: ClientConfigurationDocument,
  name: string,
): unknown => {
  const native = Object.hasOwn(parsed.servers, name);
  const value = native
    ? parsed.servers[name]
    : Object.hasOwn(parsed.legacyServers, name)
      ? parsed.legacyServers[name]
      : undefined;
  if (
    (parsed.dialect !== "opencode" && parsed.dialect !== "opencode_v2") ||
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  )
    return value;
  const entry = value as Record<string, unknown>;
  const disabled = openCodeDisabled(
    entry,
    parsed.dialect === "opencode_v2" && native ? "opencode_v2" : "opencode",
  );
  const { enabled: _enabled, disabled: _disabled, ...registration } = entry;
  return disabled === undefined ? registration : { ...registration, disabled };
};

/** Preserve source policy when editing its native table. A legacy OpenCode
 * entry moving to the V2 table first uses that owner's activation migration. */
export const clientServerForEdit = (
  parsed: ClientConfigurationDocument,
  name: string,
): unknown =>
  Object.hasOwn(parsed.servers, name)
    ? parsed.servers[name]
    : parsed.dialect === "opencode_v2"
      ? effectiveClientServer(parsed, name)
      : undefined;

/**
 * Return `parsed.document` with `servers` at its server table. A legacy OpenCode
 * V1 member named in `removeLegacy` is removed beside a native V2 table. The
 * platform names the environment identity a Cordis entry is written with.
 */
export const withClientServers = (
  parsed: ClientConfigurationDocument,
  servers: Record<string, unknown>,
  platform: NodeJS.Platform,
  removeLegacy?: string,
): Record<string, unknown> => {
  // The Harness patch list upserts or removes by entry id, not by table.
  if (parsed.dialect === "dsh")
    return Object.hasOwn(servers, PRODUCT_IDENTITY.mcpServerKey)
      ? editDshDocument(parsed, {
          desired: clientConfigurationRecordSchema.parse(
            servers[PRODUCT_IDENTITY.mcpServerKey],
          ),
          platform,
        })
      : editDshDocument(parsed);
  if (parsed.serversPath.length === 0) return { ...servers };
  const [key = "", nested] = parsed.serversPath;
  if (nested === undefined) return { ...parsed.document, [key]: servers };
  // A fresh document may not hold the outer table yet (for example a new
  // ZCode `config.json` without an `mcp` object), so treat absence as empty.
  const outerValue = parsed.document[key];
  const outer =
    outerValue === undefined
      ? {}
      : clientConfigurationRecordSchema.parse(outerValue);
  if (
    parsed.dialect === "opencode_v2" &&
    removeLegacy !== undefined &&
    !OPENCODE_V2_MCP_SETTINGS.has(removeLegacy)
  )
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
    const object = clientConfigurationRecordSchema.safeParse(current);
    if (!object.success || !Object.hasOwn(object.data, key)) return undefined;
    current = object.data[key];
  }
  return current;
};

/** Whether Grok Build's root disable list names `serverKey`. */
const grokServerListedDisabled = (
  document: Record<string, unknown>,
  serverKey: string,
): boolean =>
  Array.isArray(document.disabled_mcp_servers) &&
  document.disabled_mcp_servers.includes(serverKey);

/**
 * OMP's user `disabledServers` denylist hides a server by name regardless of
 * its entry, so a listed REA registration is not loaded.
 */
export const OMP_DISABLED_SERVERS_KEY = "disabledServers";

/** Whether OMP's root `disabledServers` denylist names `serverKey`. */
const ompServerListedDisabled = (
  document: Record<string, unknown>,
  serverKey: string,
): boolean => {
  const listed = document[OMP_DISABLED_SERVERS_KEY];
  return Array.isArray(listed) && listed.includes(serverKey);
};

/** OMP's user `enabledServers` allowlist overrides an entry's `enabled: false`. */
const OMP_ENABLED_SERVERS_KEY = "enabledServers";

/**
 * Whether OMP's allowlist forces `serverKey` on despite its entry's
 * `enabled: false`. The `disabledServers` denylist still wins over it.
 */
export const clientServerForcedEnabled = (
  parsed: ClientConfigurationDocument,
  serverKey: string,
): boolean => {
  if (parsed.dialect !== "omp") return false;
  const listed = parsed.document[OMP_ENABLED_SERVERS_KEY];
  return Array.isArray(listed) && listed.includes(serverKey);
};

/** Whether a client's own disable list suppresses `serverKey`. */
export const clientServerListedDisabled = (
  parsed: ClientConfigurationDocument,
  serverKey: string,
): boolean =>
  (parsed.dialect === "grok" &&
    grokServerListedDisabled(parsed.document, serverKey)) ||
  (parsed.dialect === "omp" &&
    ompServerListedDisabled(parsed.document, serverKey));

// jsonc-parser declares SyntaxKind as an ambient const enum, so keep its token
// code local and type-checked as in the JSON scanner used by IDA diagnostics.
const JSON_COMMA = 5 satisfies SyntaxKind;

/** Find the next non-trivia JSONC token at or after `offset`. */
const nextJsoncToken = (
  text: string,
  offset: number,
): { readonly kind: SyntaxKind; readonly offset: number } => {
  const scanner = createScanner(text, true);
  scanner.setPosition(offset);
  const kind = scanner.scan();
  return { kind, offset: scanner.getTokenOffset() };
};

const isJsonMember = (property: Node, key: string): boolean =>
  property.children?.length === 2 && property.children[0]?.value === key;

/**
 * The property a client reads for `key`. `JSON.parse` and JSONC `parse` keep
 * the last duplicate member, while jsonc-parser's `findNodeAtLocation` and
 * `modify` select the first, so JSON text edits locate members only here.
 */
const effectiveJsonProperty = (object: Node, key: string): Node | undefined =>
  object.children?.findLast((property) => isJsonMember(property, key));

/** The object a client reads at `path`, following the effective members. */
const effectiveJsonObject = (
  root: Node | undefined,
  path: readonly string[],
): Node | undefined => {
  let node = root;
  for (const key of path) {
    if (node?.type !== "object") return undefined;
    node = effectiveJsonProperty(node, key)?.children?.[1];
  }
  return node?.type === "object" ? node : undefined;
};

/**
 * Earlier members of one server name repeated in the tables a client reads,
 * in document order. Parsing keeps only the last member, as clients do.
 */
export interface ShadowedClientServers {
  readonly servers: readonly unknown[];
  /** Repeats among OpenCode V1 members beside a native V2 table. */
  readonly legacyServers: readonly unknown[];
}

const NO_SHADOWED_SERVERS: ShadowedClientServers = Object.freeze({
  servers: [],
  legacyServers: [],
});

// Token codes follow the pinned jsonc-parser scanner, as JSON_COMMA does.
const JSON_STRING = 10 satisfies SyntaxKind;
const JSON_EOF = 17 satisfies SyntaxKind;

/** A conservative duplicate check using the parser's own string decoder. */
const hasRepeatedJsonString = (text: string, name: string): boolean => {
  const scanner = createScanner(text, true);
  let matches = 0;
  for (let token = scanner.scan(); token !== JSON_EOF; token = scanner.scan()) {
    if (token === JSON_STRING && scanner.getTokenValue() === name) {
      matches += 1;
      if (matches === 2) return true;
    }
  }
  return false;
};

/** Values of the earlier members named `name` in `object`. */
const shadowedJsonMembers = (
  object: Node | undefined,
  name: string,
): readonly unknown[] =>
  (object?.children ?? [])
    .filter((property) => isJsonMember(property, name))
    .slice(0, -1)
    .map((property): unknown => {
      const value = property.children?.[1];
      return value === undefined ? undefined : getNodeValue(value);
    });

/**
 * Earlier members of `name` that removing its effective entry would make
 * effective, so a removal decision must cover them too. Locating them needs a
 * syntax tree of the whole document, which is built only when the name's
 * string token occurs more than once.
 */
export const shadowedClientServers = (
  text: string,
  parsed: ClientConfigurationDocument,
  name: string,
): ShadowedClientServers => {
  // TOML rejects repeated keys, Hermes parses YAML with unique keys, and the
  // Harness owner edits REA's entry by id rather than through a server table.
  if (
    parsed.dialect === "toml" ||
    parsed.dialect === "grok" ||
    parsed.dialect === "hermes" ||
    parsed.dialect === "dsh" ||
    !hasRepeatedJsonString(text, name)
  )
    return NO_SHADOWED_SERVERS;
  const root = parseTree(text, [], { allowTrailingComma: true });
  return {
    servers: shadowedJsonMembers(
      effectiveJsonObject(root, parsed.serversPath),
      name,
    ),
    legacyServers:
      parsed.dialect === "opencode_v2" && !OPENCODE_V2_MCP_SETTINGS.has(name)
        ? shadowedJsonMembers(
            effectiveJsonObject(root, parsed.serversPath.slice(0, 1)),
            name,
          )
        : [],
  };
};

/** Apply one edit and format the lines it touched, as `modify` does. */
const applyFormattedJsonEdit = (text: string, edit: Edit): string => {
  const edited = applyEdits(text, [edit]);
  let begin = edit.offset;
  let end = edit.offset + edit.content.length;
  if (edit.length === 0) {
    while (begin > 0 && !"\r\n".includes(edited.charAt(begin - 1))) begin -= 1;
    while (end < edited.length && !"\r\n".includes(edited.charAt(end)))
      end += 1;
  }
  return applyEdits(
    edited,
    formatJson(
      edited,
      { offset: begin, length: end - begin },
      { insertSpaces: true, tabSize: 2, eol: "\n", keepLines: false },
    ),
  );
};

/** Remove selected member spans and only the separators needed by kept members. */
const jsonChildRemovalEdits = (
  text: string,
  object: Node,
  properties: readonly Node[],
): Edit[] => {
  const siblings = object.children ?? [];
  const removed = new Set(properties);
  const anyKept = siblings.some((member) => !removed.has(member));
  const edits: Edit[] = [];
  let earlierKept = false;
  for (const [index, member] of siblings.entries()) {
    if (removed.has(member))
      edits.push({ offset: member.offset, length: member.length, content: "" });
    else earlierKept = true;
    const separator = nextJsoncToken(text, member.offset + member.length);
    const next = siblings[index + 1];
    if (separator.kind !== JSON_COMMA && next !== undefined)
      throw new TypeError("JSON property separator was not found");
    // Keep the separator before the next retained member, matching the
    // existing single-member deletion rule. JSONC may retain a trailing comma.
    const keepSeparator =
      next === undefined ? anyKept : earlierKept && !removed.has(next);
    if (separator.kind === JSON_COMMA && !keepSeparator)
      edits.push({ offset: separator.offset, length: 1, content: "" });
  }
  return edits;
};

const deleteJsonMembers = (
  text: string,
  object: Node,
  properties: readonly Node[],
): string => applyEdits(text, jsonChildRemovalEdits(text, object, properties));

/**
 * Edit values through their source nodes. Parsed numbers are useful for deciding
 * whether a field changed, but serializing unchanged values would discard their
 * original precision and spelling. Only effective object members are updated;
 * removing a nested field removes every repeat, as replacing its owning object
 * did, so an earlier field cannot become active.
 */
const jsonValueEdits = (text: string, node: Node, value: unknown): Edit[] => {
  if (node.type === "object") {
    const record = clientConfigurationRecordSchema.safeParse(value);
    if (record.success) {
      const members = node.children ?? [];
      const removed = members.filter((member) => {
        const key: unknown = member.children?.[0]?.value;
        return (
          typeof key === "string" &&
          (!Object.hasOwn(record.data, key) || record.data[key] === undefined)
        );
      });
      const edits = jsonChildRemovalEdits(text, node, removed);
      const added: string[] = [];
      for (const [key, next] of Object.entries(record.data)) {
        if (next === undefined) continue;
        const child = effectiveJsonProperty(node, key)?.children?.[1];
        if (child === undefined)
          added.push(`${JSON.stringify(key)}:${JSON.stringify(next)}`);
        else edits.push(...jsonValueEdits(text, child, next));
      }
      if (added.length > 0)
        edits.push({
          offset: node.offset + 1,
          length: 0,
          content:
            added.join(",") +
            (members.some((member) => !removed.includes(member)) ? "," : ""),
        });
      return edits;
    }
  }
  if (node.type === "array" && Array.isArray(value)) {
    const children = node.children ?? [];
    const edits = jsonChildRemovalEdits(
      text,
      node,
      children.slice(value.length),
    );
    for (const [index, child] of children.slice(0, value.length).entries())
      edits.push(...jsonValueEdits(text, child, value[index] ?? null));
    if (value.length > children.length) {
      const previous = children.at(-1);
      edits.push({
        offset:
          previous === undefined
            ? node.offset + 1
            : previous.offset + previous.length,
        length: 0,
        content:
          (previous === undefined ? "" : ",") +
          value
            .slice(children.length)
            .map((entry) => JSON.stringify(entry ?? null))
            .join(","),
      });
    }
    return edits;
  }
  return Object.is(node.value, value)
    ? []
    : [
        {
          offset: node.offset,
          length: node.length,
          content: JSON.stringify(value),
        },
      ];
};

// Token codes are checked against jsonc-parser's ambient enum.
const JSON_CLOSE_BRACE = 2 satisfies SyntaxKind;
const JSON_CLOSE_BRACKET = 4 satisfies SyntaxKind;
const JSON_LINE_COMMENT = 12 satisfies SyntaxKind;
const JSON_BLOCK_COMMENT = 13 satisfies SyntaxKind;

/** Remove JSONC syntax without decoding and re-encoding source value tokens. */
const strictJsonSyntax = (source: string): string => {
  const text = source.startsWith("\uFEFF") ? source.slice(1) : source;
  const scanner = createScanner(text, false);
  const edits: Edit[] = [];
  for (let token = scanner.scan(); token !== JSON_EOF; token = scanner.scan()) {
    const offset = scanner.getTokenOffset();
    if (token === JSON_LINE_COMMENT || token === JSON_BLOCK_COMMENT)
      edits.push({ offset, length: scanner.getTokenLength(), content: " " });
    else if (token === JSON_COMMA) {
      const next = nextJsoncToken(text, offset + 1);
      if (next.kind === JSON_CLOSE_BRACE || next.kind === JSON_CLOSE_BRACKET)
        edits.push({ offset, length: 1, content: "" });
    }
  }
  return applyEdits(text, edits);
};

/** A JSON edit refused because it would activate a shadowed duplicate member. */
export interface ClientConfigurationShadowedMember {
  readonly kind: "shadowed_member";
  /** Key path of the effective member whose removal was refused. */
  readonly path: readonly string[];
}

/**
 * Set or delete the member a client reads at `path`, keeping every byte
 * outside that member. Shadowed duplicates stay in place, and deleting a
 * member that shadows one is refused so the earlier member never becomes
 * active, unless the caller has established removal authority for that path.
 */
const editJsonMember = (
  text: string,
  path: readonly string[],
  value: unknown,
  removeShadowedMembers: boolean,
): Result<string, ClientConfigurationShadowedMember> => {
  let object = parseTree(text, [], { allowTrailingComma: true });
  for (const [index, key] of path.entries()) {
    if (object?.type !== "object")
      throw new TypeError("JSON edit parent is not an object");
    const property = effectiveJsonProperty(object, key);
    const member = property?.children?.[1];
    if (property === undefined || member === undefined) {
      if (value === undefined) return ok(text);
      const content = `${JSON.stringify(key)}: ${JSON.stringify(
        path
          .slice(index + 1)
          .reduceRight<unknown>((nested, name) => ({ [name]: nested }), value),
      )}`;
      const previous = object.children?.at(-1);
      return ok(
        applyFormattedJsonEdit(
          text,
          previous === undefined
            ? { offset: object.offset + 1, length: 0, content }
            : {
                offset: previous.offset + previous.length,
                length: 0,
                content: `,${content}`,
              },
        ),
      );
    }
    if (index < path.length - 1) {
      object = member;
      continue;
    }
    if (value !== undefined)
      return ok(applyEdits(text, jsonValueEdits(text, member, value)));
    if (
      object.children?.some(
        (sibling) => sibling !== property && isJsonMember(sibling, key),
      )
    )
      return removeShadowedMembers
        ? ok(
            deleteJsonMembers(
              text,
              object,
              (object.children ?? []).filter((sibling) =>
                isJsonMember(sibling, key),
              ),
            ),
          )
        : err({ kind: "shadowed_member", path });
    return ok(deleteJsonMembers(text, object, [property]));
  }
  throw new TypeError("JSON edit path is empty");
};

/** Edit authority beyond the members a client reads. */
export interface ClientConfigurationEditOptions {
  /**
   * Exact deleted paths whose repeated members the caller may remove.
   * Uninstall must establish ownership of every shadowed member; setup may
   * grant replacement authority for an explicitly superseded registration.
   */
  readonly removeShadowedMembersAt?: readonly (readonly string[])[];
}

/**
 * Serialize a validated client document, retaining JSONC and TOML comments.
 * JSON edits fail only when they would activate a shadowed duplicate member.
 */
const editClientDocument = (
  document: Record<string, unknown>,
  format: ClientConfigurationFormat | undefined,
  originalText?: string,
  editedPaths?: readonly (readonly string[])[],
  options: ClientConfigurationEditOptions = {},
): Result<string, ClientConfigurationShadowedMember> => {
  if (format === undefined || format === "unsupported")
    throw new TypeError("client does not have a supported MCP config format");
  if (format === "toml")
    return ok(serializeCodexConfiguration(document, originalText));
  if (format === "grok")
    return ok(serializeGrokConfiguration(document, originalText));
  if (format === "hermes")
    return ok(serializeHermesConfiguration(document, originalText));
  if (format === "goose") {
    if (originalText === undefined || editedPaths === undefined)
      return ok(stringifyGooseConfigurationYaml(document));
    let text = originalText;
    for (const path of editedPaths)
      text = editGooseConfigurationYaml(text, path, valueAt(document, path));
    return ok(text);
  }
  if (format === "dsh") return ok(serializeDshDocument(document));
  // An empty original holds no comments or settings to preserve. Writing a
  // fresh document also keeps a lone BOM from shifting past the closing brace.
  if (
    originalText === undefined ||
    isEmptyClientConfigurationText(originalText)
  )
    return ok(`${JSON.stringify(document, null, 2)}\n`);
  let text = originalText;
  if (editedPaths === undefined) {
    const root = parseTree(text, [], { allowTrailingComma: true });
    if (root === undefined) throw new TypeError("JSON document is missing");
    text = applyEdits(text, jsonValueEdits(text, root, document));
  }
  for (const path of editedPaths ?? []) {
    const edited = editJsonMember(
      text,
      path,
      valueAt(document, path),
      options.removeShadowedMembersAt?.some(
        (allowed) =>
          allowed.length === path.length &&
          allowed.every((key, index) => key === path[index]),
      ) ?? false,
    );
    if (!edited.ok) return edited;
    text = edited.value;
  }
  const reader = clientConfigurationReader(format);
  return ok(
    reader.syntax === "json" && reader.repairsJsonc === true
      ? strictJsonSyntax(text)
      : text,
  );
};

export type ClientConfigurationEditFailure =
  | ClientConfigurationShadowedMember
  | NativeDocumentFailure
  | { readonly kind: "serialize"; readonly cause: unknown };

export const serializeClientConfiguration = (
  ...args: Parameters<typeof editClientDocument>
): Result<string, ClientConfigurationEditFailure> => {
  try {
    return editClientDocument(...args);
  } catch (cause: unknown) {
    return isNativeDocumentError(cause)
      ? err({ kind: "document", detail: cause.message, cause })
      : err({ kind: "serialize", cause });
  }
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

/**
 * Keep an existing Hermes `config.yaml` intact aside from the REA server entry.
 * Hermes config files carry user comments and unrelated settings, so the rea
 * entry is upserted into the parsed YAML document (which retains formatting and
 * comments) rather than re-serializing the whole object.
 */
const serializeHermesConfiguration = (
  document: Record<string, unknown>,
  originalText: string | undefined,
): string => {
  if (
    originalText === undefined ||
    isEmptyClientConfigurationText(originalText)
  )
    return stringifyHermesConfigurationYaml(document);
  const serversKey = clientConfigurationServersKey("hermes");
  const servers = document[serversKey];
  const entry =
    typeof servers === "object" && servers !== null
      ? (servers as Record<string, unknown>)[PRODUCT_IDENTITY.mcpServerKey]
      : undefined;
  return editHermesConfigurationYaml(
    originalText,
    [serversKey, PRODUCT_IDENTITY.mcpServerKey],
    entry,
  );
};

/** Build the stdio entry shape expected by one client's configuration dialect. */
/** Native launcher fields shared by setup and explicit MCP registration. */
export const clientRegistrationLauncherEntry = (
  format: ClientRegistrationDialect,
  command: readonly string[],
): Record<string, unknown> => {
  const [executable = "rea", ...args] = command;
  switch (format) {
    case "opencode":
    case "opencode_v2":
    case "fx":
    case "kilo":
    case "mimo":
      return { type: "local", command: [...command] };
    case "goose":
      return { type: "stdio", cmd: executable, args };
    case "vscode":
    case "omp":
    case "pi":
    case "copilot_cli":
    case "copilot_cli_project":
      return { type: "stdio", command: executable, args };
    case "commandcode":
      return { transport: "stdio", command: executable, args };
    default:
      return { command: executable, args };
  }
};

/** Setup defaults and explicit environment extend the same native launcher facts. */
export const clientRegistrationEntry = (
  format: ClientRegistrationDialect,
  command: readonly string[],
  environment: Readonly<Record<string, string>>,
): Record<string, unknown> => {
  if (format === "dsh") return dshClientRegistrationEntry(command, environment);
  const defaults =
    format === "opencode_v2"
      ? { disabled: false }
      : format === "copilot_cli"
        ? { tools: ["*"] }
        : format === "goose"
          ? {
              name: PRODUCT_IDENTITY.mcpServerKey,
              description: "",
              envs: {},
              enabled: true,
              timeout: 300,
            }
          : ["opencode", "commandcode", "hermes", "fx", "kilo"].includes(format)
            ? { enabled: true }
            : {};
  const environmentKey = ["opencode", "opencode_v2", "fx", "kilo"].includes(
    format,
  )
    ? "environment"
    : format === "goose"
      ? "envs"
      : "env";
  return {
    ...clientRegistrationLauncherEntry(format, command),
    ...defaults,
    ...(Object.keys(environment).length === 0
      ? {}
      : { [environmentKey]: { ...environment } }),
  };
};

/** Parse one Gemini policy at its source boundary before consolidating scopes. */
export const parseGeminiMcpPolicy = (parsed: ClientConfigurationDocument) =>
  z
    .object({
      allowed: z.array(z.string()).optional(),
      excluded: z.array(z.string()).optional(),
    })
    .passthrough()
    .parse(parsed.document.mcp ?? {});

/** One server-name comparison for the exclusion, intersection and membership rules below. */
const normalizeGeminiServerName = (name: string): string =>
  name.toLowerCase().trim();

/** Gemini consolidates excludes by union and allowlists by normalized intersection. */
export const geminiServerPolicyBlock = (
  policies: readonly ReturnType<typeof parseGeminiMcpPolicy>[],
  serverKey: string,
): string | undefined => {
  // Hand-authored settings cannot be assumed to spell the product key exactly,
  // so every rule compares normalized names. Testing the consolidated list
  // against the raw key instead would make the outcome depend on which policy
  // supplied the spelling that survived the intersection.
  const key = normalizeGeminiServerName(serverKey);
  if (
    policies.some(({ excluded }) =>
      excluded?.some((name) => normalizeGeminiServerName(name) === key),
    )
  )
    return `Gemini mcp.excluded blocks ${serverKey}. Review the selected settings policies before rerunning setup.`;
  const allowlists = policies.flatMap(({ allowed }) =>
    allowed === undefined ? [] : [allowed],
  );
  const allowed = allowlists.reduce<string[] | undefined>(
    (previous, current) => {
      if (previous === undefined) return current;
      const normalized = new Set(current.map(normalizeGeminiServerName));
      return previous.filter((name) =>
        normalized.has(normalizeGeminiServerName(name)),
      );
    },
    undefined,
  );
  // Gemini's manager applies the consolidated allowlist only when nonempty.
  if (
    allowed !== undefined &&
    allowed.length > 0 &&
    !allowed.some((name) => normalizeGeminiServerName(name) === key)
  )
    return `Gemini mcp.allowed does not include ${serverKey}. Review the selected settings policies before rerunning setup.`;
  return undefined;
};
