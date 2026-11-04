import { readdir } from "node:fs/promises";

import type { DesktopApplicationInventory } from "../domain/desktop/desktopCapture.js";
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
  type AptRepositoryHost,
} from "./AptRepositoryInventory.js";
import { succeeded } from "./HostQuery.js";
import { inspectLibraryPackages } from "./LibraryPackageInventory.js";

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

/** The apt origin of each source by index; omitted when apt could not be asked. */
const sourceOrigins = async (
  sources: readonly string[],
  context: InventoryContext,
): Promise<Pick<Package, "source_origins">> => {
  if (sources.length === 0) return { source_origins: [] };
  const policy = succeeded(
    await context.host.runQuery("apt-cache", ["policy"], context.signal),
  );
  if (policy === undefined) return {};
  const origins = parseAptPolicyOrigins(policy);
  return {
    source_origins: sources.map((source) => origins.get(source) ?? null),
  };
};

/** Vendor repositories with their verified keys, and the libraries the executable loads. */
const installFacts = async (
  installed: Pick<Package, "name" | "sources" | "source_origins">,
  executable: string,
  context: InventoryContext,
): Promise<Partial<Package>> => {
  const vendor = await inspectAptRepositories(
    { sources: installed.sources, origins: installed.source_origins },
    context.host,
    context.signal,
  );
  context.limitations.push(...vendor.limitations);
  for (const [sha256, bytes] of vendor.keys)
    context.signingKeys.set(sha256, bytes);
  return {
    apt_repositories: [...vendor.repositories],
    ...(await inspectLibraryPackages(
      executable,
      installed.name ?? "",
      context.host.runQuery,
      context.signal,
    )),
  };
};

/**
 * The Debian package that owns the executable, with the apt sources of its
 * installed version, the vendor repositories among them and the packages of
 * the libraries the executable loads; `unknown` when dpkg owns no candidate.
 */
export const debianPackage = async (
  paths: readonly string[],
  executable: string,
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
  for (const path of ownershipCandidates(paths)) {
    const owners = await host.runQuery("dpkg-query", ["-S", path], signal);
    if (owners === "missing") {
      limitations.push(
        "dpkg-query is not installed, so the package that owns the executable is unknown.",
      );
      return unknown;
    }
    const [name] = parseDpkgOwners(succeeded(owners) ?? "", path);
    if (name === undefined) continue;
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
    const listsPresent = (
      await readdir(host.apt.lists).catch(() => [] as string[])
    ).some((list) => /_Packages(?:\.[a-z0-9]+)?$/u.test(list));
    if (!listsPresent)
      limitations.push(
        "No apt package lists are present, so whether the installed version comes from a package archive is unknown.",
      );
    const sources =
      policy === undefined ? [] : [...parseAptPolicySources(policy)];
    const installed = {
      kind: "deb" as const,
      name: parsed?.name ?? name,
      version: parsed?.version ?? null,
      architecture: parsed?.architecture ?? null,
      sources,
      ...(await sourceOrigins(sources, context)),
      package_lists_present: listsPresent,
    };
    return {
      ...installed,
      ...(await installFacts(installed, executable, context)),
    };
  }
  return unknown;
};
