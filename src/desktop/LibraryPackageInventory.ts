import {
  desktopLibraryLimit,
  desktopLibraryPolicy,
  type DesktopLibraryPolicy,
} from "../domain/desktop/libraryPolicy.js";
import { lstat, readlink, realpath, stat } from "node:fs/promises";
import { posix } from "node:path";

import type { DesktopPackage } from "../domain/desktop/desktopCapture.js";
import {
  readElfDependencies,
  type ElfDependencies,
  type ElfDependenciesFailure,
  type ElfLibraryIdentity,
} from "../domain/desktop/elfDependencies.js";
import {
  installableLibraryPackages,
  libraryClosure,
  libraryPackageNames,
  parseLinkerCache,
  type LibraryLookupAlias,
  type LibraryFileProbe,
} from "../domain/desktop/libraryPackages.js";
import {
  ownershipCandidates,
  parseAptPolicyPackageSources,
  parseDpkgOwners,
} from "../domain/desktop/linuxPackages.js";
import { err, ok, type Result } from "../domain/result.js";
import { abortIfNeeded } from "../resources/index.js";
import { compositeKey } from "../domain/unicodeCodePointOrder.js";
import { withOwnedRegularFile } from "../filesystem/OwnedRegularFile.js";
import { readFileHandleRange } from "../filesystem/readFileHandleRange.js";
import { hostReadFailure, isRefusedRead } from "./HostFileRead.js";
import { succeeded, type QueryRunner } from "./HostQuery.js";

/** The library fields of a Debian package's inventory. */
export type LibraryPackages = {
  readonly [
    Name in "library_packages" | "missing_libraries" | "unpackaged_libraries"
  ]: NonNullable<DesktopPackage[Name]>;
} & Pick<
  DesktopPackage,
  "library_packages_reason" | "uninstallable_library_packages"
>;

const QUERY_BATCH = 200;

/** The Ubuntu 24.04 base-files package supplies these exact usr-merge links. */
const suppliedByComputerBase = (
  path: string,
  target: string,
  machine: number,
): boolean =>
  (machine === 62 || machine === 183) &&
  (path === "/bin" ||
    path === "/sbin" ||
    path === "/lib" ||
    (machine === 62 && path === "/lib64")) &&
  (target === `usr${path}` || target === `/usr${path}`);

/** Do not enqueue another lookup read after cancellation; keep failed I/O primary. */
const lookupRead = async <T>(
  signal: AbortSignal | undefined,
  read: () => Promise<T>,
): Promise<T> => {
  abortIfNeeded(signal);
  const value = await read();
  abortIfNeeded(signal);
  return value;
};

/** Library lookup distinguishes expected refusals from a failed physical read. */
const probeLibraryFile = async (
  path: string,
  signal: AbortSignal | undefined,
): Promise<LibraryFileProbe> => {
  try {
    const facts = await lookupRead(signal, () => stat(path));
    return { kind: "file", isFile: facts.isFile() };
  } catch (cause: unknown) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      abortIfNeeded(signal);
      return { kind: "file", isFile: false };
    }
    if (isRefusedRead(cause)) {
      abortIfNeeded(signal);
      return { kind: "unknown", unreachable: code === "EACCES" };
    }
    throw hostReadFailure(cause);
  }
};

/** Remove dot traversal only after the filesystem resolves every preceding link. */
const ownershipSpelling = async (
  path: string,
  signal?: AbortSignal,
): Promise<string> => {
  let traversed = "";
  let spelling = "/";
  for (const part of path.split("/")) {
    abortIfNeeded(signal);
    if (part === "" || part === ".") continue;
    traversed += `/${part}`;
    spelling =
      part === ".."
        ? await lookupRead(signal, () => realpath(traversed))
        : posix.join(spelling, part);
  }
  return spelling;
};

/** Intermediate file/directory links needed to resolve a selected library. */
const requiredAliases = async (
  path: string,
  machine: number,
  signal?: AbortSignal,
): Promise<LibraryLookupAlias[]> => {
  const aliases = new Map<string, LibraryLookupAlias>();
  const visitedTargets = new Set<string>();
  const activeLinks = new Set<string>();
  const visit = async (
    lookup: string,
    directoryLeaf: boolean,
    fileLeaf = false,
  ): Promise<void> => {
    abortIfNeeded(signal);
    const ends: number[] = [];
    for (
      let end = lookup.indexOf("/", lookup.startsWith("/") ? 1 : 0);
      end !== -1;
      end = lookup.indexOf("/", end + 1)
    )
      ends.push(end);
    ends.push(lookup.length);
    for (const end of ends) {
      const prefix = lookup.slice(0, end);
      if (!(await lookupRead(signal, () => lstat(prefix))).isSymbolicLink())
        continue;
      // Canonical parents identify the link entry, not its target. Keep ../
      // in the target spelling until the kernel resolves preceding links.
      const alias = posix.join(
        await lookupRead(signal, () => realpath(posix.dirname(prefix))),
        posix.basename(prefix),
      );
      const target = await lookupRead(signal, () => readlink(prefix));
      const directory = end !== lookup.length || directoryLeaf;
      if (
        (directory || fileLeaf) &&
        !suppliedByComputerBase(alias, target, machine)
      )
        aliases.set(prefix, {
          path: alias,
          ownershipPath: await ownershipSpelling(prefix, signal),
        });
      const targetLookup = posix.isAbsolute(target)
        ? target
        : `${posix.dirname(prefix)}/${target}`;
      // Target spelling owns the next ownership context. A physical link may
      // be reached again through another alias without forming a cycle.
      const targetKey = compositeKey([
        targetLookup,
        directory ? "directory" : "file",
      ]);
      if (activeLinks.has(alias) || visitedTargets.has(targetKey)) continue;
      visitedTargets.add(targetKey);
      activeLinks.add(alias);
      try {
        // Selected leaves retain the existing DSO-owner fallback. Recursively
        // reached links need independent ownership, including their leaf.
        abortIfNeeded(signal);
        await visit(targetLookup, directory, true);
      } finally {
        activeLinks.delete(alias);
      }
    }
  };
  await visit(path, false);
  abortIfNeeded(signal);
  return [...aliases.values()];
};

const elfDependencies = async (
  path: string,
  signal: AbortSignal | undefined,
  policy: DesktopLibraryPolicy,
  expected?: ElfLibraryIdentity,
): Promise<Result<ElfDependencies, ElfDependenciesFailure>> => {
  const options = {
    symlinks: "follow" as const,
    ...(signal === undefined ? {} : { signal }),
  };
  try {
    return await withOwnedRegularFile(path, options, ({ handle, initial }) =>
      readElfDependencies(
        (offset, length) => readFileHandleRange(handle, offset, length),
        initial.size,
        policy,
        expected,
      ),
    );
  } catch (cause: unknown) {
    const failure = hostReadFailure(cause);
    if (failure !== cause) throw failure;
    if (!isRefusedRead(cause)) throw cause;
    return err({
      kind: "unreadable",
      identity: null,
      reason: "the file could not be read",
    });
  }
};

/** `ldconfig -p`, which a user's PATH may not reach in /sbin. */
const linkerCache = async (
  runQuery: QueryRunner,
  signal: AbortSignal | undefined,
): Promise<string | undefined> => {
  for (const command of ["ldconfig", "/sbin/ldconfig"]) {
    const outcome = await runQuery(command, ["-p"], signal);
    if (outcome !== "missing") return succeeded(outcome);
  }
  return undefined;
};

/** Owners of each path from batched `dpkg-query -S`, which exits 1 when some path has none. */
const packageOwners = async (
  paths: readonly string[],
  runQuery: QueryRunner,
  signal: AbortSignal | undefined,
): Promise<
  Result<
    ReadonlyMap<string, readonly string[]>,
    {
      readonly owners: ReadonlyMap<string, readonly string[]>;
      readonly reason: string;
    }
  >
> => {
  // dpkg-query reads an argument with glob characters as a pattern.
  const unique = [...new Set(paths)];
  const literal = unique.filter((path) => !/[*?[\\]/u.test(path));
  const owners = new Map<string, readonly string[]>();
  const incomplete = (reason: string) => err({ owners, reason });
  for (let start = 0; start < literal.length; start += QUERY_BATCH) {
    const batch = literal.slice(start, start + QUERY_BATCH);
    const outcome = await runQuery("dpkg-query", ["-S", ...batch], signal);
    if (outcome === "missing") return incomplete("dpkg-query is not installed");
    if (outcome === "failed") return incomplete("dpkg-query -S did not finish");
    // Exit 1 identifies unowned paths; a higher exit code answers none of the batch.
    if (outcome.exitCode > 1)
      return incomplete(
        "dpkg-query could not say which packages own the libraries",
      );
    for (const path of batch)
      owners.set(path, parseDpkgOwners(outcome.stdout, path));
  }
  return literal.length === unique.length
    ? ok(owners)
    : incomplete(
        "dpkg-query cannot safely query library paths containing pattern characters",
      );
};

const incompleteReason = (
  closure: Awaited<ReturnType<typeof libraryClosure>>,
  policy: DesktopLibraryPolicy,
): string | undefined => {
  const [first] = closure.unreadable;
  const reasons = [
    ...(closure.truncated
      ? [desktopLibraryLimit(policy, "libraries", "REA dependency closure")]
      : []),
    ...(first === undefined
      ? []
      : [
          `the dependencies of ${String(closure.unreadable.length)} libraries could not be read, such as ${first.path}: ${first.reason}`,
        ]),
  ];
  return reasons.length === 0 ? undefined : reasons.join("; ");
};

interface LibraryOwnershipLookup {
  readonly kind: "leaf" | "alias";
  readonly path: string;
  readonly candidates: readonly string[];
}

/** Reconcile equivalent query spellings without merging links with their targets. */
const libraryOwnership = (
  located: readonly LibraryOwnershipLookup[],
  knownOwners: ReadonlyMap<string, readonly string[]>,
) => {
  const names: string[] = [];
  // Distinct query spellings can address the same leaf entry. Keep every
  // observed owner, but do not report that entry unowned if another spelling
  // identifies it. Intermediate links remain independent of their targets.
  const dispositions = new Map<
    string,
    { path: string; owned: boolean; unknown: boolean }
  >();
  for (const library of located) {
    const key = compositeKey([library.kind, library.path]);
    let disposition = dispositions.get(key);
    if (disposition === undefined) {
      disposition = { path: library.path, owned: false, unknown: false };
      dispositions.set(key, disposition);
    }
    const found = library.candidates
      .map((candidate) => knownOwners.get(candidate))
      .find((owner) => owner !== undefined && owner.length > 0);
    if (found !== undefined) {
      names.push(...found);
      disposition.owned = true;
    } else if (
      !library.candidates.every((candidate) => knownOwners.has(candidate))
    )
      disposition.unknown = true;
  }
  const unowned = [...dispositions.values()].filter(({ owned }) => !owned);
  const unpackaged = unowned
    .filter(({ unknown }) => !unknown)
    .map(({ path }) => path);
  const unresolved = unowned.some(({ unknown }) => unknown);
  return { names, unpackaged, unresolved };
};

/**
 * The packages owning the shared libraries an executable loads, from its
 * DT_NEEDED closure resolved through RUNPATH, RPATH and `ldconfig -p`, with
 * `dpkg-query -S` naming each library's package.
 */
export const inspectLibraryPackages = async (
  executable: string,
  ownPackage: string,
  runQuery: QueryRunner,
  signal: AbortSignal | undefined,
  policy: DesktopLibraryPolicy = desktopLibraryPolicy(),
): Promise<LibraryPackages> => {
  const none = (reason: string): LibraryPackages => ({
    library_packages: [],
    missing_libraries: [],
    unpackaged_libraries: [],
    library_packages_reason: reason,
  });
  const root = await elfDependencies(executable, signal, policy);
  if (!root.ok)
    return none(
      `the libraries of ${executable} were not read: ${root.error.reason}`,
    );
  const cache = await linkerCache(runQuery, signal);
  if (cache === undefined)
    return none("ldconfig -p did not list the dynamic linker cache");
  const closure = await libraryClosure(
    { path: executable, dependencies: root.value },
    parseLinkerCache(cache),
    {
      resolvePath: async (path) => {
        try {
          // Admit the full lookup before deriving its ownership leaf: splitting
          // a regular file's trailing slash or dot component would erase ENOTDIR.
          const probe = await probeLibraryFile(path, signal);
          if (probe.kind !== "file" || !probe.isFile) return undefined;
          const resolvedPath = await lookupRead(signal, () => realpath(path));
          const directory = await lookupRead(signal, () =>
            realpath(posix.dirname(path)),
          );
          const selected = posix.join(directory, posix.basename(path));
          const identity = await lookupRead(signal, () =>
            stat(resolvedPath, { bigint: true }),
          );
          return {
            path: selected,
            ownershipPath: await ownershipSpelling(path, signal),
            resolvedPath,
            fileIdentity: `${identity.dev}:${identity.ino}`,
            requiredAliases: await requiredAliases(
              path,
              root.value.machine,
              signal,
            ),
          };
        } catch (cause) {
          if (isRefusedRead(cause)) {
            abortIfNeeded(signal);
            return undefined;
          }
          throw hostReadFailure(cause);
        }
      },
      dependencies: (path, expected) =>
        elfDependencies(path, signal, policy, expected),
      isFile: (path) => probeLibraryFile(path, signal),
    },
    policy.libraries,
  );
  const located: LibraryOwnershipLookup[] = [
    ...closure.libraries.map<LibraryOwnershipLookup>(
      ({ path, resolvedPath, ownershipPath }) => ({
        kind: "leaf",
        path,
        candidates: ownershipCandidates([ownershipPath, path, resolvedPath]),
      }),
    ),
    // An intermediate lookup alias is its own required entry. Ownership of
    // its physical target cannot establish who supplies that link.
    ...closure.requiredAliases.map<LibraryOwnershipLookup>(
      ({ path, ownershipPath }) => ({
        kind: "alias",
        path,
        candidates: ownershipCandidates([ownershipPath, path]),
      }),
    ),
  ];
  const owners = await packageOwners(
    located.flatMap((library) => library.candidates),
    runQuery,
    signal,
  );
  const knownOwners = owners.ok ? owners.value : owners.error.owners;
  const {
    names,
    unpackaged,
    unresolved: ownershipUnresolved,
  } = libraryOwnership(located, knownOwners);
  const reason = [
    incompleteReason(closure, policy),
    owners.ok || !ownershipUnresolved ? undefined : owners.error.reason,
  ]
    .filter((value): value is string => value !== undefined)
    .join("; ");
  return {
    library_packages: [...libraryPackageNames(names, ownPackage)],
    missing_libraries: [...closure.missing].sort(),
    unpackaged_libraries: [...new Set(unpackaged)].sort(),
    ...(reason.length === 0 ? {} : { library_packages_reason: reason }),
  };
};

/** The sources of every version of each package, from batched `apt-cache policy`; undefined when apt could not be asked. */
const packageSources = async (
  names: readonly string[],
  runQuery: QueryRunner,
  signal: AbortSignal | undefined,
  statusFile?: string,
): Promise<ReadonlyMap<string, readonly string[]> | undefined> => {
  const sources = new Map<string, readonly string[]>();
  for (let start = 0; start < names.length; start += QUERY_BATCH) {
    const output = succeeded(
      await runQuery(
        "apt-cache",
        ["policy", ...names.slice(start, start + QUERY_BATCH)],
        signal,
      ),
    );
    if (output === undefined) return undefined;
    for (const [name, listed] of parseAptPolicyPackageSources(
      output,
      statusFile,
    ))
      sources.set(name, listed);
  }
  return sources;
};

/** The packages the computer can install by name, and the rest, as `installableLibraryPackages` decides from `apt-cache policy`; undefined when apt could not be asked. */
export const installablePackages = async (
  names: readonly string[],
  available: {
    readonly origins: ReadonlyMap<string, string | null> | undefined;
    readonly declared: ReadonlySet<string>;
    readonly statusFile?: string | undefined;
  },
  runQuery: QueryRunner,
  signal: AbortSignal | undefined,
): Promise<ReturnType<typeof installableLibraryPackages> | undefined> => {
  const sources =
    names.length === 0
      ? new Map<string, readonly string[]>()
      : await packageSources(names, runQuery, signal, available.statusFile);
  return sources === undefined
    ? undefined
    : installableLibraryPackages(names, { ...available, sources });
};

/**
 * Keep the library packages the computer can install: those some version of
 * which the Ubuntu 24.04 archive or a declared vendor source offers, as
 * `apt-cache policy` listed them for `installablePackages`; the rest are
 * recorded as uninstallable.
 */
export const installableLibraries = (
  libraries: LibraryPackages,
  split: Awaited<ReturnType<typeof installablePackages>>,
): LibraryPackages => {
  const names = libraries.library_packages;
  if (split === undefined && names.length > 0)
    return {
      ...libraries,
      library_packages: [],
      uninstallable_library_packages: [],
      library_packages_reason: [
        libraries.library_packages_reason,
        `apt-cache policy did not say where ${names.join(", ")} come from, so none of them is installed`,
      ]
        .filter((reason) => reason !== undefined)
        .join("; "),
    };
  const installable = (name: string) =>
    split?.installable.includes(name) === true;
  return {
    ...libraries,
    library_packages: names.filter(installable),
    uninstallable_library_packages: names.filter((name) => !installable(name)),
  };
};
