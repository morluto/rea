import { err, ok, type Result } from "../domain/result.js";
import { readFile } from "node:fs/promises";
import {
  effectiveClientServer,
  parseClientConfiguration,
  type ClientConfigurationDocument,
} from "./ClientConfigurationDocument.js";
import type { SetupClient } from "./SupportedClients.js";

/** A named source failure that setup can explain without losing the bad path. */
export interface ClientConfigurationFileError {
  readonly kind: "unreadable" | "malformed";
  readonly path: string;
  readonly detail: string;
}

/** Preserve named read failures and distinguish a missing source from an empty file. */
export const readConfigurationText = async (
  path: string,
): Promise<Result<string | undefined, ClientConfigurationFileError>> => {
  try {
    return ok(await readFile(path, "utf8"));
  } catch (cause: unknown) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return ok(undefined);
    return err({
      kind: "unreadable",
      path,
      detail: `Configuration ${path} could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }
};

/** Read and parse one configuration at its source boundary. */
export const readConfigurationFile = async (
  path: string,
  format: SetupClient["format"],
): Promise<
  Result<ClientConfigurationDocument | undefined, ClientConfigurationFileError>
> => {
  const source = await readConfigurationText(path);
  if (!source.ok) return source;
  const content = source.value;
  if (content === undefined) return ok(undefined);
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
