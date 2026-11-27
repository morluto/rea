import { Uint8ArrayWriter, type Entry, type FileEntry } from "@zip.js/zip.js";

import { Budget } from "../domain/budget.js";

export const zipMemberSize = (value: number | undefined): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;

export const isZipFileEntry = (entry: Entry): entry is FileEntry =>
  !entry.directory && "getData" in entry;

/** Refuse expansion past the metadata budget before buffering more output. */
class BoundedUint8ArrayWriter extends Uint8ArrayWriter {
  readonly #budget: Budget;

  constructor(
    maximum: number,
    private readonly exceeded: (required: number) => Error,
  ) {
    super();
    this.#budget = new Budget(maximum);
  }

  override async init(size?: number): Promise<void> {
    if (size !== undefined && size > this.#budget.maximum)
      throw this.exceeded(size);
    await super.init?.(size);
  }

  override async writeUint8Array(array: Uint8Array): Promise<void> {
    this.#budget.charge(array.length, () =>
      this.exceeded(this.#budget.used + array.length),
    );
    await super.writeUint8Array(array);
  }
}

/** Bound the declared and emitted bytes of one buffered member. */
export const readBoundedZipMember = (
  entry: FileEntry,
  signal: AbortSignal | undefined,
  maximum: number,
  exceeded: (required: number) => Error,
): Promise<Uint8Array> => {
  const declared = zipMemberSize(entry.uncompressedSize);
  if (declared !== null && declared > maximum) throw exceeded(declared);
  return entry.getData(new BoundedUint8ArrayWriter(maximum, exceeded), {
    checkSignature: true,
    ...(signal === undefined ? {} : { signal }),
  });
};
