/** One DER element's tag and where its content starts and ends. */
interface DerElement {
  readonly tag: number;
  readonly start: number;
  readonly end: number;
}

/** The element at `at`, or undefined when its header does not fit; a lenient read lets its content run past what `bytes` holds. */
const elementAt = (bytes: Uint8Array, at: number): DerElement | undefined => {
  const tag = bytes[at];
  const first = bytes[at + 1];
  if (tag === undefined || first === undefined) return undefined;
  if (first < 0x80) return { tag, start: at + 2, end: at + 2 + first };
  const count = first & 0x7f;
  if (count === 0 || count > 3) return undefined;
  let length = 0;
  for (let index = 0; index < count; index += 1) {
    const byte = bytes[at + 2 + index];
    if (byte === undefined) return undefined;
    length = length * 256 + byte;
  }
  if (length < 0x80) return undefined;
  return { tag, start: at + 2 + count, end: at + 2 + count + length };
};

const hex = (bytes: Uint8Array, element: DerElement) =>
  Buffer.from(bytes.subarray(element.start, element.end)).toString("hex");

/** The algorithm identifiers of private keys, by their DER content, or the start of it for a family. */
const KEY_ALGORITHMS = [
  "2a864886f70d010101",
  "2a864886f70d01010a",
  "2a8648ce3d0201",
  "2a8648ce380401",
  "2a864886f70d010301",
  "2b656e",
  "2b656f",
  "2b6570",
  "2b6571",
  "6086480165030403",
  "6086480165030404",
];
/** The algorithm identifiers that encrypt a private key, exactly: PKCS #5 PBES1 and PBES2 and PKCS #12 password-based encryption, never PBKDF2 or PBMAC1. */
const ENCRYPTION_ALGORITHMS = [
  "2a864886f70d010501",
  "2a864886f70d010503",
  "2a864886f70d010504",
  "2a864886f70d010506",
  "2a864886f70d01050a",
  "2a864886f70d01050b",
  "2a864886f70d01050d",
  "2a864886f70d010c0101",
  "2a864886f70d010c0102",
  "2a864886f70d010c0103",
  "2a864886f70d010c0104",
  "2a864886f70d010c0105",
  "2a864886f70d010c0106",
];
/** The fewest bytes an encrypted key's encryptedData holds: the smallest PrivateKeyInfo, an X25519 or Ed25519 key's 48 bytes. */
const MIN_ENCRYPTED_KEY_BYTES = 48;

const isOneOf = (oid: string, starts: readonly string[]) =>
  starts.some((start) => oid.startsWith(start));

/** Whether the elements after a key's version, `second` first, begin PKCS #8, PKCS #1 RSA or SEC 1 EC. */
const isKeyAfterVersion = (
  bytes: Uint8Array,
  version: number | undefined,
  second: DerElement,
  fits: (element: DerElement | undefined) => element is DerElement,
): boolean => {
  if (second.tag === 0x30 && (version === 0 || version === 1)) {
    const oid = elementAt(bytes, second.start);
    return (
      fits(oid) && oid.tag === 0x06 && isOneOf(hex(bytes, oid), KEY_ALGORITHMS)
    );
  }
  const size = second.end - second.start;
  if (second.tag === 0x02 && version === 0) return size >= 64;
  return second.tag === 0x04 && version === 1 && size >= 20 && size <= 72;
};

/** Whether the encryptedData after an encrypted key's algorithm can hold a key; a partial read without its header goes by the room the outer element declares. */
const holdsEncryptedKey = (
  bytes: Uint8Array,
  outer: DerElement,
  algorithm: DerElement,
  whole: boolean,
  fits: (element: DerElement | undefined) => element is DerElement,
): boolean => {
  const data = elementAt(bytes, algorithm.end);
  if (data === undefined)
    return !whole && outer.end - algorithm.end >= 2 + MIN_ENCRYPTED_KEY_BYTES;
  return (
    fits(data) &&
    data.tag === 0x04 &&
    data.end - data.start >= MIN_ENCRYPTED_KEY_BYTES
  );
};

/** Whether DER at `at` begins a PKCS #8, PKCS #1 or SEC 1 private key, read from its first elements; `whole` asks that they fit in `bytes`. */
const isPrivateKeyAt = (
  bytes: Uint8Array,
  at: number,
  whole: boolean,
): boolean => {
  const outer = elementAt(bytes, at);
  if (outer?.tag !== 0x30 || (whole && outer.end > bytes.length)) return false;
  const fits = (element: DerElement | undefined): element is DerElement =>
    element !== undefined && (!whole || element.end <= outer.end);
  const first = elementAt(bytes, outer.start);
  if (!fits(first)) return false;
  if (first.tag === 0x30) {
    const oid = elementAt(bytes, first.start);
    return (
      fits(oid) &&
      oid.tag === 0x06 &&
      ENCRYPTION_ALGORITHMS.includes(hex(bytes, oid)) &&
      holdsEncryptedKey(bytes, outer, first, whole, fits)
    );
  }
  if (first.tag !== 0x02 || first.end - first.start !== 1) return false;
  const second = elementAt(bytes, first.end);
  return (
    fits(second) && isKeyAfterVersion(bytes, bytes[first.start], second, fits)
  );
};

/** Whether raw bytes hold a whole DER private key anywhere in them, as a key file an app writes does. */
export const holdsDerPrivateKey = (bytes: Uint8Array): boolean => {
  for (
    let at = bytes.indexOf(0x30);
    at !== -1;
    at = bytes.indexOf(0x30, at + 1)
  )
    if (isPrivateKeyAt(bytes, at, true)) return true;
  return false;
};

const LINE_BREAKS = /\r?\n|\\n|\\r\\n/gu;
/** The fewest base64 characters a private key takes: an X25519 or Ed25519 key's 48 bytes. */
const MIN_KEY_CHARACTERS = 60;
/** How many characters from a key's start are decoded to read its first elements. */
const HEADER_CHARACTERS = 64;

const isBase64Character = (character: string): boolean => {
  const code = character.charCodeAt(0);
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 43 ||
    code === 47
  );
};

/** Scan iteratively so a large encoded asset does not consume the regex stack. */
function* base64Runs(
  text: string,
): Generator<{ start: number; value: string }> {
  let cursor = 0;
  while (cursor < text.length) {
    if (!isBase64Character(text[cursor] ?? "")) {
      cursor += 1;
      continue;
    }
    const start = cursor++;
    while (cursor < text.length) {
      if (isBase64Character(text[cursor] ?? "")) cursor += 1;
      else if (text.startsWith("\\r\\n", cursor)) cursor += 4;
      else if (
        text.startsWith("\\n", cursor) ||
        text.startsWith("\r\n", cursor)
      )
        cursor += 2;
      else if (text[cursor] === "\n") cursor += 1;
      else break;
    }
    for (let padding = 0; padding < 2 && text[cursor] === "="; padding++)
      cursor += 1;
    yield { start, value: text.slice(start, cursor) };
  }
}

/** Map increasing compact offsets back to their positions in a run in one pass. */
const runIndices = (run: string) => {
  let seen = 0;
  let index = 0;
  return (count: number): number => {
    for (; index < run.length; index += 1) {
      if (run.startsWith("\\r\\n", index)) index += 3;
      else if (run.startsWith("\\n", index)) index += 1;
      else if (isBase64Character(run[index] ?? "")) {
        if (seen === count) return index;
        seen += 1;
      }
    }
    return run.length;
  };
};

/** Where text holds a private key as base64 DER, bounded by its declared DER length when complete. */
export function* derKeySpans(text: string): Generator<[number, number]> {
  for (const run of base64Runs(text)) {
    const compact = run.value.replace(LINE_BREAKS, "").replace(/=+$/u, "");
    const indexOf = runIndices(run.value);
    for (
      let at = compact.indexOf("M");
      at !== -1 && compact.length - at >= MIN_KEY_CHARACTERS;
      at = compact.indexOf("M", at + 1)
    ) {
      const header = Buffer.from(
        compact.slice(at, at + HEADER_CHARACTERS),
        "base64",
      );
      if (isPrivateKeyAt(header, 0, false)) {
        const outer = elementAt(header, 0);
        if (outer === undefined) continue;
        const characters = Math.min(
          Math.ceil((outer.end * 8) / 6),
          compact.length - at,
        );
        const from = indexOf(at);
        let to = indexOf(at + characters - 1) + 1;
        while (to < run.value.length && run.value[to] === "=") to += 1;
        yield [run.start + from, run.start + to];
        at += characters - 1;
      }
    }
  }
}

/** Text with each private key held as base64 DER replaced by its kind. */
export const redactDerKeys = (text: string): string => {
  let redacted = "";
  let start = 0;
  for (const [from, to] of derKeySpans(text)) {
    redacted += `${text.slice(start, from)}<credential:private-key>`;
    start = to;
  }
  return redacted + text.slice(start);
};
