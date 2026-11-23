import { err, ok, type Result } from "../domain/result.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import {
  resolveClientConfigTransactionPath,
  sameClientConfigurationFile,
} from "./ClientConfigPath.js";
import {
  parseClientConfiguration,
  legacyClientServerPath,
  shadowedClientServers,
  withClientServers,
  type ClientConfigurationDocument,
} from "./ClientConfigurationDocument.js";
import { clientConfigurationValuesEqual } from "./ClientConfigurationValues.js";
import {
  isClientConfigurationCleanupFailure,
  retryClientConfigurationCleanup,
} from "./ClientConfigurationCleanup.js";
import { InvalidUtf8FileError } from "../process/RegularFileRead.js";
import type { ArtifactResourceScope } from "../resources/index.js";
import {
  effectiveClientConfiguration,
  type ClientConfigurationSource,
} from "./ClientConfigurationFiles.js";
import { mimoCodeClaudeCodeImport } from "./MimoCodeClaudeImport.js";
import { clientRegistrationOwnership } from "./ClientRegistration.js";
import { dshDocument } from "./DshCordisPatch.js";
import type { SetupClient } from "./SupportedClients.js";
import {
  isMissing,
  item,
  type UninstallAction,
  type UninstallFileSystem,
  type UninstallItem,
} from "./UninstallShared.js";

/**
 * Every user file that can hold REA's registration for one client. An MSIX
 * package can read either its private copy or the AppData file, and earlier
 * setups wrote the AppData file, so both lose REA's entry.
 */
export const uninstallConfigPaths = (
  client: SetupClient,
): readonly string[] => [
  ...new Set([
    ...(client.readOnlyLowerLayers === true
      ? [client.configPath]
      : (client.configPaths ?? [client.configPath])),
    ...(client.msixPackage === undefined
      ? []
      : [
          client.msixPackage.privateConfigPath,
          client.msixPackage.appDataConfigPath,
        ]),
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

export type ClientConfigurationRead =
  | { readonly kind: "item"; readonly item: UninstallItem }
  | {
      readonly kind: "configuration";
      readonly transactionPath: string;
      readonly original: string;
      readonly parsed: ClientConfigurationDocument;
    };

export const readUninstallConfigurationText = async (
  path: string,
  fileSystem: UninstallFileSystem,
  resources: ArtifactResourceScope,
): Promise<
  Result<
    string | undefined,
    { readonly kind: "unreadable" | "unreleased"; readonly detail: string }
  >
> => {
  try {
    return ok(await fileSystem.readText(path));
  } catch (cause: unknown) {
    if (isClientConfigurationCleanupFailure(cause)) {
      const cleanup = await retryClientConfigurationCleanup(cause, resources);
      const detail =
        cleanup.primary instanceof InvalidUtf8FileError
          ? "Configuration is not valid UTF-8 and was not changed; its resources could not be released. Repair it, then rerun uninstall."
          : "Configuration could not be read or its resources could not be released. Check file permissions, then rerun uninstall.";
      // An unreleased handle is REA's own incomplete cleanup, never foreign-
      // storage uncertainty: it must stop removal outright, so later removals
      // and purge cannot outrun the failure that close() reports afterwards.
      if (cleanup.cleanup !== undefined)
        return err({ kind: "unreleased", detail });
      const completed: unknown =
        cause.outcome.kind === "completed" ? cause.outcome.value : undefined;
      return typeof completed === "string"
        ? ok(completed)
        : err({ kind: "unreadable", detail });
    }
    return isMissing(cause)
      ? ok(undefined)
      : err({
          kind: "unreadable",
          detail:
            cause instanceof InvalidUtf8FileError
              ? "Configuration is not valid UTF-8 and was not changed. Repair it, then rerun uninstall."
              : "Configuration could not be read. Check file permissions, then rerun uninstall.",
        });
  }
};

/**
 * MiMo Code imports Claude Code's enabled `rea` entry once none of its own
 * layers declares one. Removing REA's MiMo Code entries must not hand it an
 * entry this uninstall keeps; an entry Claude Code's own removal takes is
 * gone for both.
 */
const claudeCodeImportExposure = async (
  client: SetupClient,
  path: string,
  claudeCode: SetupClient | undefined,
  {
    fileSystem,
    resources,
    removesNative,
  }: {
    readonly fileSystem: UninstallFileSystem;
    readonly resources: ArtifactResourceScope;
    readonly removesNative: boolean;
  },
): Promise<UninstallItem | undefined> => {
  const read = await readUninstallConfigurationText(
    path,
    fileSystem,
    resources,
  );
  if (!read.ok)
    return item(
      client.name,
      "failed",
      `Claude Code's ${path}, which MiMo Code would read after uninstall: ${read.error.detail}`,
    );
  const text = read.value;
  if (text === undefined) return undefined;
  const entry = mimoCodeClaudeCodeImport(text);
  if (
    !enabledRegistration(entry) ||
    (!removesNative && clientRegistrationOwnership(entry, client) !== "owned")
  )
    return undefined;
  if (
    claudeCode !== undefined &&
    claudeCode.configPathError === undefined &&
    (await sameClientConfigurationFile(
      claudeCode.configPath,
      path,
      fileSystem.realpath,
    ))
  ) {
    const parsed = parseClientConfiguration(text, "claude_code");
    if (parsed.ok) {
      const removal = clientRegistrationRemoval(parsed.value, text, claudeCode);
      if (removal.ok && removal.value.removeNative) return undefined;
    }
  }
  return item(
    client.name,
    "failed",
    `MiMo Code would use the enabled rea entry in Claude Code's ${path} after uninstall. Remove or rename that entry, or set MIMOCODE_DISABLE_CLAUDE_CODE_MCP=1 for MiMo Code and REA, then rerun uninstall.`,
  );
};

export const inspectLayeredRegistrationRemoval = async (
  client: SetupClient,
  {
    platform,
    fileSystem,
    resources,
    claudeCode,
    mimoMayImport,
    readLayer,
  }: {
    readonly platform: NodeJS.Platform;
    readonly fileSystem: UninstallFileSystem;
    readonly resources: ArtifactResourceScope;
    readonly claudeCode: SetupClient | undefined;
    readonly mimoMayImport: boolean;
    readonly readLayer: (path: string) => Promise<ClientConfigurationRead>;
  },
): Promise<UninstallItem | undefined> => {
  const originalLayers: ClientConfigurationSource[] = [];
  const remainingLayers: ClientConfigurationSource[] = [];
  for (const configPath of client.configPaths ?? [client.configPath]) {
    const layer = await readLayer(configPath);
    if (layer.kind === "item") {
      if (layer.item.status !== "skipped") return layer.item;
      continue;
    }
    const layerRemoval = clientRegistrationRemoval(
      layer.parsed,
      layer.original,
      client,
    );
    if (!layerRemoval.ok)
      return item(client.name, "failed", layerRemoval.error.detail);
    originalLayers.push({ ...layer.parsed, sourcePath: configPath });
    const servers = { ...layer.parsed.servers };
    const legacyServers = { ...layer.parsed.legacyServers };
    const name = PRODUCT_IDENTITY.mcpServerKey;
    if (layerRemoval.value.removeNative) delete servers[name];
    if (layerRemoval.value.legacyPath !== undefined) delete legacyServers[name];
    remainingLayers.push({
      ...layer.parsed,
      servers,
      legacyServers,
      sourcePath: configPath,
    });
  }
  // REA never edits the inline layer, so it survives removal.
  const inline = client.inlineConfiguration;
  if (inline !== undefined) {
    const layer = { ...inline.parsed, inlineOrigin: inline.origin };
    originalLayers.push(layer);
    remainingLayers.push(layer);
  }
  const selected = effectiveClientConfiguration(
    originalLayers,
    undefined,
    platform,
  )?.servers[PRODUCT_IDENTITY.mcpServerKey];
  const remaining = effectiveClientConfiguration(
    remainingLayers,
    undefined,
    platform,
  )?.servers[PRODUCT_IDENTITY.mcpServerKey];
  const altersEffectiveRegistration =
    clientRegistrationOwnership(selected, client) === "owned"
      ? remaining !== undefined
      : !clientConfigurationValuesEqual(selected, remaining);
  if (altersEffectiveRegistration)
    return item(
      client.name,
      "failed",
      client.format === "opencode"
        ? "Removing REA's registration would activate or change an unowned OpenCode registration in another configuration layer, including a possible V1 fallback; no change was made. Remove or replace that registration manually, then rerun uninstall."
        : `Removing REA's registration would activate or change a registration that another ${client.format === "kilo" ? "Kilo" : "MiMo Code"} configuration layer${inline === undefined ? "" : ` or ${inline.origin}, which REA does not edit,`} keeps in effect; no change was made. Remove or replace that registration manually, then rerun uninstall.`,
    );
  if (
    remaining === undefined &&
    client.claudeCodeImportPath !== undefined &&
    (selected !== undefined || mimoMayImport)
  ) {
    const exposed = await claudeCodeImportExposure(
      client,
      client.claudeCodeImportPath,
      claudeCode,
      { fileSystem, resources, removesNative: selected !== undefined },
    );
    if (exposed !== undefined) return exposed;
  }
  return undefined;
};
