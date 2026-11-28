import { PRODUCT_IDENTITY } from "../identity.js";
import { isRecord } from "../kernel/isRecord.js";

/**
 * MiMo Code's Claude Code MCP compatibility (`mergeClaudeMcp`): after all of
 * its own configuration, MiMo Code reads the top-level `mcpServers` of the
 * user's `~/.claude.json`, then the project's `.claude.json`, and imports
 * each server no MiMo Code configuration declares. A project import replaces
 * a user import of the same name. These helpers reproduce that read for REA's
 * entry only; REA never writes either file for MiMo Code.
 */

/** MiMo Code's `Flag` truthiness: `true` in any case, or `1`. */
const flagSet = (value: string | undefined): boolean => {
  const normalized = value?.toLowerCase();
  return normalized === "true" || normalized === "1";
};

/** Whether MiMo Code imports Claude Code MCP servers in this environment. */
export const mimoCodeImportsClaudeCodeServers = (
  env: Readonly<NodeJS.ProcessEnv>,
): boolean =>
  !flagSet(env.MIMOCODE_DISABLE_CLAUDE_CODE) &&
  !flagSet(env.MIMOCODE_DISABLE_CLAUDE_CODE_MCP);

const stringRecord = (value: unknown): Record<string, string> | undefined =>
  isRecord(value)
    ? Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : undefined;

const LOCAL_TYPES = new Set(["stdio", "local"]);
const REMOTE_TYPES = new Set(["http", "streamable-http", "remote"]);

interface ImportedSettings {
  readonly enabled: boolean;
  readonly timeout?: number;
}

/** Claude Code's `args`, or `undefined` when MiMo Code rejects them. */
const importedArgs = (value: unknown): readonly string[] | undefined => {
  if (value === undefined) return [];
  return Array.isArray(value) &&
    value.every((item): item is string => typeof item === "string")
    ? value
    : undefined;
};

/** An empty or non-string `type` imports as if Claude Code declared none. */
const typeAllows = (type: unknown, allowed: ReadonlySet<string>): boolean =>
  typeof type !== "string" || type === "" || allowed.has(type);

const localEntry = (
  input: Readonly<Record<string, unknown>>,
  command: string,
  args: readonly string[],
  settings: ImportedSettings,
): Record<string, unknown> => {
  const environment =
    stringRecord(input.environment) ?? stringRecord(input.env);
  return {
    type: "local",
    command: [command, ...args],
    ...(environment === undefined ? {} : { environment }),
    ...settings,
  };
};

const remoteEntry = (
  input: Readonly<Record<string, unknown>>,
  url: string,
  settings: ImportedSettings,
): Record<string, unknown> => {
  const headers = stringRecord(input.headers);
  return {
    type: "remote",
    url,
    ...settings,
    ...(headers === undefined ? {} : { headers }),
  };
};

/**
 * MiMo Code's `ConfigMCP.fromClaude` for one entry, or `undefined` when MiMo
 * Code skips it. Claude Code's `disabled: true` becomes `enabled: false`.
 */
const importedEntry = (input: unknown): Record<string, unknown> | undefined => {
  if (!isRecord(input) || input.type === "sse") return undefined;
  const args = importedArgs(input.args);
  if (args === undefined) return undefined;
  const settings: ImportedSettings = {
    enabled: input.disabled !== true && input.enabled !== false,
    ...(typeof input.timeout === "number" ? { timeout: input.timeout } : {}),
  };
  if (input.command !== undefined)
    return typeof input.command === "string" &&
      typeAllows(input.type, LOCAL_TYPES)
      ? localEntry(input, input.command, args, settings)
      : undefined;
  return typeof input.url === "string" && typeAllows(input.type, REMOTE_TYPES)
    ? remoteEntry(input, input.url, settings)
    : undefined;
};

/**
 * The `rea` entry MiMo Code imports from one `.claude.json` text, or
 * `undefined` when it imports none. MiMo Code decodes the file without a
 * leading byte-order mark and skips a file `JSON.parse` rejects.
 */
export const mimoCodeClaudeCodeImport = (
  text: string,
): Record<string, unknown> | undefined => {
  const source = text.replace(/^\uFEFF/, "");
  if (source === "") return undefined;
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch {
    return undefined;
  }
  const name = PRODUCT_IDENTITY.mcpServerKey;
  return isRecord(data) &&
    isRecord(data.mcpServers) &&
    Object.hasOwn(data.mcpServers, name)
    ? importedEntry(data.mcpServers[name])
    : undefined;
};
