import {
  desktopLibraryLimit,
  desktopLibraryPolicy,
  type DesktopLibraryPolicy,
} from "../domain/desktop/libraryPolicy.js";
import { realpath } from "node:fs/promises";

import { appendAll } from "../domain/arrayAppend.js";

import type { DesktopPackage } from "../domain/desktop/desktopCapture.js";
import {
  readElfDependencies,
  type ElfDependencies,
} from "../domain/desktop/elfDependencies.js";
import {
  installableLibraryPackages,
  libraryClosure,
  libraryPackageNames,
  parseLinkerCache,
} from "../domain/desktop/libraryPackages.js";
import {
  ownershipCandidates,
  parseAptPolicyPackageSources,
  parseDpkgOwners,
} from "../domain/desktop/linuxPackages.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  RegularFileCleanupFailure,
  withOwnedRegularFile,
} from "../filesystem/OwnedRegularFile.js";
import { readFileHandleRange } from "../filesystem/readFileHandleRange.js";
import { hostCloseFailure, isHostFile, isRefusedRead } from "./HostFileRead.js";
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

const elfDependencies = async (
  path: string,
  signal: AbortSignal | undefined,
  policy: DesktopLibraryPolicy,
): Promise<Result<ElfDependencies, string>> => {
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
      ),
    );
  } catch (cause: unknown) {
    if (cause instanceof RegularFileCleanupFailure)
      throw hostCloseFailure(cause);
    signal?.throwIfAborted();
    if (!isRefusedRead(cause)) throw cause;
    return err("the file could not be read");
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
    return none(`the libraries of ${executable} were not read: ${root.error}`);
  const cache = await linkerCache(runQuery, signal);
  if (cache === undefined)
    return none("ldconfig -p did not list the dynamic linker cache");
  const closure = await libraryClosure(
    { path: executable, dependencies: root.value },
    parseLinkerCache(cache),
    {
      dependencies: (path) => elfDependencies(path, signal, policy),
      isFile: isHostFile,
    },
    policy.libraries,
  );
  const located = await Promise.all(
    closure.libraries.map(async ({ path }) => ({
      path,
      candidates: ownershipCandidates([
        path,
        ...(await realpath(path).then(
          (physical) => [physical],
          () => [],
        )),
      ]),
    })),
  );
  const owners = await packageOwners(
    located.flatMap((library) => library.candidates),
    runQuery,
    signal,
  );
  const knownOwners = owners.ok ? owners.value : owners.error.owners;
  const names: string[] = [];
  const unpackaged: string[] = [];
  let ownershipUnresolved = false;
  for (const library of located) {
    const found = library.candidates
      .map((candidate) => knownOwners.get(candidate))
      .find((owner) => owner !== undefined && owner.length > 0);
    if (found !== undefined) appendAll(names, found);
    else if (
      library.candidates.every((candidate) => knownOwners.has(candidate))
    )
      unpackaged.push(library.path);
    else ownershipUnresolved = true;
  }
  const reason = [
    incompleteReason(closure, policy),
    owners.ok || !ownershipUnresolved ? undefined : owners.error.reason,
  ]
    .filter((value): value is string => value !== undefined)
    .join("; ");
  return {
    library_packages: [...libraryPackageNames(names, ownPackage)],
    missing_libraries: [...closure.missing].sort(),
    unpackaged_libraries: unpackaged.sort(),
    ...(reason.length === 0 ? {} : { library_packages_reason: reason }),
  };
};

/** The sources of every version of each package, from batched `apt-cache policy`; undefined when apt could not be asked. */
const packageSources = async (
  names: readonly string[],
  runQuery: QueryRunner,
  signal: AbortSignal | undefined,
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
    for (const [name, listed] of parseAptPolicyPackageSources(output))
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
  },
  runQuery: QueryRunner,
  signal: AbortSignal | undefined,
): Promise<ReturnType<typeof installableLibraryPackages> | undefined> => {
  const sources =
    names.length === 0
      ? new Map<string, readonly string[]>()
      : await packageSources(names, runQuery, signal);
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
