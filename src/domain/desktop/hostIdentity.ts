/** The capture host's identity, which captured state can hold and a shared bundle must not. */
export interface HostIdentity {
  readonly home: string;
  /** Null when the capture did not record it. */
  readonly hostname: string | null;
  readonly user: string | null;
}

/** The home the seed spells, which the computer respells to its own at boot; the computer's user is `user`. */
export const SEED_HOME = "/home/user";
const SEED_HOST = "localhost";
const SEED_LOGIN = `user@${SEED_HOST}`;

/** Seeds up to this size are decoded and rewritten, well inside a JavaScript string; a larger one is only searched. */
const MAX_SCRUBBED_BYTES = 256 * 1024 * 1024;
const WORD = String.raw`\p{L}\p{N}_`;
/** A host name ends where no name character or `.name` follows, so `host.example.com` is left whole. */
const HOST_END = String.raw`(?![${WORD}-]|\.[${WORD}])`;

const escaped = (text: string): string =>
  text.replace(/[\\^$.*+?()[\]{}|/]/gu, "\\$&");

/** Whether a home is one the bundle must not spell: not the root, and not the seed's own. */
const hidden = (home: string): boolean => home.length > 1 && home !== SEED_HOME;

/**
 * The identity's spellings: the home path where a whole path segment ends
 * after it, as the computer respells it at boot; `user@host`; and the host
 * name as a whole name. The user name alone is never matched, since a short
 * one such as `ada` is also ordinary text.
 */
const identityPattern = ({
  home,
  hostname,
  user,
}: HostIdentity): RegExp | undefined => {
  const host =
    hostname === null || hostname === SEED_HOST ? undefined : escaped(hostname);
  const alternatives = [
    ...(hidden(home)
      ? [String.raw`(?<home>${escaped(home)})(?![${WORD}.@+~-])`]
      : []),
    ...(host === undefined || user === null
      ? []
      : [
          String.raw`(?<![${WORD}.+-])(?<login>${escaped(user)}@${host})${HOST_END}`,
        ]),
    ...(host === undefined
      ? []
      : [String.raw`(?<![${WORD}.-])(?<host>${host})${HOST_END}`]),
  ];
  return alternatives.length === 0
    ? undefined
    : new RegExp(alternatives.join("|"), "gu");
};

/** The text with the identity replaced: `/home/user` for the home, `user@localhost` and `localhost` for the host. */
export const scrubHostIdentity = (
  text: string,
  identity: HostIdentity,
): string => {
  const pattern = identityPattern(identity);
  return pattern === undefined
    ? text
    : text.replace(pattern, (...match: unknown[]) => {
        const groups = match.at(-1) as Record<string, string | undefined>;
        if (groups.home !== undefined) return SEED_HOME;
        return groups.login === undefined ? SEED_HOST : SEED_LOGIN;
      });
};

/** The first spelling of the identity a text holds, or undefined. */
export const hostIdentityIn = (
  text: string,
  identity: HostIdentity,
): string | undefined => identityPattern(identity)?.exec(text)?.[0];

/** What the export ships for one seed. */
export interface SeedScrub {
  /** The rewritten bytes, or undefined when the seed ships as captured. */
  readonly bytes: Buffer | undefined;
  /** Whether the shipped bytes still hold the host name or the captured home, as in a binary file or `host.local`. */
  readonly holdsIdentity: boolean;
}

const UTF16_MARKS = [
  { mark: [0xff, 0xfe], swap: false },
  { mark: [0xfe, 0xff], swap: true },
] as const;

/** UTF-16 text after a byte-order mark, decoded and encoded as the computer's boot respelling does; undefined otherwise. */
const utf16Text = (
  bytes: Buffer,
):
  | { readonly text: string; readonly encode: (text: string) => Buffer }
  | undefined => {
  const order = UTF16_MARKS.find(({ mark }) =>
    mark.every((byte, index) => bytes[index] === byte),
  );
  if (order === undefined) return undefined;
  const little = Buffer.from(bytes.subarray(2));
  if (order.swap && little.length % 2 === 0) little.swap16();
  try {
    const text = new TextDecoder("utf-16le", { fatal: true }).decode(little);
    return {
      text,
      encode: (scrubbed) => {
        const encoded = Buffer.from(scrubbed, "utf16le");
        if (order.swap) encoded.swap16();
        return Buffer.concat([Buffer.from(order.mark), encoded]);
      },
    };
  } catch {
    return undefined;
  }
};

/** The seed's text and how to encode it again: UTF-8 for a text seed, or UTF-16 after a byte-order mark. */
const seedText = (bytes: Buffer, text: boolean) => {
  if (bytes.length > MAX_SCRUBBED_BYTES) return undefined;
  if (!text) return utf16Text(bytes);
  try {
    return {
      // The byte-order mark is kept, as Python's utf-8 codec keeps it.
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes,
      ),
      encode: (scrubbed: string) => Buffer.from(scrubbed, "utf8"),
    };
  } catch {
    return undefined;
  }
};

/** Whether text, or bytes read as UTF-8, hold the captured home or the host name, which `user@host` contains, anywhere. */
const holdsIdentity = (
  content: string | Buffer,
  { home, hostname }: HostIdentity,
) =>
  [hidden(home) ? home : null, hostname === SEED_HOST ? null : hostname].some(
    (value) => value !== null && content.includes(value),
  );

/**
 * Rewrite a seed's text as the computer reads it at boot: a text seed as
 * UTF-8, another as UTF-16 when it starts with a byte-order mark. Other bytes
 * ship as captured. Either way the shipped bytes are searched for what is left.
 */
export const scrubSeed = (
  bytes: Buffer,
  text: boolean,
  identity: HostIdentity,
): SeedScrub => {
  const decoded = seedText(bytes, text);
  const scrubbed =
    decoded === undefined
      ? undefined
      : scrubHostIdentity(decoded.text, identity);
  const rewritten =
    decoded === undefined || scrubbed === decoded.text
      ? undefined
      : decoded.encode(scrubbed ?? "");
  return {
    bytes: rewritten,
    holdsIdentity: holdsIdentity(scrubbed ?? bytes, identity),
  };
};
