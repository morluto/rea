import { err, ok, type Result } from "../domain/result.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import { resolveClientConfigTransactionPath } from "./ClientConfigPath.js";
import {
  legacyClientServerPath,
  shadowedClientServers,
  withClientServers,
  type ClientConfigurationDocument,
} from "./ClientConfigurationDocument.js";
import { clientRegistrationOwnership } from "./ClientRegistration.js";
import { dshDocument } from "./DshCordisPatch.js";
import type { SetupClient } from "./SupportedClients.js";
import {
  item,
  type UninstallAction,
  type UninstallFileSystem,
  type UninstallItem,
} from "./UninstallShared.js";

export const uninstallConfigPaths = (
  client: SetupClient,
): readonly string[] => [
  ...new Set([
    ...(client.readOnlyLowerLayers === true
      ? [client.configPath]
      : (client.configPaths ?? [client.configPath])),
    ...(client.msixPackage?.storage.kind === "roaming_overlay"
      ? [
          client.msixPackage.storage.privateConfigPath,
          client.msixPackage.storage.appDataConfigPath,
        ]
      : []),
  ]),
];

/** Whether a client loads this entry: present and not disabled. */
export const enabledRegistration = (entry: unknown): boolean =>
  entry !== undefined &&
  !(
    typeof entry === "object" &&
    entry !== null &&
    "enabled" in entry &&
    entry.enabled === false
  );

/** Whether removal would change this configuration. */
export const registrationPresent = (
  parsed: ClientConfigurationDocument,
): boolean => {
  const name = PRODUCT_IDENTITY.mcpServerKey;
  return (
    Object.hasOwn(parsed.servers, name) ||
    // Beside a native OpenCode V2 table, OpenCode also loads a V1 `mcp.rea`.
    legacyClientServerPath(parsed, name) !== undefined ||
    // Harness ownership is the stable entry id. A stale or malformed launcher
    // still belongs to that id, and so does a direct patch that projects no row.
    (parsed.dialect === "dsh" && dshDocument(parsed.document).carriesEntry)
  );
};

export const resolveUninstallConfigPath = async (
  client: SetupClient,
  fileSystem: UninstallFileSystem,
): Promise<string | UninstallItem> => {
  const path = await resolveClientConfigTransactionPath(
    client.configPath,
    fileSystem.realpath === undefined
      ? { lstat: fileSystem.stat }
      : { lstat: fileSystem.stat, realpath: fileSystem.realpath },
  );
  return (
    path ??
    item(
      client.name,
      "failed",
      "Configuration path could not be safely verified. Check its permissions and, if it is a symbolic link, verify that the link resolves to a regular file owned by the current user, then rerun uninstall.",
    )
  );
};

/**
 * Share the exact ownership and applicability decision with preflight. A
 * removable legacy entry carries its document path, so removal edits exactly
 * the entry this decision admitted.
 */
export type RegistrationRemoval = {
  readonly removeNative: boolean;
  readonly legacyPath: readonly string[] | undefined;
};

export type RegistrationRemovalRefusal = {
  readonly kind: "shadowed_unowned_member" | "foreign_legacy_fallback";
  readonly detail: string;
  /** The owned rows that motivated removal; refusing the edit keeps them. */
  readonly owned: RegistrationRemoval;
};

export const ownedRegistrationRemoval = (
  parsed: ClientConfigurationDocument,
  client: SetupClient,
): RegistrationRemoval => {
  const name = PRODUCT_IDENTITY.mcpServerKey;
  if (
    parsed.dialect === "dsh" &&
    dshDocument(parsed.document).hasUnknownStructure
  )
    return { removeNative: false, legacyPath: undefined };
  const removeNative =
    (parsed.dialect === "dsh" && dshDocument(parsed.document).carriesEntry) ||
    (Object.hasOwn(parsed.servers, name) &&
      clientRegistrationOwnership(parsed.servers[name], client) === "owned");
  const legacyPath = legacyClientServerPath(parsed, name);
  const removeLegacy =
    legacyPath !== undefined &&
    clientRegistrationOwnership(parsed.legacyServers[name], client) === "owned";
  return {
    removeNative,
    legacyPath: removeLegacy ? legacyPath : undefined,
  };
};

const SHADOWED_UNOWNED_MEMBER_DETAIL = `Configuration repeats the "${PRODUCT_IDENTITY.mcpServerKey}" member, and an earlier duplicate is not REA-owned; removing the registration the client reads would activate an earlier duplicate, so no change was made. Remove the duplicate members manually, then rerun uninstall.`;

const UNOWNED_LEGACY_FALLBACK_DETAIL = `OpenCode falls back to the V1 "mcp.${PRODUCT_IDENTITY.mcpServerKey}" entry, which is not REA-owned; removing REA's native registration would activate it, so no change was made. Remove or replace that V1 entry manually, then rerun uninstall.`;

export const clientRegistrationRemoval = (
  parsed: ClientConfigurationDocument,
  original: string,
  client: SetupClient,
): Result<RegistrationRemoval, RegistrationRemovalRefusal> => {
  const name = PRODUCT_IDENTITY.mcpServerKey;
  const ownership = ownedRegistrationRemoval(parsed, client);
  const { removeNative, legacyPath } = ownership;
  if (removeNative || legacyPath !== undefined) {
    const shadowed = shadowedClientServers(original, parsed, name);
    if (
      (removeNative &&
        shadowed.servers.some(
          (member) => clientRegistrationOwnership(member, client) !== "owned",
        )) ||
      (legacyPath !== undefined &&
        shadowed.legacyServers.some(
          (member) => clientRegistrationOwnership(member, client) !== "owned",
        ))
    )
      return err({
        kind: "shadowed_unowned_member",
        detail: SHADOWED_UNOWNED_MEMBER_DETAIL,
        owned: ownership,
      });
  }
  if (
    removeNative &&
    legacyPath === undefined &&
    legacyClientServerPath(parsed, name) !== undefined
  )
    return err({
      kind: "foreign_legacy_fallback",
      detail: UNOWNED_LEGACY_FALLBACK_DETAIL,
      owned: ownership,
    });
  return ok(ownership);
};

/** Apply the same exact row edits to both the projected and published document. */
export const registrationRemovalDocument = (
  parsed: ClientConfigurationDocument,
  removal: RegistrationRemoval,
  platform: NodeJS.Platform,
): ClientConfigurationDocument => {
  const name = PRODUCT_IDENTITY.mcpServerKey;
  const servers = { ...parsed.servers };
  const legacyServers = { ...parsed.legacyServers };
  if (removal.removeNative) delete servers[name];
  if (removal.legacyPath !== undefined) delete legacyServers[name];
  return {
    ...parsed,
    servers,
    legacyServers,
    document: withClientServers(
      parsed,
      servers,
      platform,
      removal.legacyPath === undefined ? undefined : name,
    ),
  };
};

/**
 * Layered clients are removed file by file, but callers look up one status by
 * client name. Aggregate status does not invalidate any constituent outcome.
 */
export const collapseUninstallItems = (
  items: readonly UninstallItem[],
): UninstallItem[] => {
  const grouped = new Map<string, UninstallAction[]>();
  for (const next of items) {
    const { name, actions, ...action } = next;
    const group = grouped.get(name) ?? [];
    group.push(
      ...(actions !== undefined && actions.length > 0 ? actions : [action]),
    );
    grouped.set(name, group);
  }
  return [...grouped].map(([name, actions]) => {
    const first = actions[0];
    if (first === undefined)
      throw new Error("Uninstall outcome group has no actions.");
    if (actions.length === 1) return { name, ...first };
    const status = actions.reduce(
      (selected, action) =>
        uninstallStatusPriority(action.status) >
        uninstallStatusPriority(selected)
          ? action.status
          : selected,
      first.status,
    );
    return {
      name,
      status,
      detail: [...new Set(actions.map(({ detail }) => detail))].join(" "),
      actions,
    };
  });
};

const uninstallStatusPriority = (status: UninstallItem["status"]): number => {
  switch (status) {
    case "failed":
      return 3;
    case "removed":
      return 2;
    case "retained":
      return 1;
    case "skipped":
      return 0;
    default: {
      const exhaustive: never = status;
      throw new TypeError(
        `Unhandled uninstall item status: ${String(exhaustive)}`,
      );
    }
  }
};
