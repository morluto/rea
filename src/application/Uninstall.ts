import {
  isMissing,
  item,
  type UninstallAction,
  type UninstallFileSystem,
  type UninstallItem,
} from "./UninstallShared.js";
import {
  inspectManagedSkill,
  purgeSelectedData,
  removeManagedSkills,
} from "./UninstallDataAndSkills.js";
import { clientProjectConfigurationPaths } from "./SupportedClientLocations.js";
import { HOST_PLATFORM } from "../platform/HostPlatform.js";
import { appendCallerPath } from "../filesystem/callerPath.js";
import {
  isClientConfigurationCleanupFailure,
  retryClientConfigurationCleanup,
} from "./ClientConfigurationCleanup.js";
import {
  ClientConfigurationShapeError,
  clientConfigurationServersKey,
  clientConfigurationSyntaxName,
  parseClientConfiguration,
  serializeClientConfiguration,
  clientServerPath,
  effectiveClientServer,
  legacyClientServerPath,
  shadowedClientServers,
  withClientServers,
  type ClientConfigurationDocument,
} from "./ClientConfigurationDocument.js";
import { err, ok, type Result } from "../domain/result.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import {
  AnalysisError,
  type AnalysisCleanupObservation,
} from "../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupDependencies } from "../domain/analysisErrorCleanup.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { copyFile, lstat, realpath, rm, rmdir } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { homeDirectoryFromEnvironment } from "../config/homeDirectory.js";
import { dirname } from "node:path";
import { withinLexicalDirectory } from "../filesystem/cacheDirectory.js";

import { ClientConfigurationPublication } from "./ClientConfigurationPublication.js";
import {
  effectiveClientConfiguration,
  readEffectiveClientRegistrationConfiguration,
  type ClientConfigurationSource,
} from "./ClientConfigurationFiles.js";
import {
  clientRegistrationOwnership,
  parseClientRegistrationActivation,
} from "./ClientRegistration.js";

import { PRODUCT_IDENTITY } from "../identity.js";
import { readSkillFile, skillDestinationSelection } from "./SetupSkill.js";
import { dshDocument } from "./DshCordisPatch.js";
import {
  isAbsentClientConfigPath,
  resolveClientConfigTransactionPath,
} from "./ClientConfigPath.js";
import {
  preserveCurrentRecoveryBackup,
  type RecoveryBackupPreservationOptions,
} from "./SetupRecoveryBackup.js";
import { preservePrivateRecoveryBackup } from "./ClientRegistrationBackup.js";
import { RegularFileCleanupFailure } from "../filesystem/OwnedRegularFile.js";
import {
  InvalidUtf8FileError,
  readRegularFileText,
  bindRegularFileCleanup,
} from "../process/RegularFileRead.js";
import {
  ArtifactReaderFailure,
  ArtifactResourceScope,
} from "../resources/index.js";
import {
  appDataRedirection,
  clientOwnershipEvidencePaths,
  clientSharedRegistrationPaths,
  manualRegistrationRemediation,
  registrationWriteBlocker,
  resolveSupportedClients,
  type ClientSystemPaths,
  type SetupClient,
} from "./SupportedClients.js";
import {
  redirectedWriteBlocker,
  type MsixPackageView,
} from "./MsixPackageStorage.js";

const systemFileSystem = (
  resources: ArtifactResourceScope,
): UninstallFileSystem => ({
  readText: (path) => readRegularFileText(path, { resources }),
  readRegularText: (path) => readSkillFile(path, resources),
  copy: (source, destination) =>
    copyFile(source, destination, fsConstants.COPYFILE_EXCL),
  publishConfiguration: (path, contents, original) =>
    ClientConfigurationPublication.write(path, contents, original),
  stat: (path) => lstat(path),
  realpath: (path) => realpath(path),
  remove: (path, recursive = true) => rm(path, { recursive }),
  removeEmptyDirectory: (path) => rmdir(path),
});

/** Structured, idempotent result of removing REA-owned state. */
export interface UninstallResult {
  readonly status: "complete" | "failed";
  readonly items: readonly UninstallItem[];
  readonly cleanup?: AnalysisCleanupObservation | undefined;
}

/** Applicability established once from product-specific discovery evidence. */
export interface UninstallClient extends SetupClient {
  readonly applicability?: "unverified";
  /** Clients that load this same registration table as a fallback report the
   * owner's outcome without inspecting or editing the file again. */
  readonly sharedWith?: readonly string[];
}

/** Filesystem boundary used by the contained uninstall workflow. */
export interface UninstallHost {
  clients(): Promise<readonly UninstallClient[]>;
  /** Report a configuration that cannot be read safely, before any removal. */
  inspectClient(client: UninstallClient): Promise<UninstallItem | undefined>;
  removeClient(client: UninstallClient): Promise<UninstallItem>;
  inspectSkill?(): Promise<UninstallItem | undefined>;
  removeSkill(): Promise<UninstallItem>;
  purgeData(): Promise<readonly UninstallItem[]>;
  close?(): Promise<AnalysisError | undefined>;
}

/** Preserve the resource owner's explicit retry capabilities through uninstall reporting. */
const uninstallCleanupError = (cause: unknown): AnalysisError => {
  if (cause instanceof AnalysisError && cause.carriesCleanup) return cause;
  const cleanup = ArtifactReaderFailure.cleanupObservation(cause, []);
  const error = new ProviderCleanupError(
    "uninstall",
    cleanup.resources,
    { reason: cleanup.reason },
    { cause, cleanup, operation: "uninstall" },
  );
  bindRegularFileCleanup(cause, error);
  return error;
};

/**
 * Remove only REA-owned registrations and managed files, optionally including
 * local state. A client configuration that cannot be read safely stops the
 * operation before anything is removed; one that fails during removal stops
 * the remaining removals.
 */
export const runUninstall = async (
  purgeData: boolean,
  host: UninstallHost,
): Promise<UninstallResult> => {
  let result: UninstallResult | undefined;
  let primaryFailure: unknown;
  let failed = false;
  try {
    const clients = await host.clients();
    const blocked: UninstallItem[] = [];
    for (const client of clients) {
      const blocking = await host.inspectClient(client);
      if (blocking !== undefined)
        blocked.push({ ...blocking, configuration_path: client.configPath });
    }
    const skillBlocker = await host.inspectSkill?.();
    if (skillBlocker !== undefined) blocked.push(skillBlocker);
    const items: UninstallItem[] =
      blocked.length > 0
        ? [
            ...blocked,
            item(
              "uninstall",
              "skipped",
              "No REA registration, skill, or data was removed. Repair each failed configuration, then rerun uninstall.",
            ),
          ]
        : await removeAll(clients, purgeData, host);
    items.push({
      name: "analysis_engine",
      status: "retained",
      detail: "Hopper is not owned by REA uninstall.",
    });
    const reported = collapseUninstallItems(
      projectSharedRegistrations(items, clients),
    );
    result = {
      status: reported.some(({ status }) => status === "failed")
        ? "failed"
        : "complete",
      items: reported,
    };
  } catch (cause: unknown) {
    failed = true;
    primaryFailure = cause;
  }
  let cleanupFailure: AnalysisError | undefined;
  try {
    const report = await host.close?.();
    cleanupFailure =
      report === undefined ? undefined : uninstallCleanupError(report);
  } catch (cause: unknown) {
    cleanupFailure = uninstallCleanupError(cause);
  }
  if (cleanupFailure !== undefined && !cleanupFailure.cleanupIncomplete)
    cleanupFailure = undefined;
  if (failed) {
    if (cleanupFailure !== undefined) {
      if (primaryFailure instanceof AnalysisError)
        throw analysisErrorWithCleanupDependencies(
          primaryFailure,
          cleanupFailure,
          "uninstall",
        );
      throw new AggregateError(
        [primaryFailure, cleanupFailure],
        "Uninstall failed and its resource cleanup remains incomplete.",
        { cause: primaryFailure },
      );
    }
    throw primaryFailure;
  }
  if (result === undefined)
    throw new Error("Uninstall result was not produced.");
  if (cleanupFailure === undefined) return result;
  const items = collapseUninstallItems([
    ...result.items,
    item(
      "uninstall_cleanup",
      "failed",
      `Uninstall resource cleanup failed: ${cleanupFailure.cleanup?.reason ?? cleanupFailure.message}${cleanupFailure.cleanupResources.length === 0 ? "" : ` (${cleanupFailure.cleanupResources.join(", ")})`}`,
    ),
  ]);
  const retained = cleanupFailure;
  return {
    status: "failed",
    items,
    get cleanup() {
      return retained.cleanupIncomplete
        ? {
            reason: retained.cleanup?.reason ?? retained.message,
            resources: retained.cleanupResources,
          }
        : undefined;
    },
  };
};

/**
 * Reread each client when editing and refuse detected changes before publication.
 * A client that fails still stops the remaining removals.
 */
const removeAll = async (
  clients: readonly UninstallClient[],
  purgeData: boolean,
  host: UninstallHost,
): Promise<UninstallItem[]> => {
  const items: UninstallItem[] = [];
  const stopped = (): UninstallItem[] => [
    ...items,
    item(
      "uninstall",
      "skipped",
      "Uninstall stopped at this failure; the items above report what changed. Repair the failed removal, then rerun uninstall.",
    ),
  ];
  for (const client of clients) {
    const removed = await host.removeClient(client);
    items.push({ ...removed, configuration_path: client.configPath });
    if (removed.status === "failed") return stopped();
  }
  const skill = await host.removeSkill();
  items.push(skill);
  if (skill.status === "failed") return stopped();
  if (purgeData) items.push(...(await host.purgeData()));
  return items;
};

/**
 * Report a shared file's single outcome under every client that loads it. The
 * owner edits the file once, so a fallback reader reports what happened to its
 * registration instead of finding it already absent.
 */
const projectSharedRegistrations = (
  items: readonly UninstallItem[],
  clients: readonly UninstallClient[],
): UninstallItem[] => {
  const readersByRegistration = new Map<string, readonly string[]>();
  for (const client of clients)
    if (client.sharedWith !== undefined && client.sharedWith.length > 0)
      readersByRegistration.set(
        JSON.stringify([client.name, client.configPath]),
        client.sharedWith,
      );
  if (readersByRegistration.size === 0) return [...items];
  return items.flatMap((next) => {
    const readers =
      next.configuration_path === undefined
        ? undefined
        : readersByRegistration.get(
            JSON.stringify([next.name, next.configuration_path]),
          );
    if (readers === undefined) return [next];
    const { name, ...action } = next;
    return [name, ...readers].map((reader) => ({ ...action, name: reader }));
  });
};

/**
 * Ownership is a readable, recognizable REA-owned row, never the shared
 * file's existence. An unrelated malformed file must not establish ownership;
 * it stays retained without blocking other removals.
 */
const hasOwnershipEvidence = async (
  client: UninstallClient,
  fileSystem: UninstallFileSystem,
): Promise<boolean> => {
  for (const path of clientOwnershipEvidencePaths(client)) {
    let original: string;
    try {
      original = await fileSystem.readText(path);
    } catch (cause: unknown) {
      // A close failure after a completed read still carries the exact text
      // in its retained outcome, and that text is the ownership fact: only a
      // read that never completed proves nothing. Preserve it, so later read
      // failures stay blocking instead of softening to retained.
      if (!(cause instanceof RegularFileCleanupFailure)) continue;
      if (cause.outcome.kind !== "completed") continue;
      const completed: unknown = cause.outcome.value;
      if (typeof completed !== "string") continue;
      original = completed;
    }
    let parsed: ClientConfigurationDocument;
    try {
      parsed = parseClientConfiguration(original, client.format);
    } catch {
      // Malformed shared data is retained, never ownership evidence.
      continue;
    }
    const removal = clientRegistrationRemoval(parsed, original, client);
    // Refusing the edit never retracts the owned-row fact: an effective
    // REA-owned row shadowed by a foreign duplicate still proves ownership,
    // so later read failures stay blocking instead of softening to retained.
    const owned = removal.ok ? removal.value : removal.error.owned;
    if (owned.removeNative || owned.legacyPath !== undefined) return true;
  }
  return false;
};

/** Installation evidence for one probed path, never inferred from absence. */
interface DiscoveryProbe {
  readonly applicable: boolean;
  readonly unresolved: boolean;
}

/** A client's shared-storage applicability from its discovery paths: a hit
 * proves installation, a miss leaves it unproven, and any other probe failure
 * leaves it unresolved — never absence. */
const discoveryApplicability = async (
  discoveryPaths: readonly string[] | undefined,
  fileSystem: UninstallFileSystem,
): Promise<DiscoveryProbe> => {
  if (discoveryPaths === undefined)
    return { applicable: true, unresolved: false };
  let applicable = false;
  let unresolved = false;
  for (const path of discoveryPaths) {
    try {
      // The product's own directory proves installation, not a leftover link
      // to it: `stat` is `lstat`, so a dangling profile link passes here even
      // though setup and doctor, which follow the target, reject it. Resolve
      // the link for the same answer, keeping `lstat` for removal safety.
      const stats = await fileSystem.stat(path);
      if (stats.isSymbolicLink() && fileSystem.realpath !== undefined)
        await fileSystem.realpath(path);
      return { applicable: true, unresolved: false };
    } catch (cause: unknown) {
      // Absence keeps scanning until one discovery path exists; any
      // other probe failure leaves applicability unresolved.
      if (!isMissing(cause)) unresolved = true;
    }
  }
  return { applicable, unresolved };
};

/** One physical configuration path a client claims. */
interface ClientConfigClaim {
  readonly client: SetupClient;
  readonly configPath: string;
  /** The path is another product's storage this client falls back to. */
  readonly fallback: boolean;
}

/** One physical file, the client whose configuration it is, and the other
 * clients that load it as a fallback. */
interface SharedConfigPath {
  readonly owner: ClientConfigClaim;
  readonly readers: readonly ClientConfigClaim[];
}

/**
 * Resolve each physical configuration file to the clients that edit it. A
 * client's own configuration owns its registration row; a fallback view only
 * reports the owner's decision instead of racing it to "absent". Two clients
 * that each declare the same path as their own configuration keep their own
 * row, because they write different tables.
 */
const sharedConfigPaths = (
  clients: readonly SetupClient[],
): readonly SharedConfigPath[] => {
  const claimsByPath = new Map<string, ClientConfigClaim[]>();
  for (const client of clients)
    for (const claim of [
      ...uninstallConfigPaths(client).map((configPath) => ({
        client,
        configPath,
        fallback: false,
      })),
      ...(client.zcodeFallbackPath === undefined
        ? []
        : [
            {
              client,
              configPath: client.zcodeFallbackPath,
              fallback: true,
            },
          ]),
    ])
      claimsByPath.set(claim.configPath, [
        ...(claimsByPath.get(claim.configPath) ?? []),
        claim,
      ]);
  return [...claimsByPath.values()].flatMap((claims): SharedConfigPath[] => {
    const fallbacks = claims.filter((claim) => claim.fallback);
    const owners = claims.filter((claim) => !claim.fallback);
    // A fallback view can only report one client's row. OpenCode can be pointed
    // at FreeBuff's file through `OPENCODE_CONFIG`, and both then own the path
    // while writing different tables, so each keeps its own decision.
    if (owners.length > 0)
      return owners.map((owner) => {
        const format = owner.client.format;
        // ZCode's fallback reads mcpServers, never another table in the same
        // file (for example OpenCode's mcp table). Use the format owner's
        // mapping instead of reinterpreting table names here.
        const readers =
          format !== undefined &&
          format !== "unsupported" &&
          format !== "dsh" &&
          clientConfigurationServersKey(format) ===
            clientConfigurationServersKey("zcode_fallback")
            ? fallbacks
            : [];
        return { owner, readers };
      });
    const [only] = fallbacks;
    if (only === undefined)
      throw new Error("A configuration path has no claiming client.");
    return [{ owner: only, readers: [] }];
  });
};

/** Create uninstall effects contained to detected client configs and REA-owned paths. */
export const systemUninstallHost = (
  selectedHome: string | undefined = undefined,
  selectedFileSystem: UninstallFileSystem | undefined = undefined,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  platform: NodeJS.Platform = HOST_PLATFORM.platform,
  systemPaths: ClientSystemPaths = {},
  projectDirectory?: string,
): UninstallHost => {
  const home =
    selectedHome ?? homeDirectoryFromEnvironment(environment, platform);
  const resources = new ArtifactResourceScope();
  // Whole-operation admission must not share a gate with its nested file reads:
  // a peer's pending cleanup otherwise waits for the operation requesting it.
  const configurationOperations = new ArtifactResourceScope();
  const fileSystem = selectedFileSystem ?? systemFileSystem(resources);
  const preflightOwnedClients = new WeakSet<UninstallClient>();
  const projectTargets = new WeakMap<UninstallClient, ProjectUninstallTarget>();
  // REA's registration that only layers REA does not edit define: uninstall
  // cannot remove it, so it is reported instead of being treated as absent.
  const retainedLowerOnly = new WeakMap<UninstallClient, UninstallItem>();
  // One report per client although uninstall visits each of its files.
  const inlineReported = new Set<string>();
  /**
   * The effective REA entry across the read-only lower layers, and the user
   * layer above them when given.
   */
  const lowerLayerRegistration = async (
    client: UninstallClient,
    ownershipEstablished: boolean,
    upper?: ClientConfigurationSource,
    inline?: ClientConfigurationSource,
  ): Promise<
    | { readonly kind: "item"; readonly item: UninstallItem }
    | { readonly kind: "entry"; readonly entry: unknown }
  > => {
    const lowerLayers: ClientConfigurationSource[] = [];
    for (const configPath of client.configPaths ?? []) {
      if (configPath === client.configPath) {
        if (upper !== undefined) lowerLayers.push(upper);
        continue;
      }
      const layer = await readClientConfiguration(
        { ...client, configPath },
        fileSystem,
        resources,
        ownershipEstablished,
        "read_only",
      );
      if (layer.kind === "item") {
        if (layer.item.status !== "skipped") return layer;
        continue;
      }
      lowerLayers.push({ ...layer.parsed, sourcePath: configPath });
    }
    if (upper !== undefined && !client.configPaths?.includes(client.configPath))
      lowerLayers.push(upper);
    if (inline !== undefined) lowerLayers.push(inline);
    return {
      kind: "entry",
      entry: effectiveClientConfiguration(lowerLayers, undefined, platform)
        ?.servers[PRODUCT_IDENTITY.mcpServerKey],
    };
  };
  /**
   * Record REA's enabled registration that a read-only layer keeps in effect
   * when uninstall removes nothing from the user layer: absent there, or a
   * partial user entry inheriting REA's launcher. An unreadable layer leaves
   * that unknown, so it stops uninstall before any removal.
   */
  const retainLowerOnlyRegistration = async (
    client: UninstallClient,
    ownershipEstablished: boolean,
    upper?: ClientConfigurationSource,
  ): Promise<UninstallItem | undefined> => {
    // Inline options inherit omitted fields from the files that remain.
    // In particular, an inline launcher does not override a file's disabled flag.
    const inline = client.inlineConfiguration;
    const inlineEntry =
      inline === undefined
        ? undefined
        : effectiveClientConfiguration(
            [{ ...inline.parsed, inlineOrigin: inline.origin }],
            undefined,
            platform,
          )?.servers[PRODUCT_IDENTITY.mcpServerKey];
    if (
      inline !== undefined &&
      enabledRegistration(inlineEntry) &&
      clientRegistrationOwnership(inlineEntry, client) === "owned"
    ) {
      const remaining = await lowerLayerRegistration(
        client,
        ownershipEstablished,
        upper,
        { ...inline.parsed, inlineOrigin: inline.origin },
      );
      if (remaining.kind === "item") return remaining.item;
      if (
        !enabledRegistration(remaining.entry) ||
        clientRegistrationOwnership(remaining.entry, client) !== "owned"
      )
        return undefined;
      if (!inlineReported.has(client.name)) {
        inlineReported.add(client.name);
        const name = client.displayName ?? client.name;
        retainedLowerOnly.set(
          client,
          item(
            client.name,
            "failed",
            `${inline.origin} sets REA's enabled ${name} registration, and REA does not edit it, so the registration stays in effect after uninstall. Remove the ${PRODUCT_IDENTITY.mcpServerKey} entry from ${inline.origin}, then restart ${name}.`,
          ),
        );
      }
      return undefined;
    }
    if (client.readOnlyLowerLayers !== true) return undefined;
    const lower = await lowerLayerRegistration(
      client,
      ownershipEstablished,
      upper,
    );
    if (lower.kind === "item") return lower.item;
    if (
      enabledRegistration(lower.entry) &&
      clientRegistrationOwnership(lower.entry, client) === "owned"
    )
      retainedLowerOnly.set(
        client,
        item(
          client.name,
          "failed",
          "REA's enabled registration is defined in a read-only configuration layer REA does not change, so it stays in effect after uninstall. Remove it with that layer's owner.",
        ),
      );
    return undefined;
  };
  // Set with the client list: the package view that redirects this
  // process's AppData writes, if any.
  let redirection: MsixPackageView | undefined;
  const clientWriteBlocker = (client: SetupClient): string | undefined =>
    registrationWriteBlocker(client, "uninstall") ??
    redirectedWriteBlocker(redirection, [client.configPath], "uninstall");
  const skillWriteBlocker = (path: string): string | undefined =>
    redirectedWriteBlocker(redirection, [path], "uninstall");
  return {
    clients: async () => {
      const supported = await resolveSupportedClients(
        home,
        platform,
        environment,
        systemPaths,
      );
      redirection = appDataRedirection(supported);
      if (projectDirectory !== undefined) {
        const directory =
          await requireProjectUninstallDirectory(projectDirectory);
        return resolveProjectUninstallClients(
          supported,
          directory,
          projectTargets,
          fileSystem,
          resources,
          platform,
        );
      }
      // Shared configuration alone cannot establish product applicability.
      // Definitive absence leaves the shared paths unverified while owned
      // rows in a readable configuration can still be removed independently;
      // an unresolved probe is unknown, never absence.
      const probes = new Map<string, DiscoveryProbe>();
      for (const client of supported)
        probes.set(
          client.name,
          await discoveryApplicability(client.discoveryPaths, fileSystem),
        );
      const paths = sharedConfigPaths(supported);
      const clients: UninstallClient[] = [];
      for (const client of supported)
        for (const path of paths) {
          if (path.owner.client !== client) continue;
          // A fallback reader constrains this file only while it may load it:
          // definitive absence leaves the file to its owner. A reader that may
          // load the owner's registration makes applicability one fact per
          // physical file, so its installed proof applies and its unresolved
          // probe keeps the file fail-closed.
          const readers = path.readers.filter(({ client: reader }) => {
            const probe = probes.get(reader.name);
            return probe?.applicable === true || probe?.unresolved === true;
          });
          const probesForPath = [path.owner, ...readers].map(
            ({ client: participant }) =>
              probes.get(participant.name) ?? {
                applicable: false,
                unresolved: false,
              },
          );
          // Only definitive absence may soften failures for storage REA does
          // not own: a denied or failed probe leaves applicability unresolved,
          // and unresolved applicability must not downgrade shared-config
          // failures to retained. A denied product-local path means an unknown
          // registration state, which must stop uninstall instead of reporting
          // success.
          const applicability: Pick<UninstallClient, "applicability"> =
            probesForPath.some(({ applicable }) => applicable) ||
            probesForPath.some(({ unresolved }) => unresolved) ||
            !clientSharedRegistrationPaths(client).has(path.owner.configPath)
              ? {}
              : { applicability: "unverified" };
          clients.push({
            ...client,
            configPath: path.owner.configPath,
            ...(path.owner.fallback
              ? { format: "zcode_fallback" as const }
              : {}),
            ...applicability,
            ...(readers.length === 0
              ? {}
              : {
                  sharedWith: readers.map(({ client: reader }) => reader.name),
                }),
          });
        }
      return clients;
    },
    inspectClient: (client) =>
      configurationOperations.run(async () => {
        const project = projectTargets.get(client);
        if (project?.kind === "issue")
          return project.item.status === "failed" ? project.item : undefined;
        if (project?.kind === "planned") {
          const blocker = clientWriteBlocker(client);
          return blocker === undefined
            ? undefined
            : item(client.name, "failed", blocker);
        }
        const ownershipEstablished =
          client.sharedRegistration === true &&
          clientOwnershipEvidencePaths(client).length > 0 &&
          (await hasOwnershipEvidence(client, fileSystem));
        const read = await readClientConfiguration(
          client,
          fileSystem,
          resources,
          ownershipEstablished,
        );
        if (read.kind === "item") {
          if (read.item.status === "failed") return read.item;
          return read.item.status === "skipped"
            ? retainLowerOnlyRegistration(client, ownershipEstablished)
            : undefined;
        }
        const removal = clientRegistrationRemoval(
          read.parsed,
          read.original,
          client,
        );
        if (!removal.ok)
          return item(client.name, "failed", removal.error.detail);
        if (!removal.value.removeNative) {
          const unknown = await retainLowerOnlyRegistration(
            client,
            ownershipEstablished,
            { ...read.parsed, sourcePath: client.configPath },
          );
          if (unknown !== undefined) return unknown;
        }
        // ZCode switches the entire server table to its shared fallback once
        // the last native server disappears. Inspect the table it would load,
        // not just the REA row: unrelated servers may otherwise become active.
        if (
          client.format === "zcode" &&
          removal.value.removeNative &&
          Object.keys(read.parsed.servers).length === 1 &&
          client.zcodeFallbackPath !== undefined
        ) {
          const fallbackClient: UninstallClient = {
            ...client,
            configPath: client.zcodeFallbackPath,
            configPaths: [client.zcodeFallbackPath],
            format: "zcode_fallback",
          };
          const fallback = await readClientConfiguration(
            fallbackClient,
            fileSystem,
            resources,
            true,
          );
          if (fallback.kind === "item") {
            if (fallback.item.status !== "skipped") return fallback.item;
          } else {
            const fallbackRemoval = clientRegistrationRemoval(
              fallback.parsed,
              fallback.original,
              fallbackClient,
            );
            if (!fallbackRemoval.ok)
              return item(client.name, "failed", fallbackRemoval.error.detail);
            const remaining = Object.keys(fallback.parsed.servers).filter(
              (name) =>
                name !== PRODUCT_IDENTITY.mcpServerKey ||
                !fallbackRemoval.value.removeNative,
            );
            if (remaining.length > 0)
              return item(
                client.name,
                "failed",
                "Removing REA's last native ZCode server would activate retained fallback servers; no change was made. Review the fallback configuration, then rerun uninstall.",
              );
          }
        }
        // OpenCode and Kilo merge every layer, so removing REA's entries can
        // expose or change an entry another layer keeps.
        if (
          (client.format === "opencode" || client.format === "kilo") &&
          (removal.value.removeNative || removal.value.legacyPath !== undefined)
        ) {
          const originalLayers: ClientConfigurationSource[] = [];
          const remainingLayers: ClientConfigurationSource[] = [];
          for (const configPath of client.configPaths ?? [client.configPath]) {
            const layer =
              configPath === client.configPath
                ? read
                : await readClientConfiguration(
                    { ...client, configPath },
                    fileSystem,
                    resources,
                    ownershipEstablished,
                  );
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
            if (layerRemoval.value.legacyPath !== undefined)
              delete legacyServers[name];
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
              : !isDeepStrictEqual(selected, remaining);
          if (altersEffectiveRegistration)
            return item(
              client.name,
              "failed",
              client.format === "opencode"
                ? "Removing REA's registration would activate or change an unowned OpenCode registration in another configuration layer, including a possible V1 fallback; no change was made. Remove or replace that registration manually, then rerun uninstall."
                : `Removing REA's registration would activate or change a registration that another Kilo configuration layer${inline === undefined ? "" : ` or ${inline.origin}, which REA does not edit,`} keeps in effect; no change was made. Remove or replace that registration manually, then rerun uninstall.`,
            );
        }
        // REA writes only the user layer. If the read-only lower layers alone
        // still define an entry that is not disabled, removal would leave it
        // (or expose it) in effect, so nothing changes.
        if (client.readOnlyLowerLayers === true && removal.value.removeNative) {
          const lower = await lowerLayerRegistration(
            client,
            ownershipEstablished,
          );
          if (lower.kind === "item") return lower.item;
          if (enabledRegistration(lower.entry))
            return item(
              client.name,
              "failed",
              "A read-only configuration layer REA does not change also defines an enabled REA registration, which would stay in effect after removal; no change was made. Remove that registration with its owner, then rerun uninstall.",
            );
        }
        if (
          !removal.value.removeNative &&
          removal.value.legacyPath === undefined
        )
          return undefined;
        preflightOwnedClients.add(client);
        // A removal the running package would revert, or redirect into its
        // private storage, would leave the registration in place.
        const blocker = clientWriteBlocker(client);
        return blocker === undefined
          ? undefined
          : item(client.name, "failed", blocker);
      }),
    removeClient: (client) =>
      configurationOperations.run(async () => {
        const project = projectTargets.get(client);
        if (project?.kind === "issue") return project.item;
        const result =
          retainedLowerOnly.get(client) ??
          (await removeClient(
            client,
            fileSystem,
            resources,
            platform,
            () => clientWriteBlocker(client),
            preflightOwnedClients.has(client),
            project?.plan,
          ));
        if (result.status === "removed")
          project?.plan.pending.delete(client.configPath);
        return result;
      }),
    inspectSkill: async () => {
      if (projectDirectory !== undefined) return undefined;
      const selection = skillDestinationSelection(
        home,
        undefined,
        environment,
        platform,
      );
      if (selection.issues.length > 0)
        return item(
          "skill",
          "failed",
          selection.issues
            .map(({ path, detail }) => `${detail} (${path})`)
            .join(" "),
        );
      for (const destination of selection.destinations) {
        const inspected = await inspectManagedSkill(
          destination.path,
          destination.client,
          fileSystem,
        );
        if (inspected?.status === "failed") return inspected;
        if (inspected !== undefined) continue;
        const blocker = skillWriteBlocker(destination.path);
        if (blocker !== undefined) return item("skill", "failed", blocker);
      }
      return undefined;
    },
    removeSkill: () =>
      projectDirectory !== undefined
        ? Promise.resolve(
            item(
              "skill",
              "skipped",
              "Project uninstall does not select skills.",
            ),
          )
        : removeManagedSkills(
            home,
            fileSystem,
            environment,
            platform,
            skillWriteBlocker,
          ),
    purgeData: () =>
      projectDirectory === undefined
        ? purgeSelectedData(home, environment, platform, fileSystem)
        : Promise.resolve([]),
    close: async () => {
      try {
        await configurationOperations.close();
        await resources.close();
        return undefined;
      } catch (cause: unknown) {
        return uninstallCleanupError(cause);
      }
    },
  };
};

/**
 * Every user file that can hold REA's registration for one client. An MSIX
 * package can read either its private copy or the AppData file, and earlier
 * setups wrote the AppData file, so both lose REA's entry.
 */
const uninstallConfigPaths = (client: SetupClient): readonly string[] => [
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
const enabledRegistration = (entry: unknown): boolean =>
  entry !== undefined &&
  !(
    typeof entry === "object" &&
    entry !== null &&
    "enabled" in entry &&
    entry.enabled === false
  );

/** Whether removal would change this configuration. */
const registrationPresent = (parsed: ClientConfigurationDocument): boolean => {
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

type ClientConfigurationRead =
  | { readonly kind: "item"; readonly item: UninstallItem }
  | {
      readonly kind: "configuration";
      readonly transactionPath: string;
      readonly original: string;
      readonly parsed: ClientConfigurationDocument;
    };

/** The configuration text, or the outcome to report for a failed read. A
 * completed physical read is retained even when its handle fails to close:
 * that exact text still drives removal, so an owned row it proves stays
 * actionable instead of softening to retained. */
const readClientConfigurationText = async (
  client: UninstallClient,
  transactionPath: string,
  io: {
    readonly fileSystem: UninstallFileSystem;
    readonly resources: ArtifactResourceScope;
    readonly configurationFailure: (detail: string) => ClientConfigurationRead;
  },
): Promise<string | ClientConfigurationRead> => {
  try {
    return await io.fileSystem.readText(transactionPath);
  } catch (cause: unknown) {
    if (isClientConfigurationCleanupFailure(cause)) {
      const cleanup = await retryClientConfigurationCleanup(
        cause,
        io.resources,
      );
      const detail =
        cleanup.primary instanceof InvalidUtf8FileError
          ? "Configuration is not valid UTF-8 and was not changed; its resources could not be released. Repair it, then rerun uninstall."
          : "Configuration could not be read or its resources could not be released. Check file permissions, then rerun uninstall.";
      // An unreleased handle is REA's own incomplete cleanup, never foreign-
      // storage uncertainty: it must stop removal outright, so later removals
      // and purge cannot outrun the failure that close() reports afterwards.
      if (cleanup.cleanup !== undefined)
        return itemRead(item(client.name, "failed", detail));
      const completed: unknown =
        cause.outcome.kind === "completed" ? cause.outcome.value : undefined;
      if (typeof completed !== "string") return io.configurationFailure(detail);
      return completed;
    }
    return isMissing(cause)
      ? itemRead(item(client.name, "skipped", "Configuration does not exist."))
      : io.configurationFailure(
          cause instanceof InvalidUtf8FileError
            ? "Configuration is not valid UTF-8 and was not changed. Repair it, then rerun uninstall."
            : "Configuration could not be read. Check file permissions, then rerun uninstall.",
        );
  }
};

const readClientConfiguration = async (
  client: UninstallClient,
  fileSystem: UninstallFileSystem,
  resources: ArtifactResourceScope,
  ownershipEstablished: boolean,
  /**
   * `read_only` is a lower layer REA never changes: it is read where the
   * client reads it, without the write target's ownership check.
   */
  access: "write_target" | "read_only" = "write_target",
): Promise<ClientConfigurationRead> => {
  const applicabilityUnverified =
    client.applicability === "unverified" && !ownershipEstablished;
  const configurationFailure = (detail: string): ClientConfigurationRead =>
    itemRead(
      item(
        client.name,
        applicabilityUnverified ? "retained" : "failed",
        applicabilityUnverified
          ? `Product applicability could not be established. Shared configuration was retained without blocking other REA removals. ${detail}`
          : detail,
      ),
    );
  if (client.configPathError !== undefined)
    return configurationFailure(client.configPathError);
  const { format } = client;
  if (format === "unsupported")
    return itemRead(
      item(
        client.name,
        "skipped",
        manualRegistrationRemediation(client.name) ??
          "This client has no documented local MCP configuration boundary.",
      ),
    );
  const resolved =
    access === "read_only"
      ? client.configPath
      : await resolveUninstallConfigPath(client, fileSystem);
  if (typeof resolved !== "string")
    return resolved.status === "failed"
      ? configurationFailure(resolved.detail)
      : itemRead(resolved);
  const transactionPath = resolved;
  const original = await readClientConfigurationText(client, transactionPath, {
    fileSystem,
    resources,
    configurationFailure,
  });
  if (typeof original !== "string") return original;
  try {
    const parsed = parseClientConfiguration(original, format);
    return { kind: "configuration", transactionPath, original, parsed };
  } catch (cause: unknown) {
    return configurationFailure(
      cause instanceof ClientConfigurationShapeError ||
        cause instanceof ConfigurationError
        ? `Configuration was not changed: ${cause.message}. Repair it, then rerun uninstall.`
        : format === undefined
          ? "This client's configuration syntax is unknown, so its configuration was not changed."
          : `Configuration is not valid ${clientConfigurationSyntaxName(format)} and was not changed. Repair it, then rerun uninstall.`,
    );
  }
};

const itemRead = (result: UninstallItem): ClientConfigurationRead => ({
  kind: "item",
  item: result,
});

/**
 * Share the exact ownership and applicability decision with preflight. A
 * removable legacy entry carries its document path, so removal edits exactly
 * the entry this decision admitted.
 */
type RegistrationRemoval = {
  readonly removeNative: boolean;
  readonly legacyPath: readonly string[] | undefined;
};
type RegistrationRemovalRefusal = {
  readonly kind: "shadowed_unowned_member" | "foreign_legacy_fallback";
  readonly detail: string;
  /** The owned rows that motivated removal; refusing the edit keeps them. */
  readonly owned: RegistrationRemoval;
};

const ownedRegistrationRemoval = (
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

const clientRegistrationRemoval = (
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

const SHADOWED_UNOWNED_MEMBER_DETAIL = `Configuration repeats the "${PRODUCT_IDENTITY.mcpServerKey}" member, and an earlier duplicate is not REA-owned; removing the registration the client reads would activate an earlier duplicate, so no change was made. Remove the duplicate members manually, then rerun uninstall.`;

const UNOWNED_LEGACY_FALLBACK_DETAIL = `OpenCode falls back to the V1 "mcp.${PRODUCT_IDENTITY.mcpServerKey}" entry, which is not REA-owned; removing REA's native registration would activate it, so no change was made. Remove or replace that V1 entry manually, then rerun uninstall.`;

/** Apply the same exact row edits to both the projected and published document. */
const registrationRemovalDocument = (
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

type ProjectUninstallTarget =
  | { readonly kind: "planned"; readonly plan: ProjectUninstallPlan }
  | { readonly kind: "issue"; readonly item: UninstallItem };

type ProjectConfigurationRead = Extract<
  ClientConfigurationRead,
  { kind: "configuration" }
>;

interface ProjectRemovalFile {
  readonly client: UninstallClient;
  readonly original: string;
  readonly transactionPath: string;
  readonly originalDocument: ClientConfigurationDocument;
  readonly candidate: ClientConfigurationDocument;
}

interface ProjectUninstallPlan {
  readonly directory: string;
  readonly userClient: SetupClient;
  /** Files are removed in native low-to-high precedence order. */
  readonly pending: Map<string, ProjectRemovalFile>;
}

const requireProjectUninstallDirectory = async (
  path: string,
): Promise<string> => {
  try {
    const directory = await realpath(path);
    if ((await lstat(directory)).isDirectory()) return directory;
  } catch (cause: unknown) {
    throw new ConfigurationError(
      `Could not resolve the selected project directory ${path}. Select an existing directory before running uninstall.`,
      { cause },
    );
  }
  throw new ConfigurationError(
    `The selected project ${path} is not a directory.`,
  );
};

const resolveProjectUninstallClients = async (
  supported: readonly SetupClient[],
  directory: string,
  targets: WeakMap<UninstallClient, ProjectUninstallTarget>,
  fileSystem: UninstallFileSystem,
  resources: ArtifactResourceScope,
  platform: NodeJS.Platform,
): Promise<readonly UninstallClient[]> => {
  const selected: UninstallClient[] = [];
  for (const userClient of supported) {
    if (userClient.name !== "pi" && userClient.name !== "opencode") continue;
    const localPaths = new Set(
      clientProjectConfigurationPaths(userClient, directory, platform).filter(
        (path) => withinLexicalDirectory(path, directory, platform),
      ),
    );
    // An unresolved candidate must reach the configuration owner; only a
    // definitively absent file supplies no write target.
    const exists = await Promise.all(
      [...localPaths].map(async (path) => {
        try {
          await lstat(path);
          return true;
        } catch (cause: unknown) {
          return !isAbsentClientConfigPath(cause);
        }
      }),
    );
    if (!exists.includes(true)) continue;
    const observed = await readEffectiveClientRegistrationConfiguration(
      userClient,
      resources,
      platform,
      { projectDirectory: directory, mode: "ownership" },
    );
    const reportIssue = (path: string, detail: string) => {
      const client = { ...userClient, configPath: path };
      selected.push(client);
      targets.set(client, {
        kind: "issue",
        item: item(client.name, "failed", detail),
      });
    };
    if (!observed.ok) {
      reportIssue(observed.error.path, observed.error.detail);
      continue;
    }
    const configuration = observed.value;
    if (configuration.projectInspection === "untrusted") {
      reportIssue(
        appendCallerPath(directory, ".pi/mcp.json", platform),
        "Pi has not admitted this project's configuration. Verify the Pi project trust decision before removing the registration.",
      );
      continue;
    }
    for (const { path, source } of configuration.projectUserAliases ?? []) {
      if (!localPaths.has(path)) continue;
      const removal = ownedRegistrationRemoval(source, userClient);
      if (!removal.removeNative && removal.legacyPath === undefined) continue;
      reportIssue(
        path,
        `The selected project configuration at ${path} aliases user configuration. No change was made.`,
      );
    }
    const plan: ProjectUninstallPlan = {
      directory,
      userClient,
      pending: new Map(),
    };
    for (const source of configuration.projectSources ?? []) {
      const path = source.sourcePath;
      if (!localPaths.has(path) || !registrationPresent(source)) continue;
      const client = { ...userClient, configPath: path };
      selected.push(client);
      const prepared = await prepareProjectRemoval(
        plan,
        client,
        fileSystem,
        resources,
        platform,
      );
      if (prepared.ok) {
        plan.pending.set(path, prepared.value);
        targets.set(client, { kind: "planned", plan });
      } else targets.set(client, { kind: "issue", item: prepared.error });
    }
    const first = plan.pending.values().next().value;
    if (first !== undefined) {
      const issue = await verifyProjectFallback(plan, resources, platform);
      if (issue !== undefined)
        targets.set(first.client, { kind: "issue", item: issue });
    }
  }
  return selected;
};

const prepareProjectRemoval = async (
  plan: ProjectUninstallPlan,
  client: UninstallClient,
  fileSystem: UninstallFileSystem,
  resources: ArtifactResourceScope,
  platform: NodeJS.Platform,
): Promise<Result<ProjectRemovalFile, UninstallItem>> => {
  const read = await readClientConfiguration(
    client,
    fileSystem,
    resources,
    false,
  );
  if (read.kind === "item") return err(read.item);
  const removal = clientRegistrationRemoval(read.parsed, read.original, client);
  if (!removal.ok)
    return err(item(client.name, "failed", removal.error.detail));
  if (!removal.value.removeNative && removal.value.legacyPath === undefined)
    return err(
      item(
        client.name,
        "retained",
        "The rea-named registration is not REA-owned.",
      ),
    );
  if (
    [...plan.pending.values()].some(
      (file) => file.transactionPath === read.transactionPath,
    )
  )
    return err(
      item(
        client.name,
        "failed",
        `Multiple selected configuration paths alias ${read.transactionPath}. Keep only one project configuration path to that file, then rerun uninstall.`,
      ),
    );
  const blocker = await verifyProjectWriteTarget(
    plan,
    client,
    read.transactionPath,
    platform,
  );
  if (blocker !== undefined) return err(blocker);
  return ok({
    client,
    original: read.original,
    transactionPath: read.transactionPath,
    originalDocument: read.parsed,
    candidate: registrationRemovalDocument(
      read.parsed,
      removal.value,
      platform,
    ),
  });
};

const verifyProjectWriteTarget = async (
  project: ProjectUninstallPlan,
  client: UninstallClient,
  transactionPath: string,
  platform: NodeJS.Platform,
): Promise<UninstallItem | undefined> => {
  const failed = (detail: string) => item(client.name, "failed", detail);
  if (!withinLexicalDirectory(transactionPath, project.directory, platform))
    return failed(
      `The selected configuration resolves outside the project directory: ${transactionPath}. No change was made.`,
    );
  try {
    const backupDirectory = await realpath(dirname(client.configPath));
    if (!withinLexicalDirectory(backupDirectory, project.directory, platform))
      return failed(
        `The configuration backup would be outside the selected project directory: ${backupDirectory}. No change was made.`,
      );
  } catch {
    return failed(
      "Could not verify the configuration backup location. No change was made.",
    );
  }
  for (const path of project.userClient.configPaths ?? [
    project.userClient.configPath,
  ]) {
    try {
      if ((await realpath(path)) === transactionPath)
        return failed(
          `The selected project configuration aliases the user configuration at ${path}. No change was made.`,
        );
    } catch (cause: unknown) {
      if (!isMissing(cause))
        return failed(
          `Could not verify the user configuration at ${path}. No change was made.`,
        );
    }
  }
  return undefined;
};

const verifyProjectFallback = async (
  project: ProjectUninstallPlan,
  resources: ArtifactResourceScope,
  platform: NodeJS.Platform,
): Promise<UninstallItem | undefined> => {
  const failed = (detail: string) =>
    item(project.userClient.name, "failed", detail);
  const observed = await readEffectiveClientRegistrationConfiguration(
    project.userClient,
    resources,
    platform,
    {
      projectDirectory: project.directory,
      mode: "ownership",
      candidates: [...project.pending.values()].map(
        ({ client, originalDocument, candidate }) => ({
          path: client.configPath,
          original: originalDocument,
          replacement: candidate,
        }),
      ),
    },
  );
  if (!observed.ok) return failed(observed.error.detail);
  if (observed.value.projectInspection === "untrusted")
    return failed(
      "Pi project trust could not be established for removal. No change was made.",
    );
  const {
    document,
    configPath,
    environmentError,
    preservesOriginalRegistration,
  } = observed.value;
  const remaining =
    document === undefined
      ? undefined
      : effectiveClientServer(document, PRODUCT_IDENTITY.mcpServerKey);
  // A retained row may use another transport or have unknown launcher
  // identity. Its verified equality, independent of readiness, proves this
  // edit cannot change it. A surviving owned row still blocks removal.
  if (
    remaining !== undefined &&
    preservesOriginalRegistration === true &&
    clientRegistrationOwnership(remaining, project.userClient) !== "owned"
  )
    return undefined;
  if (document !== undefined && remaining !== undefined) {
    const activation = parseClientRegistrationActivation(
      remaining,
      project.userClient,
      document,
    );
    if (activation.ok && activation.value === "disabled") return undefined;
  }
  if (environmentError !== undefined) return failed(environmentError.detail);
  if (remaining === undefined) return undefined;
  return failed(
    `Removing this registration would leave another or unresolved REA registration at ${configPath}. No change was made. Review that registration, then rerun uninstall.`,
  );
};

/** Match the planned bytes and path identities before applying its next edit. */
const verifyProjectRemoval = async (
  project: ProjectUninstallPlan,
  client: UninstallClient,
  current: ProjectConfigurationRead,
  fileSystem: UninstallFileSystem,
  resources: ArtifactResourceScope,
  platform: NodeJS.Platform,
): Promise<UninstallItem | undefined> => {
  const target = await verifyProjectWriteTarget(
    project,
    client,
    current.transactionPath,
    platform,
  );
  if (target !== undefined) return target;
  for (const planned of project.pending.values()) {
    const read =
      planned.client === client
        ? current
        : await readClientConfiguration(
            planned.client,
            fileSystem,
            resources,
            false,
          );
    if (
      read.kind !== "configuration" ||
      read.transactionPath !== planned.transactionPath ||
      read.original !== planned.original
    )
      return item(
        client.name,
        "failed",
        `Project configuration ${planned.client.configPath} changed or could not be verified since preflight. Review the current configuration, then rerun uninstall.`,
      );
  }
  return verifyProjectFallback(project, resources, platform);
};

/** Preserve the bytes uninstall is about to edit and return the backup holding them. */
const backupClientConfiguration = async (
  client: SetupClient,
  transactionPath: string,
  original: string,
  options: RecoveryBackupPreservationOptions,
): Promise<string | UninstallItem> => {
  const failed = (detail: string) =>
    item(
      client.name,
      "failed",
      `Configuration could not be backed up, so no change was made. ${detail}`,
    );
  try {
    const preserved =
      client.privateProfile === undefined
        ? await preserveCurrentRecoveryBackup(
            `${client.configPath}.rea.backup`,
            transactionPath,
            original,
            options,
          )
        : // A private profile's backup stays owner-only (0600).
          await preservePrivateRecoveryBackup(
            `${client.configPath}.rea.backup`,
            transactionPath,
            original,
            options.resources,
          );
    if (preserved.ok) return preserved.value;
    if (preserved.error.kind === "occupied")
      return failed(
        `${preserved.error.detail}. Move that file aside, then rerun uninstall.`,
      );
  } catch (cause: unknown) {
    // The resource scope retains a backup handle whose close failed.
    if (!(cause instanceof RegularFileCleanupFailure)) throw cause;
  }
  return failed("Check file permissions, then rerun uninstall.");
};

const removeClient = async (
  client: UninstallClient,
  fileSystem: UninstallFileSystem,
  resources: ArtifactResourceScope,
  platform: NodeJS.Platform,
  writeBlocker?: () => string | undefined,
  preflightOwned = false,
  project?: ProjectUninstallPlan,
): Promise<UninstallItem> => {
  const read = await readClientConfiguration(
    client,
    fileSystem,
    resources,
    preflightOwned,
  );
  if (read.kind === "item")
    return project === undefined || read.item.status === "failed"
      ? read.item
      : item(
          client.name,
          "failed",
          `Project configuration ${client.configPath} could not be verified since preflight. Review the current configuration, then rerun uninstall.`,
        );
  if (project !== undefined) {
    const issue = await verifyProjectRemoval(
      project,
      client,
      read,
      fileSystem,
      resources,
      platform,
    );
    if (issue !== undefined) return issue;
  }
  const { transactionPath, original, parsed } = read;
  const name = PRODUCT_IDENTITY.mcpServerKey;
  if (
    parsed.dialect === "dsh" &&
    dshDocument(parsed.document).hasUnknownStructure
  )
    return item(
      client.name,
      "retained",
      "A Cordis expression may produce registration rows, so the patch was retained without changes.",
    );
  if (!registrationPresent(parsed))
    return item(client.name, "skipped", "REA registration is absent.");
  const removal = clientRegistrationRemoval(parsed, original, client);
  if (!removal.ok) return item(client.name, "failed", removal.error.detail);
  const { removeNative, legacyPath } = removal.value;
  const removeLegacy = legacyPath !== undefined;
  if (!removeNative && !removeLegacy)
    return item(
      client.name,
      "retained",
      "The rea-named registration is not REA-owned.",
    );
  const blocker = writeBlocker?.();
  if (blocker !== undefined) return item(client.name, "failed", blocker);
  const candidate = registrationRemovalDocument(
    parsed,
    removal.value,
    platform,
  );
  const editedPaths = [
    ...(removeNative ? [clientServerPath(parsed, name)] : []),
    ...(legacyPath === undefined ? [] : [legacyPath]),
  ];
  let serialized: ReturnType<typeof serializeClientConfiguration>;
  try {
    serialized = serializeClientConfiguration(
      candidate.document,
      client.format,
      original,
      editedPaths,
      // clientRegistrationRemoval admitted only names whose repeats REA owns.
      { removeShadowedMembersAt: editedPaths },
    );
  } catch (cause: unknown) {
    return item(
      client.name,
      "failed",
      cause instanceof ConfigurationError
        ? `Configuration could not be updated, so no change was made. ${cause.message}.`
        : "Configuration could not be updated, so no change was made. Repair the configuration, then rerun uninstall.",
    );
  }
  if (!serialized.ok)
    return item(
      client.name,
      "failed",
      `Configuration repeats the member at ${JSON.stringify(serialized.error.path)}; removing the registration the client reads would activate an earlier duplicate, so no change was made. Remove the duplicate members manually, then rerun uninstall.`,
    );
  const backupPath = await backupClientConfiguration(
    client,
    transactionPath,
    original,
    {
      copy: (source, destination) => fileSystem.copy(source, destination),
      resources,
    },
  );
  if (typeof backupPath !== "string") return backupPath;
  const manualRecovery = () =>
    item(
      client.name,
      "failed",
      `Configuration could not be updated or restored. Restore the backup at ${backupPath} manually, then rerun uninstall.`,
    );
  let publication: Awaited<
    ReturnType<UninstallFileSystem["publishConfiguration"]>
  >;
  try {
    publication = await fileSystem.publishConfiguration(
      transactionPath,
      serialized.value,
      original,
    );
  } catch (cause: unknown) {
    if (isClientConfigurationCleanupFailure(cause))
      await retryClientConfigurationCleanup(cause, resources);
    return manualRecovery();
  }
  const verifyRemoval = async (): Promise<UninstallItem> => {
    try {
      const text = await fileSystem.readText(publication.path);
      await publication.assertCurrent(text);
      const readback = parseClientConfiguration(text, client.format);
      if (
        (removeNative && Object.hasOwn(readback.servers, name)) ||
        (readback.dialect === "dsh" &&
          dshDocument(readback.document).carriesEntry) ||
        (removeLegacy && Object.hasOwn(readback.legacyServers, name))
      )
        throw new Error("registration readback mismatch");
      return item(
        client.name,
        "removed",
        `Removed registration from ${client.configPath}.`,
      );
    } catch (cause: unknown) {
      if (isClientConfigurationCleanupFailure(cause))
        await retryClientConfigurationCleanup(cause, resources);
      try {
        await publication.restore(original);
      } catch {
        return manualRecovery();
      }
      return item(
        client.name,
        "failed",
        `Configuration could not be updated. The original was restored and its backup at ${backupPath} was retained. Repair the configuration or restore that backup, then rerun uninstall.`,
      );
    }
  };
  let completed: UninstallItem | undefined;
  try {
    return await publication.verify(async () => {
      completed = await verifyRemoval();
      return completed;
    });
  } catch (cause: unknown) {
    if (isClientConfigurationCleanupFailure(cause))
      await retryClientConfigurationCleanup(cause, resources);
    // Finalizing the staging owner can fail after verification or rollback settled.
    const detail =
      completed === undefined
        ? "Configuration verification or resource cleanup failed."
        : `${completed.detail} Configuration publication cleanup failed.`;
    const recovery =
      completed?.status === "failed"
        ? ""
        : ` The backup at ${backupPath} was retained. Check the configuration and rerun uninstall.`;
    return item(client.name, "failed", `${detail}${recovery}`);
  }
};

const resolveUninstallConfigPath = async (
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
 * Layered clients are removed file by file, but callers look up one status by
 * client name. Aggregate status does not invalidate any constituent outcome.
 */
const collapseUninstallItems = (
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
