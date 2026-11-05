import { readdir } from "node:fs/promises";

import {
  ArtifactReaderFailure,
  artifactPrimaryCleanupLeases,
} from "../artifacts/ArtifactReader.js";
import {
  fromUbuntuNobleArchive,
  repositoryRefusal,
} from "../domain/desktop/appExportInstall.js";
import {
  declaredPackageFiles,
  repositorySupplies,
} from "../domain/desktop/aptRepositories.js";
import type {
  AptRepository,
  DesktopApplicationInventory,
} from "../domain/desktop/desktopCapture.js";
import {
  DPKG_STATUS_FORMAT,
  ownershipCandidates,
  parseAptPolicyOrigins,
  parseAptPolicySources,
  parseDpkgOwners,
  parseDpkgStatus,
} from "../domain/desktop/linuxPackages.js";
import {
  inspectAptRepositories,
  resolveAptLocations,
  type AptRepositoryHost,
} from "./AptRepositoryInventory.js";
import { succeeded } from "./HostQuery.js";
import {
  inspectLibraryPackages,
  installableLibraries,
  installablePackages,
} from "./LibraryPackageInventory.js";

/** The host commands and apt folders Debian package identification reads. */
export type DebianPackageHost = AptRepositoryHost;

/** What package identification reads with and adds to. */
export interface InventoryContext {
  readonly host: DebianPackageHost;
  readonly signal: AbortSignal | undefined;
  readonly limitations: string[];
  readonly signingKeys: Map<string, Buffer>;
}

type Package = DesktopApplicationInventory["package"];

/** The `o=` origin of every package file `apt-cache policy` lists; undefined when apt could not be asked. */
const policyOrigins = async (
  context: InventoryContext,
): Promise<ReadonlyMap<string, string | null> | undefined> => {
  const policy = succeeded(
    await context.host.runQuery("apt-cache", ["policy"], context.signal),
  );
  return policy === undefined ? undefined : parseAptPolicyOrigins(policy);
};

/**
 * One failure for two that failed side by side: it keeps both causes, and the
 * cleanup facts and leases of each, so a handle or folder either side could
 * not release keeps its owner.
 */
const bothFailed = (first: unknown, second: unknown): unknown => {
  // A shared cause, such as the caller's abort reason, stays itself.
  if (Object.is(first, second)) return first;
  const causes = [first, second];
  const both = new AggregateError(
    causes,
    causes
      .map((cause) => (cause instanceof Error ? cause.message : String(cause)))
      .join("; "),
  );
  const cleanups = causes.flatMap((cause) =>
    cause instanceof ArtifactReaderFailure && cause.cleanup !== undefined
      ? [cause.cleanup]
      : [],
  );
  if (cleanups.length === 0) return both;
  const leases = causes.map(artifactPrimaryCleanupLeases);
  return ArtifactReaderFailure.withCleanup(
    both,
    {
      reason: cleanups.map(({ reason }) => reason).join("; "),
      resources: [...new Set(cleanups.flatMap(({ resources }) => resources))],
    },
    undefined,
    // Unknown when either side holds cleanup without an exact owner.
    leases.includes(undefined)
      ? undefined
      : [...new Set(leases.flatMap((owned) => owned ?? []))],
  );
};

/** Settle both, so neither is left running, then report what failed. */
const settled = async <First, Second>(
  first: Promise<First>,
  second: Promise<Second>,
): Promise<[First, Second]> => {
  const [one, two] = await Promise.allSettled([first, second]);
  if (one.status === "rejected" && two.status === "rejected")
    throw bothFailed(one.reason, two.reason);
  if (one.status === "rejected") throw one.reason;
  if (two.status === "rejected") throw two.reason;
  return [one.value, two.value];
};

/**
 * Vendor repositories with their verified keys and, unless the archive
 * installs the package by name, the installable packages of the libraries
 * the executable loads, which a vendor repository's package or a local
 * install's may leave out of its dependencies; the library walk runs beside
 * the repository check.
 */
const installFacts = async (
  installed: Pick<
    Package,
    "name" | "sources" | "source_origins" | "executable_package"
  >,
  executable: string,
  context: InventoryContext,
  origins: ReadonlyMap<string, string | null> | undefined,
): Promise<Partial<Package>> => {
  const { runQuery } = context.host;
  const [vendor, libraries] = await settled(
    inspectAptRepositories(
      { sources: installed.sources, origins: installed.source_origins },
      context.host,
      context.signal,
    ),
    fromUbuntuNobleArchive(installed.sources, installed.source_origins)
      ? Promise.resolve(undefined)
      : inspectLibraryPackages(
          executable,
          installed.name ?? "",
          runQuery,
          context.signal,
        ),
  );
  context.limitations.push(...vendor.limitations);
  for (const [sha256, bytes] of vendor.keys)
    context.signingKeys.set(sha256, bytes);
  const usable = (repository: AptRepository) =>
    repositoryRefusal(repository) === undefined;
  const declared = declaredPackageFiles(
    vendor.repositories.filter(usable),
    vendor.indexTargets,
  );
  const program = installed.executable_package;
  const split = await installablePackages(
    [
      ...(libraries?.library_packages ?? []),
      ...(program === undefined ? [] : [program]),
    ],
    { origins, declared },
    runQuery,
    context.signal,
  );
  // The export checks these against the repositories it still declares.
  const supplies = (repository: AptRepository) =>
    split === undefined || !usable(repository)
      ? []
      : repositorySupplies(repository, split.supplied, vendor.indexTargets);
  return {
    apt_repositories: vendor.repositories.map((repository) => ({
      ...repository,
      supplies: [...supplies(repository)],
    })),
    ...(libraries === undefined ? {} : installableLibraries(libraries, split)),
    ...(program === undefined ? {} : executablePackageFacts(program, split)),
  };
};

/** Why the computer cannot install the executable's package by name beside the entry's, by the library packages' rule; nothing when it can. */
const executablePackageFacts = (
  name: string,
  split: Awaited<ReturnType<typeof installablePackages>>,
): Pick<Package, "executable_package_reason"> => {
  if (split?.installable.includes(name) === true) return {};
  return {
    executable_package_reason:
      split === undefined
        ? `apt-cache policy did not say where ${name} comes from`
        : `neither the Ubuntu 24.04 archive nor a vendor repository the export declares offers ${name}`,
  };
};

/** Which package dpkg says owns the paths, or why it could not say. */
type Ownership =
  | { readonly kind: "owned"; readonly name: string }
  | { readonly kind: "unowned" }
  | { readonly kind: "unknown"; readonly reason: string };

/** The owner of the first path dpkg owns; unknown once a query fails, since that path's owner would have come first. */
const dpkgOwner = async (
  paths: readonly string[],
  { host, signal }: InventoryContext,
): Promise<Ownership> => {
  for (const path of ownershipCandidates(paths)) {
    const outcome = await host.runQuery("dpkg-query", ["-S", path], signal);
    if (outcome === "missing")
      return { kind: "unknown", reason: "dpkg-query is not installed" };
    // dpkg-query exits 1 when no package owns the path and 2 when it could not tell.
    if (outcome === "failed" || outcome.exitCode > 1)
      return {
        kind: "unknown",
        reason: `dpkg-query could not say which package owns ${path}`,
      };
    const [name] = parseDpkgOwners(outcome.stdout, path);
    if (name !== undefined) return { kind: "owned", name };
  }
  return { kind: "unowned" };
};

/** A package name without the `:<architecture>` dpkg may qualify it with. */
const unqualified = (name: string): string => name.split(":")[0] ?? name;

/** The files a Debian package is identified from. */
export interface DebianPackagePaths {
  /** The program as launched and as resolved; dpkg may own either. */
  readonly program: readonly string[];
  /** The resolved program, whose libraries are walked. */
  readonly executable: string;
  /** The launched desktop entry and its resolved file; empty for an executable launch. */
  readonly entry: readonly string[];
}

/**
 * The Debian package that owns the desktop entry, or else the executable,
 * with the apt sources of its installed version, the vendor repositories
 * among them and the packages of the libraries the executable loads;
 * `unknown` when dpkg owns neither.
 */
export const debianPackage = async (
  { program, executable, entry }: DebianPackagePaths,
  context: InventoryContext,
): Promise<Package> => {
  const { host, signal, limitations } = context;
  const unknown: Package = {
    kind: "unknown",
    name: null,
    version: null,
    architecture: null,
    sources: [],
    package_lists_present: null,
  };
  const executableOwner = await dpkgOwner(program, context);
  if (executableOwner.kind === "unknown") {
    limitations.push(
      `${executableOwner.reason}, so the package that owns the executable is unknown.`,
    );
    return unknown;
  }
  // The entry's package installs the application, whose program can come from another package.
  const entryOwner =
    entry.length === 0
      ? ({ kind: "unowned" } as const)
      : await dpkgOwner(entry, context);
  if (entryOwner.kind === "unknown") {
    limitations.push(
      `${entryOwner.reason}, so the package that owns the desktop entry, which installs the application, is unknown.`,
    );
    return unknown;
  }
  const owner = executableOwner.kind === "owned" ? executableOwner.name : null;
  const name = entryOwner.kind === "owned" ? entryOwner.name : owner;
  if (name === null) return unknown;
  const status = succeeded(
    await host.runQuery(
      "dpkg-query",
      ["-W", `-f=${DPKG_STATUS_FORMAT}`, name],
      signal,
    ),
  );
  const parsed = status === undefined ? undefined : parseDpkgStatus(status);
  const policy = succeeded(
    await host.runQuery("apt-cache", ["policy", name], signal),
  );
  const apt = await resolveAptLocations(host.runQuery, signal, host.apt);
  const listsPresent = (
    await readdir(apt.lists).catch(() => [] as string[])
  ).some((list) => /_Packages(?:\.[a-z0-9]+)?$/u.test(list));
  if (!listsPresent)
    limitations.push(
      "No apt package lists are present, so whether the installed version comes from a package archive is unknown.",
    );
  const sources =
    policy === undefined ? [] : [...parseAptPolicySources(policy)];
  // A local install's library packages are matched to the archive by origin too.
  const origins = await policyOrigins(context);
  const installed = {
    kind: "deb" as const,
    name: parsed?.name ?? name,
    ...(owner === null || unqualified(owner) === unqualified(name)
      ? {}
      : { executable_package: unqualified(owner) }),
    // Installing the entry's package does not bring a program no package owns, such as ~/.local/bin/<name>.
    ...(owner === null
      ? { executable_package_reason: `no package owns ${executable}` }
      : {}),
    version: parsed?.version ?? null,
    architecture: parsed?.architecture ?? null,
    sources,
    ...(origins === undefined
      ? {}
      : {
          source_origins: sources.map((source) => origins.get(source) ?? null),
        }),
    package_lists_present: listsPresent,
  };
  return {
    ...installed,
    ...(await installFacts(
      installed,
      executable,
      { ...context, host: { ...host, apt } },
      origins,
    )),
  };
};
