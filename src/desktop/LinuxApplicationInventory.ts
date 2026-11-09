import { lstat, opendir, realpath, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import type { DesktopApplicationInventory } from "../domain/desktop/desktopCapture.js";
import {
  expandDesktopExec,
  parseDesktopEntry,
  tokenizeDesktopExec,
  unwrapDesktopCommand,
  type DesktopEntry,
} from "../domain/desktop/desktopEntry.js";
import {
  isAppImageHeader,
  packageFromPath,
} from "../domain/desktop/linuxPackages.js";
import { err, ok, type Result } from "../domain/result.js";
import { readElectronFuseImage } from "../electron/ElectronFuseReader.js";
import { withOwnedRegularFile } from "../filesystem/OwnedRegularFile.js";
import {
  RegularFileCapacityError,
  readStableFileBytes,
  readStableFilePrefix,
} from "../filesystem/readStableFileBytes.js";
import { stateDirectories, stateNames } from "./ApplicationStateDirectories.js";
import { APT_LOCATIONS } from "./AptRepositoryInventory.js";
import { inspectPackageFile } from "./DebianPackageFile.js";
import {
  debianPackage,
  type DebianPackageHost,
  type InventoryContext,
} from "./DebianPackageInventory.js";
import { isRefusedRead } from "./HostFileRead.js";
import { runHostQuery } from "./HostQuery.js";
import { resolveProgram } from "./ProgramLookup.js";

const DESKTOP_ENTRY_MAX_BYTES = 1024 * 1024;

/** Which application to launch, as the caller named it. */
export interface LinuxApplicationRequest {
  readonly desktopEntry: string | undefined;
  readonly executable: string | undefined;
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  /** Where a relative executable is found and an executable launch runs. */
  readonly callerDirectory: string;
  /** The absolute path of the `.deb` file the application was installed from, whose facts are recorded. */
  readonly packageFile?: string | undefined;
}

/** Why the request does not name a launchable application. */
export type LinuxApplicationRefusal =
  | {
      readonly reason: "desktop_entry_not_found";
      readonly searched: readonly string[];
    }
  | {
      readonly reason: "desktop_entry_search_incomplete";
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
  /** Verified apt signing keys' bytes by sha256, for the capture to retain. */
  readonly signingKeys: ReadonlyMap<string, Buffer>;
}

/** The host commands and apt folders the inventory reads; replaceable in tests. */
export type LinuxInventoryHost = DebianPackageHost;

const LINUX_INVENTORY_HOST: LinuxInventoryHost = {
  runQuery: runHostQuery,
  apt: APT_LOCATIONS,
};

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

/** How deep below one applications directory a nested id search may descend. */
const NESTED_SEARCH_MAX_DEPTH = 4;
/** How many directory entries one applications directory search may examine. */
const NESTED_SEARCH_MAX_ENTRIES = 4096;

type DesktopPathKind = "file" | "directory" | "other" | "absent";

/** Only missing paths establish absence; failed identity probes remain unresolved. */
const desktopPathKind = async (
  path: string,
): Promise<Result<DesktopPathKind, unknown>> => {
  try {
    const facts = await stat(path);
    return ok(
      facts.isFile() ? "file" : facts.isDirectory() ? "directory" : "other",
    );
  } catch (cause: unknown) {
    const code = (cause as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? ok("absent") : err(cause);
  }
};

/**
 * The entry in `applicationsDirectory` whose desktop file id is `id`, when one
 * is there. The Desktop Entry spec forms the id from the entry's path below
 * `applications/` by replacing the separators with dashes, so
 * `vendor/org.example.App.desktop` advertises `vendor-org.example.App.desktop`.
 * A dash may also belong to a name, so the id does not say where the
 * separators fall; list the directory instead and form each entry's id from
 * the path that holds it.
 *
 * The walk is bounded, and both bounds are reported as `truncated` rather than
 * as absence: an unvisited directory or an unreadable subtree may still hold
 * the entry, and selecting a lower-priority root would launch a different
 * application under the same id.
 */
const findNestedDesktopEntry = async (
  applicationsDirectory: string,
  id: string,
  signal: AbortSignal | undefined,
): Promise<{ path: string } | { truncated: true } | undefined> => {
  const pending = [{ path: applicationsDirectory, depth: 1 }];
  let examined = 0;
  // An unreadable or over-budget subtree may still hold the entry, but the
  // rest of this root has not been walked yet: an answer found there is the
  // right one, so remember the gap and report it only after the walk ends.
  let incomplete = false;
  while (pending.length > 0) {
    signal?.throwIfAborted();
    const directory = pending.pop();
    if (directory === undefined) break;
    let handle: Awaited<ReturnType<typeof opendir>>;
    try {
      handle = await opendir(directory.path);
    } catch (cause: unknown) {
      // A root that is not installed holds nothing; one that exists but cannot
      // be read may still hold the entry, so that search has no answer.
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      incomplete = true;
      continue;
    }
    for await (const entry of handle) {
      signal?.throwIfAborted();
      // The budget is charged while enumerating, because readdir would
      // materialize every name in a huge directory before any check ran.
      examined += 1;
      if (examined > NESTED_SEARCH_MAX_ENTRIES) return { truncated: true };
      const path = join(directory.path, entry.name);
      const kind = entry.isDirectory()
        ? ok("directory" as const)
        : entry.isFile()
          ? ok("file" as const)
          : await desktopPathKind(path);
      signal?.throwIfAborted();
      if (!kind.ok) {
        incomplete = true;
        continue;
      }
      if (entry.name.endsWith(".desktop") && kind.value === "file") {
        // A directory may be named `*.desktop`; the spec still forms the ids
        // of the entries inside it from their full path, so only a file is a
        // candidate here.
        const encoded = relative(applicationsDirectory, path).replaceAll(
          "/",
          "-",
        );
        if (encoded === id) return { path };
      }
      if (kind.value !== "directory") continue;
      if (directory.depth >= NESTED_SEARCH_MAX_DEPTH) {
        incomplete = true;
        continue;
      }
      pending.push({
        path: join(directory.path, entry.name),
        depth: directory.depth + 1,
      });
    }
  }
  return incomplete ? { truncated: true } : undefined;
};

const locateDesktopEntry = async (
  request: LinuxApplicationRequest,
  selector: string,
  signal?: AbortSignal,
): Promise<
  Result<{ path: string; id: string | null }, LinuxApplicationRefusal>
> => {
  if (isAbsolute(selector)) return ok({ path: selector, id: null });
  const id = selector.endsWith(".desktop") ? selector : `${selector}.desktop`;
  const searched = desktopEntryDirectories(request.environment, request.home);
  for (const directory of searched) {
    signal?.throwIfAborted();
    const path = join(directory, id);
    const kind = await desktopPathKind(path);
    signal?.throwIfAborted();
    if (!kind.ok)
      return err({ reason: "desktop_entry_search_incomplete", searched });
    if (kind.value === "file")
      return ok({ path, id: id.slice(0, -".desktop".length) });
    // A nested entry in this directory outranks a flat one in a later root.
    const nested = await findNestedDesktopEntry(directory, id, signal);
    signal?.throwIfAborted();
    if (nested !== undefined && "path" in nested)
      return ok({ path: nested.path, id: id.slice(0, -".desktop".length) });
    // The bounded search did not establish absence, so a later root must not
    // supply a different application under the same id.
    if (nested !== undefined)
      return err({ reason: "desktop_entry_search_incomplete", searched });
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
  /** The launched desktop entry and its resolved file; empty for an executable launch. */
  readonly entry: readonly string[];
}

const identifyPackage = async (
  { program, resolved, flatpak, entry }: ProgramLocation,
  context: InventoryContext,
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
    isAppImageHeader(await readHeader(resolved ?? program, context.signal))
  )
    return { kind: "appimage", name: basename(resolved ?? program), ...base };
  return debianPackage(
    {
      program: [program, ...(resolved === null ? [] : [resolved])],
      executable: resolved ?? program,
      entry,
    },
    context,
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
  const located = await locateDesktopEntry(
    request,
    request.desktopEntry,
    signal,
  );
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

/** Resolve what the request launches, where it came from and where it may keep state. */
export const inspectLinuxApplication = async (
  request: LinuxApplicationRequest,
  signal?: AbortSignal,
  host: LinuxInventoryHost = LINUX_INVENTORY_HOST,
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
  const context: InventoryContext = {
    host,
    signal,
    limitations: [],
    signingKeys: new Map(),
  };
  const { limitations, signingKeys } = context;
  const flatpak = wrapper.kind === "flatpak" ? wrapper.application_id : null;
  const entryFiles =
    entry === null
      ? []
      : [entry.path, await realpath(entry.path).catch(() => entry.path)];
  const identified = await identifyPackage(
    { program: path, resolved, flatpak, entry: entryFiles },
    context,
  );
  const package_ =
    request.packageFile === undefined
      ? identified
      : {
          ...identified,
          ...(await inspectPackageFile(
            request.packageFile,
            identified,
            host.runQuery,
            signal,
          )),
        };
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
    signingKeys,
  });
};
