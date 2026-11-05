import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import type { DesktopApplicationInventory } from "../domain/desktop/desktopCapture.js";
import {
  expandDesktopExec,
  parseDesktopEntry,
  tokenizeDesktopExec,
  unwrapDesktopCommand,
  type DesktopEntry,
} from "../domain/desktop/desktopEntry.js";
import {
  DPKG_STATUS_FORMAT,
  isAppImageHeader,
  packageFromPath,
  parseAptPolicyOrigins,
  parseAptPolicySources,
  parseDpkgOwners,
  parseDpkgStatus,
} from "../domain/desktop/linuxPackages.js";
import { err, ok, type Result } from "../domain/result.js";
import { readElectronFuseImage } from "../electron/ElectronFuseReader.js";
import { withOwnedRegularFile } from "../filesystem/OwnedRegularFile.js";
import {
  NonRegularFileReadError,
  RegularFileChangedError,
  isSelectedRegularFileError,
} from "../filesystem/RegularFile.js";
import {
  RegularFileCapacityError,
  readStableFileBytes,
  readStableFilePrefix,
} from "../filesystem/readStableFileBytes.js";
import {
  execFileOutput,
  execFileOutputFailure,
} from "../process/ExecFileOutput.js";
import { resolveProgram } from "./ProgramLookup.js";

const DESKTOP_ENTRY_MAX_BYTES = 1024 * 1024;
const DENIED_CODES = new Set(["EACCES", "EPERM"]);

/** A read the inventory reports as unreadable rather than failing on. */
const isRefusedRead = (cause: unknown): boolean =>
  cause instanceof RegularFileCapacityError ||
  cause instanceof RegularFileChangedError ||
  cause instanceof NonRegularFileReadError ||
  isSelectedRegularFileError(cause) ||
  DENIED_CODES.has((cause as NodeJS.ErrnoException).code ?? "");
const COMMAND_TIMEOUT_MS = 30_000;
const COMMAND_MAX_BUFFER = 4 * 1024 * 1024;

/** Which application to launch, as the caller named it. */
export interface LinuxApplicationRequest {
  readonly desktopEntry: string | undefined;
  readonly executable: string | undefined;
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  /** Where a relative executable is found and an executable launch runs. */
  readonly callerDirectory: string;
}

/** Why the request does not name a launchable application. */
export type LinuxApplicationRefusal =
  | {
      readonly reason: "desktop_entry_not_found";
      readonly searched: readonly string[];
    }
  | { readonly reason: "desktop_entry_invalid"; readonly detail: string }
  | { readonly reason: "executable_not_found"; readonly program: string }
  | {
      readonly reason: "executable_on_relative_path";
      readonly program: string;
    };

/** The inventory plus limitations found while building it. */
export interface LinuxApplicationFacts {
  readonly inventory: DesktopApplicationInventory;
  readonly limitations: readonly string[];
}

type Package = DesktopApplicationInventory["package"];

/** Directories searched for desktop entries, most specific first. */
export const desktopEntryDirectories = (
  environment: LinuxApplicationRequest["environment"],
  home: string,
): readonly string[] => {
  const dataHome = environment.XDG_DATA_HOME || join(home, ".local/share");
  const dataDirectories = (
    environment.XDG_DATA_DIRS || "/usr/local/share:/usr/share"
  )
    .split(":")
    .filter((directory) => isAbsolute(directory));
  return [dataHome, ...dataDirectories].map((directory) =>
    join(directory, "applications"),
  );
};

const locateDesktopEntry = async (
  request: LinuxApplicationRequest,
  selector: string,
): Promise<
  Result<{ path: string; id: string | null }, LinuxApplicationRefusal>
> => {
  if (isAbsolute(selector)) return ok({ path: selector, id: null });
  const id = selector.endsWith(".desktop") ? selector : `${selector}.desktop`;
  const searched = desktopEntryDirectories(request.environment, request.home);
  for (const directory of searched) {
    const path = join(directory, id);
    // Flatpak exports and Nix profiles install entries as links to the file.
    if ((await stat(path).catch(() => undefined))?.isFile() === true)
      return ok({ path, id: id.slice(0, -".desktop".length) });
  }
  return err({ reason: "desktop_entry_not_found", searched });
};

const readDesktopEntry = async (
  path: string,
  signal: AbortSignal | undefined,
): Promise<Result<DesktopEntry, LinuxApplicationRefusal>> => {
  const options = {
    symlinks: "follow" as const,
    ...(signal === undefined ? {} : { signal }),
  };
  let text: string;
  try {
    text = (
      await withOwnedRegularFile(path, options, ({ handle }) =>
        readStableFileBytes(handle, path, DESKTOP_ENTRY_MAX_BYTES, options),
      )
    ).toString("utf8");
  } catch (cause: unknown) {
    signal?.throwIfAborted();
    if (!isRefusedRead(cause)) throw cause;
    return err({
      reason: "desktop_entry_invalid",
      detail:
        cause instanceof RegularFileCapacityError
          ? "larger than 1 MiB"
          : "unreadable",
    });
  }
  const parsed = parseDesktopEntry(text);
  if (!parsed.ok)
    return err({ reason: "desktop_entry_invalid", detail: parsed.error });
  if (parsed.value.type !== "Application" || parsed.value.exec === null)
    return err({
      reason: "desktop_entry_invalid",
      detail: "not an Application entry with an Exec key",
    });
  return ok(parsed.value);
};

const runQuery = async (
  command: string,
  arguments_: readonly string[],
  signal: AbortSignal | undefined,
): Promise<{ readonly stdout: string } | "missing" | "failed"> => {
  try {
    const { stdout } = await execFileOutput(command, arguments_, {
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: COMMAND_MAX_BUFFER,
      ...(signal === undefined ? {} : { signal }),
    });
    return { stdout };
  } catch (cause: unknown) {
    signal?.throwIfAborted();
    return execFileOutputFailure(cause)?.code === "ENOENT"
      ? "missing"
      : "failed";
  }
};

/** `/bin/x` and `/usr/bin/x` name the same file on merged-/usr systems. */
const ownershipCandidates = (paths: readonly string[]): readonly string[] => [
  ...new Set(
    paths.flatMap((path) =>
      path.startsWith("/usr/") ? [path, path.slice(4)] : [path, `/usr${path}`],
    ),
  ),
];

/** The apt origin of each source by index; omitted when apt could not be asked. */
const sourceOrigins = async (
  sources: readonly string[],
  signal: AbortSignal | undefined,
): Promise<Pick<Package, "source_origins">> => {
  if (sources.length === 0) return { source_origins: [] };
  const policy = await runQuery("apt-cache", ["policy"], signal);
  if (typeof policy !== "object") return {};
  const origins = parseAptPolicyOrigins(policy.stdout);
  return {
    source_origins: sources.map((source) => origins.get(source) ?? null),
  };
};

const packageListsPresent = async (): Promise<boolean> =>
  (await readdir("/var/lib/apt/lists").catch(() => [] as string[])).some(
    (name) => /_Packages(?:\.[a-z0-9]+)?$/u.test(name),
  );

const debianPackage = async (
  paths: readonly string[],
  signal: AbortSignal | undefined,
  limitations: string[],
): Promise<Package> => {
  const unknown: Package = {
    kind: "unknown",
    name: null,
    version: null,
    architecture: null,
    sources: [],
    package_lists_present: null,
  };
  for (const path of ownershipCandidates(paths)) {
    const owners = await runQuery("dpkg-query", ["-S", path], signal);
    if (owners === "missing") {
      limitations.push(
        "dpkg-query is not installed, so the package that owns the executable is unknown.",
      );
      return unknown;
    }
    if (owners === "failed") continue;
    const [name] = parseDpkgOwners(owners.stdout, path);
    if (name === undefined) continue;
    const status = await runQuery(
      "dpkg-query",
      ["-W", `-f=${DPKG_STATUS_FORMAT}`, name],
      signal,
    );
    const parsed =
      typeof status === "object" ? parseDpkgStatus(status.stdout) : undefined;
    const policy = await runQuery("apt-cache", ["policy", name], signal);
    const listsPresent = await packageListsPresent();
    if (!listsPresent)
      limitations.push(
        "No apt package lists are present, so whether the installed version comes from a package archive is unknown.",
      );
    const sources =
      typeof policy === "object"
        ? [...parseAptPolicySources(policy.stdout)]
        : [];
    return {
      kind: "deb",
      name: parsed?.name ?? name,
      version: parsed?.version ?? null,
      architecture: parsed?.architecture ?? null,
      sources,
      ...(await sourceOrigins(sources, signal)),
      package_lists_present: listsPresent,
    };
  }
  return unknown;
};

const readHeader = async (
  path: string,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> => {
  const options = {
    symlinks: "follow" as const,
    ...(signal === undefined ? {} : { signal }),
  };
  try {
    return await withOwnedRegularFile(
      path,
      options,
      async ({ handle }) =>
        (await readStableFilePrefix(handle, path, 16, options)).bytes,
    );
  } catch (cause: unknown) {
    signal?.throwIfAborted();
    if (!isRefusedRead(cause)) throw cause;
    return new Uint8Array();
  }
};

/** The launched program as found on PATH and after resolving links. */
interface ProgramLocation {
  readonly program: string;
  readonly resolved: string | null;
  readonly flatpak: string | null;
}

const identifyPackage = async (
  { program, resolved, flatpak }: ProgramLocation,
  signal: AbortSignal | undefined,
  limitations: string[],
): Promise<Package> => {
  const base = {
    version: null,
    architecture: null,
    sources: [],
    package_lists_present: null,
  };
  if (flatpak !== null) return { kind: "flatpak", name: flatpak, ...base };
  const fromPath =
    packageFromPath(resolved ?? program) ?? packageFromPath(program);
  if (fromPath?.kind === "snap")
    return { kind: "snap", name: fromPath.name, ...base };
  if (fromPath?.kind === "flatpak")
    return { kind: "flatpak", name: fromPath.name, ...base };
  if (
    fromPath?.kind === "appimage" ||
    isAppImageHeader(await readHeader(resolved ?? program, signal))
  )
    return { kind: "appimage", name: basename(resolved ?? program), ...base };
  return debianPackage(
    [program, ...(resolved === null ? [] : [resolved])],
    signal,
    limitations,
  );
};

const electronMarkers = async (
  resolved: string | null,
  signal: AbortSignal | undefined,
): Promise<DesktopApplicationInventory["executable"]["electron_markers"]> => {
  if (resolved === null) return [];
  const markers: DesktopApplicationInventory["executable"]["electron_markers"] =
    [];
  try {
    const image = await readElectronFuseImage(
      resolved,
      signal === undefined ? {} : { signal },
    );
    if (image.slices.some((slice) => slice.sentinel_count > 0))
      markers.push("fuse-sentinel");
  } catch {
    signal?.throwIfAborted();
    // Scripts and other non-binary launchers carry no fuse wire.
  }
  const asar = join(dirname(resolved), "resources/app.asar");
  if ((await lstat(asar).catch(() => undefined)) !== undefined)
    markers.push("app-asar");
  return markers;
};

/** Folder names under XDG and dot-directories where the application may keep state. */
const stateDirectories = async (
  names: readonly (string | null)[],
  { environment, home }: Pick<LinuxApplicationRequest, "environment" | "home">,
  extra: readonly string[],
): Promise<DesktopApplicationInventory["state_directories"]> => {
  const bases = [
    environment.XDG_CONFIG_HOME || join(home, ".config"),
    environment.XDG_DATA_HOME || join(home, ".local/share"),
    environment.XDG_STATE_HOME || join(home, ".local/state"),
    environment.XDG_CACHE_HOME || join(home, ".cache"),
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
  const paths = new Set([
    ...[...variants].flatMap((name) => [
      ...bases.map((base) => join(base, name)),
      join(home, `.${name}`),
    ]),
    ...extra,
  ]);
  return Promise.all(
    [...paths].map(async (path) => ({
      path,
      exists_at_start: (await lstat(path).catch(() => undefined)) !== undefined,
    })),
  );
};

const launchCommand = async (
  request: LinuxApplicationRequest,
  signal: AbortSignal | undefined,
): Promise<
  Result<
    {
      argv: readonly string[];
      workingDirectory: string;
      entry: DesktopApplicationInventory["desktop_entry"];
    },
    LinuxApplicationRefusal
  >
> => {
  if (request.desktopEntry === undefined) {
    const executable = request.executable ?? "";
    // Run like a shell would: from the caller's directory, with a relative
    // path resolved there rather than in the application's working directory.
    return ok({
      argv: [
        executable.includes("/")
          ? resolve(request.callerDirectory, executable)
          : executable,
        ...request.arguments,
      ],
      workingDirectory: request.callerDirectory,
      entry: null,
    });
  }
  const located = await locateDesktopEntry(request, request.desktopEntry);
  if (!located.ok) return located;
  const entry = await readDesktopEntry(located.value.path, signal);
  if (!entry.ok) return entry;
  const tokens = tokenizeDesktopExec(entry.value.exec ?? "");
  if (!tokens.ok)
    return err({ reason: "desktop_entry_invalid", detail: tokens.error });
  const {
    type: _type,
    try_exec: _tryExec,
    path: workingDirectory,
    ...fields
  } = entry.value;
  return ok({
    argv: expandDesktopExec(
      tokens.value,
      {
        icon: entry.value.icon,
        name: entry.value.name,
        location: located.value.path,
      },
      request.arguments,
    ),
    workingDirectory: workingDirectory ?? request.home,
    entry: {
      id: located.value.id,
      path: located.value.path,
      ...fields,
      categories: [...fields.categories],
      mime_types: [...fields.mime_types],
    },
  });
};

/**
 * Names the application's state folders may carry, including the entry's
 * full reverse-DNS id and its last part. The executable is null for a
 * `flatpak run` launch, whose `flatpak` launcher names flatpak's own folders.
 */
const stateNames = (
  package_: Package,
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

/** Resolve what the request launches, where it came from and where it may keep state. */
export const inspectLinuxApplication = async (
  request: LinuxApplicationRequest,
  signal?: AbortSignal,
): Promise<Result<LinuxApplicationFacts, LinuxApplicationRefusal>> => {
  const command = await launchCommand(request, signal);
  if (!command.ok) return command;
  const { argv, workingDirectory, entry } = command.value;
  const wrapper = unwrapDesktopCommand(argv);
  // An `env` prefix's assignments are what the program sees: its PATH finds
  // the program and its XDG folders hold the program's state.
  const environment = { ...request.environment, ...wrapper.environment };
  const found = await resolveProgram(
    wrapper.program,
    environment,
    workingDirectory,
  );
  if (found === undefined)
    return err({ reason: "executable_not_found", program: wrapper.program });
  // The PATH an env prefix sets travels with the launch; the host's own does not.
  if (found.fromRelativeEntry && wrapper.environment.PATH === undefined)
    return err({
      reason: "executable_on_relative_path",
      program: wrapper.program,
    });
  const { path } = found;
  const resolved = await realpath(path).catch(() => null);
  const limitations: string[] = [];
  const flatpak = wrapper.kind === "flatpak" ? wrapper.application_id : null;
  const package_ = await identifyPackage(
    { program: path, resolved, flatpak },
    signal,
    limitations,
  );
  const sandboxDirectories = [
    ...(package_.kind === "snap" && package_.name !== null
      ? [join(request.home, "snap", package_.name)]
      : []),
    ...(package_.kind === "flatpak" && package_.name !== null
      ? [join(request.home, ".var/app", package_.name)]
      : []),
  ];
  const names = stateNames(
    package_,
    wrapper.kind === "flatpak" ? null : path,
    entry,
  );
  return ok({
    inventory: {
      desktop_entry: entry,
      argv: [...argv],
      working_directory: workingDirectory,
      executable: {
        path,
        resolved_path: resolved,
        electron_markers: await electronMarkers(resolved, signal),
      },
      package: package_,
      state_directories: await stateDirectories(
        names,
        { environment, home: request.home },
        sandboxDirectories,
      ),
    },
    limitations,
  });
};
