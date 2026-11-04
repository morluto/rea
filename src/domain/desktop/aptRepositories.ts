/** One `deb` entry of an apt sources file for one URI and suite. */
export interface AptSourceEntry {
  readonly file: string;
  /** Without trailing slashes, as `apt-cache policy` prints it. */
  readonly uri: string;
  readonly suite: string;
  /** Empty for a flat repository, whose suite is a path ending in `/`. */
  readonly components: readonly string[];
  readonly architectures: readonly string[];
  /** Keyring paths and key fingerprints the entry is signed by. */
  readonly signedBy: readonly string[];
  /** Whether Signed-By holds a key block rather than paths or fingerprints. */
  readonly inlineKey: boolean;
}

const ARMOR_BEGIN = "-----BEGIN PGP PUBLIC KEY BLOCK-----";
const ARMOR_END = "-----END PGP PUBLIC KEY BLOCK-----";

const listValues = (value: string | undefined): readonly string[] =>
  (value ?? "").split(/[\s,]+/u).filter((part) => part.length > 0);

const entries = (
  file: string,
  fields: {
    readonly uris: readonly string[];
    readonly suites: readonly string[];
    readonly components: readonly string[];
    readonly options: ReadonlyMap<string, string>;
  },
): AptSourceEntry[] => {
  const signedBy = fields.options.get("signed-by") ?? "";
  const inlineKey = signedBy.includes(ARMOR_BEGIN);
  return fields.uris.flatMap((uri) =>
    fields.suites.map((suite) => ({
      file,
      uri: uri.replace(/\/+$/u, ""),
      suite,
      components: suite.endsWith("/") ? [] : [...fields.components],
      architectures: listValues(fields.options.get("arch")),
      signedBy: inlineKey ? [] : listValues(signedBy),
      inlineKey,
    })),
  );
};

const ONE_LINE =
  /^deb(?:\s+\[(?<options>[^\]]*)\])?\s+(?<uri>\S+)\s+(?<suite>\S+)(?<components>(?:\s+\S+)*)\s*$/u;

/** The `deb` entries of a one-line `sources.list` file; `deb-src` lines and comments are skipped. */
export const parseOneLineSources = (
  text: string,
  file: string,
): readonly AptSourceEntry[] =>
  text.split("\n").flatMap((line) => {
    const groups = ONE_LINE.exec(line.replace(/#.*$/u, "").trim())?.groups;
    if (groups?.uri === undefined || groups.suite === undefined) return [];
    const options = new Map(
      (groups.options ?? "").split(/\s+/u).flatMap((option) => {
        const equals = option.indexOf("=");
        return equals > 0
          ? [[option.slice(0, equals), option.slice(equals + 1)] as const]
          : [];
      }),
    );
    return entries(file, {
      uris: [groups.uri],
      suites: [groups.suite],
      components: listValues(groups.components),
      options,
    });
  });

/** Fields of one deb822 paragraph by lowercase name; continuation lines keep their line breaks. */
const paragraphs = (text: string): ReadonlyMap<string, string>[] => {
  const found: Map<string, string>[] = [];
  let current = new Map<string, string>();
  let last: string | undefined;
  for (const line of [...text.split("\n"), ""]) {
    if (line.trim().length === 0) {
      if (current.size > 0) found.push(current);
      current = new Map();
      last = undefined;
    } else if (line.startsWith("#")) continue;
    else if (/^[ \t]/u.test(line) && last !== undefined)
      current.set(last, `${current.get(last) ?? ""}\n${line.trim()}`);
    else {
      const colon = line.indexOf(":");
      if (colon <= 0) continue;
      last = line.slice(0, colon).trim().toLowerCase();
      current.set(last, line.slice(colon + 1).trim());
    }
  }
  return found;
};

/** The `deb` entries of a deb822 `.sources` file; disabled paragraphs are skipped. */
export const parseDeb822Sources = (
  text: string,
  file: string,
): readonly AptSourceEntry[] =>
  paragraphs(text).flatMap((fields) => {
    if (
      !listValues(fields.get("types")).includes("deb") ||
      fields.get("enabled")?.toLowerCase() === "no"
    )
      return [];
    return entries(file, {
      uris: listValues(fields.get("uris")),
      suites: listValues(fields.get("suites")),
      components: listValues(fields.get("components")),
      options: new Map([
        ["signed-by", fields.get("signed-by") ?? ""],
        ["arch", fields.get("architectures") ?? ""],
      ]),
    });
  });

/**
 * The entry a source from `apt-cache policy` comes from: `<uri> <suite>/<component> <arch> Packages`,
 * or `<uri> <suite> Packages` for a flat repository.
 */
export const sourceEntryFor = (
  source: string,
  candidates: readonly AptSourceEntry[],
): AptSourceEntry | undefined =>
  candidates.find(({ uri, suite, components }) =>
    components.length === 0
      ? source.startsWith(`${uri} ${suite} `)
      : components.some((component) =>
          source.startsWith(`${uri} ${suite}/${component} `),
        ),
  );

const QUOTED = new Set('\\|{}[]<>"^~_=!@#$%^&*');

/** apt's file name for a URI in its lists directory: no scheme or credentials, special characters quoted, `/` as `_`. */
export const aptListFileName = (uri: string): string => {
  const path = uri
    .replace(/^[a-z][a-z0-9+.-]*:\/\//iu, "")
    .replace(/^[^/@]*@/u, "");
  let quoted = "";
  for (const character of path) {
    const code = character.codePointAt(0) ?? 0;
    quoted +=
      QUOTED.has(character) || code <= 0x20 || code >= 0x7f
        ? [...Buffer.from(character, "utf8")]
            .map((byte) => `%${byte.toString(16).padStart(2, "0")}`)
            .join("")
        : character;
  }
  return quoted.replaceAll("/", "_");
};

/** The lists-directory prefix of an entry's release files: append `InRelease`, `Release` or `Release.gpg`. */
export const aptReleaseFilePrefix = (entry: AptSourceEntry): string =>
  aptListFileName(
    entry.components.length === 0
      ? `${entry.uri}/${entry.suite}`
      : `${entry.uri}/dists/${entry.suite}/`,
  );

/** The primary key fingerprint of a good signature in `gpgv --status-fd` output. */
export const validSignatureFingerprint = (
  status: string,
): string | undefined => {
  for (const line of status.split("\n")) {
    const fields = /^\[GNUPG:\] VALIDSIG (?<fields>.+)$/u
      .exec(line.trim())
      ?.groups?.fields?.split(" ");
    if (fields !== undefined) return fields[9] ?? fields[0];
  }
  return undefined;
};

/** Whether a key file holds an ASCII-armored key, by content as agentenv decides it. */
export const isArmoredKey = (bytes: Uint8Array): boolean =>
  Buffer.from(bytes).toString("latin1").trimStart().startsWith(ARMOR_BEGIN);

/** The binary keyring an ASCII-armored key file decodes to, or undefined when it holds no key block. */
export const dearmorPublicKeys = (bytes: Uint8Array): Buffer | undefined => {
  const blocks: Buffer[] = [];
  let state: "outside" | "headers" | "body" = "outside";
  let body = "";
  for (const raw of Buffer.from(bytes).toString("latin1").split("\n")) {
    const line = raw.trim();
    if (state === "outside") {
      if (line === ARMOR_BEGIN) [state, body] = ["headers", ""];
    } else if (line === ARMOR_END) {
      blocks.push(Buffer.from(body, "base64"));
      state = "outside";
    } else if (state === "headers") {
      if (line.length === 0 || !line.includes(":")) state = "body";
      if (!line.includes(":")) body += line;
    } else if (!/^=[A-Za-z0-9+/]{4}$/u.test(line)) body += line;
  }
  const keyring = Buffer.concat(blocks);
  return keyring.length === 0 ? undefined : keyring;
};
