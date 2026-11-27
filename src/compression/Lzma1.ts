/**
 * The one owner of LZMA1 stream facts and decoding for every LZMA1 consumer
 * (UnityFS blocks, UEFI LZMA custom sections). Formats keep only their own
 * framing and limits; header validation, the decoder window and the verdict
 * on a stream are decided here.
 *
 * This module must not import other repository modules: the UnityFS decode
 * worker thread loads it directly, from source in development and from the
 * build otherwise.
 *
 * Sources: LZMA SDK `lzma-specification.txt` and `LzmaDec.c`
 * (`LzmaProps_Decode`, `LzmaDecode`), as vendored by tianocore/edk2
 * `MdeModulePkg/Library/LzmaCustomDecompressLib`.
 */

/** Properties byte plus the little-endian dictionary size. */
export const LZMA1_PROPERTIES_BYTES = 5;
/** LZMA-Alone (`.lzma`, EDK II `LZMA_HEADER_SIZE`): properties plus a u64 size. */
export const LZMA1_ALONE_HEADER_BYTES = LZMA1_PROPERTIES_BYTES + 8;
/** An LZMA-Alone size of all ones declares an unknown size and an end marker. */
export const LZMA1_UNKNOWN_SIZE = 0xffff_ffff_ffff_ffffn;
/** Little-endian u32 dictionary size after the properties byte. */
export const LZMA1_DICTIONARY_OFFSET = 1;
/** Little-endian u64 size in an LZMA-Alone header. */
export const LZMA1_SIZE_OFFSET = LZMA1_PROPERTIES_BYTES;

const DICTIONARY_OFFSET = LZMA1_DICTIONARY_OFFSET;
const SIZE_OFFSET = LZMA1_SIZE_OFFSET;
/**
 * The properties byte is `(pb * 5 + lp) * 9 + lc` with lc 0-8, lp 0-4 and
 * pb 0-4; `LzmaProps_Decode` refuses `d >= 9 * 5 * 5`. The tighter
 * lc + lp <= 4 belongs to LZMA2 and to liblzma's encoder, not to LZMA1.
 */
const PROPERTIES_LIMIT = 9 * 5 * 5;
/** `LZMA_DIC_MIN`: `LzmaProps_Decode` promotes smaller dictionaries. */
const MIN_DICTIONARY_BYTES = 1 << 12;
/** `RC_INIT_SIZE`: a zero byte, then four bytes of range coder state. */
const RANGE_CODER_INIT_BYTES = 5;

/** The decoder entry point lzma-purejs exposes. */
export interface Lzma1Codec {
  decompressFile(
    input: { readByte(): number },
    output: { writeByte(byte: number): void },
  ): unknown;
}

/** A verdict about the stream itself; never a runtime or host failure. */
export interface Lzma1Refusal {
  readonly ok: false;
  readonly kind: "truncated" | "malformed" | "output-limit";
  readonly message: string;
  /** For an output limit: the bound and, when known, the size that needed more. */
  readonly limit?: { readonly maximum: number; readonly required?: bigint };
}

export interface Lzma1Decoded {
  readonly ok: true;
  /** Exactly the decoded bytes, in a dedicated (transferable) ArrayBuffer. */
  readonly output: Buffer;
  /** Input bytes the decoder read, including any end marker. */
  readonly consumed: number;
}

export interface Lzma1AloneHeader {
  readonly ok: true;
  readonly dictionaryBytes: number;
  /** Null when the header declares an unknown size. */
  readonly declared: bigint | null;
}

const refusal = (
  kind: Lzma1Refusal["kind"],
  message: string,
  limit?: Lzma1Refusal["limit"],
): Lzma1Refusal =>
  limit === undefined
    ? { ok: false, kind, message }
    : { ok: false, kind, message, limit };

/** Refuse what the LZMA-Alone header's size and properties byte rule out. */
export const checkLzma1AloneHeader = (
  alone: Buffer,
): Lzma1Refusal | undefined => {
  if (alone.length < LZMA1_ALONE_HEADER_BYTES)
    return refusal("truncated", "Incomplete LZMA stream header.");
  if (alone[0]! >= PROPERTIES_LIMIT)
    return refusal(
      "malformed",
      "LZMA properties are outside lc 0-8, lp 0-4 and pb 0-4.",
    );
  return undefined;
};

/** Header fields as the host decoded them (see `readLzma1AloneHeader`). */
export const lzma1AloneHeader = (
  dictionaryBytes: number,
  size: bigint,
): Lzma1AloneHeader => ({
  ok: true,
  dictionaryBytes,
  declared: size === LZMA1_UNKNOWN_SIZE ? null : size,
});

/** The range coder lead-in after the header: a zero byte and four more. */
export const checkLzma1RangeCoderLeadIn = (
  alone: Buffer,
): Lzma1Refusal | undefined => {
  if (alone.length < LZMA1_ALONE_HEADER_BYTES + RANGE_CODER_INIT_BYTES)
    return refusal("truncated", "Incomplete LZMA range coder header.");
  if (alone[LZMA1_ALONE_HEADER_BYTES] !== 0)
    return refusal(
      "malformed",
      "The initial LZMA range coder byte must be zero.",
    );
  return undefined;
};

/**
 * The decoder window for a stream whose output cannot exceed `outputBound`.
 * Every valid match distance is below the bytes already produced, so a window
 * of the output bound decodes every valid stream exactly as the declared
 * dictionary would, and still refuses a distance beyond either. The SDK's
 * one-call `LzmaDecode` likewise uses its output buffer as the dictionary.
 */
export const lzma1WindowBytes = (
  dictionaryBytes: number,
  outputBound: number,
): number =>
  Math.max(MIN_DICTIONARY_BYTES, Math.min(dictionaryBytes, outputBound));

/**
 * lzma-purejs 0.9.3 reports a stream it cannot decode by throwing one of these
 * string literals (`Util.decompressFile`); they are its only verdicts.
 */
const CODEC_VERDICTS: ReadonlySet<string> = new Set([
  "Error in data stream",
  "Incorrect stream properties",
]);

const isCodecVerdict = (cause: unknown): cause is string =>
  typeof cause === "string" && CODEC_VERDICTS.has(cause);

/** Thrown inside the decoder callbacks to stop it with a verdict. */
class Lzma1Stop {
  readonly refusal: Lzma1Refusal;

  constructor(refusal: Lzma1Refusal) {
    this.refusal = refusal;
  }
}

/** Output that never grows beyond its bound and owns its ArrayBuffer. */
class BoundedOutput {
  #buffer: Buffer;
  #used = 0;

  readonly bound: number;
  readonly overflow: () => Lzma1Refusal;

  constructor(bound: number, exact: boolean, overflow: () => Lzma1Refusal) {
    this.bound = bound;
    this.overflow = overflow;
    this.#buffer = Buffer.allocUnsafeSlow(
      exact ? bound : Math.min(bound, 0x10000),
    );
  }

  writeByte(byte: number): void {
    const position = this.#used;
    if (position >= this.bound) throw new Lzma1Stop(this.overflow());
    if (position >= this.#buffer.length) {
      const next = Buffer.allocUnsafeSlow(
        Math.min(this.bound, Math.max(0x10000, this.#buffer.length * 2)),
      );
      this.#buffer.copy(next, 0, 0, position);
      this.#buffer = next;
    }
    this.#buffer[position] = byte;
    this.#used = position + 1;
  }

  get used(): number {
    return this.#used;
  }

  /** The decoded bytes, copied only when the buffer was not filled exactly. */
  take(): Buffer {
    if (this.#used === this.#buffer.length) return this.#buffer;
    const exact = Buffer.allocUnsafeSlow(this.#used);
    this.#buffer.copy(exact, 0, 0, this.#used);
    return exact;
  }
}

export interface Lzma1DecodeOptions {
  /** The most output the caller admits, refused as an output limit. */
  readonly outputLimit: number;
  /**
   * The output size the surrounding format declares when the LZMA-Alone
   * header does not. A stream that disagrees with a declaration is malformed.
   */
  readonly expectedOutput?: number;
}

/**
 * Decode one LZMA-Alone stream. `alone` must be a private copy: its
 * dictionary field is rewritten to the bounded decoder window.
 */
export const decodeLzma1Alone = (
  codec: Lzma1Codec,
  alone: Buffer,
  header: Lzma1AloneHeader,
  options: Lzma1DecodeOptions,
): Lzma1Decoded | Lzma1Refusal => {
  const invalid = checkLzma1AloneHeader(alone);
  if (invalid !== undefined) return invalid;
  const declared =
    header.declared ??
    (options.expectedOutput === undefined
      ? null
      : BigInt(options.expectedOutput));
  if (declared !== null && declared > BigInt(options.outputLimit))
    return refusal(
      "output-limit",
      `Declared LZMA output exceeds ${String(options.outputLimit)} bytes.`,
      { maximum: options.outputLimit, required: declared },
    );
  // An over-limit declaration is refused before the stream body is examined.
  const leadIn = checkLzma1RangeCoderLeadIn(alone);
  if (leadIn !== undefined) return leadIn;
  const bound = declared === null ? options.outputLimit : Number(declared);
  alone.writeUInt32LE(
    lzma1WindowBytes(header.dictionaryBytes, bound),
    DICTIONARY_OFFSET,
  );
  const output = new BoundedOutput(bound, declared !== null, () =>
    declared === null
      ? refusal(
          "output-limit",
          `Decompressed output exceeds the ${String(bound)} byte budget.`,
          { maximum: bound, required: BigInt(bound) + 1n },
        )
      : refusal(
          "malformed",
          `LZMA decoded more than its declared ${String(bound)} bytes.`,
        ),
  );
  let position = 0;
  try {
    codec.decompressFile(
      {
        readByte() {
          if (position >= alone.length)
            throw new Lzma1Stop(
              refusal(
                "truncated",
                "Compressed stream ends before the decoder can finish.",
              ),
            );
          return alone[position++]!;
        },
      },
      output,
    );
  } catch (cause: unknown) {
    if (cause instanceof Lzma1Stop) return cause.refusal;
    if (isCodecVerdict(cause)) return refusal("malformed", `${cause}.`);
    // Anything else (an allocation failure, a codec defect) is a fault in
    // the decoding host, not a fact about the stream; its host classifies it.
    throw cause;
  }
  if (declared !== null && BigInt(output.used) !== declared)
    return refusal(
      "malformed",
      `LZMA decoded ${String(output.used)} bytes; stream declared ${String(declared)} bytes.`,
    );
  return { ok: true, output: output.take(), consumed: position };
};

/**
 * An LZMA-Alone copy of a raw LZMA1 stream (properties then coded bytes, no
 * size field), declaring `size`, in a dedicated ArrayBuffer.
 */
export const lzma1AloneFromRaw = (raw: Buffer, size: bigint): Buffer => {
  // Too short to carry its properties; the header check reports it.
  if (raw.length < LZMA1_PROPERTIES_BYTES) return Buffer.from(raw);
  const alone = Buffer.allocUnsafeSlow(
    raw.length + LZMA1_ALONE_HEADER_BYTES - LZMA1_PROPERTIES_BYTES,
  );
  raw.copy(alone, 0, 0, LZMA1_PROPERTIES_BYTES);
  alone.writeBigUInt64LE(size, SIZE_OFFSET);
  raw.copy(alone, LZMA1_ALONE_HEADER_BYTES, LZMA1_PROPERTIES_BYTES);
  return alone;
};

/**
 * Decode a private LZMA-Alone copy of a stream whose size its format declares
 * outside the stream. A writer may end it at that size or with an end marker;
 * any other trailing byte is malformed.
 */
export const decodeLzma1KnownSize = (
  codec: Lzma1Codec,
  alone: Buffer,
  dictionaryBytes: number,
  expected: number,
): Lzma1Decoded | Lzma1Refusal => {
  const options = { outputLimit: expected, expectedOutput: expected };
  alone.writeBigUInt64LE(BigInt(expected), SIZE_OFFSET);
  const sized = decodeLzma1Alone(
    codec,
    alone,
    lzma1AloneHeader(dictionaryBytes, BigInt(expected)),
    options,
  );
  if (!sized.ok || sized.consumed === alone.length) return sized;
  // Unread input after the declared size may be an end marker, which only a
  // decode that runs to the marker can establish.
  alone.writeBigUInt64LE(LZMA1_UNKNOWN_SIZE, SIZE_OFFSET);
  const marked = decodeLzma1Alone(
    codec,
    alone,
    lzma1AloneHeader(dictionaryBytes, LZMA1_UNKNOWN_SIZE),
    options,
  );
  if (!marked.ok || marked.consumed === alone.length) return marked;
  return refusal("malformed", "LZMA stream has trailing bytes.");
};
