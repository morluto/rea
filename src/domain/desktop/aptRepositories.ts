import type { AptRepository } from "./desktopCapture.js";
import { byteToHex } from "../../kernel/byteToHex.js";
import { err, ok, type Result } from "../result.js";
import { isStrictUtf8 } from "../strictUtf8.js";

/**
 * One `deb` line, or one deb822 stanza, of an apt sources file. A stanza's
 * URIs and suites stay lists: apt reads every pair of them, and expanding
 * the pairs would let a 1 MiB file make millions of entries.
 */
export interface AptSourceStanza {
  readonly file: string;
  /** apt's number for the entry: a one-line entry's line, a deb822 entry's stanza, counted from 1. */
  readonly position: number;
  readonly format: "one-line" | "deb822";
  readonly uris: readonly AptSourceUri[];
  readonly suites: readonly string[];
  readonly components: readonly string[];
  readonly architectures: readonly string[];
  /** Keyring paths and key fingerprints the entry is signed by. */
  readonly signedBy: readonly string[];
  /** The armored key block Signed-By holds in place of paths or fingerprints; null when it holds none. */
  readonly inlineKey: string | null;
}

interface AptSourceUri {
  /** The authored URI without credentials, or null when their boundary is unclear. */
  readonly uri: string | null;
  readonly credentials: boolean;
}

/** One `deb` entry of an apt sources file for one URI and suite. */
export interface AptSourceEntry extends Omit<
  AptSourceStanza,
  "uris" | "suites" | "format"
> {
  readonly uri: string | null;
  /** Whether the entry's URI held a user name or password, which `uri` leaves out. */
  readonly credentials: boolean;
  readonly suite: string;
  /** Empty for a flat repository, whose suite is a path ending in `/`. */
  readonly components: readonly string[];
}

const ARMOR_BEGIN = "-----BEGIN PGP PUBLIC KEY BLOCK-----";
const ARMOR_END = "-----END PGP PUBLIC KEY BLOCK-----";

/** Source fields separate words with whitespace; commas remain URI/name data. */
const fieldValues = (value: string | undefined): readonly string[] =>
  (value ?? "").split(/\s+/u).filter((part) => part.length > 0);

/** Architecture and Signed-By options also admit comma-separated values. */
const optionValues = (value: string | undefined): readonly string[] =>
  (value ?? "").split(/[\s,]+/u).filter((part) => part.length > 0);

/** Keep redundant path separators that APT preserves in Repo-URI. */
const withoutOptionalTrailingSlash = (uri: string): string =>
  uri.replace(/(?<!\/)\/$/u, "");

// APT decodes one-line URI escapes before separating userinfo. A slash,
// even when escaped, ends the authority.
const ONE_LINE_ESCAPED_USER_INFO =
  /^[a-z][a-z0-9+.-]*:\/\/(?:(?!%2f)[^/])*%40/iu;

/** A URI's user name and password: up to the last `@` before its path, as apt reads them. */
const USER_INFO = /^(?<scheme>[a-z][a-z0-9+.-]*:\/\/)[^/]*@/iu;

/** A URI without the user name and password it may hold before its host. */
export const withoutCredentials = (uri: string): string =>
  uri.replace(USER_INFO, "$<scheme>");

/** A line of apt's output with every URI in it stripped of a user name and password, whether or not apt printed them. */
export const withoutCredentialsIn = (text: string): string =>
  text.replace(/(?<scheme>[a-z][a-z0-9+.-]*:\/\/)[^\s/]*@/giu, "$<scheme>");

const withTrailingSlash = (uri: string): string =>
  uri.endsWith("/") ? uri : `${uri}/`;

const EMPTY_AUTHORITY = /^([a-z][a-z0-9+.-]*:)\/\/(?=\/)/iu;
const NUMERIC_PORT =
  /^([a-z][a-z0-9+.-]*:\/\/(?:\[[^\]]+\]|[^/:]+)):([0-9]+)(?=\/|$)/iu;

/** APT fixes up deb822 URIs before emitting Repo-URI, leaving path octets intact. */
const deb822RepoUri = (uri: string): string =>
  withTrailingSlash(
    uri
      .replace(EMPTY_AUTHORITY, "$1")
      .replace(NUMERIC_PORT, (_match, authority: string, port: string) => {
        const digits = port.replace(/^0+/u, "");
        return digits === "" ? authority : `${authority}:${digits}`;
      }),
  );

/**
 * The key block a deb822 Signed-By field holds, as apt writes it to a key
 * file: each line stripped and a `.` line made empty, from its BEGIN line to
 * its last END line; null when the field holds no key block.
 */
const inlineKeyBlock = (value: string): string | null => {
  if (!value.includes(ARMOR_BEGIN)) return null;
  const lines = value.split("\n").map((line) => {
    const stripped = line.trim();
    return stripped === "." ? "" : stripped;
  });
  const begin = Math.max(lines.indexOf(ARMOR_BEGIN), 0);
  const end = lines.lastIndexOf(ARMOR_END);
  return `${lines.slice(begin, end < begin ? lines.length : end + 1).join("\n")}\n`;
};

/** Match the selected release without changing an authored suite. */
const isRelease = (suite: string, target: AptIndexTarget): boolean => {
  const architectureVariable = "$(ARCH)";
  if (suite.includes(architectureVariable)) {
    if (target.configuredArchitecture === undefined) return false;
    suite = suite.replaceAll(
      architectureVariable,
      target.configuredArchitecture,
    );
  }
  return suite === target.release || (suite === "/" && target.release === "");
};

const stanza = (
  at: { readonly file: string; readonly position: number },
  fields: {
    readonly uris: readonly string[];
    readonly suites: readonly string[];
    readonly components: readonly string[];
    readonly options: ReadonlyMap<string, string>;
    readonly oneLine?: true;
  },
): AptSourceStanza => {
  const signedBy = fields.options.get("signed-by") ?? "";
  const inlineKey = inlineKeyBlock(signedBy);
  return {
    ...at,
    format: fields.oneLine === true ? "one-line" : "deb822",
    uris: fields.uris.map((source) => {
      const uri = withoutCredentials(source);
      return fields.oneLine === true && ONE_LINE_ESCAPED_USER_INFO.test(uri)
        ? { uri: null, credentials: true }
        : { uri, credentials: source !== uri };
    }),
    suites: fields.suites,
    components: fields.components,
    architectures: optionValues(fields.options.get("arch")),
    signedBy: inlineKey === null ? optionValues(signedBy) : [],
    inlineKey,
  };
};

/** Keep the position of undecodable lines without inserting replacement text. */
function* sourceLines(text: string | Buffer): Generator<string | undefined> {
  if (typeof text === "string") {
    yield* text.split("\n");
    return;
  }
  for (let start = 0; start <= text.length;) {
    const end = text.indexOf(0x0a, start);
    const line = text.subarray(start, end === -1 ? text.length : end);
    // APT ignores the whole comment after its ASCII marker, even if its
    // bytes do not decode. Keep it distinct from a blank line or an entry.
    if (line[0] === 0x23) yield "#";
    else yield isStrictUtf8(line) ? line.toString("utf8") : undefined;
    if (end === -1) break;
    start = end + 1;
  }
}

const ONE_LINE =
  /^deb(?:\s+\[(?<options>[^\]]*)\])?\s+(?<uri>\S+)\s+(?<suite>\S+)(?<components>(?:\s+\S+)*)\s*$/u;

/** The `deb` lines of a one-line `sources.list` file; `deb-src` lines and comments are skipped. */
export const parseOneLineSources = (
  text: string | Buffer,
  file: string,
): readonly AptSourceStanza[] =>
  [...sourceLines(text)].flatMap((line, index) => {
    if (line === undefined) return [];
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
    return [
      stanza(
        { file, position: index + 1 },
        {
          uris: [groups.uri],
          suites: [groups.suite],
          components: fieldValues(groups.components),
          options,
          oneLine: true,
        },
      ),
    ];
  });

/** Fields of each deb822 paragraph by lowercase name; continuation lines keep their line breaks. */
export const deb822Paragraphs = (
  text: string | Buffer,
): ReadonlyMap<string, string>[] => {
  const found: Map<string, string>[] = [];
  let current = new Map<string, string>();
  let last: string | undefined;
  let readable = true;
  const finish = () => {
    // A sources-file stanza's position still counts when it cannot be read.
    if (!readable) found.push(new Map());
    else if (current.size > 0) found.push(current);
    current = new Map();
    last = undefined;
    readable = true;
  };
  for (const line of sourceLines(text)) {
    if (line === undefined) {
      readable = false;
    } else if (line.trim().length === 0) {
      finish();
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
  finish();
  return found;
};

/** The `deb` stanzas of a deb822 `.sources` file; disabled paragraphs are skipped but still counted. */
export const parseDeb822Sources = (
  text: string | Buffer,
  file: string,
): readonly AptSourceStanza[] =>
  deb822Paragraphs(text).flatMap((fields, index) => {
    if (
      !fieldValues(fields.get("types")).includes("deb") ||
      fields.get("enabled")?.toLowerCase() === "no"
    )
      return [];
    return [
      stanza(
        { file, position: index + 1 },
        {
          uris: fieldValues(fields.get("uris")),
          suites: fieldValues(fields.get("suites")),
          components: fieldValues(fields.get("components")),
          options: new Map([
            ["signed-by", fields.get("signed-by") ?? ""],
            ["arch", fields.get("architectures") ?? ""],
          ]),
        },
      ),
    ];
  });

/** One index `apt-get indextargets` lists, with the release facts apt read for it. */
export interface AptIndexTarget {
  /** The index as `apt-cache policy` prints it. */
  readonly description: string;
  /** The sources file and position of the entry apt read it from. */
  readonly sourcesFile: string;
  readonly position: number;
  /** Without a user name or password, as `baseUri`, whether or not apt printed them. */
  readonly repoUri: string;
  readonly repoUriCredentialsRemoved?: true;
  /** APT's selected suite after variable expansion; empty for the flat suite `/`. */
  readonly release: string;
  /** Effective APT::Architecture from apt-config, distinct from an index's architecture. */
  readonly configuredArchitecture?: string;
  /** The entry's component the index belongs to; null for a flat repository. */
  readonly component: string | null;
  /** The URI of the folder holding the release's InRelease, Release and Release.gpg. */
  readonly baseUri: string;
  /** The index file in apt's lists folder, where the release files are too. */
  readonly filename: string;
  readonly origin: string | null;
  /** The release's Suite (apt's `a=`) and Codename (`n=`). */
  readonly suite: string | null;
  readonly codename: string | null;
}

const SOURCES_ENTRY = /^(?<file>\/.*):(?<position>[1-9]\d*)$/u;

/** The index targets of `apt-get indextargets` output; a paragraph missing a field REA needs is skipped. */
export const parseAptIndexTargets = (
  output: string | Buffer,
  configuredArchitecture?: string,
): readonly AptIndexTarget[] =>
  deb822Paragraphs(output).flatMap((fields) => {
    const at = SOURCES_ENTRY.exec(fields.get("sourcesentry") ?? "")?.groups;
    const description = fields.get("description");
    const repoUri = fields.get("repo-uri");
    const baseUri = fields.get("base-uri");
    const filename = fields.get("filename");
    if (
      at?.file === undefined ||
      at.position === undefined ||
      description === undefined ||
      !repoUri ||
      baseUri === undefined ||
      filename?.startsWith("/") !== true
    )
      return [];
    const optional = (name: string) => fields.get(name) || null;
    const sanitizedRepoUri = withoutCredentials(repoUri);
    return [
      {
        description: withoutCredentialsIn(description),
        sourcesFile: at.file,
        position: Number(at.position),
        repoUri: sanitizedRepoUri,
        ...(sanitizedRepoUri === repoUri
          ? {}
          : { repoUriCredentialsRemoved: true as const }),
        release: fields.get("release") ?? "",
        ...(configuredArchitecture === undefined
          ? {}
          : { configuredArchitecture }),
        component: optional("component"),
        baseUri: withoutCredentials(baseUri),
        filename,
        origin: optional("origin"),
        suite: optional("suite"),
        codename: optional("codename"),
      },
    ];
  });

/**
 * The sources entry an index target comes from: the stanza at its file and
 * position, with its URI and suite when the stanza lists several.
 */
export const entryForTarget = (
  target: AptIndexTarget,
  stanzas: readonly AptSourceStanza[],
): AptSourceEntry | undefined => {
  const at = stanzas.find(
    (candidate) =>
      candidate.file === target.sourcesFile &&
      candidate.position === target.position,
  );
  if (at === undefined) return undefined;
  const { uris, suites, format, ...entry } = at;
  const single = format === "one-line";
  // A one-line entry has one URI and one suite. Only deb822 needs a URI lookup.
  const matches = single
    ? uris
    : uris.filter(
        ({ uri }) => uri !== null && deb822RepoUri(uri) === target.repoUri,
      );
  const first = matches[0];
  if (first === undefined) return undefined;
  const uri =
    first.uri === null ? null : withoutOptionalTrailingSlash(first.uri);
  const suite = single
    ? suites[0]
    : suites.find((listed) => isRelease(listed, target));
  if (
    suite === undefined ||
    matches.some(({ uri: listed }) =>
      listed === null
        ? uri !== null
        : withoutOptionalTrailingSlash(listed) !== uri,
    )
  )
    return undefined;
  return {
    ...entry,
    uri,
    credentials: matches.some((listed) => listed.credentials),
    suite,
    components: suite.endsWith("/") ? [] : entry.components,
  };
};

type ReplayRepository = Pick<
  AptRepository,
  "uri" | "repo_uri" | "uri_credentials_removed"
> &
  Partial<Pick<AptRepository, "sources_file">>;

type RepositoryDeclaration = ReplayRepository &
  Pick<AptRepository, "source" | "suite" | "components">;

const oneLineSource = (repository: ReplayRepository): boolean =>
  repository.sources_file?.endsWith(".sources") !== true;

/** Detect credentials left in a legacy or externally supplied capture. */
export const aptRepositoryHoldsCredentials = (
  repository: ReplayRepository,
): boolean => {
  const { uri, repo_uri } = repository;
  return (
    (uri !== null &&
      (withoutCredentials(uri) !== uri ||
        (oneLineSource(repository) && ONE_LINE_ESCAPED_USER_INFO.test(uri)))) ||
    (repo_uri !== undefined && withoutCredentials(repo_uri) !== repo_uri)
  );
};

type AptReplayRefusal = {
  readonly kind: "credentials" | "uri";
  readonly reason: string;
};

const httpSourceUri = (uri: string): boolean => /^https?:\/\/[^/]+/u.test(uri);
const isDeb822UriToken = (uri: string): boolean =>
  !/[\s\p{Cc}]/u.test(uri) && !uri.includes("$(ARCH)");

/** Admit one AgentEnv deb822 URI and the APT Repo-URI it reproduces. */
export const aptRepositoryReplayUri = (
  repository: ReplayRepository,
): Result<
  { readonly uri: string; readonly repoUri: string },
  AptReplayRefusal
> => {
  if (
    repository.uri_credentials_removed === true ||
    aptRepositoryHoldsCredentials(repository)
  )
    return err({
      kind: "credentials",
      reason:
        "its sources entry's URI held a user name or password, which REA neither records nor exports",
    });
  const { uri, repo_uri: observed } = repository;
  if (uri === null)
    return err({ kind: "uri", reason: "no apt sources entry configures it" });
  if (
    !httpSourceUri(uri) ||
    (observed !== undefined && !httpSourceUri(observed))
  )
    return err({
      kind: "uri",
      reason: "agentenv installs apt repositories over http or https only",
    });

  const oneLine = oneLineSource(repository);
  // A one-line escape can break the indextargets field before REA reads it.
  if (oneLine && /%(?:0[0-9a-f]|1[0-9a-f]|7f)/iu.test(uri))
    return err({
      kind: "uri",
      reason:
        "its one-line URI contains an escaped control byte, so apt's index URI cannot be established",
    });
  if (observed === undefined && oneLine && /%[0-9a-f]{2}/iu.test(uri))
    return err({
      kind: "uri",
      reason:
        "its one-line URI has percent escapes and the capture does not record apt's Repo-URI. Capture the application again",
    });

  const repoUri = observed ?? deb822RepoUri(uri);
  const declaration =
    deb822RepoUri(uri) === repoUri && isDeb822UriToken(uri)
      ? uri
      : withoutOptionalTrailingSlash(repoUri);
  if (!isDeb822UriToken(declaration) || deb822RepoUri(declaration) !== repoUri)
    return err({
      kind: "uri",
      reason:
        "apt's repository URI cannot be represented as one AgentEnv deb822 URI token",
    });
  return ok({ uri: declaration, repoUri });
};

/**
 * The package files, as `apt-cache policy` prints them, that apt reads once
 * these repositories are declared: every index of the same URI and suite in
 * one of their components. Check the source index against the deb822 spelling
 * used by the exported declaration, since APT reads .list URI tokens differently.
 */
export const declaredPackageFiles = (
  repositories: readonly RepositoryDeclaration[],
  targets: ReadonlyMap<string, AptIndexTarget>,
): ReadonlySet<string> => {
  const declarations = repositories.flatMap((repository) => {
    const observed = targets.get(repository.source);
    const replay = aptRepositoryReplayUri(repository);
    return !replay.ok ||
      observed?.repoUri !== replay.value.repoUri ||
      repository.suite === null
      ? []
      : [
          {
            ...repository,
            repoUri: replay.value.repoUri,
            suite: repository.suite,
          },
        ];
  });
  const files = new Set<string>();
  for (const target of targets.values()) {
    if (
      declarations.some(
        ({ repoUri, suite, components }) =>
          repoUri === target.repoUri &&
          isRelease(suite, target) &&
          (target.component === null
            ? components.length === 0
            : components.includes(target.component)),
      )
    )
      files.add(target.description);
  }
  return files;
};

/** The packages of `supplied` whose declared sources include one of the repository's package files, sorted. */
export const repositorySupplies = (
  repository: RepositoryDeclaration,
  supplied: ReadonlyMap<string, readonly string[]>,
  targets: ReadonlyMap<string, AptIndexTarget>,
): readonly string[] => {
  const files = declaredPackageFiles([repository], targets);
  return [...supplied]
    .filter(([, sources]) => sources.some((source) => files.has(source)))
    .map(([name]) => name)
    .sort();
};

/** The `NAME='value'` assignments `apt-config shell` prints; apt writes a quote in a value as `'\''`. */
export const parseAptConfigShell = (
  output: string,
): ReadonlyMap<string, string> => {
  const values = new Map<string, string>();
  const prefix = /([A-Za-z_]\w*)='/uy;
  let offset = 0;
  while (offset < output.length) {
    prefix.lastIndex = offset;
    const match = prefix.exec(output);
    if (match === null) {
      const newline = output.indexOf("\n", offset);
      if (newline < 0) break;
      offset = newline + 1;
      continue;
    }
    const start = prefix.lastIndex;
    let end = output.indexOf("'", start);
    // Only apt's close/escaped-quote/reopen sequence continues the value.
    // Literal newlines inside the quotes are data, not record boundaries.
    while (end >= 0 && output.startsWith(`'\\''`, end))
      end = output.indexOf("'", end + 4);
    if (end < 0) break;
    const after = end + 1;
    if (after === output.length || output[after] === "\n")
      values.set(match[1]!, output.slice(start, end).replaceAll(`'\\''`, "'"));
    const newline = output.indexOf("\n", after);
    if (newline < 0) break;
    offset = newline + 1;
  }
  return values;
};

const QUOTED = new Set('\\|{}[]<>"^~_=!@#$%^&*');

/** apt's file name for a URI in its lists directory: no scheme or credentials, special characters quoted, `/` as `_`. */
export const aptListFileName = (uri: string): string => {
  const path = uri
    .replace(/^[a-z][a-z0-9+.-]*:(?:\/\/)?/iu, "")
    .replace(/^[^/@]*@/u, "")
    // APT removes authority brackets before encoding the path for the cache.
    .replace(/^\[([^\]]+)\](?=[:/]|$)/u, "$1");
  let quoted = "";
  for (const character of path) {
    const code = character.codePointAt(0) ?? 0;
    quoted +=
      QUOTED.has(character) || code <= 0x20 || code >= 0x7f
        ? [...Buffer.from(character, "utf8")]
            .map((byte) => `%${byteToHex(byte)}`)
            .join("")
        : character;
  }
  return quoted.replaceAll("/", "_");
};

/** Ubuntu Pro's ESM repositories, which apt reaches only with the host's Ubuntu Pro credentials. */
export const isUbuntuProRepository = (
  origin: string | null,
  uri: string | null,
): boolean =>
  (origin ?? "").startsWith("UbuntuESM") ||
  /^https?:\/\/esm\.ubuntu\.com(?:[/:]|$)/iu.test(uri ?? "");

/** A good signature's signing and primary key fingerprints, uppercase. */
export interface ValidSignature {
  readonly signing: string;
  readonly primary: string;
}

const UNTRUSTED_SIGNATURE =
  /^\[GNUPG:\] (?:BADSIG|EXPSIG|EXPKEYSIG|REVKEYSIG|ERRSIG) (?<key>[0-9A-Fa-f]+)(?: |$)/u;

/**
 * The first VALIDSIG in `gpgv --status-fd` output whose key no bad, expired,
 * revoked or unverifiable signature names. gpgv's exit status is not used: a
 * release also signed by a key the keyring lacks makes gpgv fail.
 */
export const validSignature = (status: string): ValidSignature | undefined => {
  const lines = status.split("\n").map((line) => line.trim());
  const untrusted = lines.flatMap((line) => {
    const key = UNTRUSTED_SIGNATURE.exec(line)?.groups?.key;
    return key === undefined ? [] : [key.toUpperCase()];
  });
  const names = (fingerprint: string, key: string) =>
    fingerprint.startsWith(key) || fingerprint.endsWith(key);
  for (const line of lines) {
    const fields = /^\[GNUPG:\] VALIDSIG (?<fields>.+)$/u
      .exec(line)
      ?.groups?.fields?.split(" ");
    const signing = fields?.[0]?.toUpperCase();
    if (signing === undefined) continue;
    const primary = (fields?.[9] ?? signing).toUpperCase();
    if (!untrusted.some((key) => names(signing, key) || names(primary, key)))
      return { signing, primary };
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
