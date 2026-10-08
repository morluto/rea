import { ArtifactReaderFailure } from "./ArtifactReader.js";

/**
 * Element ceiling for one TOC. The byte cap still allows millions of tiny
 * elements, and the DOM is built before member collection can charge the
 * metadata budget.
 */
const MAX_TOC_ELEMENTS = 100_000;

/** Reject a TOC whose element count would materialize an unbounded DOM. */
export const assertXarTocElements = (xml: string): void => {
  let elements = 0;
  for (let index = 0; index < xml.length; index += 1) {
    if (xml[index] !== "<") continue;
    const next = xml[index + 1];
    if (next === undefined || next === "/" || next === "?" || next === "!")
      continue;
    elements += 1;
    if (elements > MAX_TOC_ELEMENTS)
      throw new ArtifactReaderFailure(
        "limit",
        `xar TOC exceeds ${MAX_TOC_ELEMENTS} XML elements`,
      );
  }
};

/** Required XAR integer syntax: nonempty unsigned decimal, exactly representable. */
export const xarInteger = (
  value: string | undefined,
  label: string,
): number => {
  const text = value?.trim() ?? "";
  const parsed = /^\d+$/u.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(parsed))
    throw new ArtifactReaderFailure(
      "format",
      `xar TOC has an invalid ${label}`,
    );
  return parsed;
};

/** Optional mode metadata is accepted only as a complete unsigned octal field. */
export const xarMode = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const text = value.trim();
  const mode = /^[0-7]+$/u.test(text) ? Number.parseInt(text, 8) : Number.NaN;
  if (!Number.isSafeInteger(mode))
    throw new ArtifactReaderFailure("format", "xar TOC has an invalid mode");
  return mode;
};

/** Validate the entire absolute heap range before allocating or requesting it. */
export const xarHeapPosition = (
  heap: number,
  offset: number,
  length: number,
  size: number,
): number => {
  const position = heap + offset;
  const end = position + length;
  if (
    ![position, end, offset, length].every(Number.isSafeInteger) ||
    offset < 0 ||
    length < 0 ||
    end > size
  )
    throw new ArtifactReaderFailure(
      "format",
      "xar member has an invalid or out-of-file heap extent",
    );
  return position;
};

/** Bound retained path text before constructing paths from deeply nested TOCs. */
export class XarPathBudget {
  #used = 0;
  private readonly maximumPathBytes = 4096;
  private readonly maximumTotalBytes = 16 * 1024 * 1024;

  /** Form the next path only when individual and cumulative budgets permit it. */
  join(parent: string, name: string): string {
    const bytes =
      Buffer.byteLength(parent) +
      Buffer.byteLength(name) +
      (parent.length > 0 ? 1 : 0);
    if (
      bytes > this.maximumPathBytes ||
      bytes > this.maximumTotalBytes - this.#used
    )
      throw new ArtifactReaderFailure(
        "limit",
        `xar TOC path text exceeds its ${this.maximumPathBytes}-byte path or ${this.maximumTotalBytes}-byte cumulative budget`,
      );
    this.#used += bytes;
    return parent === "" ? name : `${parent}/${name}`;
  }
}
