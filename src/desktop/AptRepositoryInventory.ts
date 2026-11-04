import { createHash } from "node:crypto";
import { readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  aptReleaseFilePrefix,
  dearmorPublicKeys,
  isArmoredKey,
  parseDeb822Sources,
  parseOneLineSources,
  sourceEntryFor,
  validSignatureFingerprint,
  type AptSourceEntry,
} from "../domain/desktop/aptRepositories.js";
import type { AptRepository } from "../domain/desktop/desktopCapture.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import { readHostFile } from "./HostFileRead.js";
import { succeeded, type QueryRunner } from "./HostQuery.js";

/** Where apt keeps its sources, trusted keys and downloaded lists. */
export interface AptLocations {
  readonly sourceList: string;
  readonly sourceParts: string;
  readonly trustedParts: string;
  readonly trusted: string;
  readonly lists: string;
}

export const APT_LOCATIONS: AptLocations = {
  sourceList: "/etc/apt/sources.list",
  sourceParts: "/etc/apt/sources.list.d",
  trustedParts: "/etc/apt/trusted.gpg.d",
  trusted: "/etc/apt/trusted.gpg",
  lists: "/var/lib/apt/lists",
};

/** The host commands and apt folders the repository check reads. */
export interface AptRepositoryHost {
  readonly runQuery: QueryRunner;
  readonly apt: AptLocations;
}

/** The repositories, each verified key's bytes by sha256 for the capture to retain, and what could not be read. */
export interface AptRepositoryFacts {
  readonly repositories: readonly AptRepository[];
  readonly keys: ReadonlyMap<string, Buffer>;
  readonly limitations: readonly string[];
}

const FILE_MAX_BYTES = 1024 * 1024;
const MAX_CANDIDATE_KEYS = 64;

const fileNames = async (directory: string): Promise<readonly string[]> =>
  (await readdir(directory).catch(() => [] as string[])).sort();

const isFile = async (path: string): Promise<boolean> =>
  (await stat(path).catch(() => undefined))?.isFile() === true;

/** Every `deb` entry apt reads, in its order, and the sources files that could not be read. */
const sourceEntries = async (
  apt: AptLocations,
  signal: AbortSignal | undefined,
) => {
  const files = [
    apt.sourceList,
    ...(await fileNames(apt.sourceParts))
      .filter((name) => name.endsWith(".list") || name.endsWith(".sources"))
      .map((name) => join(apt.sourceParts, name)),
  ];
  const entries: AptSourceEntry[] = [];
  const unreadable: string[] = [];
  for (const file of files) {
    const bytes = await readHostFile(file, FILE_MAX_BYTES, signal);
    if (bytes === "unreadable") unreadable.push(file);
    if (typeof bytes === "string") continue;
    const text = bytes.toString("utf8");
    entries.push(
      ...(file.endsWith(".sources")
        ? parseDeb822Sources(text, file)
        : parseOneLineSources(text, file)),
    );
  }
  return { entries, unreadable };
};

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

/** The entry's signed release: InRelease, or Release.gpg with the Release it signs. */
const signedRelease = async (
  entry: AptSourceEntry,
  lists: string,
): Promise<readonly string[] | undefined> => {
  const prefix = join(lists, aptReleaseFilePrefix(entry));
  if (await isFile(`${prefix}InRelease`)) return [`${prefix}InRelease`];
  return (await isFile(`${prefix}Release.gpg`)) &&
    (await isFile(`${prefix}Release`))
    ? [`${prefix}Release.gpg`, `${prefix}Release`]
    : undefined;
};

/** Runs gpgv on one candidate keyring at a time, written into a private folder it owns. */
class GpgvKeyCheck {
  #root: PrivateRuntimeRoot | undefined;
  #keyrings = 0;
  readonly #reads = new Map<string, Buffer | "missing" | "unreadable">();

  constructor(
    private readonly runQuery: QueryRunner,
    private readonly signal: AbortSignal | undefined,
  ) {}

  async #read(path: string): Promise<Buffer | "missing" | "unreadable"> {
    const read =
      this.#reads.get(path) ??
      (await readHostFile(path, FILE_MAX_BYTES, this.signal));
    this.#reads.set(path, read);
    return read;
  }

  /** The first candidate key that verifies the release, or why none did. */
  async firstVerifying(
    candidates: readonly string[],
    release: readonly string[],
  ): Promise<
    | {
        readonly path: string;
        readonly bytes: Buffer;
        readonly fingerprint: string;
      }
    | { readonly reason: string }
  > {
    const unreadable: string[] = [];
    for (const path of candidates) {
      const bytes = await this.#read(path);
      if (bytes === "unreadable") unreadable.push(path);
      if (typeof bytes === "string") continue;
      const verified = await this.#verify(bytes, release);
      if (verified === "missing")
        return {
          reason:
            "gpgv is not installed, so no key could be checked against the repository's signature",
        };
      if (verified !== undefined) return { path, bytes, ...verified };
    }
    return {
      reason: `no candidate key (${candidates.join(", ")}) verifies ${release[0] ?? "its release file"}${unreadable.length === 0 ? "" : `; unreadable: ${unreadable.join(", ")}`}`,
    };
  }

  /** The signing key's fingerprint when the key verifies the release; `missing` without gpgv. */
  async #verify(
    key: Buffer,
    release: readonly string[],
  ): Promise<{ readonly fingerprint: string } | "missing" | undefined> {
    const keyring = isArmoredKey(key) ? dearmorPublicKeys(key) : key;
    if (keyring === undefined) return undefined;
    this.#root ??= await PrivateRuntimeRoot.create({ prefix: "rea-apt-keys-" });
    const path = join(this.#root.path, `keyring-${String(this.#keyrings)}.gpg`);
    this.#keyrings += 1;
    await writeFile(path, keyring, { mode: 0o600, flag: "wx" });
    const outcome = await this.runQuery(
      "gpgv",
      [
        "--homedir",
        this.#root.path,
        "--status-fd",
        "1",
        "--keyring",
        path,
        ...release,
      ],
      this.signal,
    );
    if (outcome === "missing") return "missing";
    const fingerprint = validSignatureFingerprint(succeeded(outcome) ?? "");
    return fingerprint === undefined ? undefined : { fingerprint };
  }

  /** Remove the private folder; the reason when that failed. */
  async close(): Promise<string | undefined> {
    const root = this.#root;
    if (root === undefined) return undefined;
    return root.close().then(
      () => undefined,
      (cause: unknown) =>
        `REA could not remove its temporary keyring folder ${root.path}: ${cause instanceof Error ? cause.message : String(cause)}.`,
    );
  }
}

const verifiedRepository = async (
  source: string,
  entry: AptSourceEntry | undefined,
  context: {
    readonly apt: AptLocations;
    readonly check: GpgvKeyCheck;
    readonly keys: Map<string, Buffer>;
  },
): Promise<AptRepository> => {
  const base = {
    source,
    sources_file: entry?.file ?? null,
    uri: entry?.uri ?? null,
    suite: entry?.suite ?? null,
    components: [...(entry?.components ?? [])],
  };
  const unverified = (reason: string): AptRepository => ({
    ...base,
    signing_key: null,
    signing_key_reason: reason,
  });
  if (entry === undefined)
    return unverified("no entry in the apt sources files lists this source");
  if (entry.inlineKey)
    return unverified(
      "its Signed-By field holds the key itself, which REA does not read",
    );
  const release = await signedRelease(entry, context.apt.lists);
  if (release === undefined)
    return unverified(
      `apt holds no signed release file for it in ${context.apt.lists}`,
    );
  const candidates = await candidateKeys(entry, context.apt);
  if (candidates.length > MAX_CANDIDATE_KEYS)
    return unverified(`more than ${String(MAX_CANDIDATE_KEYS)} candidate keys`);
  const verified = await context.check.firstVerifying(candidates, release);
  if ("reason" in verified) return unverified(verified.reason);
  const sha256 = createHash("sha256").update(verified.bytes).digest("hex");
  context.keys.set(sha256, verified.bytes);
  return {
    ...base,
    signing_key: {
      path: verified.path,
      sha256,
      format: isArmoredKey(verified.bytes) ? "armored" : "binary",
      fingerprint: verified.fingerprint,
    },
  };
};

/**
 * The apt repositories other than Ubuntu's that list the installed version,
 * each with the key whose signature over the repository's release gpgv
 * verified: the entry's Signed-By keyrings, or every key apt trusts.
 */
export const inspectAptRepositories = async (
  installed: {
    readonly sources: readonly string[];
    readonly origins: readonly (string | null)[] | undefined;
  },
  host: AptRepositoryHost,
  signal: AbortSignal | undefined,
): Promise<AptRepositoryFacts> => {
  const vendor = installed.sources.filter(
    (_, index) => installed.origins?.[index] !== "Ubuntu",
  );
  if (vendor.length === 0)
    return { repositories: [], keys: new Map(), limitations: [] };
  const { entries, unreadable } = await sourceEntries(host.apt, signal);
  const check = new GpgvKeyCheck(host.runQuery, signal);
  const keys = new Map<string, Buffer>();
  const repositories: AptRepository[] = [];
  try {
    for (const source of vendor)
      repositories.push(
        await verifiedRepository(source, sourceEntryFor(source, entries), {
          apt: host.apt,
          check,
          keys,
        }),
      );
  } catch (cause: unknown) {
    await check.close();
    throw cause;
  }
  const closeFailure = await check.close();
  return {
    repositories,
    keys,
    limitations: [
      ...unreadable.map(
        (file) =>
          `The apt sources file ${file} could not be read, so repositories it lists are not matched.`,
      ),
      ...(closeFailure === undefined ? [] : [closeFailure]),
    ],
  };
};
