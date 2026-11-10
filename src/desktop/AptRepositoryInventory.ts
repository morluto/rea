import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  aptListFileName,
  entryForTarget,
  isUbuntuProRepository,
  parseAptConfigShell,
  parseAptIndexTargets,
  parseDeb822Sources,
  parseOneLineSources,
  type AptIndexTarget,
  type AptSourceEntry,
  type AptSourceStanza,
} from "../domain/desktop/aptRepositories.js";
import type { AptRepository } from "../domain/desktop/desktopCapture.js";
import {
  withGpgvKeyCheck,
  type HeldKey,
  type VerifiedKey,
} from "./GpgvKeyCheck.js";
import { hostFileKind, readHostFile } from "./HostFileRead.js";
import { succeeded, type QueryRunner } from "./HostQuery.js";

/** Where apt keeps its trusted keys and downloaded lists. */
export interface AptLocations {
  readonly trustedParts: string;
  readonly trusted: string;
  readonly lists: string;
}

export const APT_LOCATIONS: AptLocations = {
  trustedParts: "/etc/apt/trusted.gpg.d",
  trusted: "/etc/apt/trusted.gpg",
  lists: "/var/lib/apt/lists",
};

/**
 * apt's folders as `apt-config` resolves them under `Dir`, which an
 * `APT_CONFIG` file can move, as a user-space `apt-get update` does with its
 * lists. Each is the fallback's when apt-config is missing, fails or does not
 * name it.
 */
export const resolveAptLocations = async (
  runQuery: QueryRunner,
  signal: AbortSignal | undefined,
  fallback: AptLocations = APT_LOCATIONS,
): Promise<AptLocations> => {
  const output = succeeded(
    await runQuery(
      "apt-config",
      [
        "shell",
        "LISTS",
        "Dir::State::Lists/d",
        "PARTS",
        "Dir::Etc::TrustedParts/d",
        "TRUSTED",
        "Dir::Etc::Trusted/f",
      ],
      signal,
    ),
  );
  const values = parseAptConfigShell(output ?? "");
  const value = (name: string) => {
    const found = values.get(name);
    return found?.startsWith("/") === true ? found : undefined;
  };
  return {
    lists: value("LISTS") ?? fallback.lists,
    trustedParts: value("PARTS") ?? fallback.trustedParts,
    trusted: value("TRUSTED") ?? fallback.trusted,
  };
};

/** The host commands and apt folders the repository check reads. */
export interface AptRepositoryHost {
  readonly runQuery: QueryRunner;
  readonly apt: AptLocations;
}

/** The repositories, each verified key's retained bytes by sha256, and what could not be read. */
export interface AptRepositoryFacts {
  readonly repositories: readonly AptRepository[];
  readonly keys: ReadonlyMap<string, Buffer>;
  /** The Packages indexes apt lists; empty when it was not asked or could not list them. */
  readonly indexTargets: readonly AptIndexTarget[];
  readonly limitations: readonly string[];
}

const FILE_MAX_BYTES = 1024 * 1024;
const MAX_CANDIDATE_KEYS = 64;
const UBUNTU_PRO =
  "not checked: it is an Ubuntu Pro (ESM) repository, which apt reaches only with the host's Ubuntu Pro credentials, and the computer has none";

/** apt's Packages indexes by the text `apt-cache policy` prints for each; undefined when apt-get could not list them. */
const indexTargets = async (
  runQuery: QueryRunner,
  signal: AbortSignal | undefined,
): Promise<ReadonlyMap<string, AptIndexTarget> | undefined> => {
  const output = succeeded(
    await runQuery("apt-get", ["indextargets", "Created-By: Packages"], signal),
  );
  if (output === undefined) return undefined;
  const targets = new Map<string, AptIndexTarget>();
  for (const target of parseAptIndexTargets(output))
    if (!targets.has(target.description))
      targets.set(target.description, target);
  return targets;
};

/** The stanzas of each sources file apt names, read once; files that could not be read are kept for the limitations. */
const sourcesFiles = (signal: AbortSignal | undefined) => {
  const parsed = new Map<string, readonly AptSourceStanza[]>();
  const unreadable: string[] = [];
  const read = async (file: string): Promise<readonly AptSourceStanza[]> => {
    const cached = parsed.get(file);
    if (cached !== undefined) return cached;
    const bytes = await readHostFile(file, FILE_MAX_BYTES, signal);
    if (bytes === "unreadable") unreadable.push(file);
    const stanzas =
      typeof bytes === "string"
        ? []
        : (file.endsWith(".sources")
            ? parseDeb822Sources
            : parseOneLineSources)(bytes.toString("utf8"), file);
    parsed.set(file, stanzas);
    return stanzas;
  };
  return { read, unreadable };
};

const fileNames = async (directory: string): Promise<readonly string[]> =>
  (await readdir(directory).catch(() => [] as string[])).sort();

/** The entry's Signed-By keyrings, or every key apt trusts for all repositories. */
const candidateKeys = async (
  entry: AptSourceEntry,
  apt: AptLocations,
): Promise<readonly string[]> => {
  const signedBy = entry.signedBy.filter((value) => value.startsWith("/"));
  if (signedBy.length > 0) return signedBy;
  return [
    ...(await fileNames(apt.trustedParts))
      .filter((name) => name.endsWith(".gpg") || name.endsWith(".asc"))
      .map((name) => join(apt.trustedParts, name)),
    apt.trusted,
  ];
};

/** The index's signed release beside it in apt's lists folder: InRelease, or Release.gpg with the Release it signs; null when a check could not tell. */
const signedRelease = async (
  target: AptIndexTarget,
): Promise<readonly string[] | null | undefined> => {
  const prefix = join(
    dirname(target.filename),
    aptListFileName(target.baseUri),
  );
  const inRelease = await hostFileKind(`${prefix}InRelease`);
  if (inRelease === null) return null;
  if (inRelease) return [`${prefix}InRelease`];
  const signed = await hostFileKind(`${prefix}Release.gpg`);
  if (!signed && signed !== null) return undefined;
  const release = await hostFileKind(`${prefix}Release`);
  // A detached release needs both members, so a Release known to be absent
  // settles the pair even when Release.gpg could not be probed.
  if (release === false) return undefined;
  if (signed === null || release === null) return null;
  return [`${prefix}Release.gpg`, `${prefix}Release`];
};

/** The keys gpgv checks a release with: candidate key files, or the one key the sources entry holds. */
type KeyCandidates = readonly string[] | HeldKey;

interface RepositoryContext {
  readonly apt: AptLocations;
  readonly targets: ReadonlyMap<string, AptIndexTarget> | undefined;
  readonly sources: (file: string) => Promise<readonly AptSourceStanza[]>;
  readonly verify: (
    candidates: KeyCandidates,
    release: readonly string[],
  ) => Promise<VerifiedKey | { readonly reason: string }>;
}

/** Why a source's key could not be checked, or the release and candidate keys gpgv checks. */
const keyCheck = async (
  target: AptIndexTarget | undefined,
  entry: AptSourceEntry | undefined,
  context: RepositoryContext,
): Promise<
  | { readonly reason: string }
  | {
      readonly release: readonly string[];
      readonly candidates: KeyCandidates;
    }
> => {
  if (target === undefined)
    return {
      reason:
        context.targets === undefined
          ? "apt-get indextargets did not list apt's indexes"
          : "apt-get indextargets lists no index with this source",
    };
  if (entry === undefined)
    return {
      reason: `no sources entry at ${target.sourcesFile}:${String(target.position)} configures it`,
    };
  const release = await signedRelease(target);
  if (release === null)
    return {
      reason: `apt's release files for it in ${dirname(target.filename)} could not be checked`,
    };
  if (release === undefined)
    return {
      reason: `apt holds no signed release file for it in ${dirname(target.filename)}`,
    };
  // apt trusts only the key an entry holds, never the keys it trusts for all repositories.
  if (entry.inlineKey !== null)
    return {
      release,
      candidates: { path: entry.file, bytes: Buffer.from(entry.inlineKey) },
    };
  const candidates = await candidateKeys(entry, context.apt);
  return candidates.length > MAX_CANDIDATE_KEYS
    ? { reason: `more than ${String(MAX_CANDIDATE_KEYS)} candidate keys` }
    : { release, candidates };
};

/** A repository's facts from apt's index target and the sources entry it names, before its key is checked. */
const repositoryBase = (
  source: string,
  target: AptIndexTarget | undefined,
  entry: AptSourceEntry | undefined,
): Omit<AptRepository, "signing_key" | "signing_key_reason"> =>
  entry === undefined
    ? {
        source,
        sources_file: null,
        uri: null,
        uri_credentials_removed: false,
        suite: null,
        components: [],
        architectures: [],
        release: target?.suite ?? target?.codename ?? null,
      }
    : {
        source,
        sources_file: entry.file,
        uri: entry.uri,
        uri_credentials_removed: entry.credentials,
        suite: entry.suite,
        components: [...entry.components],
        architectures: [...entry.architectures],
        release: target?.suite ?? target?.codename ?? null,
      };

/** One vendor source with the entry apt read it from and the key gpgv verified its release with. */
const repositoryFacts = async (
  vendor: { readonly source: string; readonly origin: string | null },
  context: RepositoryContext,
): Promise<{ repository: AptRepository; key: VerifiedKey | undefined }> => {
  const target = context.targets?.get(vendor.source);
  const entry =
    target === undefined
      ? undefined
      : entryForTarget(target, await context.sources(target.sourcesFile));
  const base = repositoryBase(vendor.source, target, entry);
  const unverified = (reason: string) => ({
    repository: { ...base, signing_key: null, signing_key_reason: reason },
    key: undefined,
  });
  const origin = vendor.origin ?? target?.origin ?? null;
  if (isUbuntuProRepository(origin, base.uri ?? target?.repoUri ?? null))
    return unverified(UBUNTU_PRO);
  const check = await keyCheck(target, entry, context);
  if ("reason" in check) return unverified(check.reason);
  const verified = await context.verify(check.candidates, check.release);
  if ("reason" in verified) return unverified(verified.reason);
  const { path, sha256, format, fingerprint } = verified;
  return {
    repository: { ...base, signing_key: { path, sha256, format, fingerprint } },
    key: verified,
  };
};

/**
 * The apt repositories other than Ubuntu's that list the installed version.
 * `apt-get indextargets` names each source's sources entry, release and
 * signed release file; the key is the one whose signature over that release
 * gpgv verified: the key the entry's Signed-By holds, its Signed-By keyrings,
 * or every key apt trusts.
 */
export const inspectAptRepositories = async (
  installed: {
    readonly sources: readonly string[];
    readonly origins: readonly (string | null)[] | undefined;
  },
  host: AptRepositoryHost,
  signal: AbortSignal | undefined,
): Promise<AptRepositoryFacts> => {
  const vendor = installed.sources.flatMap((source, index) => {
    const origin = installed.origins?.[index] ?? null;
    return origin === "Ubuntu" ? [] : [{ source, origin }];
  });
  if (vendor.length === 0)
    return {
      repositories: [],
      keys: new Map(),
      indexTargets: [],
      limitations: [],
    };
  const targets = await indexTargets(host.runQuery, signal);
  const files = sourcesFiles(signal);
  return withGpgvKeyCheck(host.runQuery, signal, async (check) => {
    const context: RepositoryContext = {
      apt: host.apt,
      targets,
      sources: files.read,
      verify: (candidates, release) =>
        "bytes" in candidates
          ? check.heldVerifying(candidates, release)
          : check.firstVerifying(candidates, release),
    };
    const keys = new Map<string, Buffer>();
    const repositories: AptRepository[] = [];
    for (const source of vendor) {
      const facts = await repositoryFacts(source, context);
      repositories.push(facts.repository);
      if (facts.key !== undefined) keys.set(facts.key.sha256, facts.key.bytes);
    }
    return {
      repositories,
      keys,
      indexTargets: [...(targets?.values() ?? [])],
      limitations: files.unreadable.map(
        (file) =>
          `The apt sources file ${file} could not be read, so repositories it lists are not matched.`,
      ),
    };
  });
};
