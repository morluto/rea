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

/** The home path an argument names, absolute or from the working directory; none for an option or a path outside the home. */
const homePathOf = (
  argument: string,
  home: string,
  workingDirectory: string,
): { readonly path: string; readonly url: URL | undefined } | undefined => {
  // An empty value is not a relative path. Resolving it would name the working directory.
  if (argument === "" || argument.startsWith("-")) return undefined;
  let input = argument;
  let parsedUrl: URL | undefined;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(argument)) {
    try {
      const url = new URL(argument);
      if (url.protocol !== "file:") return undefined;
      input = fileURLToPath(url);
      parsedUrl = url;
    } catch {
      return undefined;
    }
  }
  const path = posix.resolve(workingDirectory, input);
  return path.startsWith(`${home}/`)
    ? { path: path.slice(home.length + 1), url: parsedUrl }
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
  const namesCaptured = (path: string) => {
    const seedPath = spelled(path);
    return (
      facts.isDocument(path) ||
      facts.isDocument(seedPath) ||
      facts.isCaptured?.(path) === true ||
      facts.isCaptured?.(seedPath) === true
    );
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
  const spelledArgument = (absolute: string, url: URL | undefined) => {
    if (url === undefined) return absolute;
    const retargeted = new URL(url);
    retargeted.pathname = pathToFileURL(absolute).pathname;
    return retargeted.href;
  };
  const retarget = (argument: string) => {
    const equals = argument.indexOf("=");
    if (argument.startsWith("-") && equals > 0) {
      const value = argument.slice(equals + 1);
      const parsed = homePathOf(value, home, facts.workingDirectory);
      const absolute =
        parsed === undefined ? undefined : absoluteSeed(parsed.path);
      return absolute === undefined
        ? argument
        : `${argument.slice(0, equals + 1)}${spelledArgument(absolute, parsed?.url)}`;
    }
    const parsed = homePathOf(argument, home, facts.workingDirectory);
    if (parsed === undefined) return argument;
    const absolute = absoluteSeed(parsed.path);
    return absolute === undefined
      ? argument
      : spelledArgument(absolute, parsed.url);
  };
  const command = unwrapDesktopCommand(argv);
  const firstArgument = desktopArgumentIndex(argv);
  const retargetEnvValue = (argument: string) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/u.test(argument)) return argument;
    const split = argument.indexOf("=");
    const value = argument.slice(split + 1);
    const parsed = homePathOf(value, home, facts.workingDirectory);
    const absolute =
      parsed === undefined ? undefined : absoluteSeed(parsed.path);
    return absolute === undefined
      ? argument
      : `${argument.slice(0, split + 1)}${spelledArgument(absolute, parsed?.url)}`;
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
      return homePathOf(value, home, facts.workingDirectory)?.path;
    })
    .map((path) => (path === undefined ? undefined : spelled(path)));
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
