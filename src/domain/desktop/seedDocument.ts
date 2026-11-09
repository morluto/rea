import { posix } from "node:path";
import { fileURLToPath } from "node:url";

import { execTakesFiles } from "./desktopEntry.js";

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
): string | undefined => {
  if (argument === "" || argument.startsWith("-")) return undefined;
  let input = argument;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(argument)) {
    const candidate = posix.resolve(workingDirectory, argument);
    if (candidate.startsWith(`${home}/`)) {
      const relative = candidate.slice(home.length + 1);
      if (known(relative)) return relative;
    }
    const parsed = capturedFileUrl(argument);
    if (parsed === undefined) return undefined;
    input = parsed.path;
  }
  const path = posix.resolve(workingDirectory, input);
  return path.startsWith(`${home}/`) ? path.slice(home.length + 1) : undefined;
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
  },
): { readonly argv: readonly string[]; readonly opens: LaunchDocument } => {
  const { home, exec, documents } = facts;
  const none = (reason: string) => ({
    argv,
    opens: { kind: "none", reason } as const,
  });
  const named = argv
    .slice(1)
    .map((argument) =>
      homePathOf(argument, home, facts.workingDirectory, facts.isDocument),
    );
  if (named.some((path) => path !== undefined && facts.isDocument(path)))
    return { argv, opens: { kind: "captured" } };
  const [document] = documents;
  if (document === undefined) return { argv, opens: { kind: "empty" } };
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
    argv: [...argv, `${home}/${document}`],
    opens: { kind: "seed", document },
  };
};
