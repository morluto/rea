import { posix } from "node:path";

import type { Result } from "../result.js";
import { fromUbuntuNobleArchive } from "./appExportInstall.js";
import { isWithinAny } from "./desktopStateDiff.js";
import type {
  ElfDependencies,
  ElfDependenciesFailure,
  ElfLibraryIdentity,
} from "./elfDependencies.js";

/** One library `ldconfig -p` lists from the dynamic linker cache. */
export interface LinkerCacheEntry {
  readonly soname: string;
  readonly flags: readonly string[];
  readonly path: string;
}

const CACHE_LINE = /^\s+(?<soname>\S+) \((?<flags>[^)]*)\) => (?<path>\/.+)$/u;

/** The entries of `ldconfig -p` output. */
export const parseLinkerCache = (output: string): readonly LinkerCacheEntry[] =>
  output.split("\n").flatMap((line) => {
    const groups = CACHE_LINE.exec(line)?.groups;
    return groups?.soname === undefined || groups.path === undefined
      ? []
      : [
          {
            soname: groups.soname,
            flags: (groups.flags ?? "").split(",").map((flag) => flag.trim()),
            path: posix.normalize(groups.path),
          },
        ];
  });

/** The flag `ldconfig -p` marks a library for a 64-bit ELF machine with. */
const CACHE_FLAGS: ReadonlyMap<number, string> = new Map([
  [62, "x86-64"],
  [183, "AArch64"],
]);
const MACHINE_FLAGS = new Set(CACHE_FLAGS.values());

const cachedPaths = (
  cache: readonly LinkerCacheEntry[],
  soname: string,
  machine: number,
): readonly string[] => {
  const matching = cache.filter((entry) => entry.soname === soname);
  const flag = CACHE_FLAGS.get(machine);
  if (flag !== undefined)
    return matching
      .filter((entry) => entry.flags.includes(flag))
      .map((entry) => entry.path);
  const unclassified = matching.filter(
    (entry) => !entry.flags.some((name) => MACHINE_FLAGS.has(name)),
  );
  return (unclassified.length > 0 ? unclassified : matching).map(
    (entry) => entry.path,
  );
};

/** A loaded object and the object whose DT_NEEDED loaded it, as ld.so links them. */
interface LoadedObject {
  readonly path: string;
  readonly dependencies: ElfDependencies;
  readonly loader: LoadedObject | undefined;
}

const ORIGIN_TOKEN = /\$(?:ORIGIN(?![A-Za-z0-9_])|\{ORIGIN\})/gu;

/** Absolute directories with `$ORIGIN` expanded to the owner's folder; relative and other dynamic-token paths are left out. */
const expanded = (
  owner: string,
  directories: readonly string[],
): readonly string[] =>
  directories
    // Check tokens before expansion: dollars in the owner's directory are data.
    .filter((path) => !path.replace(ORIGIN_TOKEN, "").includes("$"))
    .map((path) => path.replace(ORIGIN_TOKEN, () => posix.dirname(owner)))
    .filter((path) => path.startsWith("/"))
    .map((path) => posix.normalize(path));

/**
 * Where ld.so looks for an object's needed libraries before its cache: an
 * object without RUNPATH uses the RPATH of itself and of each object up its
 * loader chain to the executable, and then its RUNPATH.
 */
const searchDirectories = (object: LoadedObject): readonly string[] => {
  const rpaths: string[] = [];
  if (object.dependencies.runpath === undefined)
    for (let at: LoadedObject | undefined = object; at; at = at.loader)
      rpaths.push(...expanded(at.path, at.dependencies.rpath));
  return [
    ...new Set([
      ...rpaths,
      ...expanded(object.path, object.dependencies.runpath ?? []),
    ]),
  ];
};

/** Search order identifies candidates; existence alone does not select a loaded object. */
async function* libraryCandidates(
  soname: string,
  directories: readonly string[],
  machine: number,
  cache: readonly LinkerCacheEntry[],
  host: LibraryWalkHost,
): AsyncGenerator<{ path: string; unprobed: boolean }> {
  if (soname.startsWith("/")) {
    yield { path: posix.normalize(soname), unprobed: false };
    return;
  }
  const unprobed: string[] = [];
  if (!soname.includes("/"))
    for (const directory of directories) {
      const candidate = posix.join(directory, soname);
      const probe = await host.isFile(candidate);
      if (probe.kind === "file") {
        if (probe.isFile) yield { path: candidate, unprobed: false };
      }
      // A folder the linker cannot search is not the object it loads with the
      // same credentials. It is only evidence that the soname may be there.
      else if (probe.unreachable) unprobed.push(candidate);
      // Any other failed check may be transient, so the candidate keeps its
      // search position instead of falling behind every cache entry.
      else yield { path: candidate, unprobed: false };
    }
  for (const path of cachedPaths(cache, soname, machine))
    yield { path, unprobed: false };
  for (const path of unprobed) yield { path, unprobed: true };
}

/** What a host check of one candidate path established. */
export type LibraryFileProbe =
  | { readonly kind: "file"; readonly isFile: boolean }
  | {
      readonly kind: "unknown";
      /** The check settled the candidate, rather than failing transiently. */
      readonly unreachable: boolean;
    };
/** Host reads the closure walk needs. */
export interface LibraryWalkHost {
  readonly dependencies: (
    path: string,
    expected: ElfLibraryIdentity,
  ) => Promise<Result<ElfDependencies, ElfDependenciesFailure>>;
  readonly isFile: (path: string) => Promise<LibraryFileProbe>;
}

/** The shared libraries an executable loads at start, as the dynamic linker would find them. */
export interface LibraryClosure {
  /** Libraries outside the application's own folder, by the soname that loaded them. */
  readonly libraries: readonly {
    readonly soname: string;
    readonly path: string;
  }[];
  /** Sonames without a compatible candidate in the searched directories or linker cache. */
  readonly missing: readonly string[];
  /** Candidates whose selection or dependency closure could not be established. */
  readonly unreadable: readonly {
    readonly path: string;
    readonly reason: string;
  }[];
  /** Whether the walk stopped at its library limit. */
  readonly truncated: boolean;
}

/**
 * Walk DT_NEEDED breadth first from the executable: each soname is looked up
 * in the RPATH and RUNPATH directories ld.so searches for the needing object,
 * then the linker cache. Paths are normalized before any containment check.
 * Libraries in the executable's own folder are the application's and are
 * walked but not listed. At most `limit` sonames are resolved.
 */
export const libraryClosure = async (
  executable: { readonly path: string; readonly dependencies: ElfDependencies },
  cache: readonly LinkerCacheEntry[],
  host: LibraryWalkHost,
  limit: number,
): Promise<LibraryClosure> => {
  const root = { ...executable, path: posix.normalize(executable.path) };
  const ownFolder = posix.dirname(root.path);
  const queue: LoadedObject[] = [{ ...root, loader: undefined }];
  const seen = new Set<string>();
  const closure = {
    libraries: [] as { soname: string; path: string }[],
    missing: [] as string[],
    unreadable: [] as { path: string; reason: string }[],
    truncated: false,
  };
  for (const object of queue) {
    const directories = searchDirectories(object);
    for (const soname of object.dependencies.needed) {
      if (seen.has(soname)) continue;
      if (seen.size >= limit) return { ...closure, truncated: true };
      seen.add(soname);
      let selected:
        | {
            path: string;
            dependencies: Result<ElfDependencies, ElfDependenciesFailure>;
          }
        | undefined;
      let unresolved = false;
      // A candidate the probe could not reach stays behind everything the walk
      // did check, so a searchable candidate with the same soname still wins.
      let unprobed: { path: string; reason: string } | undefined;
      for await (const { path, unprobed: couldNotProbe } of libraryCandidates(
        soname,
        directories,
        object.dependencies.machine,
        cache,
        host,
      )) {
        const dependencies = await host.dependencies(path, object.dependencies);
        if (!dependencies.ok && dependencies.error.identity === null) {
          if (couldNotProbe) {
            unprobed ??= { path, reason: dependencies.error.reason };
            continue;
          }
          // A failed identity read does not prove this candidate can be skipped,
          // or that its package belongs to the executable's loaded closure.
          closure.unreadable.push({
            path,
            reason: dependencies.error.reason,
          });
          unresolved = true;
          break;
        }
        if (!dependencies.ok && dependencies.error.kind === "incompatible") {
          if (soname.startsWith("/")) {
            closure.unreadable.push({
              path,
              reason: dependencies.error.reason,
            });
            unresolved = true;
            break;
          }
          continue;
        }
        selected = { path, dependencies };
        break;
      }
      if (selected === undefined) {
        if (unprobed !== undefined) closure.unreadable.push(unprobed);
        else if (!unresolved) closure.missing.push(soname);
        continue;
      }
      const { path, dependencies } = selected;
      if (!isWithinAny(path, [ownFolder]))
        closure.libraries.push({ soname, path });
      if (dependencies.ok)
        queue.push({ path, dependencies: dependencies.value, loader: object });
      else closure.unreadable.push({ path, reason: dependencies.error.reason });
    }
  }
  return closure;
};

/** Package names from `dpkg-query -S` owners: architecture qualifiers dropped and the application's own package left out. */
export const libraryPackageNames = (
  owners: readonly string[],
  ownPackage: string,
): readonly string[] =>
  [
    ...new Set(
      owners
        .map((owner) => owner.split(":")[0] ?? owner)
        .filter((name) => name !== ownPackage.split(":")[0]),
    ),
  ].sort();

/**
 * Library packages the computer can install, and the rest: a package is
 * installable when some version of it comes from the Ubuntu 24.04 archive
 * or from one of the vendor sources the export declares. `supplied` names the
 * declared sources of each installable package the archive does not offer.
 */
export const installableLibraryPackages = (
  names: readonly string[],
  available: {
    /** The sources of every version of each package, from `apt-cache policy`. */
    readonly sources: ReadonlyMap<string, readonly string[]>;
    /** The `o=` origin of each source; undefined when apt could not be asked, so only Canonical's hosts count. */
    readonly origins: ReadonlyMap<string, string | null> | undefined;
    readonly declared: ReadonlySet<string>;
  },
): {
  readonly installable: string[];
  readonly uninstallable: string[];
  readonly supplied: ReadonlyMap<string, readonly string[]>;
} => {
  const installable: string[] = [];
  const uninstallable: string[] = [];
  const supplied = new Map<string, readonly string[]>();
  for (const name of names) {
    const sources = available.sources.get(name) ?? [];
    const declared = sources.filter((source) => available.declared.has(source));
    const archive = fromUbuntuNobleArchive(
      sources,
      available.origins === undefined
        ? undefined
        : sources.map((source) => available.origins?.get(source) ?? null),
    );
    if (archive || declared.length > 0) installable.push(name);
    else uninstallable.push(name);
    if (!archive && declared.length > 0) supplied.set(name, declared);
  }
  return { installable, uninstallable, supplied };
};
