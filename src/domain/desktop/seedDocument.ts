import { posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  desktopArgumentIndex,
  execTakesFiles,
  unwrapDesktopCommand,
} from "./desktopEntry.js";

/** What the exported app opens at launch. */
export type LaunchDocument =
  /** The seed's one document, by home path. */
  | { readonly kind: "seed"; readonly document: string }
  /** A document the captured command already names. */
  | { readonly kind: "captured" }
  /** Nothing, since the seed holds no document. */
  | { readonly kind: "empty" }
  /** No document, for the reason given, which follows "since". */
  | { readonly kind: "none"; readonly reason: string };

/** Parse a captured Linux file URL independently of the exporter host OS. */
export const capturedFileUrl = (
  value: string,
): { readonly url: URL; readonly path: string } | undefined => {
  if (!/^file:/iu.test(value)) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "file:"
      ? { url, path: fileURLToPath(url, { windows: false }) }
      : undefined;
  } catch {
    return undefined;
  }
};

/** The home path an argument names, absolute or from the working directory; none for an option or a path outside the home. */
const homePathOf = (
  argument: string,
  home: string,
  workingDirectory: string,
  known: (path: string) => boolean,
  knownSeed: (path: string) => boolean,
  mapOutside?: (path: string) => string | null,
): { readonly source: string } | { readonly seed: string } | undefined => {
  // An empty value is not a relative path. Resolving it would name the working directory.
  if (argument === "" || argument.startsWith("-")) return undefined;
  let input = argument;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(argument)) {
    const candidate = posix.resolve(workingDirectory, argument);
    if (candidate.startsWith(`${home}/`)) {
      const relative = candidate.slice(home.length + 1);
      if (known(relative)) return { source: relative };
    }
    const parsed = capturedFileUrl(argument);
    if (parsed === undefined) return undefined;
    input = parsed.path;
  }
  const path = posix.resolve(workingDirectory, input);
  if (path.startsWith(`${home}/`))
    return { source: path.slice(home.length + 1) };
  const mapped = mapOutside?.(path);
  return mapped !== null && mapped !== undefined && knownSeed(mapped)
    ? { seed: mapped }
    : undefined;
};

/**
 * The launch arguments, with the seed's document appended when the seed holds
 * exactly one and the desktop entry's `Exec` takes a file, so the app opens on
 * it rather than on its start screen. A command that already names a document,
 * absolute or from its working directory, is kept as it is.
 */
export const openSeedDocument = (
  argv: readonly string[],
  facts: {
    readonly home: string;
    readonly workingDirectory: string;
    readonly exec: string | null;
    readonly documents: readonly string[];
    /** Whether a home path is a document the capture saw. */
    readonly isDocument: (homePath: string) => boolean;
    /** The seed's spelling of a home path, when a selected link renamed it. */
    readonly spell?: (homePath: string) => string;
    /** Where the process starts when that directory's spelling moved. */
    readonly launchDirectory?: string;
    /** A home path the capture holds as a file or a settings directory. */
    readonly isCaptured?: (homePath: string) => boolean;
    /** The seed spelling of a captured absolute path outside the home. */
    readonly mapOutside?: (absolutePath: string) => string | null;
  },
): { readonly argv: readonly string[]; readonly opens: LaunchDocument } => {
  const { home, exec, documents } = facts;
  const spelled = (path: string) => facts.spell?.(path) ?? path;
  const directoryMoved =
    facts.launchDirectory !== undefined &&
    facts.launchDirectory !== facts.workingDirectory;
  const none = (reason: string) => ({
    argv: argvSpelled,
    opens: { kind: "none", reason } as const,
  });
  const isCapturedSeed = (path: string) =>
    facts.isDocument(path) || facts.isCaptured?.(path) === true;
  const namesCaptured = (path: string) => {
    const seedPath = spelled(path);
    return isCapturedSeed(path) || isCapturedSeed(seedPath);
  };
  const absoluteSeed = (path: string) => {
    if (!namesCaptured(path)) return undefined;
    const seedPath = spelled(path);
    // A relative file was resolved in the captured directory. Once that
    // directory moves, the same relative word would name a different file.
    return seedPath === path && !directoryMoved
      ? undefined
      : `${home}/${seedPath}`;
  };
  const seedName = (
    path: { readonly source: string } | { readonly seed: string },
  ) => ("seed" in path ? path.seed : spelled(path.source));
  const retargetValue = (value: string): string => {
    const url = capturedFileUrl(value);
    if (url !== undefined) {
      const path = homePathOf(
        value,
        home,
        facts.workingDirectory,
        namesCaptured,
        isCapturedSeed,
        facts.mapOutside,
      );
      if (path === undefined) return value;
      if ("source" in path && !namesCaptured(path.source)) return value;
      const seedPath = seedName(path);
      if ("source" in path && seedPath === path.source) return value;
      const encoded = pathToFileURL(`${home}/${seedPath}`, {
        windows: false,
      }).pathname.split("/");
      const original = url.url.pathname.split("/");
      const oldParts = url.path.split("/");
      const newParts = `${home}/${seedPath}`.split("/");
      // Preserve the caller's encoded spelling for unchanged path segments.
      let first = 0;
      while (first < oldParts.length && oldParts[first] === newParts[first]) {
        encoded[first] = original[first] ?? encoded[first]!;
        first += 1;
      }
      let oldEnd = oldParts.length - 1;
      let newEnd = newParts.length - 1;
      while (
        oldEnd >= first &&
        newEnd >= first &&
        oldParts[oldEnd] === newParts[newEnd]
      ) {
        encoded[newEnd] = original[oldEnd] ?? encoded[newEnd]!;
        oldEnd -= 1;
        newEnd -= 1;
      }
      const prefix =
        /^file:(?:\/\/(?:localhost)?)?/iu.exec(value)?.[0] ?? "file://";
      const suffix = /[?#].*$/su.exec(value)?.[0] ?? "";
      return `${prefix}${encoded.join("/")}${suffix}`;
    }
    const path = homePathOf(
      value,
      home,
      facts.workingDirectory,
      namesCaptured,
      isCapturedSeed,
      facts.mapOutside,
    );
    if (path === undefined) return value;
    return "seed" in path
      ? `${home}/${path.seed}`
      : (absoluteSeed(path.source) ?? value);
  };
  const retarget = (argument: string) => {
    const equals = argument.indexOf("=");
    if (argument.startsWith("-") && equals > 0) {
      const value = argument.slice(equals + 1);
      return `${argument.slice(0, equals + 1)}${retargetValue(value)}`;
    }
    return retargetValue(argument);
  };
  const command = unwrapDesktopCommand(argv);
  const firstArgument = desktopArgumentIndex(argv);
  const retargetEnvValue = (argument: string) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/u.test(argument)) return argument;
    const split = argument.indexOf("=");
    const value = argument.slice(split + 1);
    return `${argument.slice(0, split + 1)}${retargetValue(value)}`;
  };
  const argvSpelled = argv.map((argument, index) => {
    if (index === 0 || (command.kind === "direct" && index === command.index))
      return argument;
    return index < firstArgument
      ? retargetEnvValue(argument)
      : retarget(argument);
  });
  const named = argv
    .slice(firstArgument)
    .map((argument) => {
      const equals = argument.indexOf("=");
      const value =
        argument.startsWith("-") && equals > 0
          ? argument.slice(equals + 1)
          : argument;
      return homePathOf(
        value,
        home,
        facts.workingDirectory,
        namesCaptured,
        isCapturedSeed,
        facts.mapOutside,
      );
    })
    .map((path) => (path === undefined ? undefined : seedName(path)));
  if (named.some((path) => path !== undefined && facts.isDocument(path)))
    return {
      argv: argvSpelled,
      opens: { kind: "captured" },
    };
  const [document] = documents;
  if (document === undefined)
    return { argv: argvSpelled, opens: { kind: "empty" } };
  if (documents.length > 1)
    return none(
      `the seed holds ${String(documents.length)} documents (${documents.map((path) => `~/${path}`).join(", ")}) and the app opens one only when it holds exactly one`,
    );
  if (exec === null)
    return none(
      "the capture launched the program without a desktop entry, so whether it takes a file is unknown",
    );
  if (!execTakesFiles(exec))
    return none(
      "its desktop entry's Exec takes no file (no %f, %F, %u or %U field code)",
    );
  return {
    argv: [...argvSpelled, `${home}/${document}`],
    opens: { kind: "seed", document },
  };
};
