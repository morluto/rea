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
/** The algorithm identifiers that encrypt a private key: PKCS #5 and PKCS #12 password-based encryption. */
const ENCRYPTION_ALGORITHMS = ["2a864886f70d0105", "2a864886f70d010c01"];

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
      isOneOf(hex(bytes, oid), ENCRYPTION_ALGORITHMS)
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

/** Runs of base64 long enough to hold a key, line breaks and escaped ones inside them included. */
const BASE64_RUN =
  /[A-Za-z0-9+/](?:[A-Za-z0-9+/]|\r?\n|\\n|\\r\\n){59,}={0,2}/gu;
const LINE_BREAKS = /\r?\n|\\n|\\r\\n/gu;
/** The fewest base64 characters a private key takes: an X25519 or Ed25519 key's 48 bytes. */
const MIN_KEY_CHARACTERS = 60;
/** How many characters from a key's start are decoded to read its first elements. */
const HEADER_CHARACTERS = 64;

/** Where in `run` its `count`th base64 character is. */
const runIndex = (run: string, count: number): number => {
  let seen = 0;
  for (let index = 0; index < run.length; index += 1)
    if (/[A-Za-z0-9+/]/u.test(run[index] ?? "") && (seen += 1) > count)
      return index;
  return run.length;
};

/** Where text holds a private key as base64 DER: from the key's first character to the end of its run. */
export const derKeySpans = (text: string): [number, number][] => {
  const spans: [number, number][] = [];
  for (const run of text.matchAll(BASE64_RUN)) {
    const compact = run[0].replace(LINE_BREAKS, "");
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
        spans.push([
          run.index + runIndex(run[0], at),
          run.index + run[0].length,
        ]);
        break;
      }
    }
  }
  return spans;
};

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
