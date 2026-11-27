import { err, ok, type Result } from "./result.js";

/**
 * Read one 32-bit word at a byte offset from the start of a hash table. The
 * caller owns address mapping and byte order; an error is its bounds reason.
 */
export type ElfHashWordReader = (offset: number) => Result<number, string>;

export type ElfHashCountFailure =
  | { readonly kind: "malformed"; readonly message: string }
  | {
      readonly kind: "budget";
      readonly label: string;
      readonly count: number;
      /** True when the walk stopped before reaching the end of the table. */
      readonly lowerBound?: true;
    };

/** Yields between bounded steps so each driver owns scheduling and cancellation. */
export type ElfGnuHashCountWalk = Generator<
  void,
  Result<number | null, ElfHashCountFailure>,
  void
>;

const CHECKPOINT_STEPS = 4096;

const malformed = (message: string): Result<never, ElfHashCountFailure> =>
  err({ kind: "malformed", message });
const overBudget = (
  label: string,
  count: number,
  lowerBound?: true,
): Result<never, ElfHashCountFailure> =>
  err({
    kind: "budget",
    label,
    count,
    ...(lowerBound === true ? { lowerBound: true } : {}),
  });

/** A byte offset requests one word. An empty step is a cancellation checkpoint. */
export type ElfHashCountSteps<
  Count,
  Step extends number | undefined = number | undefined,
> = Generator<Step, Result<Count, ElfHashCountFailure>, Result<number, string>>;

/** The width of one DT_HASH entry and, for eight-byte entries, its byte order. */
export type ElfHashEntryLayout = {
  readonly bytes: 4 | 8;
  readonly little: boolean;
};

const EM_S390 = 22;
const EM_ALPHA = 0x9026;
const EM_S390_OLD = 0xa390;

/** binutils and glibc store 64-bit Alpha and s390x DT_HASH entries in eight bytes. */
export const elfHashEntryLayout = ({
  machine,
  bits,
  little,
}: {
  readonly machine: number;
  readonly bits: 32 | 64;
  readonly little: boolean;
}): ElfHashEntryLayout => ({
  bytes:
    bits === 64 &&
    (machine === EM_S390 || machine === EM_ALPHA || machine === EM_S390_OLD)
      ? 8
      : 4,
  little,
});

/** DT_HASH's nchain is the dynamic symbol count; the whole table must be readable. */
export function* readElfHashSymbolCountSteps(
  maximum = Number.POSITIVE_INFINITY,
  entry: ElfHashEntryLayout = { bytes: 4, little: true },
): ElfHashCountSteps<number, number> {
  function* header(index: number): ElfHashCountSteps<number, number> {
    const at = index * entry.bytes;
    if (entry.bytes === 4) {
      const word = yield at;
      return word.ok
        ? ok(word.value)
        : malformed(`DT_HASH header ${word.error}`);
    }
    const low = yield at + (entry.little ? 0 : 4);
    if (!low.ok) return malformed(`DT_HASH header ${low.error}`);
    const high = yield at + (entry.little ? 4 : 0);
    if (!high.ok) return malformed(`DT_HASH header ${high.error}`);
    return high.value === 0
      ? ok(low.value)
      : malformed("DT_HASH header entry exceeds 32 bits");
  }
  const buckets = yield* header(0);
  if (!buckets.ok) return buckets;
  const count = yield* header(1);
  if (!count.ok) return count;
  if (count.value > maximum)
    return overBudget("DT_HASH symbol table", count.value);
  const end = yield entry.bytes * (2 + buckets.value + count.value) - 4;
  return end.ok ? ok(count.value) : malformed(`DT_HASH table ${end.error}`);
}

export const readElfHashSymbolCount = (
  read: ElfHashWordReader,
  maximum = Number.POSITIVE_INFINITY,
  entry?: ElfHashEntryLayout,
): Result<number, ElfHashCountFailure> => {
  const steps = readElfHashSymbolCountSteps(maximum, entry);
  let next = steps.next();
  while (!next.done) next = steps.next(read(next.value));
  return next.value;
};

/**
 * DT_GNU_HASH records the first hashed index and bounded buckets and chains.
 * The count is the end of the last chain, with no payload-to-EOF walk.
 * Empty buckets leave the count indeterminate: unhashed imports can extend
 * beyond symoffset. Return null rather than treating symoffset as exact.
 */
export function* readElfGnuHashSymbolCountSteps(
  wordBytes: 4 | 8,
  maximum = Number.POSITIVE_INFINITY,
): ElfHashCountSteps<number | null> {
  const header: number[] = [];
  for (const offset of [0, 4, 8, 12]) {
    const word = yield offset;
    if (!word.ok) return malformed(`DT_GNU_HASH header ${word.error}`);
    header.push(word.value);
  }
  const [buckets = 0, firstSymbol = 0, bloomWords = 0] = header;
  if (buckets > maximum) return overBudget("DT_GNU_HASH bucket table", buckets);
  if (bloomWords > maximum)
    return overBudget("DT_GNU_HASH bloom filter", bloomWords);
  if (firstSymbol > maximum)
    return overBudget("DT_GNU_HASH symbol index", firstSymbol);
  if (buckets === 0 || bloomWords === 0)
    return malformed("DT_GNU_HASH buckets are malformed");
  const bucketsAt = 16 + bloomWords * wordBytes;
  const prefixBytes = bucketsAt + buckets * 4;
  const lastBucket = yield prefixBytes - 4;
  if (!lastBucket.ok)
    return malformed(`DT_GNU_HASH buckets ${lastBucket.error}`);
  let last = 0;
  for (let index = 0; index < buckets; index += 1) {
    if (index % CHECKPOINT_STEPS === 0) yield;
    const value = yield bucketsAt + index * 4;
    if (!value.ok) return malformed(`DT_GNU_HASH buckets ${value.error}`);
    if (value.value !== 0 && value.value < firstSymbol)
      return malformed("DT_GNU_HASH bucket precedes its first symbol");
    last = Math.max(last, value.value);
  }
  if (last === 0) return ok(null);
  for (let index = last; ; index += 1) {
    if (index + 1 > maximum)
      return overBudget("DT_GNU_HASH symbol table", index + 1, true);
    if ((index - last) % CHECKPOINT_STEPS === 0) yield;
    const chain = yield prefixBytes + (index - firstSymbol) * 4;
    if (!chain.ok) return malformed(`DT_GNU_HASH chain ${chain.error}`);
    if ((chain.value & 1) !== 0) return ok(index + 1);
  }
}

/** Drive the shared hash walk over synchronous words and expose its checkpoints. */
export function* readElfGnuHashSymbolCount(
  read: ElfHashWordReader,
  wordBytes: 4 | 8,
  maximum = Number.POSITIVE_INFINITY,
): ElfGnuHashCountWalk {
  const steps = readElfGnuHashSymbolCountSteps(wordBytes, maximum);
  const checkpoint = ok(0);
  let next = steps.next();
  while (!next.done) {
    if (next.value === undefined) {
      yield;
      next = steps.next(checkpoint);
    } else next = steps.next(read(next.value));
  }
  return next.value;
}
