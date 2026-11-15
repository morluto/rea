import { lstat, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

import type { DesktopApplicationInventory } from "../domain/desktop/desktopCapture.js";
import { xdgBase } from "./XdgBase.js";

/** The environment whose XDG folders, and the home whose dot-folders, may hold the application's state. */
interface StateLocations {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly home: string;
}

/**
 * Names the application's state folders may carry, including the entry's
 * full reverse-DNS id and its last part. The executable is null for a
 * `flatpak run` launch, whose `flatpak` launcher names flatpak's own folders.
 */
export const stateNames = (
  package_: DesktopApplicationInventory["package"],
  executable: string | null,
  entry: DesktopApplicationInventory["desktop_entry"],
): readonly (string | null)[] => [
  package_.kind === "deb"
    ? (package_.name?.split(":")[0] ?? null)
    : package_.name,
  executable === null ? null : basename(executable),
  entry?.id ?? null,
  entry?.id?.split(".").at(-1) ?? null,
  entry?.startup_wm_class ?? null,
  entry?.name ?? null,
];

/** Whether a home entry is a dotfile named after the application, such as `.varicad-cfg.ini` or `.notesrc`. */
const appNamedDotfile = (entry: string, names: ReadonlySet<string>): boolean =>
  [...names].some((name) => {
    // Short names would match unrelated dotfiles.
    if (name.length < 3 || !entry.startsWith(`.${name}`)) return false;
    const rest = entry.slice(name.length + 1);
    return rest === "rc" || /^[-._]./u.test(rest);
  });

/** A folder's entries that are the prefix and then one of the lowercase names in any letter case, such as `GIMP` for `gimp`. */
const recasedEntries = async (
  folder: string,
  prefix: string,
  names: ReadonlySet<string>,
): Promise<readonly string[]> =>
  (await readdir(folder).catch(() => [] as string[]))
    .filter(
      (entry) =>
        entry.startsWith(prefix) &&
        names.has(entry.slice(prefix.length).toLowerCase()),
    )
    .map((entry) => join(folder, entry));

/**
 * Folder names under XDG and dot-directories where the application may keep
 * state, KDE's `<name>rc` settings file in the config folder, and the
 * dotfiles in the home named after it, which an application may only read
 * during a capture.
 */
export const stateDirectories = async (
  names: readonly (string | null)[],
  { environment, home }: StateLocations,
  extra: readonly string[],
): Promise<DesktopApplicationInventory["state_directories"]> => {
  const bases = [
    xdgBase(environment.XDG_CONFIG_HOME, join(home, ".config")),
    xdgBase(environment.XDG_DATA_HOME, join(home, ".local/share")),
    xdgBase(environment.XDG_STATE_HOME, join(home, ".local/state")),
    xdgBase(environment.XDG_CACHE_HOME, join(home, ".cache")),
  ];
  const variants = new Set(
    names
      .filter(
        (name): name is string =>
          name !== null &&
          /^[^/\0]+$/u.test(name) &&
          name !== "." &&
          name !== "..",
      )
      .flatMap((name) => [name, name.toLowerCase()]),
  );
  const lowered = new Set([...variants].map((name) => name.toLowerCase()));
  const dotfiles = (await readdir(home).catch(() => [] as string[]))
    .filter((entry) => appNamedDotfile(entry, variants))
    .map((entry) => join(home, entry));
  // A folder present in another letter case than any name, such as GIMP's `~/.config/GIMP`, is the application's too.
  const recased = await Promise.all([
    ...bases.map((base) => recasedEntries(base, "", lowered)),
    recasedEntries(home, ".", lowered),
  ]);
  const [config = join(home, ".config")] = bases;
  const paths = new Set([
    ...[...variants].flatMap((name) => [
      ...bases.map((base) => join(base, name)),
      join(home, `.${name}`),
      // KDE's settings file, such as Tellico's `~/.config/tellicorc`, which the app may first write during the capture.
      ...(name.length < 3 ? [] : [join(config, `${name}rc`)]),
    ]),
    ...recased.flat(),
    ...dotfiles,
    ...extra,
  ]);
  return Promise.all(
    [...paths].map(async (path) => {
      try {
        await lstat(path);
        return { path, exists_at_start: true };
      } catch (cause: unknown) {
        const code = (cause as NodeJS.ErrnoException).code;
        return code === "ENOENT" || code === "ENOTDIR"
          ? { path, exists_at_start: false }
          : {
              path,
              exists_at_start: null,
              existence_error:
                cause instanceof Error ? cause.message : String(cause),
            };
      }
    }),
  );
};
