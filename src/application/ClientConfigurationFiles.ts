import { err, ok, type Result } from "../domain/result.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import { readFile } from "node:fs/promises";
import {
  effectiveClientServer,
  geminiServerPolicyBlock,
  parseGeminiMcpPolicy,
  parseClientConfiguration,
  type ClientConfigurationDocument,
} from "./ClientConfigurationDocument.js";
import type { SetupClient } from "./SupportedClients.js";

/** A named source failure that setup can explain without losing the bad path. */
interface ClientConfigurationFileError {
  readonly kind: "unreadable" | "malformed";
  readonly path: string;
  readonly detail: string;
}

const readConfigurationFile = async (
  path: string,
  format: SetupClient["format"],
): Promise<
  Result<ClientConfigurationDocument | undefined, ClientConfigurationFileError>
> => {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (cause: unknown) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return ok(undefined);
    return err({
      kind: "unreadable",
      path,
      detail: `Configuration ${path} could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }
  try {
    return ok(parseClientConfiguration(content, format));
  } catch (cause: unknown) {
    return err({
      kind: "malformed",
      path,
      detail: `Configuration ${path} is malformed: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }
};

/** Read every applicable user file; malformed lower-priority files also stop setup. */
export const readClientConfigurationFiles = async (
  client: SetupClient,
): Promise<
  Result<readonly ClientConfigurationDocument[], ClientConfigurationFileError>
> => {
  const documents: ClientConfigurationDocument[] = [];
  for (const path of client.configPaths ?? [client.configPath]) {
    const document = await readConfigurationFile(path, client.format);
    if (!document.ok) return document;
    if (document.value !== undefined) documents.push(document.value);
  }
  return ok(documents);
};

/** OpenCode merges server objects in file order, replacing arrays and scalar values. */
const mergeConfigurationValue = (previous: unknown, next: unknown): unknown => {
  if (!isObject(previous) || !isObject(next)) return next;
  return Object.fromEntries(
    [...new Set([...Object.keys(previous), ...Object.keys(next)])].map(
      (key) => [
        key,
        Object.hasOwn(next, key)
          ? mergeConfigurationValue(previous[key], next[key])
          : previous[key],
      ],
    ),
  );
};
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Project a client's effective user registration without modifying its source files. */
export const effectiveClientConfiguration = (
  documents: readonly ClientConfigurationDocument[],
): ClientConfigurationDocument | undefined => {
  const last = documents.at(-1);
  if (last === undefined) return undefined;
  if (documents.length === 1) return last;
  const servers: Record<string, unknown> = {};
  for (const document of documents) {
    const names = new Set([
      ...Object.keys(document.legacyServers),
      ...Object.keys(document.servers),
    ]);
    for (const name of names)
      servers[name] = mergeConfigurationValue(
        servers[name],
        effectiveClientServer(document, name),
      );
  }
  return { ...last, servers, legacyServers: {} };
};

/** Respect every Gemini allowlist/exclude list without changing managed policy. */
export const readClientPolicyBlock = async (
  client: SetupClient,
  userDocument?: ClientConfigurationDocument,
): Promise<Result<string | undefined, ClientConfigurationFileError>> => {
  if (client.name !== "gemini_cli") return ok(undefined);
  const sources: { path: string; document: ClientConfigurationDocument }[] = [];
  for (const path of client.policyPaths ?? []) {
    const document = await readConfigurationFile(path, "json");
    if (!document.ok) return document;
    if (document.value !== undefined)
      sources.push({ path, document: document.value });
  }
  let user = userDocument;
  if (user === undefined) {
    const files = await readClientConfigurationFiles(client);
    if (!files.ok) return files;
    user = effectiveClientConfiguration(files.value);
  }
  if (user !== undefined)
    sources.push({ path: client.configPath, document: user });
  const policies: ReturnType<typeof parseGeminiMcpPolicy>[] = [];
  for (const { path, document } of sources) {
    try {
      policies.push(parseGeminiMcpPolicy(document));
    } catch (cause: unknown) {
      return err({
        kind: "malformed",
        path,
        detail: `Gemini MCP policy in ${path} is malformed: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
    }
  }
  return ok(geminiServerPolicyBlock(policies, PRODUCT_IDENTITY.mcpServerKey));
};
