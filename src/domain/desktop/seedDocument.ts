import { execTakesFiles } from "./desktopEntry.js";

/** What the exported app opens at launch. */
export type LaunchDocument =
  /** The seed's one document, by home path. */
  | { readonly kind: "seed"; readonly document: string }
  /** The file under the home the captured command already names. */
  | { readonly kind: "captured" }
  /** Nothing, since the seed holds no document. */
  | { readonly kind: "empty" }
  /** No document, for the reason given, which follows "since". */
  | { readonly kind: "none"; readonly reason: string };

/**
 * The launch arguments, with the seed's document appended when the seed holds
 * exactly one and the desktop entry's `Exec` takes a file, so the app opens on
 * it rather than on its start screen. A command that already names a file
 * under the home is kept as it is.
 */
export const openSeedDocument = (
  argv: readonly string[],
  facts: {
    readonly home: string;
    readonly exec: string | null;
    readonly documents: readonly string[];
  },
): { readonly argv: readonly string[]; readonly opens: LaunchDocument } => {
  const { home, exec, documents } = facts;
  const none = (reason: string) => ({
    argv,
    opens: { kind: "none", reason } as const,
  });
  if (argv.slice(1).some((argument) => argument.startsWith(`${home}/`)))
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
