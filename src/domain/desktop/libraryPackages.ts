import type { Result } from "../result.js";
import type { ElfDependencies } from "./elfDependencies.js";

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
            path: groups.path,
          },
        ];
  });

/** The flag `ldconfig -p` marks a library for a 64-bit ELF machine with. */
const CACHE_FLAGS: ReadonlyMap<number, string> = new Map([
  [62, "x86-64"],
  [183, "AArch64"],
]);
const MACHINE_FLAGS = new Set(CACHE_FLAGS.values());

const cachedPath = (
  cache: readonly LinkerCacheEntry[],
  soname: string,
  machine: number,
): string | undefined => {
  const matching = cache.filter((entry) => entry.soname === soname);
  const flag = CACHE_FLAGS.get(machine);
  return (
    flag === undefined
      ? (matching.find(
          (entry) => !entry.flags.some((name) => MACHINE_FLAGS.has(name)),
        ) ?? matching[0])
      : matching.find((entry) => entry.flags.includes(flag))
  )?.path;
};

const directoryOf = (path: string): string =>
  path.slice(0, Math.max(path.lastIndexOf("/"), 1));

const isWithin = (path: string, folder: string): boolean =>
  path === folder || path.startsWith(`${folder === "/" ? "" : folder}/`);

/** RUNPATH or RPATH directories with `$ORIGIN` expanded; relative and other dynamic-token paths are left out. */
const searchDirectories = (
  object: string,
  dependencies: ElfDependencies,
): readonly string[] =>
  dependencies.searchPaths
    .map((path) =>
      path.replace(/\$(?:ORIGIN|\{ORIGIN\})/gu, directoryOf(object)),
    )
    .filter((path) => path.startsWith("/") && !path.includes("$"));

/** Host reads the closure walk needs. */
export interface LibraryWalkHost {
  readonly dependencies: (
    path: string,
  ) => Promise<Result<ElfDependencies, string>>;
  readonly isFile: (path: string) => Promise<boolean>;
}

/** The shared libraries an executable loads at start, as the dynamic linker would find them. */
export interface LibraryClosure {
  /** Libraries outside the application's own folder, by the soname that loaded them. */
  readonly libraries: readonly {
    readonly soname: string;
    readonly path: string;
  }[];
  /** Sonames found neither in a RUNPATH or RPATH directory nor in the linker cache. */
  readonly missing: readonly string[];
  /** Libraries whose own dependencies could not be read. */
  readonly unreadable: readonly {
    readonly path: string;
    readonly reason: string;
  }[];
  /** Whether the walk stopped at its library limit. */
  readonly truncated: boolean;
}

/**
 * Walk DT_NEEDED from the executable: each soname is looked up in the
 * needing object's RUNPATH or RPATH directories, then the linker cache.
 * Libraries in the executable's own folder are the application's and are
 * walked but not listed. At most `limit` sonames are resolved.
 */
export const libraryClosure = async (
  executable: { readonly path: string; readonly dependencies: ElfDependencies },
  cache: readonly LinkerCacheEntry[],
  host: LibraryWalkHost,
  limit: number,
): Promise<LibraryClosure> => {
  const ownFolder = directoryOf(executable.path);
  const queue = [executable];
  const seen = new Set<string>();
  const closure = {
    libraries: [] as { soname: string; path: string }[],
    missing: [] as string[],
    unreadable: [] as { path: string; reason: string }[],
    truncated: false,
  };
  for (const object of queue) {
    const directories = searchDirectories(object.path, object.dependencies);
    for (const soname of object.dependencies.needed) {
      if (seen.has(soname)) continue;
      if (seen.size >= limit) return { ...closure, truncated: true };
      seen.add(soname);
      let path = soname.startsWith("/") ? soname : undefined;
      for (const directory of soname.includes("/") ? [] : directories)
        if (path === undefined && (await host.isFile(`${directory}/${soname}`)))
          path = `${directory}/${soname}`;
      path ??= cachedPath(cache, soname, object.dependencies.machine);
      if (path === undefined) {
        closure.missing.push(soname);
        continue;
      }
      if (!isWithin(path, ownFolder)) closure.libraries.push({ soname, path });
      const dependencies = await host.dependencies(path);
      if (dependencies.ok)
        queue.push({ path, dependencies: dependencies.value });
      else closure.unreadable.push({ path, reason: dependencies.error });
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
