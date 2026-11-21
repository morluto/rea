import { decodeStrictUtf8 } from "../domain/strictUtf8.js";
import { desktopLibraryPolicy } from "../domain/desktop/libraryPolicy.js";
import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

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
import {
  assertArtifactReadActive,
  ArtifactReaderFailure,
} from "../resources/index.js";
import { withOwnedRegularFile } from "../filesystem/OwnedRegularFile.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import {
  RegularFileCapacityError,
  readStableFileBytes,
  readStableFilePrefix,
} from "../filesystem/readStableFileBytes.js";
import { stateDirectories, stateNames } from "./ApplicationStateDirectories.js";
import { APT_LOCATIONS } from "./AptRepositoryInventory.js";
import { xdgBase } from "./XdgBase.js";
import { inspectPackageFile } from "./DebianPackageFile.js";
import {
  debianPackage,
  type DebianPackageHost,
  type InventoryContext,
} from "./DebianPackageInventory.js";
import { hostReadFailure, isRefusedRead } from "./HostFileRead.js";
import { runHostQuery } from "./HostQuery.js";
import { resolveProgram } from "./ProgramLookup.js";
import type {
  LinuxApplicationFacts,
  LinuxApplicationRefusal,
  LinuxApplicationRequest,
} from "../ports/DesktopApplicationSession.js";

const DESKTOP_ENTRY_MAX_BYTES = 1024 * 1024;

/** The host commands and apt folders the inventory reads; replaceable in tests. */
export type LinuxInventoryHost = DebianPackageHost;

const LINUX_INVENTORY_HOST: LinuxInventoryHost = {
  runQuery: runHostQuery,
  apt: APT_LOCATIONS,
};

type Package = DesktopApplicationInventory["package"];

/** Directories searched for desktop entries, most specific first. */
const desktopEntryDirectories = (
  environment: LinuxApplicationRequest["environment"],
  home: string,
): readonly string[] => {
  const dataHome = xdgBase(
    environment.XDG_DATA_HOME,
    join(home, ".local/share"),
  );
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
/** How many applicable path probes one applications directory search may issue. */
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
 * A desktop ID replaces path separators with dashes, while names can also
 * contain dashes. Probe only spellings that encode this ID, rather than
 * enumerating unrelated directories. Each descent consumes part of the ID.
 */
const findNestedDesktopEntry = async (
  applicationsDirectory: string,
  id: string,
  signal: AbortSignal | undefined,
): Promise<{ path: string } | { truncated: true } | undefined> => {
  const pending = [{ path: applicationsDirectory, remaining: id, depth: 1 }];
  let examined = 0;
  let incomplete = false;
  while (pending.length > 0) {
    assertArtifactReadActive(signal);
    const directory = pending.pop()!;
    if (directory.depth > 1) {
      if (examined >= NESTED_SEARCH_MAX_ENTRIES) return { truncated: true };
      examined++;
      const path = join(directory.path, directory.remaining);
      const kind = await desktopPathKind(path);
      assertArtifactReadActive(signal);
      if (!kind.ok) incomplete = true;
      else if (kind.value === "file") return { path };
    }
    for (
      let split = directory.remaining.indexOf("-");
      split !== -1;
      split = directory.remaining.indexOf("-", split + 1)
    ) {
      const prefix = directory.remaining.slice(0, split);
      if (prefix === "" || prefix === "." || prefix === "..") continue;
      if (examined >= NESTED_SEARCH_MAX_ENTRIES) return { truncated: true };
      examined++;
      const path = join(directory.path, prefix);
      const kind = await desktopPathKind(path);
      assertArtifactReadActive(signal);
      if (!kind.ok) {
        incomplete = true;
        continue;
      }
      if (kind.value !== "directory") continue;
      if (directory.depth >= NESTED_SEARCH_MAX_DEPTH) {
        incomplete = true;
        continue;
      }
      pending.push({
        path,
        remaining: directory.remaining.slice(split + 1),
        depth: directory.depth + 1,
      });
    }
  }
  return incomplete ? { truncated: true } : undefined;
};

const tryExecUnavailable = async (
  entry: DesktopEntry,
  request: LinuxApplicationRequest,
): Promise<string | undefined> => {
  if (entry.type !== "Application" || !entry.try_exec) return undefined;
  const found = await resolveProgram(
    entry.try_exec,
    request.environment,
    request.callerDirectory,
  );
  return found === undefined ? entry.try_exec : undefined;
};

const locateDesktopEntry = async (
  request: LinuxApplicationRequest,
  selector: string,
  signal?: AbortSignal,
): ReturnType<typeof readDesktopEntry> => {
  if (isAbsolute(selector)) {
    const located = await readDesktopEntry(selector, null, signal);
    if (!located.ok) return located;
    const program = await tryExecUnavailable(located.value.entry, request);
    assertArtifactReadActive(signal);
    return program === undefined
      ? located
      : err({ reason: "executable_not_found", program });
  }
  const id = selector.endsWith(".desktop") ? selector : `${selector}.desktop`;
  const searched = desktopEntryDirectories(request.environment, request.home);
  for (const directory of searched) {
    assertArtifactReadActive(signal);
    const path = join(directory, id);
    const kind = await desktopPathKind(path);
    assertArtifactReadActive(signal);
    if (!kind.ok)
      return err({ reason: "desktop_entry_search_incomplete", searched });
    let candidate = path;
    if (kind.value !== "file") {
      // A nested entry in this directory outranks a flat one in a later root.
      const nested = await findNestedDesktopEntry(directory, id, signal);
      assertArtifactReadActive(signal);
      if (nested === undefined) continue;
      // A bounded search cannot establish absence in this root.
      if (!("path" in nested))
        return err({ reason: "desktop_entry_search_incomplete", searched });
      candidate = nested.path;
    }
    const located = await readDesktopEntry(
      candidate,
      id.slice(0, -".desktop".length),
      signal,
    );
    if (!located.ok) return located;
    if (!located.value.entry.hidden) {
      const program = await tryExecUnavailable(located.value.entry, request);
      assertArtifactReadActive(signal);
      if (program !== undefined) continue;
      return located;
    }
    const { type, malformed_line } = located.value.entry;
    if (type !== "Application") continue;
    // Claim deletion only after the hidden entry establishes its structure.
    if (malformed_line !== undefined)
      return err({
        reason: "desktop_entry_invalid",
        detail: `malformed desktop entry structure at line ${String(malformed_line)}`,
      });
    break;
  }
  return err({ reason: "desktop_entry_not_found", searched });
};

const readDesktopEntry = async (
  path: string,
  id: string | null,
  signal: AbortSignal | undefined,
): Promise<
  Result<
    { path: string; id: string | null; entry: DesktopEntry },
    LinuxApplicationRefusal
  >
> => {
  const options = {
    symlinks: "follow" as const,
    ...(signal === undefined ? {} : { signal }),
  };
  let bytes: Uint8Array;
  try {
    bytes = await withOwnedRegularFile(path, options, ({ handle }) =>
      readStableFileBytes(handle, path, DESKTOP_ENTRY_MAX_BYTES, options),
    );
  } catch (cause: unknown) {
    const failure = hostReadFailure(cause);
    if (failure !== cause) throw failure;
    if (!isRefusedRead(cause)) throw cause;
    return err({
      reason: "desktop_entry_invalid",
      detail:
        cause instanceof RegularFileCapacityError
          ? "larger than 1 MiB"
          : "unreadable",
    });
  }
  let text: string;
  try {
    text = decodeStrictUtf8(bytes, "preserve");
  } catch {
    return err({ reason: "desktop_entry_invalid", detail: "not valid UTF-8" });
  }
  const parsed = parseDesktopEntry(text);
  if (!parsed.ok)
    return err({ reason: "desktop_entry_invalid", detail: parsed.error });
  return ok({ path, id, entry: parsed.value });
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
    const failure = hostReadFailure(cause);
    if (failure !== cause) throw failure;
    if (!isRefusedRead(cause)) throw cause;
    return new Uint8Array();
  }
};

const launchEnvironment = (
  wrapper: ReturnType<typeof unwrapDesktopCommand>,
  inherited: LinuxApplicationRequest["environment"],
) => {
  const inheritedEnvironment = wrapper.clearEnvironment ? {} : { ...inherited };
  for (const name of wrapper.unsetEnvironment ?? [])
    delete inheritedEnvironment[name];
  const environment = { ...inheritedEnvironment, ...wrapper.environment };
  // GNU env's execvp searches the Linux system path when the prefix removes PATH.
  const pathRemoved =
    wrapper.clearEnvironment || wrapper.unsetEnvironment?.includes("PATH");
  const lookupEnvironment =
    pathRemoved && environment.PATH === undefined
      ? { ...environment, PATH: "/bin:/usr/bin" }
      : environment;
  return { environment, lookupEnvironment };
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
  } catch (cause: unknown) {
    if (
      cause instanceof ArtifactReaderFailure &&
      (cause.cleanup !== undefined || cause.reason === "cancelled")
    )
      throw cause;
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
          ? absoluteCallerPath(executable, { cwd: request.callerDirectory })
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
  const { entry } = located.value;
  if (entry.type !== "Application" || entry.exec === null)
    return err({
      reason: "desktop_entry_invalid",
      detail: "not an Application entry with an Exec key",
    });
  const tokens = tokenizeDesktopExec(entry.exec);
  if (!tokens.ok)
    return err({ reason: "desktop_entry_invalid", detail: tokens.error });
  const {
    type: _type,
    try_exec: _tryExec,
    hidden: _hidden,
    malformed_line: _malformedLine,
    path: workingDirectory,
    ...fields
  } = entry;
  return ok({
    argv: expandDesktopExec(
      tokens.value,
      {
        icon: entry.icon,
        name: entry.name,
        location: located.value.path,
      },
      request.arguments,
    ),
    workingDirectory: workingDirectory || request.home,
    entry: {
      id: located.value.id,
      path: located.value.path,
      ...fields,
      categories: [...fields.categories],
      mime_types: [...fields.mime_types],
    },
  });
};

const envApplicationDirectory = async (
  path: string | undefined,
  workingDirectory: string,
  signal: AbortSignal | undefined,
): Promise<Result<string | undefined, LinuxApplicationRefusal>> => {
  if (path === undefined) return ok(undefined);
  const invalidDirectory = {
    reason: "desktop_entry_invalid" as const,
    detail: "env chdir does not name a directory",
  };
  if (path === "") return err(invalidDirectory);
  const selected = absoluteCallerPath(path, { cwd: workingDirectory });
  try {
    assertArtifactReadActive(signal);
    const physical = await realpath(selected);
    assertArtifactReadActive(signal);
    const directory = await stat(physical);
    assertArtifactReadActive(signal);
    return directory.isDirectory() ? ok(physical) : err(invalidDirectory);
  } catch (cause: unknown) {
    if (!isRefusedRead(cause) || signal?.aborted === true) throw cause;
    return err(invalidDirectory);
  }
};

const directLaunchStateHome = (
  wrapper: ReturnType<typeof unwrapDesktopCommand>,
  packageKind: Package["kind"],
  hostHome: string,
): string | undefined => {
  // Sandbox-managed directories continue to use the host home.
  if (wrapper.kind !== "direct" || packageKind === "snap") return hostHome;
  const launchHome = wrapper.environment.HOME;
  if (launchHome !== undefined && isAbsolute(launchHome)) return launchHome;
  if (wrapper.clearEnvironment || wrapper.unsetEnvironment?.includes("HOME"))
    return undefined;
  return hostHome;
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
  if (wrapper.invalidUnset)
    return err({
      reason: "desktop_entry_invalid",
      detail: "env unset does not name a variable",
    });
  const directory = await envApplicationDirectory(
    wrapper.chdir?.path,
    workingDirectory,
    signal,
  );
  if (!directory.ok) return directory;
  const applicationDirectory = directory.value;
  // An `env` prefix's assignments are what the program sees: its PATH finds
  // the program and its XDG folders hold the program's state.
  const { environment, lookupEnvironment } = launchEnvironment(
    wrapper,
    request.environment,
  );
  const found = await resolveProgram(
    wrapper.program,
    lookupEnvironment,
    applicationDirectory ?? workingDirectory,
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
    libraryPolicy: desktopLibraryPolicy(request.libraryPolicy),
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
  const stateHome = directLaunchStateHome(wrapper, package_.kind, request.home);
  if (stateHome === undefined)
    limitations.push(
      "The launch prefix provides no absolute HOME after removing the inherited value. The application's default home state paths are unknown. Select known locations with --state-path.",
    );
  return ok({
    inventory: {
      desktop_entry: entry,
      argv: [...argv],
      working_directory: workingDirectory,
      ...(applicationDirectory === undefined
        ? {}
        : { application_working_directory: applicationDirectory }),
      executable: {
        path,
        resolved_path: resolved,
        electron_markers: await electronMarkers(resolved, signal),
      },
      package: package_,
      state_directories: await stateDirectories(
        names,
        {
          environment,
          home: stateHome,
        },
        sandboxDirectories,
      ),
    },
    ...(wrapper.index === 0 ? {} : { envProgramIndex: wrapper.index }),
    limitations,
    signingKeys,
  });
};
